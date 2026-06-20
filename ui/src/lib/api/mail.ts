/**
 * Mail API for the human inbox / compose surface.
 *
 * Wired to the real aweb LOCAL mail endpoints over the shared `authedRequest`
 * helper, so auth (Bearer JWT) + team scoping (X-AWEB-Team-Id) are attached
 * automatically. This is the structural twin of `chat.ts`.
 *
 * LOCAL mail only: compose POSTs the message and the server stamps the sender
 * from the Better Auth JWT. We never send `from_did` / `signature` /
 * `signed_payload` — those are back-compat optional fields for the
 * client-signed / federated paths and stay unset here.
 *
 * Endpoints (see server/src/aweb/routes/messages.py + conversations.py):
 *   - GET  /v1/messages/inbox?unread_only=&limit=
 *   - GET  /v1/conversations?conversation_type=mail&limit=&cursor=
 *   - GET  /v1/messages/conversations/{conversation_id}?limit=
 *   - POST /v1/messages                      (new: to_alias/subject/body; reply: conversation_id/body)
 *   - POST /v1/messages/{message_id}/ack
 */

import { authedRequest } from "./http";
import { listAgents } from "./members";

export type MailPriority = "low" | "normal" | "high" | "urgent";

// ---------------------------------------------------------------------------
// Inbox / thread messages (GET /v1/messages/inbox, /messages/conversations/{id})
// ---------------------------------------------------------------------------

/**
 * A single mail message as returned by the inbox + mail-conversation endpoints.
 * `read_at === null` means unread. `verification_status` is a server-resolved
 * per-message trust signal (for token-auth local mail this is
 * `verified_server`); a missing value renders no chip.
 */
export interface InboxMessage {
  message_id: string;
  conversation_id: string | null;
  from_agent_id: string | null;
  from_alias: string;
  to_alias: string;
  subject: string | null;
  body: string | null;
  content_mode: string;
  message_version: number;
  priority: MailPriority;
  /** ISO-8601 read timestamp, or null when unread. */
  read_at: string | null;
  created_at: string;
  from_did: string | null;
  to_did: string | null;
  from_address: string | null;
  to_address: string | null;
  verification_status?:
    | "verified"
    | "verified_server"
    | "verified_legacy"
    | "unverified"
    | "failed";
}

export interface InboxResponse {
  messages: InboxMessage[];
}

/**
 * List the inbox for the active team (messages addressed to you), newest first.
 * Pass `unreadOnly` to restrict to unread mail (used by the unread badge).
 */
export async function listInbox(
  teamId: string | null,
  opts: { unreadOnly?: boolean; limit?: number; signal?: AbortSignal } = {},
): Promise<InboxMessage[]> {
  const res = await authedRequest<InboxResponse>("/v1/messages/inbox", {
    teamId,
    query: {
      unread_only: opts.unreadOnly ? true : undefined,
      limit: opts.limit ?? 50,
    },
    signal: opts.signal,
  });
  return res.messages ?? [];
}

/**
 * Read a full mail thread (all messages in a conversation), sorted oldest ->
 * newest. The server already orders ascending; we re-sort defensively so the
 * thread render is stable regardless of source ordering.
 */
export async function getMailThread(
  teamId: string | null,
  conversationId: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<InboxMessage[]> {
  const res = await authedRequest<InboxResponse>(
    `/v1/messages/conversations/${encodeURIComponent(conversationId)}`,
    {
      teamId,
      query: { limit: opts.limit ?? 200 },
      signal: opts.signal,
    },
  );
  const messages = res.messages ?? [];
  return [...messages].sort((a, b) =>
    a.created_at.localeCompare(b.created_at),
  );
}

// ---------------------------------------------------------------------------
// Mail conversation list (GET /v1/conversations?conversation_type=mail)
// ---------------------------------------------------------------------------

export interface MailConversationItem {
  conversation_type: "mail" | "chat";
  conversation_id: string | null;
  legacy_message_id: string | null;
  status: string;
  /** Display aliases on the thread (includes you). */
  participants: string[];
  participant_dids: string[];
  participant_addresses: string[];
  subject: string;
  last_message_at: string;
  last_message_from: string;
  last_message_preview: string;
  unread_count: number;
}

export interface MailConversationsResponse {
  conversations: MailConversationItem[];
  next_cursor: string | null;
}

/**
 * List mail conversations (threads) for the active team, newest first, enriched
 * with last-message preview + unread counts. This is the Sent/threads surface;
 * filtering to `conversation_type=mail` drops chat rows server-side.
 */
export async function listMailConversations(
  teamId: string | null,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<MailConversationsResponse> {
  return authedRequest<MailConversationsResponse>("/v1/conversations", {
    teamId,
    query: {
      conversation_type: "mail",
      limit: opts.limit ?? 50,
      cursor: opts.cursor ?? undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Sending mail (POST /v1/messages)
// ---------------------------------------------------------------------------

export interface SendMessageResponse {
  message_id: string;
  conversation_id: string | null;
  status: string;
  delivered_at: string;
}

/**
 * Send a NEW mail to a single recipient (by alias). The server stamps the
 * sender from the JWT and either opens a fresh conversation or continues the
 * existing 1:1 mail thread with that recipient. LOCAL only — no signing fields.
 */
export async function sendNewMail(
  teamId: string | null,
  input: { to_alias: string; subject: string; body: string; priority?: MailPriority },
): Promise<SendMessageResponse> {
  return authedRequest<SendMessageResponse>("/v1/messages", {
    method: "POST",
    teamId,
    body: {
      to_alias: input.to_alias,
      subject: input.subject,
      body: input.body,
      priority: input.priority ?? "normal",
    },
  });
}

/**
 * Reply within an existing mail thread. With a `conversation_id` and no
 * explicit recipient, the server routes the reply to the other participant.
 */
export async function replyInThread(
  teamId: string | null,
  conversationId: string,
  body: string,
): Promise<SendMessageResponse> {
  return authedRequest<SendMessageResponse>("/v1/messages", {
    method: "POST",
    teamId,
    body: { conversation_id: conversationId, body },
  });
}

// ---------------------------------------------------------------------------
// Acknowledge (POST /v1/messages/{message_id}/ack) — marks read
// ---------------------------------------------------------------------------

/**
 * Mark a single inbound message read. Idempotent server-side (a second ack on an
 * already-read or missing message is harmless), so callers can fire-and-forget.
 */
export async function ackMessage(
  teamId: string | null,
  messageId: string,
): Promise<void> {
  await authedRequest<unknown>(
    `/v1/messages/${encodeURIComponent(messageId)}/ack`,
    { method: "POST", teamId },
  );
}

// ---------------------------------------------------------------------------
// Role fan-out (send the same mail to every agent in a role)
// ---------------------------------------------------------------------------

/** Per-recipient outcome for a role fan-out send. Never throws on a partial. */
export interface SendMailResult {
  alias: string;
  ok: boolean;
  message_id?: string;
  error?: string;
}

/** Normalize an agent's role identifier (role takes precedence over role_name). */
function agentRoleKey(agent: { role: string | null; role_name: string | null }): string {
  return (agent.role || agent.role_name || "").trim();
}

/**
 * Send the same mail to every agent whose role matches `roleKey`. Resolves the
 * recipient aliases from `listAgents(teamId)` filtered by role/role_name, then
 * fires one `sendNewMail` per alias and reports each outcome. NEVER throws on a
 * partial failure — a failed recipient becomes a `{ ok: false, error }` row so
 * the caller can show a per-recipient results view.
 */
export async function sendMailToRole(
  teamId: string | null,
  roleKey: string,
  input: { subject: string; body: string; priority?: MailPriority },
): Promise<SendMailResult[]> {
  const wanted = roleKey.trim();
  const agents = await listAgents(teamId);
  // De-dupe aliases (a role can have multiple workspaces for one alias).
  const aliases = Array.from(
    new Set(
      agents
        .filter((a) => agentRoleKey(a) === wanted && a.alias)
        .map((a) => a.alias),
    ),
  );

  if (aliases.length === 0) return [];

  const settled = await Promise.allSettled(
    aliases.map((alias) => sendNewMail(teamId, { to_alias: alias, ...input })),
  );

  return settled.map((outcome, i) => {
    const alias = aliases[i];
    if (outcome.status === "fulfilled") {
      return { alias, ok: true, message_id: outcome.value.message_id };
    }
    const reason = outcome.reason;
    const error =
      reason instanceof Error ? reason.message : String(reason ?? "Send failed");
    return { alias, ok: false, error };
  });
}
