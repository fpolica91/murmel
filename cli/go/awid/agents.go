package awid

import (
	"context"
	"fmt"
	"strings"
	"time"
)

// HeartbeatResponse is returned by POST /v1/agents/heartbeat.
type HeartbeatResponse struct {
	AgentID    string `json:"agent_id"`
	Alias      string `json:"alias"`
	LastSeenAt string `json:"last_seen_at"`
}

type AgentView struct {
	AgentID       string                  `json:"agent_id"`
	Alias         string                  `json:"alias"`
	DIDKey        string                  `json:"did_key"`
	DIDAW         string                  `json:"did_aw,omitempty"`
	Address       string                  `json:"address,omitempty"`
	HumanName     string                  `json:"human_name,omitempty"`
	AgentType     string                  `json:"agent_type,omitempty"`
	WorkspaceType string                  `json:"workspace_type,omitempty"`
	Role          string                  `json:"role,omitempty"`
	Hostname      string                  `json:"hostname,omitempty"`
	WorkspacePath string                  `json:"workspace_path,omitempty"`
	Repo          string                  `json:"repo,omitempty"`
	Status        string                  `json:"status,omitempty"`
	LastSeen      string                  `json:"last_seen,omitempty"`
	Online        bool                    `json:"online,omitempty"`
	IdentityScope string                  `json:"identity_scope,omitempty"`
	InboundMode   string                  `json:"inbound_mode,omitempty"`
	Lifetime      string                  `json:"lifetime,omitempty"`
	EncryptionKey *EncryptionKeyAssertion `json:"encryption_key,omitempty"`
}

// syntheticJWTDIDKeyPrefix marks the placeholder did:key the aweb server mints
// for token-authenticated humans (`did:key:jwt-<subject>`). It is a local
// routing key only and is NEVER used for signature verification — the human's
// real self-custodial did:key is carried in their published encryption-key
// assertion's identity_did. See server routes/agents.py.
const syntheticJWTDIDKeyPrefix = "did:key:jwt-"

func isSyntheticJWTDIDKey(didKey string) bool {
	return strings.HasPrefix(strings.TrimSpace(didKey), syntheticJWTDIDKeyPrefix)
}

// encryptionVerificationDID returns the did:key an agent's encryption-key
// assertion must verify against. For token humans the roster did_key is a
// synthetic placeholder, so the assertion's own self-asserted identity_did (the
// real self-custodial key that signed it) is authoritative — the server vouches
// for that binding by publishing it under the authenticated token. For everyone
// else the roster did_key is authoritative.
func (a AgentView) encryptionVerificationDID() string {
	didKey := strings.TrimSpace(a.DIDKey)
	if isSyntheticJWTDIDKey(didKey) && a.EncryptionKey != nil {
		return strings.TrimSpace(a.EncryptionKey.IdentityDID)
	}
	return didKey
}

func (a AgentView) VerifyEncryptionKey(now time.Time) error {
	if a.EncryptionKey == nil {
		return nil
	}
	stableID := strings.TrimSpace(a.DIDAW)
	if isSyntheticJWTDIDKey(a.DIDKey) {
		// Token humans are local self-custodial identities with no did:aw; their
		// assertion intentionally omits identity_stable_id.
		stableID = ""
	}
	return VerifyEncryptionKeyAssertion(
		a.EncryptionKey,
		a.encryptionVerificationDID(),
		stableID,
		now,
	)
}

func (a AgentView) RequireEncryptionKey(now time.Time) (*EncryptionKeyAssertion, error) {
	if a.EncryptionKey == nil {
		return nil, fmt.Errorf("agent %s has no E2E encryption key; ask them to upgrade murmel/Pi/channel and publish one, or explicitly send a server-readable upgrade note with --plaintext", a.Alias)
	}
	if err := a.VerifyEncryptionKey(now); err != nil {
		return nil, err
	}
	return a.EncryptionKey, nil
}

func (c *Client) e2eeRecipientFromAgent(ctx context.Context, agent AgentView) (E2EERecipientKey, error) {
	if strings.TrimSpace(agent.DIDAW) != "" {
		return c.e2eeGlobalRecipientFromAgent(ctx, agent)
	}
	if assertion, err := agent.RequireEncryptionKey(time.Now().UTC()); err == nil {
		// For token humans the roster did_key is a synthetic placeholder; the key
		// wrap must address the real self-custodial did:key the recipient decrypts
		// with (the assertion's identity_did), while the server still routes on
		// the synthetic placeholder. Carry both so the envelope is correct AND
		// delivery resolves. Token humans are addressless local identities: their
		// roster address is a display/routing hint they cannot present at decrypt
		// time, so it must not be bound into the key wrap.
		address := strings.TrimSpace(agent.Address)
		routingDID := ""
		if isSyntheticJWTDIDKey(agent.DIDKey) {
			routingDID = strings.TrimSpace(agent.DIDKey)
			address = ""
		}
		return E2EERecipientKey{
			Address:       address,
			DID:           agent.encryptionVerificationDID(),
			RoutingDID:    routingDID,
			EncryptionKey: assertion,
			InboundMode:   strings.TrimSpace(agent.InboundMode),
		}, nil
	} else if agent.EncryptionKey != nil {
		return E2EERecipientKey{}, err
	}

	return E2EERecipientKey{}, fmt.Errorf("agent %s has no E2E encryption key; local-only recipients cannot be resolved through AWID, ask them to upgrade murmel/Pi/channel and publish one, or explicitly send a server-readable upgrade note with --plaintext", agent.Alias)
}

func (c *Client) e2eeGlobalRecipientFromAgent(ctx context.Context, agent AgentView) (E2EERecipientKey, error) {
	address := strings.TrimSpace(agent.Address)
	if address == "" {
		return E2EERecipientKey{}, fmt.Errorf("agent %s is global but has no address for AWID E2E key discovery; send by address or repair the roster entry", agent.Alias)
	}
	identity, err := c.ResolveIdentity(ctx, address)
	if err != nil {
		return E2EERecipientKey{}, fmt.Errorf("agent %s AWID E2E key discovery for %s failed: %w", agent.Alias, address, err)
	}
	if strings.TrimSpace(identity.StableID) != strings.TrimSpace(agent.DIDAW) {
		return E2EERecipientKey{}, fmt.Errorf("agent %s AWID key discovery stable id mismatch: roster has %s, address %s resolved to %s", agent.Alias, strings.TrimSpace(agent.DIDAW), address, strings.TrimSpace(identity.StableID))
	}
	if identity.EncryptionKey == nil {
		return E2EERecipientKey{}, fmt.Errorf("agent %s has no AWID-published E2E encryption key; ask them to upgrade murmel/Pi/channel and publish one, or explicitly send a server-readable upgrade note with --plaintext", agent.Alias)
	}
	return E2EERecipientKey{
		Address:        strings.TrimSpace(identity.Address),
		DID:            strings.TrimSpace(identity.DID),
		StableID:       strings.TrimSpace(identity.StableID),
		EncryptionKey:  identity.EncryptionKey,
		DeliveryOrigin: strings.TrimSpace(identity.DeliveryOrigin),
		InboundMode:    strings.TrimSpace(agent.InboundMode),
	}, nil
}

func (c *Client) learnedE2EERecipientFromEnvelope(envelope *E2EEMessageEnvelope) (E2EERecipientKey, bool, error) {
	if envelope == nil {
		return E2EERecipientKey{}, false, nil
	}
	from := envelope.From
	if strings.TrimSpace(from.DID) == "" {
		return E2EERecipientKey{}, false, nil
	}
	for _, self := range []string{c.e2eeEnvelopeDID(), c.stableID, c.address} {
		self = strings.TrimSpace(self)
		if self == "" {
			continue
		}
		for _, candidate := range []string{from.DID, from.StableID, from.Address} {
			if strings.EqualFold(strings.TrimSpace(candidate), self) {
				return E2EERecipientKey{}, false, nil
			}
		}
	}
	if strings.TrimSpace(from.Address) != "" {
		return E2EERecipientKey{}, false, nil
	}
	if !strings.HasPrefix(strings.TrimSpace(from.DID), "did:key:") {
		return E2EERecipientKey{}, false, nil
	}
	recipient, err := E2EERecipientFromEnvelopeSender(envelope, time.Now().UTC())
	if err != nil {
		return E2EERecipientKey{}, true, fmt.Errorf("local-only E2E reply target %s cannot be used: %w", strings.TrimSpace(from.DID), err)
	}
	return recipient, true, nil
}

type ListAgentsResponse struct {
	TeamID string      `json:"team_id"`
	Agents []AgentView `json:"agents"`
}

type AgentInboundModeResponse struct {
	AgentID       string `json:"agent_id"`
	TeamID        string `json:"team_id"`
	Alias         string `json:"alias"`
	IdentityScope string `json:"identity_scope"`
	InboundMode   string `json:"inbound_mode"`
	Configurable  bool   `json:"configurable"`
}

type UpdateAgentInboundModeRequest struct {
	InboundMode string `json:"inbound_mode"`
}

type PublishAgentEncryptionKeyResponse struct {
	AgentID       string                  `json:"agent_id"`
	TeamID        string                  `json:"team_id"`
	Alias         string                  `json:"alias"`
	EncryptionKey *EncryptionKeyAssertion `json:"encryption_key,omitempty"`
}

// Heartbeat reports agent liveness to the aweb server.
func (c *Client) Heartbeat(ctx context.Context) (*HeartbeatResponse, error) {
	var out HeartbeatResponse
	if err := c.Post(ctx, "/v1/agents/heartbeat", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListAgents lists agents visible in the authenticated team.
func (c *Client) ListAgents(ctx context.Context) (*ListAgentsResponse, error) {
	var out ListAgentsResponse
	if err := c.Get(ctx, "/v1/agents", &out); err != nil {
		return nil, err
	}
	for _, agent := range out.Agents {
		if agent.EncryptionKey == nil {
			continue
		}
		if err := agent.VerifyEncryptionKey(time.Now().UTC()); err != nil {
			return nil, fmt.Errorf("ListAgents: invalid encryption key assertion for %s: %w", agent.Alias, err)
		}
	}
	return &out, nil
}

// rosterPublishedKey returns the sender's CURRENT server-published active
// signing did:key for a sender address/alias, by consulting GET /v1/agents
// (the server roster — the trust anchor in the token/custodial model). For a
// token human the roster's did_key column is a synthetic placeholder, so the
// real self-custodial key is the published encryption-key assertion's
// identity_did (encryptionVerificationDID). Results are cached per sender for
// the lifetime of the client so a single history render makes at most one
// roster call per distinct sender.
//
// Returns "" when the roster cannot be fetched or the sender is not found /
// has no published key. An empty result means "no server confirmation",
// which the caller treats as "do not loosen" (fail closed).
func (c *Client) rosterPublishedKey(ctx context.Context, senderAddress, senderAlias string) string {
	cacheKey := strings.TrimSpace(senderAddress)
	if cacheKey == "" {
		cacheKey = strings.TrimSpace(senderAlias)
	}
	if cacheKey == "" {
		return ""
	}
	if v, ok := c.rosterKeyCache.Load(cacheKey); ok {
		return v.(string)
	}
	resp, err := c.ListAgents(ctx)
	if err != nil || resp == nil {
		// Do not cache transient failures; retry on the next message.
		return ""
	}
	published := ""
	wantAddr := strings.TrimSpace(senderAddress)
	wantAlias := strings.TrimSpace(senderAlias)
	for i := range resp.Agents {
		agent := resp.Agents[i]
		if wantAddr != "" && strings.EqualFold(strings.TrimSpace(agent.Address), wantAddr) {
			published = strings.TrimSpace(agent.encryptionVerificationDID())
			break
		}
		if wantAlias != "" && strings.EqualFold(strings.TrimSpace(agent.Alias), wantAlias) {
			published = strings.TrimSpace(agent.encryptionVerificationDID())
			// Keep scanning for an exact address match if one was requested;
			// otherwise an alias hit is authoritative.
			if wantAddr == "" {
				break
			}
		}
	}
	c.rosterKeyCache.Store(cacheKey, published)
	return published
}

func (c *Client) GetMyInboundMode(ctx context.Context) (*AgentInboundModeResponse, error) {
	var out AgentInboundModeResponse
	if err := c.Get(ctx, "/v1/agents/me/inbound-mode", &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) UpdateMyInboundMode(ctx context.Context, mode string) (*AgentInboundModeResponse, error) {
	var out AgentInboundModeResponse
	req := UpdateAgentInboundModeRequest{InboundMode: strings.TrimSpace(mode)}
	if err := c.Patch(ctx, "/v1/agents/me/inbound-mode", req, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) PublishMyEncryptionKey(ctx context.Context, assertion *EncryptionKeyAssertion) (*PublishAgentEncryptionKeyResponse, error) {
	var out PublishAgentEncryptionKeyResponse
	if err := c.Put(ctx, "/v1/agents/me/encryption-key", assertion, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
