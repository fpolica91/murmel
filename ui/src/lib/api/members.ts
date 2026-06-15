/**
 * Typed wrappers for the two "who is on this team" surfaces:
 *
 *   - listAgents(teamId)  -> GET /v1/agents               (agent workspaces +
 *                                                           presence)
 *   - listMembers(teamId) -> GET /v1/teams/{teamId}/members (human memberships;
 *                                                           ADMIN-ONLY)
 *
 * The aweb backend models humans and agents in two different places:
 *
 *   * AGENTS live in the `agents`/`workspaces` tables and carry presence
 *     (online/last_seen/status). `GET /v1/agents` EXPLICITLY EXCLUDES rows
 *     whose `agent_type == 'human'`, so this endpoint is "the agents only".
 *
 *   * HUMAN MEMBERS live in the `memberships` table keyed by Better Auth
 *     `subject`. `GET /v1/teams/{teamId}/members` lists them, but it is
 *     ADMIN/OWNER-ONLY and returns 403 to non-admins. There is NO presence
 *     data for human members and NO display name — only `subject`, `role`,
 *     and `status`. Callers must degrade gracefully on 403.
 *
 * NOTE: This file is a SHARED helper. Do NOT edit it from a feature lane.
 */

import { authedRequest } from "./http";

// ---------------------------------------------------------------------------
// Agents (GET /v1/agents)
// ---------------------------------------------------------------------------

/** A team agent (NOT a human). Presence fields come from Redis heartbeats. */
export interface Agent {
  agent_id: string;
  alias: string;
  did_key: string;
  did_aw: string | null;
  address: string | null;
  human_name: string | null;
  /** "agent" | "human" | ... — this endpoint only ever returns non-human. */
  agent_type: string | null;
  workspace_type: string | null;
  role: string | null;
  role_name: string | null;
  hostname: string | null;
  workspace_path: string | null;
  repo: string | null;
  /** "offline" when no live presence, else the presence status. */
  status: string;
  /** ISO-8601 timestamp of last presence, or null if never/offline. */
  last_seen: string | null;
  /** True when there is a live Redis presence record. */
  online: boolean;
  identity_scope: string;
  inbound_mode: string | null;
}

export interface ListAgentsResponse {
  team_id: string;
  agents: Agent[];
}

/**
 * List the AGENTS in a team (excludes humans). Includes presence
 * (online/status/last_seen). Available to any team-scoped caller.
 */
export async function listAgents(
  teamId: string | null,
): Promise<Agent[]> {
  const res = await authedRequest<ListAgentsResponse>("/v1/agents", {
    teamId,
  });
  return res.agents ?? [];
}

// ---------------------------------------------------------------------------
// Members (GET /v1/teams/{teamId}/members) — ADMIN ONLY
// ---------------------------------------------------------------------------

/**
 * A human membership row. `subject` is the Better Auth user id (the JWT `sub`).
 * There is no display name and no presence on this surface.
 */
export interface Member {
  subject: string;
  team_id: string;
  /** Free-form label, e.g. "member" | "admin" | "owner". */
  role: string;
  /** "active" | "suspended". */
  status: string;
  created_at: string | null;
  updated_at: string | null;
}

export interface ListMembersResponse {
  team_id: string;
  members: Member[];
}

/**
 * List the HUMAN members of a team. ADMIN/OWNER-ONLY: this throws
 * `ApiError` with status 403 for non-admin callers. Features that show
 * members to everyone should catch that and degrade (e.g. show agents only).
 */
export async function listMembers(
  teamId: string,
): Promise<Member[]> {
  const res = await authedRequest<ListMembersResponse>(
    `/v1/teams/${encodeURIComponent(teamId)}/members`,
    { teamId },
  );
  return res.members ?? [];
}
