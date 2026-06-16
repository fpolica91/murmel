package main

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/awebai/aw/awconfig"
	"github.com/awebai/aw/awid"
)

// tokenInitOptions configures the token-only workspace writer.
type tokenInitOptions struct {
	// WorkingDir is the directory whose `.aw/` is initialized.
	WorkingDir string
	// AwebURL is the coordination server base URL recorded in the binding.
	AwebURL string
	// TeamID scopes the bearer to a team via the X-AWEB-Team-Id header.
	TeamID string
	// Alias / RoleName are optional coordination metadata.
	Alias    string
	RoleName string
	// HumanName / AgentType are optional descriptive workspace metadata.
	HumanName string
	AgentType string
	// WriteContext ensures `.aw/context` exists when true.
	WriteContext bool
}

// tokenInitOutput is the JSON-friendly result of a token-only init.
type tokenInitOutput struct {
	Status        string `json:"status"`
	TeamID        string `json:"team_id"`
	Alias         string `json:"alias,omitempty"`
	AwebURL       string `json:"aweb_url"`
	DID           string `json:"did,omitempty"`
	IdentityScope string `json:"identity_scope,omitempty"`
}

// initTokenWorkspace writes a cert-less, token-authenticated workspace binding.
//
// It requires a usable bearer token (cached ~/.aw/token from `aw login`, or an
// injected --token/AW_TOKEN), then:
//   - writes a cert-less `.aw/workspace.yaml` (aweb_url + one team membership
//     with no cert_path) via awconfig.SaveWorktreeWorkspaceTo,
//   - creates a local self-custodial signing key + minimal `.aw/identity.yaml`
//     (custody=self, DID derived from the key) so the E2EE messaging key path
//     (setupOrRotateIdentityEncryptionKeyForDir) works — this key is for
//     message encryption only and is NEVER sent for auth,
//   - ensures `.aw/context` when requested.
//
// Auth is by bearer token; the team certificate cluster is not involved.
func initTokenWorkspace(ctx context.Context, opts tokenInitOptions) (tokenInitOutput, error) {
	workingDir := strings.TrimSpace(opts.WorkingDir)
	if workingDir == "" {
		wd, err := os.Getwd()
		if err != nil {
			return tokenInitOutput{}, err
		}
		workingDir = wd
	}
	awebURL := strings.TrimSpace(opts.AwebURL)
	if awebURL == "" {
		return tokenInitOutput{}, usageError("token-only init requires an aweb server URL; pass --aweb-url")
	}
	teamID := strings.TrimSpace(opts.TeamID)
	if teamID == "" {
		return tokenInitOutput{}, usageError("token-only init requires a team; pass --team")
	}

	// Require a usable token before mutating anything on disk.
	if _, err := bearerTokenProvider(ctx); err != nil {
		if os.IsNotExist(err) {
			return tokenInitOutput{}, usageError("no token available: run `aw login` or pass --token / set AW_TOKEN")
		}
		return tokenInitOutput{}, err
	}

	if err := ensureAwebRuntimeGitIgnored(workingDir); err != nil {
		return tokenInitOutput{}, err
	}

	// Create the local self-custodial signing key + identity (for E2EE only).
	did, err := ensureLocalSelfIdentity(workingDir)
	if err != nil {
		return tokenInitOutput{}, err
	}

	// Write the cert-less workspace binding.
	workspacePath := filepath.Join(workingDir, awconfig.DefaultWorktreeWorkspaceRelativePath())
	workspaceState, existingErr := awconfig.LoadWorktreeWorkspaceFrom(workspacePath)
	if existingErr != nil && !os.IsNotExist(existingErr) {
		return tokenInitOutput{}, existingErr
	}
	if workspaceState == nil {
		workspaceState = &awconfig.WorktreeWorkspace{}
	}
	workspaceState.AwebURL = awebURL
	upsertTokenWorkspaceMembership(workspaceState, awconfig.WorktreeMembership{
		TeamID:   teamID,
		Alias:    strings.TrimSpace(opts.Alias),
		RoleName: strings.TrimSpace(opts.RoleName),
		JoinedAt: time.Now().UTC().Format(time.RFC3339),
	})
	if name := strings.TrimSpace(opts.HumanName); name != "" {
		workspaceState.HumanName = name
	}
	if agent := strings.TrimSpace(opts.AgentType); agent != "" {
		workspaceState.AgentType = agent
	}
	workspaceState.CanonicalOrigin = canonicalizeGitOrigin(discoverRepoOrigin(workingDir))
	if host, err := os.Hostname(); err == nil {
		workspaceState.Hostname = strings.TrimSpace(host)
	}
	workspaceState.WorkspacePath = workingDir
	workspaceState.UpdatedAt = time.Now().UTC().Format(time.RFC3339)
	if err := awconfig.SaveWorktreeWorkspaceTo(workspacePath, workspaceState); err != nil {
		return tokenInitOutput{}, err
	}

	if opts.WriteContext {
		if err := ensureWorktreeContextAt(workingDir); err != nil {
			return tokenInitOutput{}, err
		}
	}

	// Best-effort: create + publish the local E2EE encryption key. Failures to
	// publish are non-fatal (offline / no server) — the local key still exists.
	if err := ensureLocalIdentityEncryptionKeyForDir(workingDir); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not set up E2E encryption key: %v\n", err)
	} else if _, err := setupOrRotateIdentityEncryptionKeyForDir(ctx, workingDir, false); err != nil {
		fmt.Fprintf(os.Stderr, "Warning: could not publish E2E encryption key automatically: %v\n", err)
	}

	return tokenInitOutput{
		Status:        "connected",
		TeamID:        teamID,
		Alias:         strings.TrimSpace(opts.Alias),
		AwebURL:       awebURL,
		DID:           did,
		IdentityScope: awid.IdentityModeLocal,
	}, nil
}

// ensureLocalSelfIdentity guarantees a local self-custodial signing key and a
// minimal `.aw/identity.yaml` exist for workingDir, returning the did:key. If a
// valid identity is already present it is reused; otherwise a fresh ed25519
// signing key is generated and persisted. This key authenticates E2EE messages
// only — it is never used for server auth (that is the bearer token).
func ensureLocalSelfIdentity(workingDir string) (string, error) {
	signingKeyPath := awconfig.WorktreeSigningKeyPath(workingDir)
	identityPath := filepath.Join(workingDir, awconfig.DefaultWorktreeIdentityRelativePath())

	// Reuse an existing valid self-custody identity when present.
	if existing, err := awconfig.LoadWorktreeIdentityFrom(identityPath); err == nil {
		if key, kerr := awid.LoadSigningKey(signingKeyPath); kerr == nil {
			did := awid.ComputeDIDKey(key.Public().(ed25519.PublicKey))
			if strings.TrimSpace(existing.DID) == did && strings.TrimSpace(existing.Custody) == awid.CustodySelf {
				return did, nil
			}
		}
	}

	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return "", fmt.Errorf("generate signing key: %w", err)
	}
	if err := awid.SaveSigningKey(signingKeyPath, priv); err != nil {
		return "", fmt.Errorf("save signing key: %w", err)
	}
	did := awid.ComputeDIDKey(pub)
	if err := awconfig.SaveWorktreeIdentityTo(identityPath, &awconfig.WorktreeIdentity{
		DID:       did,
		Custody:   awid.CustodySelf,
		Lifetime:  awid.LifetimeEphemeral,
		CreatedAt: time.Now().UTC().Format(time.RFC3339),
	}); err != nil {
		return "", fmt.Errorf("save identity: %w", err)
	}
	return did, nil
}

// upsertTokenWorkspaceMembership inserts or replaces the membership for the
// given team_id (case-insensitive) on a cert-less binding, preserving any
// existing joined_at.
func upsertTokenWorkspaceMembership(ws *awconfig.WorktreeWorkspace, m awconfig.WorktreeMembership) {
	if ws == nil {
		return
	}
	key := strings.ToLower(strings.TrimSpace(m.TeamID))
	for i := range ws.Memberships {
		if strings.ToLower(strings.TrimSpace(ws.Memberships[i].TeamID)) == key {
			if strings.TrimSpace(m.JoinedAt) == "" {
				m.JoinedAt = ws.Memberships[i].JoinedAt
			}
			// Preserve any previously stored cert_path so a legacy cert-based
			// binding is not silently downgraded.
			if strings.TrimSpace(m.CertPath) == "" {
				m.CertPath = ws.Memberships[i].CertPath
			}
			ws.Memberships[i] = m
			return
		}
	}
	ws.Memberships = append(ws.Memberships, m)
}
