package main

import (
	"context"
	"os"
	"testing"
)

// TestLiveTokenWorkspaceAuthenticatesToAweb drives the gateway's real
// workspaceMailClient (token-only branch) against a live aweb server and makes
// an authenticated call. It is gated on GW_LIVE_WORKSPACE_DIR so it never runs
// in CI; run it manually with:
//
//	GW_LIVE_WORKSPACE_DIR=/tmp/tok-ws GW_LIVE_TEAM=default:local \
//	AW_TOKEN=$JWT go test ./cmd/aweb-a2a-gw/ -run TestLiveTokenWorkspaceAuthenticatesToAweb -v -count=1
func TestLiveTokenWorkspaceAuthenticatesToAweb(t *testing.T) {
	dir := os.Getenv("GW_LIVE_WORKSPACE_DIR")
	if dir == "" {
		t.Skip("set GW_LIVE_WORKSPACE_DIR (and AW_TOKEN) to run the live token-auth check")
	}
	team := os.Getenv("GW_LIVE_TEAM")

	client, gatewayIdentity, err := workspaceMailClient(dir, team, "", "")
	if err != nil {
		t.Fatalf("workspaceMailClient (live token-only): %v", err)
	}
	if client == nil {
		t.Fatal("expected a bearer client, got nil")
	}
	t.Logf("gateway identity: %q", gatewayIdentity)

	resp, err := client.ListAgents(context.Background())
	if err != nil {
		t.Fatalf("authenticated aweb call (ListAgents) failed: %v", err)
	}
	t.Logf("authenticated ListAgents OK: %d agents in team", len(resp.Agents))
}
