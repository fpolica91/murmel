package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/awebai/aw/awconfig"
	"github.com/spf13/cobra"
)

// mcpServeCmd is the token-only MCP bridge. A host (e.g. Claude Code) launches
// it as a stdio MCP server; it forwards each MCP message to this workspace's
// aweb `/mcp/` endpoint over Streamable HTTP, attaching a fresh Better Auth JWT
// (auto-refreshed from ~/.aw/token) and the active team on every request. This
// is the token-only replacement for the certificate-based channel: it works for
// any user who has run `aw login` + `aw init`, with no per-account config.
var mcpServeCmd = &cobra.Command{
	Use:   "mcp-serve",
	Short: "Run a local MCP server bridging this session to the aweb /mcp/ endpoint (token-only, auto-refreshing)",
	Long: `mcp-serve is a stdio MCP server. Configure it with the JSON from
'aw mcp-config' and a host like Claude Code will launch it. It proxies MCP
requests to this workspace's aweb /mcp/ endpoint, attaching a fresh
auto-refreshed Better Auth JWT (~/.aw/token, or AW_TOKEN) plus the active team
on every request — so the agent gets the native aweb tools without a team
certificate.`,
	SilenceUsage: true,
	RunE:         runMCPServe,
}

func init() {
	rootCmd.AddCommand(mcpServeCmd)
}

func runMCPServe(cmd *cobra.Command, _ []string) error {
	baseURL, teamID, err := resolveMCPTarget()
	if err != nil {
		return err
	}
	mcpURL := strings.TrimSuffix(baseURL, "/") + "/mcp/"

	ctx := cmd.Context()
	if ctx == nil {
		ctx = context.Background()
	}
	client := &http.Client{Timeout: 5 * time.Minute}
	out := bufio.NewWriter(os.Stdout)
	in := bufio.NewReaderSize(os.Stdin, 1<<20)

	var sessionID string
	for {
		line, readErr := in.ReadBytes('\n')
		if msg := bytes.TrimSpace(line); len(msg) > 0 {
			respLines, newSession := forwardMCPMessage(ctx, client, mcpURL, teamID, sessionID, msg)
			if newSession != "" {
				sessionID = newSession
			}
			for _, rl := range respLines {
				out.Write(rl)
				out.WriteByte('\n')
			}
			if err := out.Flush(); err != nil {
				return err
			}
		}
		if readErr == io.EOF {
			return nil
		}
		if readErr != nil {
			return readErr
		}
	}
}

// resolveMCPTarget resolves the aweb base URL + active team for the current
// workspace, matching the rest of the CLI: AWEB_URL env wins, then the
// workspace's aweb_url, then the baked default; the team comes from --team or
// the workspace's active membership.
func resolveMCPTarget() (baseURL, teamID string, err error) {
	wd, err := os.Getwd()
	if err != nil {
		return "", "", err
	}
	workspace, teamState, _, lerr := awconfig.LoadWorkspaceAndTeamState(wd)
	if lerr != nil && workspace == nil && !errors.Is(lerr, os.ErrNotExist) {
		return "", "", fmt.Errorf("load workspace: %w", lerr)
	}

	switch {
	case strings.TrimSpace(os.Getenv("AWEB_URL")) != "":
		baseURL = strings.TrimSpace(os.Getenv("AWEB_URL"))
	case workspace != nil && strings.TrimSpace(workspace.AwebURL) != "":
		baseURL = strings.TrimSpace(workspace.AwebURL)
	default:
		baseURL = DefaultAwebURL
	}
	if strings.TrimSpace(baseURL) == "" {
		return "", "", fmt.Errorf("no aweb server configured; run `aw init` or set AWEB_URL")
	}

	switch {
	case strings.TrimSpace(teamFlag) != "":
		teamID = strings.TrimSpace(teamFlag)
	default:
		if m := awconfig.ActiveMembershipFor(workspace, teamState); m != nil {
			teamID = strings.TrimSpace(m.TeamID)
		} else if teamState != nil && teamState.Membership(strings.TrimSpace(teamState.ActiveTeam)) != nil {
			teamID = strings.TrimSpace(teamState.ActiveTeam)
		}
	}
	return baseURL, teamID, nil
}

// forwardMCPMessage POSTs one MCP message to /mcp/ with a fresh bearer + team,
// and returns the JSON-RPC response message(s) to write back to the host.
func forwardMCPMessage(ctx context.Context, client *http.Client, mcpURL, teamID, sessionID string, msg []byte) (lines [][]byte, newSession string) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, mcpURL, bytes.NewReader(msg))
	if err != nil {
		return [][]byte{mcpErrorFor(msg, err)}, ""
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/event-stream")
	tok, terr := bearerTokenProvider(ctx)
	if terr != nil {
		return [][]byte{mcpErrorFor(msg, fmt.Errorf("not authenticated (%v); run `aw login`", terr))}, ""
	}
	if tok != "" {
		req.Header.Set("Authorization", "Bearer "+tok)
	}
	if teamID != "" {
		req.Header.Set("X-AWEB-Team-Id", teamID)
	}
	if sessionID != "" {
		req.Header.Set("Mcp-Session-Id", sessionID)
	}

	resp, err := client.Do(req)
	if err != nil {
		return [][]byte{mcpErrorFor(msg, err)}, ""
	}
	defer resp.Body.Close()
	newSession = strings.TrimSpace(resp.Header.Get("Mcp-Session-Id"))

	// 202 Accepted (a notification/response with no body) yields nothing.
	if resp.StatusCode == http.StatusAccepted {
		return nil, newSession
	}
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		return parseSSEData(resp.Body), newSession
	}
	body, _ := io.ReadAll(resp.Body)
	if body = bytes.TrimSpace(body); len(body) > 0 {
		lines = append(lines, body)
	}
	return lines, newSession
}

// parseSSEData extracts each SSE event's `data:` JSON payload as its own line.
func parseSSEData(r io.Reader) [][]byte {
	var lines [][]byte
	sc := bufio.NewScanner(r)
	sc.Buffer(make([]byte, 0, 64*1024), 8<<20)
	var data bytes.Buffer
	flush := func() {
		if payload := bytes.TrimSpace(data.Bytes()); len(payload) > 0 {
			cp := make([]byte, len(payload))
			copy(cp, payload)
			lines = append(lines, cp)
		}
		data.Reset()
	}
	for sc.Scan() {
		line := sc.Bytes()
		if len(bytes.TrimSpace(line)) == 0 {
			flush() // blank line = end of one SSE event
			continue
		}
		if bytes.HasPrefix(line, []byte("data:")) {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.Write(bytes.TrimSpace(line[len("data:"):]))
		}
		// event:/id:/comment lines are ignored
	}
	flush()
	return lines
}

// mcpErrorFor builds a JSON-RPC error carrying the original request id, so the
// host surfaces a clean error rather than hanging.
func mcpErrorFor(reqMsg []byte, cause error) []byte {
	var probe struct {
		ID json.RawMessage `json:"id"`
	}
	_ = json.Unmarshal(reqMsg, &probe)
	id := json.RawMessage("null")
	if len(probe.ID) > 0 {
		id = probe.ID
	}
	out, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0",
		"id":      id,
		"error": map[string]any{
			"code":    -32000,
			"message": fmt.Sprintf("aweb mcp bridge: %v", cause),
		},
	})
	return out
}
