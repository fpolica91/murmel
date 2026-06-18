package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/awebai/aw/awconfig"
	"github.com/awebai/aw/awid"
)

// mintGatewayJWTFromSession exchanges a Better Auth session token for a
// short-lived JWKS-verifiable JWT at tokenURL (GET with the session as a Bearer
// credential). It mirrors the CLI's mintJWTFromSession so the gateway's token
// refresh stays symmetric with `murmel login`. The session is preserved as the
// refresh credential.
func mintGatewayJWTFromSession(ctx context.Context, tokenURL, sessionToken string) (*awconfig.CachedToken, error) {
	tokenURL = strings.TrimSpace(tokenURL)
	if tokenURL == "" {
		return nil, fmt.Errorf("no token endpoint recorded")
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, tokenURL, nil)
	if err != nil {
		return nil, fmt.Errorf("build mint request: %w", err)
	}
	req.Header.Set("Authorization", "Bearer "+sessionToken)
	req.Header.Set("Accept", "application/json")

	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		detail, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("mint failed (%d): %s", resp.StatusCode, strings.TrimSpace(string(detail)))
	}

	var out struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, fmt.Errorf("decode mint response: %w", err)
	}
	jwt := strings.TrimSpace(out.Token)
	if jwt == "" {
		return nil, fmt.Errorf("token endpoint returned no token")
	}

	tok := &awconfig.CachedToken{
		AccessToken:  jwt,
		RefreshToken: sessionToken,
		TokenType:    "Bearer",
		TokenURL:     tokenURL,
	}
	if exp, ok := awconfig.JWTExpiryUnverified(jwt); ok {
		tok.ExpiresAt = exp
	}
	if sub, ok := awconfig.JWTSubjectUnverified(jwt); ok {
		tok.Subject = sub
	}
	return tok, nil
}

// Token-only (bearer / SimpleAuth JWT) auth for the A2A gateway.
//
// The token-only `murmel init` pivot writes a cert-less `.murmel/workspace.yaml` (a
// team membership with no cert_path and no .murmel/team-certs/), authenticating to
// aweb with `Authorization: Bearer <jwt>` + `X-AWEB-Team-Id: <team>` instead of
// a team certificate. workspaceMailClient hard-required a certificate, so the
// gateway could not run against such a workspace.
//
// This file adds the bearer path additively. The cert path in
// workspaceMailClient is untouched; the caller branches on whether the resolved
// team membership carries a cert_path. Token resolution mirrors the `murmel` CLI's
// canonical bearerTokenProvider: an explicit AW_TOKEN env var wins (CI/scripts,
// no cache, no refresh), otherwise the cached ~/.murmel/token (written by
// `murmel login`) is loaded and auto-refreshed.

// gatewayInjectedBearerToken returns an explicitly supplied bearer JWT from the
// AW_TOKEN environment variable. Like the CLI's --token/AW_TOKEN override, an
// injected token is for non-interactive use: it bypasses the ~/.murmel/token cache
// and is never refreshed (the caller owns its lifetime). The gateway has no
// interactive flag, so AW_TOKEN is the sole injection source. Returns "" when
// unset.
func gatewayInjectedBearerToken() string {
	return strings.TrimSpace(os.Getenv("AW_TOKEN"))
}

// gatewayHasInjectedBearerToken reports whether AW_TOKEN is present.
func gatewayHasInjectedBearerToken() bool {
	return gatewayInjectedBearerToken() != ""
}

// gatewaySessionRefresher re-mints a JWT from the cached session token (recorded
// as the refresh credential by `murmel login`) at the cached token endpoint. It
// mirrors the CLI's sessionRefresher so an expired cached token is refreshed
// rather than sent stale.
type gatewaySessionRefresher struct{}

func (gatewaySessionRefresher) Refresh(ctx context.Context, refreshToken string) (*awconfig.CachedToken, error) {
	cached, err := awconfig.LoadToken()
	if err != nil {
		return nil, err
	}
	return mintGatewayJWTFromSession(ctx, cached.TokenURL, refreshToken)
}

// gatewayBearerTokenProvider returns a valid SimpleAuth JWT for the gateway. An
// explicit AW_TOKEN override wins and is returned verbatim (no cache, no
// refresh). Otherwise it loads and auto-refreshes the cached ~/.murmel/token,
// returning an error wrapping os.ErrNotExist when no token is cached. Installed
// on the awid client via SetBearerProvider so every coordination request
// attaches the token.
func gatewayBearerTokenProvider(ctx context.Context) (string, error) {
	if t := gatewayInjectedBearerToken(); t != "" {
		return t, nil
	}
	return awconfig.LoadValidToken(ctx, gatewaySessionRefresher{})
}

// hasUsableBearerToken reports whether a token is resolvable right now (either
// AW_TOKEN or a cached ~/.murmel/token). It is used to fail the gateway build with a
// clear message before wiring a bearer client that would 401.
func hasUsableBearerToken() bool {
	if gatewayHasInjectedBearerToken() {
		return true
	}
	_, err := awconfig.LoadToken()
	return err == nil
}

// tokenWorkspaceMailClient builds the gateway's coordination client for a
// cert-less (token-only) workspace binding. It authenticates with
// `Authorization: Bearer <jwt>` + `X-AWEB-Team-Id: <team>` (attached per request
// by the awid client when a bearer provider + team id are set), and wires the
// workspace's local self-custodial signing key as the E2EE envelope-signing key
// so plaintext mail/chat the gateway sends are signed from its real did:key
// (token humans are addressless and sign envelopes from their did:key, which the
// server verifies via the published encryption-key binding).
//
// It is the bearer counterpart of workspaceMailClient and is only reached when
// the resolved team membership has no cert_path. The signature matches
// workspaceMailClient so the two are interchangeable at the call site.
func tokenWorkspaceMailClient(workspaceDir, teamIDOverride, registryURLOverride, gatewayIdentityOverride string) (*awid.Client, string, error) {
	workspace, teamState, root, err := awconfig.LoadWorkspaceAndTeamState(workspaceDir)
	if err != nil {
		return nil, "", fmt.Errorf("load workspace: %w", err)
	}
	teamID := strings.TrimSpace(teamIDOverride)
	if teamID == "" {
		teamID = strings.TrimSpace(teamState.ActiveTeam)
	}
	workspaceMembership := workspace.Membership(teamID)
	if workspaceMembership == nil {
		return nil, "", fmt.Errorf("team %q is not present in workspace.yaml", teamID)
	}

	if !hasUsableBearerToken() {
		return nil, "", fmt.Errorf("token-only workspace for team %q has no usable bearer token: set AW_TOKEN or run `murmel login`", teamID)
	}

	baseURL := ""
	if teamMembership := teamState.Membership(teamID); teamMembership != nil {
		baseURL = firstNonEmpty(teamMembership.AwebURL, workspace.AwebURL)
	} else {
		baseURL = strings.TrimSpace(workspace.AwebURL)
	}
	if baseURL == "" {
		return nil, "", fmt.Errorf("workspace is missing aweb_url")
	}

	client, err := awid.New(baseURL)
	if err != nil {
		return nil, "", err
	}
	client.SetTeamID(teamID)
	client.SetBearerProvider(gatewayBearerTokenProvider)

	// Wire the local self-custodial signing key as the E2EE envelope-signing
	// key. Bearer transport auth is the JWT (no DIDKey signature), but outgoing
	// plaintext/E2EE envelopes must still be signed from the gateway's real
	// did:key so recipients verify them instead of rendering "[unverified]".
	if signingKey, kerr := awid.LoadSigningKey(awconfig.WorktreeSigningKeyPath(root)); kerr == nil {
		did := awid.ComputeDIDKey(signingKey.Public().(ed25519.PublicKey))
		client.SetE2EESigningKey(signingKey, did)
	}

	address := firstNonEmpty(workspaceMembership.Alias)
	if address != "" {
		client.SetAddress(address)
	}
	client.SetRequireRecipientBindingForDirectAddresses(true)

	resolver := awid.NewRegistryResolver(client.HTTPClient(), nil)
	registryURL := registryURLOverride
	if registryURL == "" {
		if teamMembership := teamState.Membership(teamID); teamMembership != nil {
			registryURL = teamMembership.RegistryURL
		}
	}
	if strings.TrimSpace(registryURL) != "" {
		if err := resolver.SetFallbackRegistryURL(registryURL); err != nil {
			return nil, "", fmt.Errorf("registry_url: %w", err)
		}
	}
	client.SetResolver(resolver)

	gatewayIdentity := firstNonEmpty(gatewayIdentityOverride, workspaceMembership.Alias)
	return client, gatewayIdentity, nil
}
