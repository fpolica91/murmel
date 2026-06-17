package main

import (
	"context"
	"encoding/json"
	"net/http"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestAwWorkReadyFiltersClaimsHeldByOthers(t *testing.T) {
	t.Parallel()

	const selfID = "11111111-1111-1111-1111-111111111111"
	const otherID = "22222222-2222-2222-2222-222222222222"

	server := newLocalHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireCertificateAuthForTest(t, r)
		switch r.URL.Path {
		case "/v1/claims":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"claims": []map[string]any{
					{
						"bead_id":      "ISSUE-002",
						"workspace_id": otherID,
						"alias":        "bob",
						"human_name":   "Bob",
						"claimed_at":   "2026-03-10T10:00:00Z",
					},
				},
				"has_more": false,
			})
		case "/v1/issues":
			// `aw work ready` filters todo issues to unassigned ones.
			if got := r.URL.Query().Get("status"); got != "todo" {
				t.Fatalf("status=%q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"issues": []map[string]any{
					{"issue_id": "ISSUE-001", "title": "Unclaimed ready issue", "status": "todo"},
					{"issue_id": "ISSUE-002", "title": "Claimed elsewhere", "status": "todo"},
					{"issue_id": "ISSUE-003", "title": "Already assigned", "status": "todo", "assignee_type": "agent", "assignee_id": "carol"},
				},
			})
		case "/v1/agents/heartbeat":
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("path=%s", r.URL.Path)
		}
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tmp := t.TempDir()
	bin := filepath.Join(tmp, "aw")
	buildAwBinary(t, ctx, bin)
	writeWorkspaceBindingForTest(t, tmp, workspaceBinding(server.URL, "backend:demo", "alice", selfID))

	run := exec.CommandContext(ctx, bin, "work", "ready")
	run.Env = testCommandEnv(tmp)
	run.Dir = tmp
	out, err := run.CombinedOutput()
	if err != nil {
		t.Fatalf("run failed: %v\n%s", err, string(out))
	}
	text := string(out)
	if !strings.Contains(text, "ISSUE-001") {
		t.Fatalf("ready output missing unclaimed issue:\n%s", text)
	}
	if strings.Contains(text, "ISSUE-002") {
		t.Fatalf("ready output should filter claimed issue:\n%s", text)
	}
	if strings.Contains(text, "ISSUE-003") {
		t.Fatalf("ready output should filter assigned issue:\n%s", text)
	}
}

func TestAwWorkActiveListsInProgressIssues(t *testing.T) {
	t.Parallel()

	server := newLocalHTTPServer(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requireCertificateAuthForTest(t, r)
		switch r.URL.Path {
		case "/v1/issues":
			if got := r.URL.Query().Get("status"); got != "in_progress" {
				t.Fatalf("status=%q", got)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"issues": []map[string]any{
					{
						"issue_id":      "ISSUE-010",
						"title":         "Native issue",
						"status":        "in_progress",
						"assignee_type": "agent",
						"assignee_id":   "alice",
					},
					{
						"issue_id": "ISSUE-020",
						"title":    "Unowned issue",
						"status":   "in_progress",
					},
				},
			})
		case "/v1/agents/heartbeat":
			w.WriteHeader(http.StatusOK)
		default:
			t.Fatalf("path=%s", r.URL.Path)
		}
	}))

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()

	tmp := t.TempDir()
	bin := filepath.Join(tmp, "aw")
	buildAwBinary(t, ctx, bin)
	writeWorkspaceBindingForTest(t, tmp, workspaceBinding(server.URL, "backend:demo", "self", "agent-self"))

	run := exec.CommandContext(ctx, bin, "work", "active")
	run.Env = testCommandEnv(tmp)
	run.Dir = tmp
	out, err := run.CombinedOutput()
	if err != nil {
		t.Fatalf("run failed: %v\n%s", err, string(out))
	}
	text := string(out)
	for _, want := range []string{
		"Active work (2):",
		"ISSUE-010  [IN_PROGRESS]  Native issue  agent:alice",
		"ISSUE-020  [IN_PROGRESS]  Unowned issue  unassigned",
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("active output missing %q:\n%s", want, text)
		}
	}
}
