/**
 * Typed wrappers for the workspace control-plane endpoints
 * (the workspaces_router, `/v1/workspaces`, in
 * server/.../coordination/routes/workspaces.py).
 *
 * A "workspace" is the server-side row backing an AGENT (one `.murmel/`
 * directory bound to a team). It carries the agent's coordination role
 * (`role`/`role_name`) plus presence and identity. This client is the
 * operator role-assignment surface: it lists workspaces (to map an agent
 * `alias` -> its `workspace_id`) and PATCHes the role on one workspace.
 *
 *   - listWorkspaces(teamId)                  -> GET   /v1/workspaces
 *   - setWorkspaceRole(id, roleName, teamId)  -> PATCH /v1/workspaces/{id}
 *
 * Why the UNFILTERED list (`GET /v1/workspaces`, not `/online`): the operator
 * must be able to (re)role an OFFLINE agent too. The root list returns every
 * registered workspace for the team, including `status:"offline"` rows; the
 * `/online` variant would hide them. It paginates (default 50, max 200), so we
 * request `limit=200` to get the full team roster in one call.
 *
 * Role semantics (confirmed against the server models): the PATCH body's
 * `role` and `role_name` are synced server-side (`resolve_role_name_aliases`) —
 * sending `role_name` sets BOTH. The server normalizes the name the same way
 * `roles.ts#normalizeRoleName` does. Setting a role does NOT refresh Redis
 * presence, so callers should reconcile from a reload rather than trust the
 * optimistic value indefinitely.
 *
 * Goes through the shared `authedRequest` helper (Bearer JWT + the
 * `X-AWEB-Team-Id` header); the team id is passed through explicitly,
 * mirroring `members.ts` / `roles.ts`. Token-auth only — no certificate path.
 */

import { authedRequest } from "./http";

/** Page size for the roster fetch — the server caps this at 200. */
const WORKSPACES_PAGE_LIMIT = 200;

/**
 * One workspace row from `GET /v1/workspaces`. This mirrors the server's
 * `WorkspaceInfo` but only types the fields this surface needs; `alias` is the
 * team-unique selector we match a `Participant` on, `workspace_id` is the PATCH
 * target, and `role`/`role_name` carry the currently-assigned coordination role
 * (the server keeps them in sync, so they are equal in practice).
 */
export interface Workspace {
  workspace_id: string;
  alias: string;
  role: string | null;
  role_name: string | null;
  /** "active" | "idle" | "offline" — offline rows ARE included here. */
  status: string;
}

export interface ListWorkspacesResponse {
  workspaces: Workspace[];
  has_more: boolean;
  next_cursor: string | null;
}

/** `PATCH /v1/workspaces/{id}` response. */
export interface UpdateWorkspaceResponse {
  workspace_id: string;
  alias: string;
  updated: boolean;
}

/**
 * List the team's workspaces (agents), INCLUDING offline ones, so an operator
 * can map an agent `alias` to its `workspace_id` and re-role it regardless of
 * presence. Returns [] when no team is selected. One page of up to 200 rows —
 * enough for any realistic team roster.
 */
export async function listWorkspaces(
  teamId: string | null,
): Promise<Workspace[]> {
  if (!teamId) return [];
  const res = await authedRequest<ListWorkspacesResponse>("/v1/workspaces", {
    teamId,
    query: { limit: WORKSPACES_PAGE_LIMIT, include_presence: true },
  });
  return res.workspaces ?? [];
}

/**
 * Assign (or change) the coordination role on one workspace.
 * `PATCH /v1/workspaces/{workspace_id}` with `{ role_name }`. The server syncs
 * `role` from `role_name`, normalizes it, and returns `{ workspace_id, alias,
 * updated }`. This does NOT refresh Redis presence — reconcile by reloading the
 * roster afterwards.
 */
export async function setWorkspaceRole(
  workspaceId: string,
  roleName: string,
  teamId: string | null,
): Promise<UpdateWorkspaceResponse> {
  return authedRequest<UpdateWorkspaceResponse>(
    `/v1/workspaces/${encodeURIComponent(workspaceId)}`,
    {
      method: "PATCH",
      teamId,
      body: { role_name: roleName },
    },
  );
}
