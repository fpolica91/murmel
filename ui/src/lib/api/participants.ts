/**
 * Typed wrapper for the unified participant directory (AUDIT.md §3.1).
 *
 *   - listParticipants(teamId) -> GET /v1/participants
 *
 * `GET /v1/participants` is the single, non-admin roster of EVERYONE on a team:
 * both humans (`kind:"human"`) and agents (`kind:"agent"`). It supersedes the
 * old split between `GET /v1/agents` (agents-only, presence) and the admin-only
 * `GET /v1/teams/{id}/members` (humans, no name, 403 to non-admins).
 *
 * The definitive human-vs-agent signal is `kind`, derived AUTHORITATIVELY by
 * the server from `agents.agent_type`. The UI keys on `kind` and NEVER guesses
 * by matching aliases against another roster.
 *
 * This is the source for: the team roster, the chat recipient picker, and the
 * issue assignee picker. `alias` is the team-unique stable selector used as
 * both a chat `to_aliases` target and an issue `assignee_id`.
 *
 * Goes through the shared `authedRequest` helper (Bearer JWT + the
 * `X-AWEB-Team-Id` header), so the team id is passed through explicitly.
 */

import { authedRequest } from "./http";

/** Authoritative participant kind, derived by the server from `agent_type`. */
export type ParticipantKind = "human" | "agent";

/**
 * A single team participant (human or agent). `kind` is authoritative; the UI
 * keys on it and never guesses. Presence applies to any participant that
 * heartbeats: a signed-in human (via POST /v1/presence/heartbeat) and an agent
 * (via its own heartbeat) both carry live `online`/`status`/`last_seen`.
 */
export interface Participant {
  /** AUTHORITATIVE. "human" iff agent_type === 'human', else "agent". */
  kind: ParticipantKind;
  /** Team-unique stable selector. Used as chat `to_aliases` + issue `assignee_id`. */
  alias: string;
  /** human_name for humans; alias for agents when blank. */
  display_name: string;
  /** agents.agent_id (UUID) when present. */
  agent_id: string | null;
  did_key: string | null;
  did_aw: string | null;
  /** "team_id/alias". */
  address: string | null;
  role: string | null;
  /** Raw passthrough of agents.agent_type ("human" | "agent" | ...). */
  agent_type: string;
  /** True for any participant (human or agent) with live presence. */
  online: boolean;
  /** "active" when a fresh presence record exists, else "offline". */
  status: string;
  /** ISO-8601 last-seen, or null when no presence record exists. */
  last_seen: string | null;
}

export interface ListParticipantsResponse {
  team_id: string;
  participants: Participant[];
}

/**
 * List ALL participants in a team — humans and agents — with an authoritative
 * `kind`. Non-admin: available to any team-scoped caller. Returns [] when no
 * team is selected.
 */
export async function listParticipants(
  teamId: string | null,
): Promise<Participant[]> {
  if (!teamId) return [];
  const res = await authedRequest<ListParticipantsResponse>("/v1/participants", {
    teamId,
  });
  return res.participants ?? [];
}
