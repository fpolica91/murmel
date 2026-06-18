package main

import (
	"context"
	"crypto/ed25519"
	"fmt"
	"os"
	"os/exec"
	"strings"

	"github.com/awebai/aw/awconfig"
	"github.com/awebai/aw/awid"
)

// errMissingIdentityRegistryContext is returned when a global identity cannot
// safely resolve an AWID registry (no registry_url, no address domain).
var errMissingIdentityRegistryContext = errMissingRegistryContext()

func errMissingRegistryContext() error {
	return fmt.Errorf("missing identity registry context")
}

// currentIdentityRegistryURL resolves the AWID registry URL to use for the
// given identity when publishing E2EE encryption-key assertions.
func currentIdentityRegistryURL(ctx context.Context, identity *awconfig.ResolvedIdentity, registry *awid.RegistryClient) (string, error) {
	if identity == nil {
		return "", fmt.Errorf("missing identity context")
	}
	if registry == nil {
		return "", fmt.Errorf("missing registry client")
	}
	if strings.TrimSpace(os.Getenv("AWID_REGISTRY_URL")) != "" {
		return registry.DefaultRegistryURL, nil
	}
	if strings.TrimSpace(identity.RegistryURL) != "" {
		return strings.TrimSpace(identity.RegistryURL), nil
	}
	if strings.TrimSpace(identity.Domain) != "" {
		return registry.DiscoverRegistry(ctx, identity.Domain)
	}
	if strings.TrimSpace(identity.StableID) != "" {
		return "", fmt.Errorf("%w: global identity %s has no registry_url or address domain; cannot safely choose an AWID registry", errMissingIdentityRegistryContext, strings.TrimSpace(identity.StableID))
	}
	return registry.DefaultRegistryURL, nil
}

// newRegistryClientWithPreferredBaseURL builds an awid registry client,
// optionally preferring baseURL as a fallback registry URL.
func newRegistryClientWithPreferredBaseURL(baseURL string) (*awid.RegistryClient, error) {
	registry, err := newConfiguredRegistryClient(nil, "")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(baseURL) == "" {
		return registry, nil
	}
	if err := registry.SetFallbackRegistryURL(baseURL); err != nil {
		return nil, fmt.Errorf("invalid identity registry URL: %w", err)
	}
	return registry, nil
}

// discoverRepoOrigin returns the git origin URL for workingDir, or "".
func discoverRepoOrigin(workingDir string) string {
	cmd := exec.Command("git", "-C", workingDir, "remote", "get-url", "origin")
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

// canonicalizeGitOrigin strips the .git suffix and normalizes git URLs to
// domain/path form.
func canonicalizeGitOrigin(origin string) string {
	origin = strings.TrimSpace(origin)
	if origin == "" {
		return ""
	}
	origin = strings.TrimSuffix(origin, ".git")
	if strings.HasPrefix(origin, "git@") {
		origin = strings.TrimPrefix(origin, "git@")
		origin = strings.Replace(origin, ":", "/", 1)
	}
	for _, prefix := range []string{"https://", "http://"} {
		if strings.HasPrefix(origin, prefix) {
			origin = strings.TrimPrefix(origin, prefix)
		}
	}
	return origin
}

// formatConnect renders the human-readable output for a token-only init.
func formatConnect(v any) string {
	out := v.(tokenInitOutput)
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Status:      %s\n", out.Status))
	sb.WriteString(fmt.Sprintf("Team:        %s\n", out.TeamID))
	if strings.TrimSpace(out.Alias) != "" {
		sb.WriteString(fmt.Sprintf("Alias:       %s\n", out.Alias))
	}
	sb.WriteString(fmt.Sprintf("Aweb URL:    %s\n", out.AwebURL))
	return sb.String()
}

// This file holds identity helpers that survived the removal of the
// certificate/DID/namespace/team cluster. They are still used by the kept
// E2EE encryption-key command (id_encryption_key.go) and by doctor identity
// diagnostics (doctor_identity.go). They previously lived in id_format.go,
// id_registry.go, and id_registry_read_format.go.

// resolveIdentitySigningKey loads the local ed25519 signing key for a resolved
// self-custodial identity. The signing key authenticates E2EE messages only.
func resolveIdentitySigningKey(identity *awconfig.ResolvedIdentity) (ed25519.PrivateKey, error) {
	if identity == nil {
		return nil, fmt.Errorf("missing identity context")
	}
	if strings.TrimSpace(identity.SigningKeyPath) == "" {
		return nil, usageError("current identity has no local signing key")
	}
	priv, err := awid.LoadSigningKey(identity.SigningKeyPath)
	if err != nil {
		return nil, fmt.Errorf("failed to load signing key: %w", err)
	}
	return priv, nil
}

// resolveIdentityRegistryClient builds an awid registry client for publishing
// E2EE encryption-key assertions, preferring the identity's recorded registry
// URL.
func resolveIdentityRegistryClient(identity *awconfig.ResolvedIdentity) (*awid.RegistryClient, error) {
	baseURL := ""
	if identity != nil {
		baseURL = strings.TrimSpace(identity.RegistryURL)
	}
	registry, err := newRegistryClientWithPreferredBaseURL(baseURL)
	if err != nil {
		return nil, err
	}
	return registry, nil
}

// registryAddressDeliveryOrigin returns the delivery origin recorded on a
// registry address, or "" when none is set.
func registryAddressDeliveryOrigin(address *awid.RegistryAddress) string {
	if address == nil || address.Delivery == nil {
		return ""
	}
	return strings.TrimSpace(address.Delivery.Origin)
}

// formatIDEncryptionKey renders the human-readable output for the
// `murmel id encryption-key` command.
func formatIDEncryptionKey(v any) string {
	out := v.(idEncryptionKeyOutput)
	var sb strings.Builder
	sb.WriteString(fmt.Sprintf("Status:      %s\n", out.Status))
	if strings.TrimSpace(out.KeyID) != "" {
		sb.WriteString(fmt.Sprintf("Key ID:      %s\n", out.KeyID))
	}
	if strings.TrimSpace(out.PrivateKey) != "" {
		sb.WriteString(fmt.Sprintf("Private key: %s\n", out.PrivateKey))
	}
	if strings.TrimSpace(out.StatePath) != "" {
		sb.WriteString(fmt.Sprintf("State:       %s\n", out.StatePath))
	}
	if len(out.Published) > 0 {
		sb.WriteString("Published:\n")
		for _, target := range out.Published {
			sb.WriteString(fmt.Sprintf("- %s\n", target))
		}
	}
	if len(out.PublishSkipped) > 0 {
		sb.WriteString("Skipped:\n")
		for _, target := range out.PublishSkipped {
			sb.WriteString(fmt.Sprintf("- %s\n", target))
		}
	}
	if strings.TrimSpace(out.Warning) != "" {
		sb.WriteByte('\n')
		sb.WriteString(out.Warning)
		sb.WriteByte('\n')
	}
	return sb.String()
}
