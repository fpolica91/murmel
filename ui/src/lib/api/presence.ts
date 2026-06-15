/**
 * Thin wrapper for the presence heartbeat endpoint.
 *
 *   - sendHeartbeat(teamId) -> POST /v1/presence/heartbeat
 *
 * The aweb server marks the calling (token / human) identity online by writing
 * a Redis presence record keyed by the human's real `agent_id` UUID, with a
 * server-side TTL (120s). The request carries no body; the team is scoped via
 * the `X-AWEB-Team-Id` header that `authedRequest` attaches.
 *
 * Goes through the shared `authedRequest` helper (Bearer JWT + team header);
 * the shared helper itself is NOT modified.
 */

import { authedRequest } from "./http";

/** Server response for a successful heartbeat. */
export interface HeartbeatResponse {
  agent_id: string;
  alias: string;
  online: boolean;
  last_seen: string;
}

/**
 * Send a presence heartbeat for the active team. Returns the server's view
 * (online + last_seen). Throws `ApiError` on a non-2xx response.
 */
export async function sendHeartbeat(
  teamId: string | null,
  signal?: AbortSignal,
): Promise<HeartbeatResponse> {
  return authedRequest<HeartbeatResponse>("/v1/presence/heartbeat", {
    method: "POST",
    teamId,
    signal,
  });
}
