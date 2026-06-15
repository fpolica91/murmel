/**
 * Resolve the aweb-specific JWT claims for a subject.
 *
 * IMPORTANT: the values returned here (team_ids, roles) are only a *hint*
 * stamped onto the token for convenience. The aweb server treats the
 * `memberships` table as the source of truth and re-authorizes every request
 * against it. So this lookup does NOT need to be perfectly fresh — a slightly
 * stale hint is fine and never grants access on its own.
 *
 * Where do the hints come from? Two acceptable strategies:
 *   1. Query the aweb server DB's `memberships` table directly (read-only).
 *   2. Call an aweb server endpoint that returns the caller's active teams.
 *
 * This scaffold ships a pluggable stub so the lane that owns server wiring can
 * choose. Until then it emits empty hints, which is SAFE: the server derives
 * real authorization from `memberships` regardless of the hint.
 */

export interface SubjectClaims {
  /** Teams the subject belongs to (HINT only — server re-checks memberships). */
  teamIds: string[];
  /** Role hints, e.g. ["member"] or ["owner"]. */
  roles: string[];
  /** Set when the subject is an agent rather than a human. */
  agentName?: string;
}

/**
 * Look up claim hints for a subject id (Better Auth user id == JWT `sub`).
 *
 * Replace the body with a real `memberships` lookup during server integration
 * (see follow_ups). Reading directly from the aweb DB:
 *
 *   SELECT team_id, role FROM memberships
 *   WHERE subject = $1 AND status = 'active';
 *
 * map team_id -> teamIds, distinct role -> roles.
 */
export async function resolveSubjectClaims(
  subjectId: string,
): Promise<SubjectClaims> {
  // Optional: if AWEB_MEMBERSHIPS_URL is set, fetch hints from the server.
  const membershipsUrl = process.env.AWEB_MEMBERSHIPS_URL;
  if (membershipsUrl) {
    try {
      const res = await fetch(
        `${membershipsUrl}?subject=${encodeURIComponent(subjectId)}`,
        { headers: { accept: "application/json" } },
      );
      if (res.ok) {
        const data = (await res.json()) as {
          team_ids?: string[];
          roles?: string[];
          agent_name?: string;
        };
        return {
          teamIds: data.team_ids ?? [],
          roles: data.roles ?? [],
          agentName: data.agent_name,
        };
      }
    } catch {
      // Fall through to empty hints — server still authorizes via memberships.
    }
  }

  return { teamIds: [], roles: [] };
}
