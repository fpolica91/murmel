/**
 * Typed wrappers for the team coordination-roles endpoints (the roles_router,
 * `/v1/roles`, in server/.../coordination/routes/team_roles.py).
 *
 * Coordination roles are the team's shared playbook bundle: a map of named
 * roles, each with a `title` and a markdown `playbook_md`. Agents read them via
 * the `roles_show` MCP tool; humans curate them from this UI. The bundle is
 * VERSIONED and copy-on-write — every change writes a NEW version and activates
 * it; the previous version stays in history.
 *
 *   - fetchActiveRoles(teamId)              -> GET  /v1/roles/active
 *   - createRolesBundle(bundle, baseId, …)  -> POST /v1/roles
 *   - activateRolesBundle(id, teamId)       -> POST /v1/roles/{id}/activate
 *   - fetchRolesHistory(teamId)             -> GET  /v1/roles/history
 *   - resetRoles(teamId)                    -> POST /v1/roles/reset
 *
 * The active response carries roles at the TOP LEVEL (`roles`, `adapters`) plus
 * the version's `team_roles_id` — that id is the optimistic-concurrency token:
 * pass it as `base_team_roles_id` when writing so a stale write 409s instead of
 * clobbering a concurrent edit (see CONFLICT_STATUS).
 *
 * These go through the shared `authedRequest` helper (Bearer JWT + the
 * `X-AWEB-Team-Id` header); the team id is passed through explicitly, mirroring
 * `comments.ts`. Token-auth only — no certificate / signing path.
 */

import { authedRequest } from "./http";

/** HTTP status the server returns when `base_team_roles_id` is stale. */
export const ROLES_CONFLICT_STATUS = 409;

/** A single named role definition: a title and a markdown playbook. */
export interface RoleDefinition {
  title: string;
  playbook_md: string;
}

/** The curated bundle: named roles plus opaque adapter config (passed through). */
export interface RolesBundle {
  roles: Record<string, RoleDefinition>;
  adapters: Record<string, unknown>;
}

/**
 * `GET /v1/roles/active` response. Roles + adapters are at the top level (not
 * nested under `bundle`). `team_roles_id` identifies this active version and is
 * the concurrency token for the next write.
 */
export interface ActiveRolesResponse {
  team_roles_id: string;
  active_team_roles_id: string | null;
  team_id: string;
  version: number;
  updated_at: string | null;
  roles: Record<string, RoleDefinition>;
  adapters: Record<string, unknown>;
}

/** `POST /v1/roles` response: the freshly created (not yet active) version. */
export interface CreateRolesResponse {
  team_roles_id: string;
  team_id: string;
  version: number;
  created: boolean;
}

/** `POST /v1/roles/{id}/activate` response. */
export interface ActivateRolesResponse {
  activated: boolean;
  active_team_roles_id: string;
}

/** `POST /v1/roles/reset` response: the new active default version. */
export interface ResetRolesResponse {
  reset: boolean;
  active_team_roles_id: string;
  version: number;
}

/** One row in the version history list. */
export interface RolesHistoryItem {
  team_roles_id: string;
  version: number;
  created_at: string;
  created_by_alias: string | null;
  is_active: boolean;
}

export interface RolesHistoryResponse {
  team_roles_versions: RolesHistoryItem[];
}

/**
 * Fetch the team's active roles bundle. The server bootstraps an empty active
 * bundle on first read, so this resolves for a brand-new team too.
 * `GET /v1/roles/active`.
 */
export async function fetchActiveRoles(
  teamId: string | null,
): Promise<ActiveRolesResponse> {
  return authedRequest<ActiveRolesResponse>("/v1/roles/active", { teamId });
}

/**
 * Create a new roles version from a full bundle. Pass `baseId` (the current
 * active `team_roles_id`) as `base_team_roles_id` so a concurrent edit causes a
 * {@link ROLES_CONFLICT_STATUS} instead of silently overwriting. The created
 * version is NOT active until {@link activateRolesBundle}. `POST /v1/roles`.
 */
export async function createRolesBundle(
  bundle: RolesBundle,
  baseId: string | null,
  teamId: string | null,
): Promise<CreateRolesResponse> {
  return authedRequest<CreateRolesResponse>("/v1/roles", {
    method: "POST",
    teamId,
    body: { bundle, base_team_roles_id: baseId },
  });
}

/**
 * Activate a previously created version as the team's live bundle.
 * `POST /v1/roles/{team_roles_id}/activate`.
 */
export async function activateRolesBundle(
  id: string,
  teamId: string | null,
): Promise<ActivateRolesResponse> {
  return authedRequest<ActivateRolesResponse>(
    `/v1/roles/${encodeURIComponent(id)}/activate`,
    { method: "POST", teamId },
  );
}

/**
 * List recent roles versions, newest-first.
 * `GET /v1/roles/history`.
 */
export async function fetchRolesHistory(
  teamId: string | null,
): Promise<RolesHistoryItem[]> {
  const res = await authedRequest<RolesHistoryResponse>("/v1/roles/history", {
    teamId,
  });
  return res.team_roles_versions ?? [];
}

/**
 * Reset the team's active roles to the platform default bundle (writes +
 * activates a fresh version). `POST /v1/roles/reset`.
 */
export async function resetRoles(
  teamId: string | null,
): Promise<ResetRolesResponse> {
  return authedRequest<ResetRolesResponse>("/v1/roles/reset", {
    method: "POST",
    teamId,
  });
}

// --------------------------------------------------------------------------
// Pure bundle helpers (no I/O). Copy-on-write: each returns a NEW bundle so the
// caller can POST it as the next version without mutating current state.
// --------------------------------------------------------------------------

/** Insert or replace a role by name, returning a new bundle. */
export function upsertRole(
  bundle: RolesBundle,
  name: string,
  def: RoleDefinition,
): RolesBundle {
  return {
    ...bundle,
    roles: { ...bundle.roles, [name]: def },
    adapters: { ...bundle.adapters },
  };
}

/** Remove a role by name, returning a new bundle. No-op if absent. */
export function deleteRole(bundle: RolesBundle, name: string): RolesBundle {
  const roles = { ...bundle.roles };
  delete roles[name];
  return { ...bundle, roles, adapters: { ...bundle.adapters } };
}

// Role-name rules, mirrored from the server (coordination/roles.py):
//   ROLE_MAX_LENGTH = 50, ROLE_MAX_WORDS = 2,
//   ROLE_WORD_PATTERN = ^[a-zA-Z0-9][a-zA-Z0-9_-]*$
// normalize = trim + collapse internal whitespace + lowercase.
const ROLE_MAX_LENGTH = 50;
const ROLE_MAX_WORDS = 2;
const ROLE_WORD_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;
export const ROLE_NAME_ERROR =
  "Invalid role: use 1-2 words (letters/numbers) with hyphens/underscores allowed; max 50 chars";

/**
 * Normalize a role name exactly as the server does: trim, collapse runs of
 * whitespace to single spaces, lowercase. The server stores the normalized
 * form, so the UI sends that to keep names stable across humans + agents.
 */
export function normalizeRoleName(name: string): string {
  return name.trim().split(/\s+/).join(" ").toLowerCase();
}

/**
 * Validate a role name against the server's rules. Returns the {@link
 * ROLE_NAME_ERROR} string when invalid, or `null` when valid — so callers can
 * gate a save and surface the message directly.
 */
export function validateRoleName(name: string): string | null {
  if (typeof name !== "string") return ROLE_NAME_ERROR;
  const normalized = normalizeRoleName(name);
  if (!normalized || normalized.length > ROLE_MAX_LENGTH) return ROLE_NAME_ERROR;
  const words = normalized.split(" ");
  if (words.length > ROLE_MAX_WORDS) return ROLE_NAME_ERROR;
  if (!words.every((w) => ROLE_WORD_PATTERN.test(w))) return ROLE_NAME_ERROR;
  return null;
}
