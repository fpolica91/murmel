package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"
)

var (
	mcpConfigChannel bool
)

var mcpConfigCmd = &cobra.Command{
	Use:   "mcp-config",
	Short: "Output MCP server configuration for the current identity",
	Long: `Prints the JSON to drop into your host's MCP config (e.g. .mcp.json).

By default it emits the token-only bridge ('aw mcp-serve'), which proxies to the
aweb /mcp/ endpoint with an auto-refreshed Better Auth JWT — no team certificate
required. Use --channel for the legacy certificate-based @awebai/claude-channel.`,
	RunE: func(cmd *cobra.Command, args []string) error {
		wd, err := os.Getwd()
		if err != nil {
			return fmt.Errorf("get working directory: %w", err)
		}
		var cfg map[string]any
		if mcpConfigChannel {
			cfg = channelMCPConfig(wd)
		} else {
			cfg = bridgeMCPConfig()
		}
		out, err := json.MarshalIndent(cfg, "", "  ")
		if err != nil {
			return fmt.Errorf("marshal config: %w", err)
		}
		fmt.Println(string(out))
		return nil
	},
}

// bridgeMCPConfig emits the token-only stdio bridge config: it runs this same
// `aw` binary as `aw mcp-serve`, which proxies to /mcp/ with an auto-refreshing
// token. Using the resolved executable path avoids relying on PATH in the host's
// launch environment.
func bridgeMCPConfig() map[string]any {
	command := "aw"
	if exe, err := os.Executable(); err == nil && strings.TrimSpace(exe) != "" {
		command = exe
	}
	return map[string]any{
		"mcpServers": map[string]any{
			"aweb": map[string]any{
				"command": command,
				"args":    []string{"mcp-serve"},
			},
		},
	}
}

func channelMCPConfig(cwd string) map[string]any {
	return map[string]any{
		"mcpServers": map[string]any{
			"aweb": map[string]any{
				"command": "npx",
				"args":    []string{"@awebai/claude-channel"},
				"cwd":     cwd,
			},
		},
	}
}

func init() {
	mcpConfigCmd.Flags().BoolVar(&mcpConfigChannel, "channel", false, "Emit the legacy certificate-based @awebai/claude-channel config instead of the token-only bridge")
	rootCmd.AddCommand(mcpConfigCmd)
}
