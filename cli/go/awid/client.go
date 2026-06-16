package awid

import (
	"bytes"
	"context"
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// signedFields holds the identity fields attached to outgoing messages
// when the client has a signing key.
type signedFields struct {
	FromDID       string
	ToDID         string
	ToStableID    string
	FromStableID  string
	Signature     string
	SigningKeyID  string
	Timestamp     string
	MessageID     string
	SignedPayload string
}

// RecipientResolutionError means a signed message could not bind its direct
// recipient to a current did:key, so sending must stop before posting.
type RecipientResolutionError struct {
	Target      string
	MessageType string
	Err         error
}

func (e *RecipientResolutionError) Error() string {
	if e == nil {
		return ""
	}
	msgType := strings.TrimSpace(e.MessageType)
	if msgType == "" {
		msgType = "message"
	}
	if e.Err == nil {
		return fmt.Sprintf("resolve recipient %q for signed %s", e.Target, msgType)
	}
	return fmt.Sprintf("resolve recipient %q for signed %s: %v", e.Target, msgType, e.Err)
}

func (e *RecipientResolutionError) Unwrap() error {
	if e == nil {
		return nil
	}
	return e.Err
}

func isRegistryAddressNotFound(err error) bool {
	if code, ok := HTTPStatusCode(err); ok && code == http.StatusNotFound {
		body, _ := HTTPErrorBody(err)
		return strings.Contains(body, "Address not found")
	}
	return false
}

// signEnvelope signs a MessageEnvelope and returns the fields to embed
// in the request. When the client has no signing key (legacy/custodial),
// returns a zero signedFields. Callers stamp the returned fields onto
// the request struct before posting.
func (c *Client) signEnvelope(ctx context.Context, env *MessageEnvelope) (signedFields, error) {
	signingKey := c.envelopeSigningKey()
	signingDID := c.envelopeSigningDID()
	if signingKey == nil || signingDID == "" {
		return signedFields{}, nil
	}
	if strings.TrimSpace(env.From) == "" {
		env.From = c.address
	}
	env.FromDID = signingDID
	env.FromStableID = c.stableID
	env.Timestamp = time.Now().UTC().Format(time.RFC3339)
	msgID, err := GenerateUUID4()
	if err != nil {
		return signedFields{}, err
	}
	env.MessageID = msgID

	// Stable did:aw targets belong in to_stable_id; to_did is reserved for the
	// recipient's current did:key binding.
	if strings.HasPrefix(strings.TrimSpace(env.ToDID), "did:aw:") && !strings.Contains(strings.TrimSpace(env.ToDID), ",") {
		env.ToStableID = strings.TrimSpace(env.ToDID)
		env.ToDID = ""
	}
	if strings.TrimSpace(env.ToStableID) == "" && strings.HasPrefix(strings.TrimSpace(env.To), "did:aw:") && !strings.Contains(strings.TrimSpace(env.To), ",") {
		env.ToStableID = strings.TrimSpace(env.To)
	}

	// Resolve recipient DID for recipient binding when we have a stable
	// identity target or an explicit routable address. Bare aliases are
	// team-scoped selectors; the server resolves them under the authenticated
	// team certificate.
	bindingTarget := ""
	if env.ToDID == "" {
		bindingTarget = strings.TrimSpace(env.ToStableID)
		if bindingTarget == "" && env.Type == "mail" && isRoutableAddressTarget(env.To) {
			bindingTarget = c.canonicalTrustAddress(env.To)
		} else if bindingTarget == "" && env.Type == "chat" && !strings.Contains(env.To, ",") && isRoutableAddressTarget(env.To) {
			bindingTarget = c.canonicalTrustAddress(env.To)
		}
	}
	globalStableTarget := strings.HasPrefix(strings.TrimSpace(env.ToStableID), "did:aw:")
	storedRouteGlobalTarget := globalStableTarget && env.AllowStoredRouteGlobalBinding
	bindingRequired := env.RequireRecipientBinding || (globalStableTarget && !env.AllowStoredRouteGlobalBinding)
	if c.resolver != nil && env.ToDID == "" && bindingTarget != "" && !storedRouteGlobalTarget {
		identity, err := c.resolver.Resolve(ctx, bindingTarget)
		if err != nil {
			if bindingRequired {
				return signedFields{}, &RecipientResolutionError{Target: bindingTarget, MessageType: env.Type, Err: err}
			}
			identity = nil
		}
		if identity != nil {
			if strings.TrimSpace(identity.DID) == "" {
				return signedFields{}, &RecipientResolutionError{Target: bindingTarget, MessageType: env.Type, Err: errors.New("missing current did:key")}
			}
			env.ToDID = strings.TrimSpace(identity.DID)
			if strings.TrimSpace(env.ToStableID) == "" && strings.TrimSpace(identity.StableID) != "" {
				env.ToStableID = strings.TrimSpace(identity.StableID)
			}
		}
	}
	if bindingRequired && env.ToDID == "" && bindingTarget != "" {
		return signedFields{}, &RecipientResolutionError{Target: bindingTarget, MessageType: env.Type, Err: errors.New("missing current did:key")}
	}

	sig, err := SignMessage(signingKey, env)
	if err != nil {
		return signedFields{}, fmt.Errorf("sign message: %w", err)
	}
	return signedFields{
		FromDID:       signingDID,
		ToDID:         env.ToDID,
		ToStableID:    env.ToStableID,
		FromStableID:  c.stableID,
		Signature:     sig,
		SigningKeyID:  signingDID,
		Timestamp:     env.Timestamp,
		MessageID:     env.MessageID,
		SignedPayload: CanonicalJSON(env),
	}, nil
}

func isRoutableAddressTarget(target string) bool {
	target = strings.TrimSpace(target)
	return strings.Contains(target, "/") || strings.Contains(target, "~")
}

const (
	// DefaultTimeout is the default HTTP timeout used by the client.
	// 30s leaves headroom for venue WiFi or mobile links where large request
	// bodies plus TLS setup and header wait can exceed shorter ceilings against
	// a healthy server. Override per-process with AWEB_HTTP_TIMEOUT.
	DefaultTimeout = 30 * time.Second

	MaxResponseSize = 10 * 1024 * 1024
)

// agentMeta holds cached metadata about a resolved agent.
type agentMeta struct {
	Lifetime string // "persistent" or "ephemeral"
	Custody  string // "self" or "custodial"
	Resolved bool
}

// Client is an aweb HTTP client.
//
// It is designed to be easy to extract into a standalone repo and to be used by:
// - the `aw` CLI
// - higher-level coordination products built on the same transport
type Client struct {
	baseURL    string
	httpClient *http.Client
	sseClient  *http.Client       // No response timeout; SSE connections are long-lived.
	signingKey ed25519.PrivateKey // nil for legacy/custodial; ALSO selects DIDKey transport auth
	did        string             // empty for legacy/custodial
	// e2eeSigningKey / e2eeDID decouple the E2EE envelope-signing key from the
	// transport-auth key. Bearer (SimpleAuth/JWT) clients authenticate by token
	// — they must NOT set c.signingKey (that would flip the auth selector to the
	// DIDKey branch and fail transport auth). Instead they wire their local
	// self-custodial signing key + DID here so the E2EE prepare/encrypt/decrypt
	// paths can sign and address envelopes while transport auth stays on the JWT.
	// Certificate/identity clients leave these nil and the E2EE paths fall back
	// to signingKey/did. Set via SetE2EESigningKey.
	e2eeSigningKey          ed25519.PrivateKey
	e2eeDID                 string
	teamCertHeader          string // base64-encoded team certificate for X-AWID-Team-Certificate
	teamID                  string // team identifier from certificate, used in auth signature
	certAlias               string // certificate alias, used for signed payloads in cert-auth mode
	address                 string // namespace/alias, used in signed envelopes
	e2eeSenderAddress       string // explicit address for E2EE envelopes; empty for addressless local/team identities
	e2eeSenderAddressSet    bool
	stableID                string // did:aw:..., set on outgoing signed envelopes as from_stable_id
	e2eeEncryptionKey       *EncryptionKeyAssertion
	e2eePrivateKey          *ecdh.PrivateKey
	requireRecipientBinding bool
	resolver                IdentityResolver // optional; resolves recipient DID for to_did binding
	pinStore                *PinStore        // optional; TOFU pin store for sender identity verification
	pinStorePath            string           // disk path for persisting pin store
	metaCache               sync.Map         // address → *agentMeta; cached resolver results
	rosterKeyCache          sync.Map         // trustAddress|alias → string; cached server-published active did:key
	latestClientVersion     atomic.Value     // last seen X-Latest-Client-Version header (string)
	// bearerProvider, when set and no certificate/identity key is present,
	// supplies a SimpleAuth (Better Auth JWT) bearer token per request. It is
	// expected to refresh the token as needed. Injected by the command layer so
	// this transport package stays independent of the token cache.
	bearerProvider func(context.Context) (string, error)
}

// SetBearerProvider installs a per-request bearer-token provider used when the
// client has no certificate/identity signing key. The provider should return a
// fresh (auto-refreshed) token; returning an empty string or error leaves the
// request unauthenticated (the caller may then fall back / surface a 401).
func (c *Client) SetBearerProvider(provider func(context.Context) (string, error)) {
	c.bearerProvider = provider
}

// New creates a new client.
func New(baseURL string) (*Client, error) {
	if _, err := url.Parse(baseURL); err != nil {
		return nil, err
	}
	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout:   APITimeout(),
			Transport: NewAPITransport(),
		},
		// No Timeout: SSE streams are long-lived. The transport still
		// bounds dial/TLS/header waits.
		sseClient: &http.Client{Transport: NewSSETransport()},
	}, nil
}

// NewWithIdentity creates an authenticated client with signing capability.
func NewWithIdentity(baseURL string, signingKey ed25519.PrivateKey, did string) (*Client, error) {
	if signingKey == nil {
		return nil, fmt.Errorf("signingKey must not be nil")
	}
	if did == "" {
		return nil, fmt.Errorf("did must not be empty")
	}
	expected := ComputeDIDKey(signingKey.Public().(ed25519.PublicKey))
	if did != expected {
		return nil, fmt.Errorf("did does not match signingKey")
	}
	c, err := New(baseURL)
	if err != nil {
		return nil, err
	}
	c.signingKey = signingKey
	c.did = did
	return c, nil
}

// NewWithCertificate creates an authenticated client that uses DIDKey signatures
// and a team certificate instead of API key authentication.
func NewWithCertificate(baseURL string, signingKey ed25519.PrivateKey, cert *TeamCertificate) (*Client, error) {
	if signingKey == nil {
		return nil, fmt.Errorf("signingKey must not be nil")
	}
	if cert == nil {
		return nil, fmt.Errorf("certificate must not be nil")
	}
	did := ComputeDIDKey(signingKey.Public().(ed25519.PublicKey))
	if did != cert.MemberDIDKey {
		return nil, fmt.Errorf("signing key did:key %s does not match certificate member_did_key %s", did, cert.MemberDIDKey)
	}
	certHeader, err := EncodeTeamCertificateHeader(cert)
	if err != nil {
		return nil, fmt.Errorf("encode team certificate: %w", err)
	}
	c, err := New(baseURL)
	if err != nil {
		return nil, err
	}
	c.signingKey = signingKey
	c.did = did
	c.teamCertHeader = certHeader
	c.teamID = cert.Team
	c.certAlias = strings.TrimSpace(cert.Alias)
	return c, nil
}

func (c *Client) TeamID() string {
	if c == nil {
		return ""
	}
	return strings.TrimSpace(c.teamID)
}

// SetHTTPClient replaces the client's HTTP client used for normal API calls.
// A nil client is ignored.
func (c *Client) SetHTTPClient(httpClient *http.Client) {
	if httpClient == nil {
		return
	}
	c.httpClient = httpClient
}

// SetSSEClient replaces the client's HTTP client used for SSE requests.
// A nil client is ignored.
func (c *Client) SetSSEClient(httpClient *http.Client) {
	if httpClient == nil {
		return
	}
	c.sseClient = httpClient
}

// HTTPClient returns the HTTP client used for standard JSON API calls.
func (c *Client) HTTPClient() *http.Client { return c.httpClient }

// SSEClient returns the HTTP client used for SSE requests.
func (c *Client) SSEClient() *http.Client { return c.sseClient }

// SigningKey returns the client's signing key, or nil for legacy/custodial clients.
func (c *Client) SigningKey() ed25519.PrivateKey { return c.signingKey }

// DID returns the client's DID, or empty for legacy/custodial clients.
func (c *Client) DID() string { return c.did }

// Address returns the client's address, if configured.
func (c *Client) Address() string { return c.address }

// SetAddress sets the client's agent address (namespace/alias) for use in
// signed message envelopes.
func (c *Client) SetAddress(address string) { c.address = address }

// SetTeamID sets the team identifier. For the bearer (SimpleAuth) path it is
// sent as the X-AWEB-Team-Id header so the server scopes the request to that
// team; the certificate path sets it from the certificate instead.
func (c *Client) SetTeamID(teamID string) { c.teamID = strings.TrimSpace(teamID) }

// SetE2EESenderAddress sets the address to place in E2EE sender metadata.
// Use an explicit address from identity/certificate state, not a display
// fallback derived from domain + alias.
func (c *Client) SetE2EESenderAddress(address string) {
	c.e2eeSenderAddress = strings.TrimSpace(address)
	c.e2eeSenderAddressSet = true
}

func (c *Client) e2eeAddress() string {
	if c.e2eeSenderAddressSet {
		return strings.TrimSpace(c.e2eeSenderAddress)
	}
	return strings.TrimSpace(c.address)
}

func (c *Client) addressAlias() string {
	parts := strings.SplitN(c.address, "/", 2)
	if len(parts) == 2 && parts[1] != "" {
		return parts[1]
	}
	return ""
}

// isBearerEnvelopeSigner reports whether this client signs envelopes with a
// bearer self-custodial key (transport auth is a JWT, not a DIDKey signature).
// Token humans are addressless local identities: their server-side address is a
// display/routing hint they cannot present as a signed-from authority, so they
// must sign envelopes from their real did:key, which the server accepts via the
// published encryption-key binding.
func (c *Client) isBearerEnvelopeSigner() bool {
	return c.signingKey == nil && c.e2eeSigningKey != nil
}

func (c *Client) signedPayloadFrom(identityTarget, preferAlias bool) string {
	from := strings.TrimSpace(c.address)
	if !c.canSignEnvelopes() {
		return from
	}
	signingDID := c.envelopeSigningDID()
	// Bearer self-custodial signers (token humans) have no routable signed-from
	// address authority; sign from the real did:key the server can verify.
	if c.isBearerEnvelopeSigner() && c.addressAlias() == "" {
		return signingDID
	}
	if identityTarget {
		if from == "" {
			return signingDID
		}
		return from
	}
	if preferAlias {
		if c.teamCertHeader != "" {
			if alias := c.certAlias; alias != "" {
				return alias
			}
		}
		if alias := c.addressAlias(); alias != "" {
			return alias
		}
	}
	if from == "" {
		return signingDID
	}
	return from
}

// SetStableID sets the client's stable identifier (did:aw:...) for use
// as from_stable_id in outgoing signed envelopes.
func (c *Client) SetStableID(id string) {
	c.stableID = id
	if strings.TrimSpace(id) != "" {
		c.requireRecipientBinding = true
	}
}

// StableID returns the client's stable identifier, if configured.
func (c *Client) StableID() string { return c.stableID }

// SetRequireRecipientBindingForDirectAddresses controls whether signed direct
// address sends must bind the recipient address to a current did:key before
// posting. Persistent identity clients should enable this so private or hidden
// registry addresses fail closed instead of falling through to local routing.
func (c *Client) SetRequireRecipientBindingForDirectAddresses(required bool) {
	c.requireRecipientBinding = required
}

// SetResolver sets the identity resolver used to resolve recipient DIDs
// for to_did binding in signed envelopes.
func (c *Client) SetResolver(r IdentityResolver) { c.resolver = r }

func (c *Client) SetE2EEKey(assertion *EncryptionKeyAssertion, privateKey *ecdh.PrivateKey) {
	if c == nil {
		return
	}
	c.e2eeEncryptionKey = assertion
	c.e2eePrivateKey = privateKey
}

// SetE2EESigningKey wires a dedicated Ed25519 key + did:key used ONLY to sign
// and address E2EE envelopes. It is the bearer (JWT) client's path to E2EE: the
// token human holds a local self-custodial signing key whose did:key is the
// recipient identity published to the server (custody=self). Transport auth is
// unaffected — c.signingKey stays nil so requests still authenticate by bearer
// token, not by a DIDKey signature the server has no participant for. A nil key
// or empty DID clears the override (E2EE paths then fall back to signingKey/did).
func (c *Client) SetE2EESigningKey(signingKey ed25519.PrivateKey, did string) {
	if c == nil {
		return
	}
	did = strings.TrimSpace(did)
	if signingKey == nil || did == "" {
		c.e2eeSigningKey = nil
		c.e2eeDID = ""
		return
	}
	c.e2eeSigningKey = signingKey
	c.e2eeDID = did
}

// e2eeEnvelopeSigningKey returns the key to sign E2EE envelopes with: the
// dedicated E2EE key when set (bearer clients), else the transport signing key
// (certificate/identity clients).
func (c *Client) e2eeEnvelopeSigningKey() ed25519.PrivateKey {
	if c.e2eeSigningKey != nil {
		return c.e2eeSigningKey
	}
	return c.signingKey
}

// e2eeEnvelopeDID returns the did:key to address E2EE envelopes from: the
// dedicated E2EE DID when set (bearer clients), else the transport DID.
func (c *Client) e2eeEnvelopeDID() string {
	if strings.TrimSpace(c.e2eeDID) != "" {
		return strings.TrimSpace(c.e2eeDID)
	}
	return strings.TrimSpace(c.did)
}

// hasE2EESigningMaterial reports whether the client can sign/address E2EE
// envelopes via either the dedicated E2EE key or the transport signing key.
func (c *Client) hasE2EESigningMaterial() bool {
	return c.e2eeEnvelopeSigningKey() != nil && c.e2eeEnvelopeDID() != ""
}

// envelopeSigningKey returns the key used to sign plaintext message envelopes
// (mail/chat). Certificate/identity clients sign with the transport key. Bearer
// (SimpleAuth/JWT) clients have no transport signing key (c.signingKey is nil so
// transport auth stays on the token), but they DO hold a local self-custodial
// signing key wired via SetE2EESigningKey. That key — whose did:key is the
// identity the human published to the server with custody=self — is the correct
// signer for plaintext envelopes too, so recipients can verify the signature
// against the sender's published key resolved from the roster. Without this,
// token-human plaintext chat/mail would be unsigned and render "[unverified]".
func (c *Client) envelopeSigningKey() ed25519.PrivateKey {
	if c.signingKey != nil {
		return c.signingKey
	}
	return c.e2eeSigningKey
}

// envelopeSigningDID returns the did:key to stamp as from_did / signing_key_id
// on plaintext envelopes — the real self-custodial did:key that matches
// envelopeSigningKey. This is NEVER the synthetic did:key:jwt-<sub> routing
// placeholder (that lives only in the server roster's did_key column and the
// token client never holds it).
func (c *Client) envelopeSigningDID() string {
	if c.signingKey != nil {
		return strings.TrimSpace(c.did)
	}
	return strings.TrimSpace(c.e2eeDID)
}

// canSignEnvelopes reports whether the client can produce a signed plaintext
// envelope (either via the transport signing key or the bearer self-custodial
// E2EE signing key).
func (c *Client) canSignEnvelopes() bool {
	return c.envelopeSigningKey() != nil && c.envelopeSigningDID() != ""
}

func (c *Client) ResolveIdentity(ctx context.Context, identifier string) (*ResolvedIdentity, error) {
	if c == nil || c.resolver == nil {
		return nil, errors.New("aweb: no identity resolver configured")
	}
	return c.resolver.Resolve(ctx, identifier)
}

// SetPinStore sets the TOFU pin store for sender identity verification.
// If path is non-empty, the store is persisted to disk after updates.
func (c *Client) SetPinStore(ps *PinStore, path string) {
	c.pinStore = ps
	c.pinStorePath = path
}

// LatestClientVersion returns the most recent X-Latest-Client-Version header
// value seen in any API response, or empty if no header was received.
func (c *Client) LatestClientVersion() string {
	if v, ok := c.latestClientVersion.Load().(string); ok {
		return v
	}
	return ""
}

func (c *Client) canonicalTrustAddress(address string) string {
	address = strings.TrimSpace(address)
	if address == "" {
		return ""
	}
	if strings.Contains(address, "/") || strings.Contains(address, "~") {
		return address
	}
	if namespace := c.namespaceSlug(); namespace != "" {
		return namespace + "/" + address
	}
	return address
}

// resolveAgentMeta returns cached lifetime/custody metadata for a sender address.
// On first contact, resolves via the client's IdentityResolver and caches the result.
// Returns an unresolved marker if no resolver is set or resolution fails.
func (c *Client) resolveAgentMeta(ctx context.Context, address string) *agentMeta {
	rawAddress := strings.TrimSpace(address)
	trustAddress := c.canonicalTrustAddress(rawAddress)
	if trustAddress == "" {
		return &agentMeta{}
	}
	if v, ok := c.metaCache.Load(trustAddress); ok {
		return v.(*agentMeta)
	}
	fallback := &agentMeta{
		Lifetime: LifetimePersistent,
		Custody:  CustodySelf,
		Resolved: true,
	}
	if c.resolver != nil {
		if identity, err := c.resolver.Resolve(ctx, trustAddress); err == nil {
			meta := &agentMeta{
				Lifetime: LifetimePersistent,
				Custody:  CustodySelf,
				Resolved: true,
			}
			if identity.Lifetime != "" {
				meta.Lifetime = identity.Lifetime
			}
			if identity.Custody != "" {
				meta.Custody = identity.Custody
			}
			c.metaCache.Store(trustAddress, meta)
			return meta
		}
	}
	// Bare local aliases are ambiguous across teams; fail closed unless the
	// resolver resolved them under the current namespace. Fully qualified
	// addresses keep the historical fallback behavior.
	if rawAddress != trustAddress {
		return &agentMeta{}
	}
	// Resolver absent or failed for an already-qualified address: return
	// defaults but don't cache, so a transient failure retries on the next
	// message.
	return fallback
}

// NormalizeSenderTrust applies sender-specific trust normalization after
// signature verification. It suppresses contact tags for ephemeral senders and
// then applies continuity pinning using shared resolver metadata.
func (c *Client) NormalizeSenderTrust(ctx context.Context, status VerificationStatus, rawAddress, fromDID, fromStableID string, ra *RotationAnnouncement, repl *ReplacementAnnouncement, isContact *bool) (VerificationStatus, *bool) {
	if strings.TrimSpace(rawAddress) == "" {
		return status, isContact
	}
	trustAddress := c.canonicalTrustAddress(rawAddress)
	meta := c.resolveAgentMeta(ctx, rawAddress)
	if strings.TrimSpace(fromStableID) == "" || (meta.Resolved && meta.Lifetime == LifetimeEphemeral) {
		isContact = nil
	}
	var registryConfirmedCurrentKey bool
	status, registryConfirmedCurrentKey = c.checkStableIdentityRegistry(ctx, status, trustAddress, fromDID, fromStableID)

	// Server-anchored key trust (token/custodial model). When the sender has no
	// did:aw stable identity, they are a token/custodial self-custodial identity
	// whose authoritative current key is the one the aweb server publishes in its
	// roster (GET /v1/agents). The signature was already cryptographically
	// verified against from_did before reaching here (status==Verified gates the
	// pin check), so a from_did that matches the server's current published key is
	// a legitimate key — including a rotation or a new device that minted a fresh
	// key and re-published it. We resolve that published key and pass it through
	// so the local TOFU pin acts as a cache that follows the server, not a hard
	// gate that rejects rotations. Forgeries are still caught: a message whose
	// signature does not validate never reaches Verified, and a key the server has
	// NOT published yields no confirmation (rosterConfirmedCurrentKey stays false).
	rosterConfirmedCurrentKey := false
	if (status == Verified || status == VerifiedCustodial) &&
		strings.TrimSpace(fromDID) != "" &&
		!strings.HasPrefix(strings.TrimSpace(fromStableID), "did:aw:") &&
		meta != nil && meta.Resolved && meta.Lifetime != LifetimeEphemeral {
		published := c.rosterPublishedKey(ctx, trustAddress, HandleFromAddress(strings.TrimSpace(rawAddress)))
		if published != "" && published == strings.TrimSpace(fromDID) {
			rosterConfirmedCurrentKey = true
		}
	}

	status = c.checkTOFUPinWithMeta(ctx, status, strings.TrimSpace(rawAddress), trustAddress, fromDID, fromStableID, ra, repl, meta, registryConfirmedCurrentKey, rosterConfirmedCurrentKey)
	return status, isContact
}

// NormalizeRecipientBinding applies the local recipient-binding check after
// signature verification and any sender-side trust normalization.
func (c *Client) NormalizeRecipientBinding(status VerificationStatus, toDID string, toStableID string) VerificationStatus {
	return c.checkRecipientBinding(status, toDID, toStableID)
}

func (c *Client) checkStableIdentityRegistry(ctx context.Context, status VerificationStatus, trustAddress, fromDID, fromStableID string) (VerificationStatus, bool) {
	if status != Verified || strings.TrimSpace(fromStableID) == "" || strings.TrimSpace(fromDID) == "" {
		return status, false
	}
	if !strings.HasPrefix(strings.TrimSpace(fromStableID), "did:aw:") {
		return status, false
	}
	verifier, ok := c.resolver.(StableIdentityVerifier)
	if !ok {
		return status, false
	}
	result := verifier.VerifyStableIdentity(ctx, trustAddress, fromStableID)
	if result == nil {
		return status, false
	}
	switch result.Outcome {
	case StableIdentityVerified:
		currentDIDKey := strings.TrimSpace(result.CurrentDIDKey)
		if currentDIDKey != "" && currentDIDKey != fromDID {
			return IdentityMismatch, false
		}
		return status, currentDIDKey == fromDID
	case StableIdentityHardError:
		return IdentityMismatch, false
	}
	return status, false
}

// CheckTOFUPin checks a verified message against the TOFU pin store.
// On first contact, creates a pin. On subsequent contact with matching DID,
// updates last_seen. On DID mismatch, checks for a valid rotation announcement
// before returning IdentityMismatch.
// Returns the status unchanged if no pin store is set, the message is not
// verified, or from_did/from_address is empty.
// Uses the resolver to determine the sender's lifetime (ephemeral agents
// skip pinning) and custody (custodial agents return VerifiedCustodial).
//
// When fromStableID is present, pins are keyed by stable_id instead of did:key.
// The pin stores the last observed did:key for that stable identity, so a
// stable_id can survive key rotation while still enforcing continuity.
func (c *Client) CheckTOFUPin(ctx context.Context, status VerificationStatus, fromAddress, fromDID, fromStableID string, ra *RotationAnnouncement, repl *ReplacementAnnouncement) VerificationStatus {
	if c.pinStore == nil || (status != Verified && status != VerifiedCustodial) || fromDID == "" || fromAddress == "" {
		return status
	}

	// Validate stable_id prefix before using it as a pin key.
	if fromStableID != "" && !strings.HasPrefix(fromStableID, "did:aw:") {
		fromStableID = "" // Treat invalid prefix as absent.
	}

	trustAddress := c.canonicalTrustAddress(fromAddress)
	meta := c.resolveAgentMeta(ctx, trustAddress)
	return c.checkTOFUPinWithMeta(ctx, status, strings.TrimSpace(fromAddress), trustAddress, fromDID, fromStableID, ra, repl, meta, false, false)
}

func (c *Client) checkTOFUPinWithMeta(ctx context.Context, status VerificationStatus, rawAddress, trustAddress, fromDID, fromStableID string, ra *RotationAnnouncement, repl *ReplacementAnnouncement, meta *agentMeta, registryConfirmedCurrentKey, rosterConfirmedCurrentKey bool) VerificationStatus {
	if c.pinStore == nil || (status != Verified && status != VerifiedCustodial) || fromDID == "" || trustAddress == "" || meta == nil {
		return status
	}
	if !meta.Resolved {
		return status
	}
	if meta.Lifetime == LifetimeEphemeral {
		c.pinStore.mu.Lock()
		removed := c.pinStore.RemoveAddress(trustAddress)
		rawAddress = strings.TrimSpace(rawAddress)
		if rawAddress != "" && rawAddress != trustAddress {
			removed = c.pinStore.RemoveAddress(rawAddress) || removed
		}
		c.pinStore.mu.Unlock()
		if removed {
			c.savePinStore()
		}
		return status
	}

	if meta.Custody == CustodyCustodial && status == Verified {
		status = VerifiedCustodial
	}

	c.pinStore.mu.Lock()
	defer c.pinStore.mu.Unlock()

	pinKey := fromDID

	// A synthetic did:key:jwt-<sub> is a server-side routing placeholder for a
	// token human — no one holds its private key, so it can never be a real
	// verification anchor. If a stale pin recorded it for this address (e.g.
	// from a pre-signing run), drop it so the sender's real self-custodial
	// did:key pins cleanly instead of tripping an IdentityMismatch against the
	// placeholder. The incoming fromDID here is always the signature-verified
	// real key (status==Verified gated this far).
	if existingDID, ok := c.pinStore.Addresses[trustAddress]; ok && isSyntheticJWTDIDKey(existingDID) && existingDID != pinKey {
		delete(c.pinStore.Pins, existingDID)
		c.pinStore.RemoveAddress(trustAddress)
		c.savePinStore()
	}

	if fromStableID != "" {
		pinKey = fromStableID

		// Upgrade-on-first-sight: if we have a did:key pin for this address
		// and the did:key matches, migrate to stable_id pin before the check.
		if existingDID, ok := c.pinStore.Addresses[trustAddress]; ok && existingDID == fromDID {
			if existingPin, hasDIDPin := c.pinStore.Pins[fromDID]; hasDIDPin {
				delete(c.pinStore.Pins, fromDID)
				existingPin.StableID = fromStableID
				c.pinStore.Pins[fromStableID] = existingPin
				c.pinStore.Addresses[trustAddress] = fromStableID
			}
		}
	}

	pinResult := c.pinStore.CheckPin(trustAddress, pinKey, meta.Lifetime)
	switch pinResult {
	case PinNew:
		c.pinStore.StorePin(pinKey, trustAddress, "", "")
		if fromStableID != "" {
			c.pinStore.Pins[pinKey].StableID = fromStableID
			c.pinStore.Pins[pinKey].DIDKey = fromDID
		}
		c.savePinStore()
	case PinOK:
		if fromStableID != "" {
			if pin, ok := c.pinStore.Pins[pinKey]; ok && strings.TrimSpace(pin.DIDKey) != "" && pin.DIDKey != fromDID {
				// A verified registry chain is authoritative for persistent
				// identities; stale local TOFU must not block archive/recreate.
				// Security assumption: awid enforces a did:aw belongs to one
				// current address; the client does not independently prove that.
				if registryConfirmedCurrentKey {
					c.pinStore.StorePin(pinKey, trustAddress, "", "")
					c.pinStore.Pins[pinKey].StableID = fromStableID
					c.pinStore.Pins[pinKey].DIDKey = fromDID
					c.savePinStore()
					return status
				}
				if (ra == nil || !c.verifyRotationAnnouncement(ra, fromDID, pin.DIDKey)) &&
					(repl == nil || !c.verifyReplacementAnnouncement(ctx, trustAddress, repl, fromDID, pin.DIDKey)) {
					return IdentityMismatch
				}
			}
		}
		c.pinStore.StorePin(pinKey, trustAddress, "", "")
		if fromStableID != "" {
			c.pinStore.Pins[pinKey].StableID = fromStableID
			c.pinStore.Pins[pinKey].DIDKey = fromDID
		}
		c.savePinStore()
	case PinMismatch:
		pinnedKey := c.pinStore.Addresses[trustAddress]
		// Server-anchored key trust (token/custodial self-custodial identities,
		// no did:aw). The signature already verified against from_did, and the
		// aweb server roster publishes from_did as this sender's CURRENT active
		// key — so this is a legitimate rotation or a new device that minted a
		// fresh key and re-published it, NOT a forgery. Treat the local pin as a
		// cache: replace the stale did:key pin and accept. Security tradeoff: this
		// trusts the aweb server to report the correct active key, consistent with
		// the custodial model where the server already mediates auth and message
		// routing. A forged from_did never reaches Verified, and a key the server
		// has not published yields no confirmation (rosterConfirmedCurrentKey is
		// false), so this does not blanket-pass mismatches.
		if rosterConfirmedCurrentKey && fromStableID == "" {
			c.pinStore.RemoveAddress(trustAddress)
			c.pinStore.StorePin(pinKey, trustAddress, "", "")
			c.savePinStore()
			return status
		}
		// A verified registry chain proves the address now belongs to this
		// stable identity and did:key, so replace the stale address pin.
		// Security assumption: awid enforces a did:aw belongs to one current
		// address; the client does not independently prove that.
		if registryConfirmedCurrentKey && fromStableID != "" {
			c.pinStore.RemoveAddress(trustAddress)
			c.pinStore.StorePin(pinKey, trustAddress, "", "")
			c.pinStore.Pins[pinKey].StableID = fromStableID
			c.pinStore.Pins[pinKey].DIDKey = fromDID
			c.savePinStore()
			return status
		}
		if fromStableID != "" && pinnedKey == fromStableID {
			if pin, ok := c.pinStore.Pins[pinnedKey]; ok {
				if strings.TrimSpace(pin.DIDKey) != "" && pin.DIDKey == fromDID {
					c.pinStore.StorePin(pinnedKey, trustAddress, "", "")
					c.pinStore.Pins[pinnedKey].StableID = fromStableID
					c.savePinStore()
					return status
				}
				if strings.TrimSpace(pin.DIDKey) != "" &&
					((ra != nil && c.verifyRotationAnnouncement(ra, fromDID, pin.DIDKey)) ||
						(repl != nil && c.verifyReplacementAnnouncement(ctx, trustAddress, repl, fromDID, pin.DIDKey))) {
					c.pinStore.StorePin(pinnedKey, trustAddress, "", "")
					c.pinStore.Pins[pinnedKey].StableID = fromStableID
					c.pinStore.Pins[pinnedKey].DIDKey = fromDID
					c.savePinStore()
					return status
				}
			}
		}
		if (ra != nil && c.verifyRotationAnnouncement(ra, fromDID, pinnedKey)) ||
			(repl != nil && c.verifyReplacementAnnouncement(ctx, trustAddress, repl, fromDID, pinnedKey)) {
			delete(c.pinStore.Pins, pinnedKey)
			c.pinStore.StorePin(pinKey, trustAddress, "", "")
			if fromStableID != "" {
				c.pinStore.Pins[pinKey].StableID = fromStableID
				c.pinStore.Pins[pinKey].DIDKey = fromDID
			}
			c.savePinStore()
			return status
		}
		return IdentityMismatch
	}
	return status
}

// verifyRotationAnnouncement checks that a rotation announcement is valid:
// the old key signed the transition from old_did to new_did, the message's
// from_did matches the announcement's new_did, and the announcement's old_did
// matches the currently pinned DID.
func (c *Client) verifyRotationAnnouncement(ra *RotationAnnouncement, messageDID, pinnedDID string) bool {
	if ra.OldDID == "" || ra.NewDID == "" || ra.OldKeySignature == "" || ra.Timestamp == "" {
		return false
	}
	if !isTimestampFresh(ra.Timestamp) {
		return false
	}
	if ra.NewDID != messageDID {
		return false
	}
	if ra.OldDID != pinnedDID {
		return false
	}
	oldPub, err := ExtractPublicKey(ra.OldDID)
	if err != nil {
		return false
	}
	ok, err := VerifyRotationSignature(oldPub, ra.OldDID, ra.NewDID, ra.Timestamp, ra.OldKeySignature)
	return err == nil && ok
}

func (c *Client) verifyReplacementAnnouncement(ctx context.Context, address string, repl *ReplacementAnnouncement, messageDID, pinnedDID string) bool {
	if repl == nil {
		return false
	}
	if repl.Address == "" || repl.OldDID == "" || repl.NewDID == "" || repl.ControllerDID == "" || repl.Timestamp == "" || repl.ControllerSignature == "" {
		return false
	}
	if !isTimestampFresh(repl.Timestamp) {
		return false
	}
	if repl.Address != address || repl.NewDID != messageDID || repl.OldDID != pinnedDID {
		return false
	}
	if c.resolver == nil {
		return false
	}
	identity, err := c.resolver.Resolve(ctx, address)
	if err != nil {
		return false
	}
	if identity.ControllerDID == "" || identity.ControllerDID != repl.ControllerDID {
		return false
	}
	controllerPub, err := ExtractPublicKey(repl.ControllerDID)
	if err != nil {
		return false
	}
	ok, err := VerifyReplacementSignature(controllerPub, repl.Address, repl.ControllerDID, repl.OldDID, repl.NewDID, repl.Timestamp, repl.ControllerSignature)
	return err == nil && ok
}

func (c *Client) savePinStore() {
	if c.pinStorePath != "" {
		// Best effort: atomic write via temp+rename. A failed save means
		// the next process loads a stale store and may re-pin.
		_ = c.pinStore.Save(c.pinStorePath)
	}
}

// checkRecipientBinding downgrades a Verified status to IdentityMismatch
// if the message's recipient binding doesn't match the client's identity.
// A matching stable binding is sufficient across local key rotation; otherwise
// we fall back to the current did:key binding.
func (c *Client) checkRecipientBinding(status VerificationStatus, toDID string, toStableID string) VerificationStatus {
	if status != Verified {
		return status
	}
	if stableID := strings.TrimSpace(c.stableID); stableID != "" && strings.TrimSpace(toStableID) != "" {
		if strings.EqualFold(strings.TrimSpace(toStableID), stableID) {
			return status
		}
		return IdentityMismatch
	}
	if toDID == "" || c.did == "" {
		return status
	}
	if strings.HasPrefix(strings.TrimSpace(toDID), "did:aw:") {
		if strings.TrimSpace(toStableID) != "" {
			return status
		}
		stableID := strings.TrimSpace(c.stableID)
		if stableID != "" {
			if strings.EqualFold(strings.TrimSpace(toDID), stableID) {
				return status
			}
			return IdentityMismatch
		}
		return status
	}
	if toDID != c.did {
		return IdentityMismatch
	}
	return status
}

// APIError represents an HTTP error from the aweb API.
type APIError struct {
	StatusCode int
	Body       string
}

func (e *APIError) Error() string {
	if e.Body == "" {
		return fmt.Sprintf("aweb: http %d", e.StatusCode)
	}
	return fmt.Sprintf("aweb: http %d: %s", e.StatusCode, e.Body)
}

// HTTPStatusCode returns the HTTP status code for API errors.
func HTTPStatusCode(err error) (int, bool) {
	var e *APIError
	if errors.As(err, &e) {
		return e.StatusCode, true
	}
	var registryErr *RegistryError
	if errors.As(err, &registryErr) {
		return registryErr.StatusCode, true
	}
	return 0, false
}

// HTTPErrorBody returns the response body for API errors.
func HTTPErrorBody(err error) (string, bool) {
	var e *APIError
	if errors.As(err, &e) {
		return e.Body, true
	}
	var registryErr *RegistryError
	if errors.As(err, &registryErr) {
		return registryErr.Detail, true
	}
	return "", false
}

// Get performs an HTTP GET request and decodes the JSON response.
func (c *Client) Get(ctx context.Context, path string, out any) error {
	return c.Do(ctx, http.MethodGet, path, nil, out)
}

// Post performs an HTTP POST request with a JSON body and decodes the JSON response.
func (c *Client) Post(ctx context.Context, path string, in any, out any) error {
	return c.Do(ctx, http.MethodPost, path, in, out)
}

// PostWithHeaders performs an HTTP POST with additional request headers.
func (c *Client) PostWithHeaders(ctx context.Context, path string, in any, out any, extraHeaders map[string]string) error {
	return c.DoWithHeaders(ctx, http.MethodPost, path, in, out, extraHeaders)
}

// Patch performs an HTTP PATCH request with a JSON body and decodes the JSON response.
func (c *Client) Patch(ctx context.Context, path string, in any, out any) error {
	return c.Do(ctx, http.MethodPatch, path, in, out)
}

// Put performs an HTTP PUT request with a JSON body and decodes the JSON response.
func (c *Client) Put(ctx context.Context, path string, in any, out any) error {
	return c.Do(ctx, http.MethodPut, path, in, out)
}

// Delete performs an HTTP DELETE request.
func (c *Client) Delete(ctx context.Context, path string) error {
	return c.Do(ctx, http.MethodDelete, path, nil, nil)
}

// Do performs an HTTP request with optional JSON body and response decoding.
func (c *Client) Do(ctx context.Context, method, path string, in any, out any) error {
	return c.DoWithHeaders(ctx, method, path, in, out, nil)
}

// DoWithHeaders performs an HTTP request with optional JSON body, response
// decoding, and additional request headers.
func (c *Client) DoWithHeaders(ctx context.Context, method, path string, in any, out any, extraHeaders map[string]string) error {
	resp, err := c.DoRawWithHeaders(ctx, method, path, "application/json", in, extraHeaders)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	limited := io.LimitReader(resp.Body, MaxResponseSize)
	data, err := io.ReadAll(limited)
	if err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return &APIError{StatusCode: resp.StatusCode, Body: string(data)}
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return err
	}
	return nil
}

// DoRaw performs an HTTP request and returns the raw response.
func (c *Client) DoRaw(ctx context.Context, method, path, accept string, in any) (*http.Response, error) {
	return c.DoRawWithHeaders(ctx, method, path, accept, in, nil)
}

// DoRawWithHeaders performs an HTTP request and returns the raw response.
func (c *Client) DoRawWithHeaders(ctx context.Context, method, path, accept string, in any, extraHeaders map[string]string) (*http.Response, error) {
	var body io.Reader
	var bodyBytes []byte
	if in != nil {
		data, err := json.Marshal(in)
		if err != nil {
			return nil, err
		}
		bodyBytes = data
		body = bytes.NewReader(data)
	}

	if strings.HasSuffix(c.baseURL, "/api") && strings.HasPrefix(path, "/api/") {
		path = strings.TrimPrefix(path, "/api")
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		return nil, err
	}
	if in != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Accept", accept)
	for key, value := range extraHeaders {
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if key != "" && value != "" {
			req.Header.Set(key, value)
		}
	}
	if c.teamCertHeader != "" && c.signingKey != nil {
		// Certificate auth: DIDKey signature over {body_sha256, team_id, timestamp}.
		// body_sha256 binds the request body to the signature without the
		// server having to consume the body stream for signature verification.
		timestamp := time.Now().UTC().Format(time.RFC3339)
		signPayload := certAuthSignPayload(c.teamID, timestamp, bodyBytes)
		sig := ed25519.Sign(c.signingKey, signPayload)
		req.Header.Set("Authorization", fmt.Sprintf("DIDKey %s %s", c.did, base64.RawStdEncoding.EncodeToString(sig)))
		req.Header.Set("X-AWEB-Timestamp", timestamp)
		req.Header.Set("X-AWID-Team-Certificate", c.teamCertHeader)
	} else if c.signingKey != nil {
		timestamp := time.Now().UTC().Format(time.RFC3339)
		signPayload := identityAuthSignPayload(c.stableID, timestamp, bodyBytes)
		sig := ed25519.Sign(c.signingKey, signPayload)
		req.Header.Set("Authorization", fmt.Sprintf("DIDKey %s %s", c.did, base64.RawStdEncoding.EncodeToString(sig)))
		req.Header.Set("X-AWEB-Timestamp", timestamp)
		if c.stableID != "" {
			req.Header.Set("X-AWEB-DID-AW", c.stableID)
		}
	} else if c.bearerProvider != nil {
		// SimpleAuth (Better Auth JWT) path: no certificate/identity key, so
		// attach the cached bearer token (the provider refreshes it as needed).
		// Additive — cert/identity requests above never reach here.
		if token, err := c.bearerProvider(ctx); err == nil && token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
			if c.teamID != "" {
				req.Header.Set("X-AWEB-Team-Id", c.teamID)
			}
		}
	}

	resp, err := c.httpClient.Do(req)
	if err != nil {
		return nil, decorateTimeoutError(method, err)
	}
	if v := resp.Header.Get("X-Latest-Client-Version"); v != "" {
		c.latestClientVersion.Store(v)
	}
	return resp, nil
}

// decorateTimeoutError marks timed-out mutating requests as ambiguous: the
// request may have reached the server and applied before the response was
// lost, so blind retries risk duplicate writes. Reads stay undecorated —
// retrying a timed-out read is always safe.
func decorateTimeoutError(method string, err error) error {
	switch strings.ToUpper(strings.TrimSpace(method)) {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return err
	}
	var netErr net.Error
	if !errors.As(err, &netErr) || !netErr.Timeout() {
		return err
	}
	return fmt.Errorf("%w\nRequest timed out before a response was received; it may have applied. Check current state before retrying.", err)
}

// certAuthSignPayload builds the canonical JSON bytes for certificate auth:
// {"body_sha256":"<hex>","team_id":"<team_id>","timestamp":"<ts>"} —
// sorted keys, no whitespace. body_sha256 is the hex SHA256 of the request
// body bytes (empty body hashes the empty string).
func certAuthSignPayload(teamID, timestamp string, body []byte) []byte {
	h := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(h[:])
	payload, err := CanonicalJSONValue(map[string]string{
		"body_sha256": bodyHash,
		"team_id":     teamID,
		"timestamp":   timestamp,
	})
	if err != nil {
		panic(fmt.Sprintf("certAuthSignPayload: %v", err))
	}
	return []byte(payload)
}

func identityAuthSignPayload(didAW, timestamp string, body []byte) []byte {
	h := sha256.Sum256(body)
	bodyHash := hex.EncodeToString(h[:])
	payload, err := CanonicalJSONValue(map[string]string{
		"body_sha256": bodyHash,
		"did_aw":      didAW,
		"timestamp":   timestamp,
	})
	if err != nil {
		panic(fmt.Sprintf("identityAuthSignPayload: %v", err))
	}
	return []byte(payload)
}
