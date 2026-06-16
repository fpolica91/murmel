/**
 * Chat / conversation API for the "agent conversation feed" feature.
 *
 * Wired to the real aweb chat endpoints (see CONTRACTS.md §1) via the shared
 * `authedRequest` helper, so auth (Bearer JWT) + team scoping (X-AWEB-Team-Id)
 * are attached automatically.
 *
 * We use the chat-native surface (`/v1/chat/sessions`) for the inbox because it
 * is chat-only and exposes `sender_waiting`, and the merged
 * `/v1/conversations?conversation_type=chat` surface to enrich the list with
 * last-message previews + unread counts. Reading and posting messages go
 * through `/v1/chat/sessions/{id}/messages`.
 */

import { authedRequest } from "./http";

// ---------------------------------------------------------------------------
// Conversation list (merged mail+chat model; we filter to chat)
// ---------------------------------------------------------------------------

export interface ConversationItem {
  conversation_type: "mail" | "chat";
  /** The chat session_id for chat rows. */
  conversation_id: string | null;
  legacy_message_id: string | null;
  status: string;
  /** Display aliases (includes you). */
  participants: string[];
  participant_dids: string[];
  participant_addresses: string[];
  /** "" for chat. */
  subject: string;
  last_message_at: string;
  last_message_from: string;
  last_message_preview: string;
  unread_count: number;
}

export interface ConversationsResponse {
  conversations: ConversationItem[];
  next_cursor: string | null;
}

/**
 * List chat conversations for the active team, enriched with last-message
 * preview + unread counts (the merged conversations surface).
 */
export async function listChatConversations(
  teamId: string | null,
  opts: { limit?: number; cursor?: string | null } = {},
): Promise<ConversationsResponse> {
  return authedRequest<ConversationsResponse>("/v1/conversations", {
    teamId,
    query: {
      conversation_type: "chat",
      limit: opts.limit ?? 50,
      cursor: opts.cursor ?? undefined,
    },
  });
}

// ---------------------------------------------------------------------------
// Chat-native session list (has sender_waiting; no preview/unread)
// ---------------------------------------------------------------------------

export interface SessionListItem {
  session_id: string;
  conversation_id: string;
  team_id: string;
  participants: string[];
  participant_dids: string[];
  participant_addresses: string[];
  created_at: string;
  last_activity: string;
  sender_waiting: boolean;
}

export interface SessionsResponse {
  sessions: SessionListItem[];
}

/** Chat-native session list (includes `sender_waiting`). */
export async function listChatSessions(
  teamId: string | null,
): Promise<SessionListItem[]> {
  const res = await authedRequest<SessionsResponse>("/v1/chat/sessions", {
    teamId,
  });
  return res.sessions ?? [];
}

// ---------------------------------------------------------------------------
// Messages within a session
// ---------------------------------------------------------------------------

export interface ChatMessage {
  conversation_id: string;
  message_id: string;
  /** Sender alias — use to render who sent it. */
  from_agent: string;
  from_address: string | null;
  /**
   * AUTHORITATIVE sender kind (AUDIT.md §3.2), resolved server-side from the
   * sender's participant row. The UI renders human-vs-agent from this, NOT by
   * matching `from_agent` against another roster. Optional for back-compat with
   * pre-contract servers; treat a missing value as "agent".
   */
  from_kind?: "human" | "agent";
  /** Plaintext (encrypted sessions return ""). */
  body: string;
  content_mode: string;
  message_version: number;
  timestamp: string;
  sender_leaving: boolean;
  reply_to: string | null;
  to_address: string;
  from_did: string | null;
  from_stable_id: string | null;
  /**
   * Per-message trust signal resolved server-side (see server
   * `message_verification_status`). Optional for back-compat with pre-contract
   * servers; a missing value renders no badge. Possible values: `verified`
   * (client-signed), `verified_server` (server-attributed Better Auth token
   * identity), `verified_legacy` (signed but no conversation binding),
   * `unverified` (no signature), `failed` (signature mismatch).
   */
  verification_status?:
    | "verified"
    | "verified_server"
    | "verified_legacy"
    | "unverified"
    | "failed";
  is_contact: boolean;
}

export interface MessagesResponse {
  messages: ChatMessage[];
}

/** Read messages in a session (oldest -> newest). */
export async function listSessionMessages(
  teamId: string | null,
  sessionId: string,
  opts: { limit?: number; signal?: AbortSignal } = {},
): Promise<ChatMessage[]> {
  const res = await authedRequest<MessagesResponse>(
    `/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      teamId,
      query: { limit: opts.limit ?? 200 },
      signal: opts.signal,
    },
  );
  return res.messages ?? [];
}

// ---------------------------------------------------------------------------
// Sending messages
// ---------------------------------------------------------------------------

export interface SendMessageResponse {
  message_id: string;
  conversation_id: string;
  delivered: boolean;
  extends_wait_seconds: number;
}

/** Continue an existing session by posting a message into it. */
export async function sendSessionMessage(
  teamId: string | null,
  sessionId: string,
  body: string,
  replyTo?: string,
): Promise<SendMessageResponse> {
  return authedRequest<SendMessageResponse>(
    `/v1/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: "POST",
      teamId,
      body: { body, ...(replyTo ? { reply_to: replyTo } : {}) },
    },
  );
}

export interface CreateSessionResponse {
  session_id: string;
  conversation_id: string;
  message_id: string;
  participants: {
    did: string;
    alias: string;
    agent_id: string | null;
    address: string | null;
  }[];
  sse_url: string;
  targets_connected: string[];
  targets_left: string[];
}

/**
 * Start a new chat session with a peer (by alias). A recipient is required —
 * you cannot create an empty session. If a 1:1 session already exists the
 * server returns it.
 */
export async function startChatSession(
  teamId: string | null,
  toAlias: string,
  message: string,
): Promise<CreateSessionResponse> {
  return authedRequest<CreateSessionResponse>("/v1/chat/sessions", {
    method: "POST",
    teamId,
    body: { message, to_aliases: [toAlias] },
  });
}

// ---------------------------------------------------------------------------
// Mark read (optional, for unread badges)
// ---------------------------------------------------------------------------

/** Mark a session read up to a given message id. */
export async function markSessionRead(
  teamId: string | null,
  sessionId: string,
  upToMessageId: string,
): Promise<void> {
  await authedRequest<unknown>(
    `/v1/chat/sessions/${encodeURIComponent(sessionId)}/read`,
    {
      method: "POST",
      teamId,
      body: { up_to_message_id: upToMessageId },
    },
  );
}
