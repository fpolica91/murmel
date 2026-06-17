package main

import (
	"strings"
	"testing"
)

func TestInitNextStepLinesPromotesMCPBridge(t *testing.T) {
	lines := initNextStepLines(&initResult{
		ServerName:    "app.aweb.ai",
		ExportBaseURL: "https://app.aweb.ai/api",
	}, t.TempDir(), false, false, false)
	text := strings.Join(lines, "\n")

	for _, want := range []string{
		"aw init --inject-docs",
		"aw claim-human --email you@example.com",
		"claude mcp add aweb -- aw mcp-serve",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in next steps:\n%s", want, text)
		}
	}
	// The legacy certificate-based channel path must no longer be suggested.
	for _, unwanted := range []string{
		"aw init --setup-channel",
		"/plugin marketplace add awebai/claude-plugins",
		"dangerously-load-development-channels",
	} {
		if strings.Contains(text, unwanted) {
			t.Fatalf("unexpected legacy channel text %q in next steps:\n%s", unwanted, text)
		}
	}
}

func TestInitNextStepLinesAllDoneStillShowsMCPBridge(t *testing.T) {
	lines := initNextStepLines(&initResult{
		ServerName:    "localhost",
		ExportBaseURL: "http://127.0.0.1:8000/api",
	}, t.TempDir(), true, true, true)
	text := strings.Join(lines, "\n")

	if !strings.Contains(text, "claude mcp add aweb -- aw mcp-serve") {
		t.Fatalf("missing MCP bridge instruction:\n%s", text)
	}
	for _, unwanted := range []string{
		"aw init --inject-docs",
		"aw init --setup-channel",
		"aw claim-human",
		"dangerously-load-development-channels",
	} {
		if strings.Contains(text, unwanted) {
			t.Fatalf("unexpected %q in next steps:\n%s", unwanted, text)
		}
	}
}

func TestInitNextStepLinesAPIKeyAuthSuppressesClaimHuman(t *testing.T) {
	lines := initNextStepLines(&initResult{
		ServerName:    "app.aweb.ai",
		ExportBaseURL: "https://app.aweb.ai/api",
		APIKeyAuth:    true,
	}, t.TempDir(), false, false, false)
	text := strings.Join(lines, "\n")

	if strings.Contains(text, "aw claim-human") {
		t.Fatalf("API-key auth should suppress claim-human suggestion:\n%s", text)
	}
	for _, want := range []string{
		"aw init --inject-docs",
		"claude mcp add aweb -- aw mcp-serve",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("missing %q in next steps:\n%s", want, text)
		}
	}
}
