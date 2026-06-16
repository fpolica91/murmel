package main

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"github.com/awebai/aw/awconfig"
	"github.com/awebai/aw/awid"
)

// testDidLogEntry builds a signed did-log evidence entry for tests. It
// previously lived in the removed id_commands_test.go and is still used by
// doctor_identity_test.go.
func testDidLogEntry(t *testing.T, didAW string, signingKey ed25519.PrivateKey, newDID, operation string, previousDID, prevHash *string, seq int, stateHash string) awid.DidKeyEvidence {
	t.Helper()
	entry := awid.DidKeyEvidence{
		Seq:            seq,
		Operation:      operation,
		PreviousDIDKey: previousDID,
		NewDIDKey:      newDID,
		PrevEntryHash:  prevHash,
		StateHash:      stateHash,
		AuthorizedBy:   awid.ComputeDIDKey(signingKey.Public().(ed25519.PublicKey)),
		Timestamp:      "2026-04-04T00:00:00Z",
	}
	payload := awid.CanonicalDidLogPayload(didAW, &entry)
	sum := sha256.Sum256([]byte(payload))
	entry.EntryHash = hex.EncodeToString(sum[:])
	entry.Signature = base64.RawStdEncoding.EncodeToString(ed25519.Sign(signingKey, []byte(payload)))
	return entry
}

// didLogJSON renders a did-log evidence entry as the JSON map the registry
// returns. It previously lived in the removed id_commands_test.go and is still
// used by doctor_identity_test.go.
func didLogJSON(entry awid.DidKeyEvidence) map[string]any {
	return map[string]any{
		"seq":              entry.Seq,
		"operation":        entry.Operation,
		"previous_did_key": entry.PreviousDIDKey,
		"new_did_key":      entry.NewDIDKey,
		"prev_entry_hash":  entry.PrevEntryHash,
		"entry_hash":       entry.EntryHash,
		"state_hash":       entry.StateHash,
		"authorized_by":    entry.AuthorizedBy,
		"signature":        entry.Signature,
		"timestamp":        entry.Timestamp,
	}
}

// idCreateCommandEnv returns the environment used by identity-command tests
// that need an isolated HOME. It previously lived in the removed
// id_commands_test.go.
func idCreateCommandEnv(home string) []string {
	return append(os.Environ(), "HOME="+home, "AW_CONFIG_PATH=")
}

// writeStandaloneSelfCustodyIdentity seeds a self-custodial global identity
// (signing key + .aw/identity.yaml) for tests. It previously lived in the
// removed id_commands_test.go and is still used by claim_human_test.go.
func writeStandaloneSelfCustodyIdentity(t *testing.T, workingDir, address, did, stableID, registryURL string, signingKey ed25519.PrivateKey) {
	t.Helper()
	pub := signingKey.Public().(ed25519.PublicKey)
	signingKeyPath := awconfig.WorktreeSigningKeyPath(workingDir)
	if err := awid.SaveKeypairAt(signingKeyPath, awid.PublicKeyPath(signingKeyPath), pub, signingKey); err != nil {
		t.Fatal(err)
	}
	if err := awconfig.SaveWorktreeIdentityTo(filepath.Join(workingDir, ".aw", "identity.yaml"), &awconfig.WorktreeIdentity{
		DID:            did,
		StableID:       stableID,
		Address:        address,
		Custody:        awid.CustodySelf,
		Lifetime:       awid.LifetimePersistent,
		RegistryURL:    registryURL,
		RegistryStatus: "registered",
		CreatedAt:      "2026-04-05T00:00:00Z",
	}); err != nil {
		t.Fatal(err)
	}
}
