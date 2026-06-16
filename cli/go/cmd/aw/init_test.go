package main

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/awebai/aw/awconfig"
)

func TestResolveInitURLPrecedence(t *testing.T) {
	oldAwebURL := initAwebURL
	oldCompatURL := initURL
	t.Cleanup(func() {
		initAwebURL = oldAwebURL
		initURL = oldCompatURL
	})

	t.Setenv("AWEB_URL", "https://env-aweb.example")

	initAwebURL = "https://flag-aweb.example"
	initURL = ""

	awebURL, err := resolveInitAwebURL()
	if err != nil {
		t.Fatalf("resolveInitAwebURL: %v", err)
	}
	if awebURL != "https://flag-aweb.example" {
		t.Fatalf("awebURL=%q", awebURL)
	}
}

func TestResolveInitTeamIDFromFlagAndEnv(t *testing.T) {
	oldTeam := initTeam
	t.Cleanup(func() { initTeam = oldTeam })

	t.Run("flag wins", func(t *testing.T) {
		initTeam = "default:local"
		t.Setenv("AWEB_TEAM_ID", "other:team")
		got, err := resolveInitTeamID()
		if err != nil {
			t.Fatalf("resolveInitTeamID: %v", err)
		}
		if got != "default:local" {
			t.Fatalf("team=%q", got)
		}
	})

	t.Run("env fallback", func(t *testing.T) {
		initTeam = ""
		t.Setenv("AWEB_TEAM_ID", "env:team")
		got, err := resolveInitTeamID()
		if err != nil {
			t.Fatalf("resolveInitTeamID: %v", err)
		}
		if got != "env:team" {
			t.Fatalf("team=%q", got)
		}
	})

	t.Run("missing errors", func(t *testing.T) {
		initTeam = ""
		t.Setenv("AWEB_TEAM_ID", "")
		_, err := resolveInitTeamID()
		if err == nil {
			t.Fatal("expected error when no team provided")
		}
		if !strings.Contains(err.Error(), "team is required") {
			t.Fatalf("unexpected error: %v", err)
		}
	})
}

func TestRejectRemovedInitFlags(t *testing.T) {
	saved := []*string{&initUsername, &initDomain, &initInboundMode, &initAWIDRegistry, &initName}
	savedVals := make([]string, len(saved))
	for i, p := range saved {
		savedVals[i] = *p
	}
	savedBYOD, savedPersistent := initBYOD, initPersistent
	t.Cleanup(func() {
		for i, p := range saved {
			*p = savedVals[i]
		}
		initBYOD, initPersistent = savedBYOD, savedPersistent
	})

	reset := func() {
		initBYOD = false
		initPersistent = false
		initUsername = ""
		initDomain = ""
		initInboundMode = ""
		initAWIDRegistry = ""
		initName = ""
	}

	cases := []struct {
		name string
		set  func()
		want string
	}{
		{"byod", func() { initBYOD = true }, "--byod"},
		{"global", func() { initPersistent = true }, "--global"},
		{"username", func() { initUsername = "x" }, "--username"},
		{"domain", func() { initDomain = "x" }, "--domain"},
		{"inbound-mode", func() { initInboundMode = "open" }, "--inbound-mode"},
		{"awid-registry", func() { initAWIDRegistry = "x" }, "--awid-registry"},
		{"name", func() { initName = "x" }, "--name"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			reset()
			tc.set()
			err := rejectRemovedInitFlags()
			if err == nil {
				t.Fatalf("expected %s to be rejected", tc.want)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected error mentioning %s, got: %v", tc.want, err)
			}
		})
	}

	t.Run("no removed flags passes", func(t *testing.T) {
		reset()
		if err := rejectRemovedInitFlags(); err != nil {
			t.Fatalf("expected nil, got %v", err)
		}
	})
}

// TestRunInitTokenFlowWritesCertlessWorkspace exercises the default token-only
// runInit path end-to-end with an injected AW_TOKEN.
func TestRunInitTokenFlowWritesCertlessWorkspace(t *testing.T) {
	// Cannot use t.Parallel() — needs cwd and globals.
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AW_TOKEN", "test.jwt.token")

	oldAwebURL := initAwebURL
	oldURL := initURL
	oldTeam := initTeam
	oldRole := initRole
	oldInjectDocs := initInjectDocs
	oldDoNotTouch := initDoNotTouchAgentsMD
	oldWriteContext := initWriteContext
	oldJSON := jsonFlag
	oldTokenFlag := tokenFlag
	t.Cleanup(func() {
		initAwebURL = oldAwebURL
		initURL = oldURL
		initTeam = oldTeam
		initRole = oldRole
		initInjectDocs = oldInjectDocs
		initDoNotTouchAgentsMD = oldDoNotTouch
		initWriteContext = oldWriteContext
		jsonFlag = oldJSON
		tokenFlag = oldTokenFlag
	})

	tmp := t.TempDir()
	origWd, _ := os.Getwd()
	if err := os.Chdir(tmp); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(origWd)

	initAwebURL = "http://localhost:8088"
	initURL = ""
	initTeam = "default:local"
	initRole = "developer"
	initInjectDocs = false
	initDoNotTouchAgentsMD = true
	initWriteContext = true
	jsonFlag = true
	tokenFlag = ""

	cmd := &cobraCommandClone{Command: *initCmd}
	cmd.Command.SetContext(context.Background())
	cmd.Command.SetIn(strings.NewReader(""))
	cmd.Command.SetOut(io.Discard)
	cmd.Command.SetErr(io.Discard)

	if err := runInit(&cmd.Command, nil); err != nil {
		t.Fatalf("runInit: %v", err)
	}

	ws, err := awconfig.LoadWorktreeWorkspaceFrom(filepath.Join(tmp, ".aw", "workspace.yaml"))
	if err != nil {
		t.Fatalf("load workspace: %v", err)
	}
	if ws.AwebURL != "http://localhost:8088" {
		t.Fatalf("aweb_url=%q", ws.AwebURL)
	}
	if len(ws.Memberships) != 1 {
		t.Fatalf("expected 1 membership, got %d", len(ws.Memberships))
	}
	if ws.Memberships[0].TeamID != "default:local" {
		t.Fatalf("team=%q", ws.Memberships[0].TeamID)
	}
	if ws.Memberships[0].CertPath != "" {
		t.Fatalf("expected cert-less membership, got cert_path %q", ws.Memberships[0].CertPath)
	}

	// Local self-custody identity must exist for E2EE messaging.
	if _, err := os.Stat(filepath.Join(tmp, ".aw", "identity.yaml")); err != nil {
		t.Fatalf("expected .aw/identity.yaml: %v", err)
	}
	if _, err := os.Stat(filepath.Join(tmp, ".aw", "signing.key")); err != nil {
		t.Fatalf("expected .aw/signing.key: %v", err)
	}
}

func TestRunInitRejectsExistingWorkspace(t *testing.T) {
	home := t.TempDir()
	t.Setenv("HOME", home)
	t.Setenv("AW_TOKEN", "test.jwt.token")

	oldAwebURL := initAwebURL
	oldTeam := initTeam
	oldTokenFlag := tokenFlag
	t.Cleanup(func() {
		initAwebURL = oldAwebURL
		initTeam = oldTeam
		tokenFlag = oldTokenFlag
	})

	tmp := t.TempDir()
	origWd, _ := os.Getwd()
	if err := os.Chdir(tmp); err != nil {
		t.Fatal(err)
	}
	defer os.Chdir(origWd)

	initAwebURL = "http://localhost:8088"
	initTeam = "default:local"
	tokenFlag = ""

	// Pre-write a workspace binding.
	wsPath := filepath.Join(tmp, ".aw", "workspace.yaml")
	if err := os.MkdirAll(filepath.Dir(wsPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := awconfig.SaveWorktreeWorkspaceTo(wsPath, &awconfig.WorktreeWorkspace{
		AwebURL: "http://localhost:8088",
		Memberships: []awconfig.WorktreeMembership{{
			TeamID: "default:local",
		}},
	}); err != nil {
		t.Fatalf("seed workspace: %v", err)
	}

	cmd := &cobraCommandClone{Command: *initCmd}
	cmd.Command.SetContext(context.Background())
	cmd.Command.SetIn(strings.NewReader(""))
	cmd.Command.SetOut(io.Discard)
	cmd.Command.SetErr(io.Discard)

	err := runInit(&cmd.Command, nil)
	if err == nil {
		t.Fatal("expected error for already-initialized directory")
	}
	if !strings.Contains(err.Error(), "already has a workspace") {
		t.Fatalf("unexpected error: %v", err)
	}
}
