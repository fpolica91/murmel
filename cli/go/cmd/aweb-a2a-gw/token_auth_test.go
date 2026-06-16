package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/awebai/aw/awconfig"
	"github.com/awebai/aw/awid"
)

// fakeJWT builds an unsigned (header.payload.signature) token whose payload
// carries the given subject and an exp one hour out. The CLI/gateway only read
// these claims for cache/display heuristics; the server verifies the signature.
// The signature segment is non-empty so the 3-part shape parses.
func fakeJWT(t *testing.T, subject string) string {
	t.Helper()
	enc := func(v any) string {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		return base64.RawURLEncoding.EncodeToString(b)
	}
	header := enc(map[string]string{"alg": "none", "typ": "JWT"})
	payload := enc(map[string]any{"sub": subject, "exp": time.Now().Add(time.Hour).Unix()})
	sig := base64.RawURLEncoding.EncodeToString([]byte("sig"))
	return header + "." + payload + "." + sig
}

// writeTokenOnlyGatewayWorkspace writes a cert-less (token-only) workspace
// binding: a workspace.yaml + teams.yaml membership with NO cert_path and NO
// .aw/team-certs/, plus a local self-custodial signing key. This mirrors what
// the pivoted `aw init` produces for a token-only workspace.
func writeTokenOnlyGatewayWorkspace(t *testing.T, dir, awebURL, teamID string) {
	t.Helper()
	_, memberPriv, err := awid.GenerateKeypair()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(dir, ".aw"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := awid.SaveSigningKey(filepath.Join(dir, ".aw", "signing.key"), memberPriv); err != nil {
		t.Fatal(err)
	}
	workspace := &awconfig.WorktreeWorkspace{
		AwebURL: awebURL,
		Memberships: []awconfig.WorktreeMembership{{
			TeamID: teamID,
			Alias:  "gateway",
			// CertPath intentionally empty: token-only binding.
		}},
	}
	if err := awconfig.SaveWorktreeWorkspaceTo(filepath.Join(dir, ".aw", "workspace.yaml"), workspace); err != nil {
		t.Fatal(err)
	}
	if err := awconfig.SaveTeamState(dir, &awconfig.TeamState{
		ActiveTeam: teamID,
		Memberships: []awconfig.TeamMembership{{
			TeamID:  teamID,
			Alias:   "gateway",
			AwebURL: awebURL,
		}},
	}); err != nil {
		t.Fatal(err)
	}
}

// TestTokenWorkspaceMailClientUsesBearerAuth verifies that a cert-less
// (token-only) workspace builds an aweb client that authenticates with
// Authorization: Bearer <jwt> + X-AWEB-Team-Id (not a team certificate), and
// that workspaceMailClient routes to that bearer path without a cert.
func TestTokenWorkspaceMailClientUsesBearerAuth(t *testing.T) {
	tmp := t.TempDir()
	teamID := "default:local"
	jwt := fakeJWT(t, "user-123")
	t.Setenv("AW_TOKEN", jwt)

	var gotAuth, gotTeam string
	var gotCert string
	awebServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/agents":
			gotAuth = r.Header.Get("Authorization")
			gotTeam = r.Header.Get("X-AWEB-Team-Id")
			gotCert = r.Header.Get("X-AWID-Team-Certificate")
			_ = json.NewEncoder(w).Encode(map[string]any{"agents": []any{}})
		default:
			t.Fatalf("unexpected aweb request %s %s", r.Method, r.URL.Path)
		}
	}))
	defer awebServer.Close()

	writeTokenOnlyGatewayWorkspace(t, tmp, awebServer.URL, teamID)

	client, gatewayIdentity, err := workspaceMailClient(tmp, "", "", "")
	if err != nil {
		t.Fatalf("workspaceMailClient (token-only): %v", err)
	}
	if client == nil {
		t.Fatal("expected a bearer-authenticated client, got nil")
	}
	if gatewayIdentity != "gateway" {
		t.Fatalf("gatewayIdentity=%q, want %q", gatewayIdentity, "gateway")
	}

	// Drive one authenticated aweb call through the client's transport and assert
	// it presented the bearer token + team header and NO certificate.
	if _, err := client.ListAgents(context.Background()); err != nil {
		t.Fatalf("ListAgents through bearer client: %v", err)
	}
	if want := "Bearer " + jwt; gotAuth != want {
		t.Fatalf("Authorization=%q, want %q", gotAuth, want)
	}
	if gotTeam != teamID {
		t.Fatalf("X-AWEB-Team-Id=%q, want %q", gotTeam, teamID)
	}
	if gotCert != "" {
		t.Fatalf("token-only client must not send a team certificate, got %q", gotCert)
	}
}

// TestTokenWorkspaceMailClientRequiresToken verifies that a cert-less workspace
// with NO resolvable token fails with an actionable error rather than building a
// client that would 401.
func TestTokenWorkspaceMailClientRequiresToken(t *testing.T) {
	tmp := t.TempDir()
	teamID := "default:local"
	// Ensure no AW_TOKEN and no cached ~/.aw/token leaks in: point HOME at an
	// empty dir and clear AW_TOKEN.
	t.Setenv("AW_TOKEN", "")
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("USERPROFILE", home)

	writeTokenOnlyGatewayWorkspace(t, tmp, "http://127.0.0.1:0", teamID)

	_, _, err := workspaceMailClient(tmp, "", "", "")
	if err == nil {
		t.Fatal("expected an error when no bearer token is available")
	}
	if got := err.Error(); got == "" {
		t.Fatalf("expected a non-empty error, got %v", err)
	}
}
