package main

import (
	"context"
	"path/filepath"
	"strings"
	"testing"

	"github.com/awebai/aw/awconfig"
	"github.com/awebai/aw/awid"
)

// TestInitTokenWorkspaceWritesCertlessBinding verifies the token-only writer
// produces a cert-less workspace.yaml plus a local self-custody identity, when
// a token is injected via AW_TOKEN.
func TestInitTokenWorkspaceWritesCertlessBinding(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AW_TOKEN", "test.jwt.token")
	savedTokenFlag := tokenFlag
	tokenFlag = ""
	t.Cleanup(func() { tokenFlag = savedTokenFlag })

	out, err := initTokenWorkspace(context.Background(), tokenInitOptions{
		WorkingDir:   dir,
		AwebURL:      "http://localhost:8088",
		TeamID:       "default:local",
		Alias:        "alice",
		RoleName:     "developer",
		HumanName:    "Alice",
		AgentType:    "claude-code",
		WriteContext: true,
	})
	if err != nil {
		t.Fatalf("initTokenWorkspace: %v", err)
	}
	if out.TeamID != "default:local" {
		t.Fatalf("unexpected team: %q", out.TeamID)
	}
	if !strings.HasPrefix(out.DID, "did:key:") {
		t.Fatalf("expected did:key, got %q", out.DID)
	}

	wsPath := filepath.Join(dir, awconfig.DefaultWorktreeWorkspaceRelativePath())
	ws, err := awconfig.LoadWorktreeWorkspaceFrom(wsPath)
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if ws.AwebURL != "http://localhost:8088" {
		t.Fatalf("unexpected aweb_url: %q", ws.AwebURL)
	}
	if len(ws.Memberships) != 1 {
		t.Fatalf("expected 1 membership, got %d", len(ws.Memberships))
	}
	if ws.Memberships[0].CertPath != "" {
		t.Fatalf("expected cert-less membership, got cert_path %q", ws.Memberships[0].CertPath)
	}
	if ws.Memberships[0].Alias != "alice" || ws.Memberships[0].RoleName != "developer" {
		t.Fatalf("unexpected membership metadata: %+v", ws.Memberships[0])
	}
	if ws.HumanName != "Alice" || ws.AgentType != "claude-code" {
		t.Fatalf("unexpected workspace metadata: human=%q agent=%q", ws.HumanName, ws.AgentType)
	}

	// Identity round-trips with custody=self and matching did:key.
	idPath := filepath.Join(dir, awconfig.DefaultWorktreeIdentityRelativePath())
	id, err := awconfig.LoadWorktreeIdentityFrom(idPath)
	if err != nil {
		t.Fatalf("load identity: %v", err)
	}
	if id.Custody != awid.CustodySelf {
		t.Fatalf("expected self custody, got %q", id.Custody)
	}
	if id.DID != out.DID {
		t.Fatalf("identity did %q != output did %q", id.DID, out.DID)
	}

	// A second call is idempotent and reuses the same identity.
	out2, err := initTokenWorkspace(context.Background(), tokenInitOptions{
		WorkingDir: dir,
		AwebURL:    "http://localhost:8088",
		TeamID:     "default:local",
	})
	if err != nil {
		t.Fatalf("second initTokenWorkspace: %v", err)
	}
	if out2.DID != out.DID {
		t.Fatalf("expected stable did across calls: %q != %q", out2.DID, out.DID)
	}
}

// TestInitTokenWorkspaceRequiresToken verifies init fails clearly when no token
// is available.
func TestInitTokenWorkspaceRequiresToken(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("AW_TOKEN", "")
	t.Setenv("HOME", dir) // isolate ~/.aw/token cache lookups to an empty dir
	savedTokenFlag := tokenFlag
	tokenFlag = ""
	t.Cleanup(func() { tokenFlag = savedTokenFlag })

	_, err := initTokenWorkspace(context.Background(), tokenInitOptions{
		WorkingDir: dir,
		AwebURL:    "http://localhost:8088",
		TeamID:     "default:local",
	})
	if err == nil {
		t.Fatal("expected error when no token available")
	}
	if !strings.Contains(err.Error(), "aw login") {
		t.Fatalf("expected guidance to run aw login, got: %v", err)
	}
}
