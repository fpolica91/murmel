/**
 * Typed wrapper for the team task/issue claims endpoint.
 *
 *   - listClaims(teamId) -> GET /v1/claims
 *
 * A claim is an active-work marker: it indicates which workspace is currently
 * working on which task/issue within the team (stamped when an agent claims
 * work and marks it in progress). Claims do NOT expire and there is no
 * release endpoint — they clear when the underlying work moves on. This is the
 * read-only "who is on what right now" half of the monitor.
 *
 * Calls go through the shared `authedRequest` helper (Bearer JWT +
 * `X-AWEB-Team-Id`), so the team id is passed explicitly from
 * `useTeam().activeTeam`.
 */

import { authedRequest } from "./http";

export interface Claim {
  /** The task/issue reference this workspace is actively working on. */
  task_ref: string;
  workspace_id: string;
  /** Holder alias (human or agent) of the claiming workspace. */
  alias: string;
  /** Friendly human name behind the alias, when known. */
  human_name: string | null;
  /** ISO timestamp the claim was made. */
  claimed_at: string;
  team_id: string;
}

export interface ListClaimsResponse {
  claims: Claim[];
  has_more: boolean;
  next_cursor: string | null;
}

/** List active task/issue claims for the team, most-recently-claimed first. */
export async function listClaims(teamId: string | null): Promise<Claim[]> {
  const res = await authedRequest<ListClaimsResponse>("/v1/claims", {
    teamId,
  });
  return res.claims ?? [];
}
