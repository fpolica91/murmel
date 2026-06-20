/**
 * Typed wrappers for the team resource-reservation (lock) endpoints.
 *
 *   - listReservations(teamId)                 -> GET  /v1/reservations
 *   - releaseReservation(resource_key, teamId) -> POST /v1/reservations/release
 *
 * A reservation is a soft, team-scoped lock on an arbitrary `resource_key`
 * (a file path, an external system, a migration slot…) with a TTL. The server
 * returns only live (non-expired) reservations and computes
 * `ttl_remaining_seconds` per row. Release is HOLDER-ONLY: the server returns
 * 409 with the current holder if a different caller tries to release a lock
 * they don't own (see ReservationConflict below). The team id is passed
 * explicitly from `useTeam().activeTeam`; identity is derived from the JWT
 * server-side.
 */

import { authedRequest, ApiError } from "./http";

export interface Reservation {
  team_id: string;
  /** The arbitrary resource key under lock (file path, external id, …). */
  resource_key: string;
  /** Agent id of the current holder (uuid). */
  holder_agent_id: string;
  /** Holder alias (human or agent) for display. */
  holder_alias: string;
  /** ISO timestamp the lock was acquired. */
  acquired_at: string;
  /** ISO timestamp the lock expires. */
  expires_at: string;
  /**
   * Seconds left until expiry, computed server-side at fetch time. The client
   * ticks this down 1s locally and reconciles to this value on each refetch.
   */
  ttl_remaining_seconds: number;
  /** Optional human-readable reason ("editing migration", …). */
  reason: string | null;
  metadata: Record<string, unknown>;
}

export interface ListReservationsResponse {
  reservations: Reservation[];
}

export interface ReleaseReservationResponse {
  status: string;
  resource_key: string;
}

/**
 * Shape of the 409 body returned when a non-holder attempts to release (or
 * acquire/renew) a reservation held by someone else.
 */
export interface ReservationConflict {
  detail: string;
  holder_agent_id: string;
  holder_alias: string;
  expires_at: string;
}

/** List live resource locks for the team, ordered by resource key. */
export async function listReservations(
  teamId: string | null,
): Promise<Reservation[]> {
  const res = await authedRequest<ListReservationsResponse>(
    "/v1/reservations",
    { teamId },
  );
  return res.reservations ?? [];
}

/**
 * Release a held reservation. Holder-only on the server: a non-holder gets a
 * 409. Callers should catch {@link ApiError} (status 409) and surface the
 * holder from {@link asReservationConflict}.
 */
export function releaseReservation(
  resourceKey: string,
  teamId: string | null,
): Promise<ReleaseReservationResponse> {
  return authedRequest<ReleaseReservationResponse>(
    "/v1/reservations/release",
    {
      method: "POST",
      teamId,
      body: { resource_key: resourceKey },
    },
  );
}

/**
 * Narrow an {@link ApiError} to a {@link ReservationConflict} when it is a 409
 * carrying a holder. Returns null otherwise, so callers can fall back to a
 * generic message.
 */
export function asReservationConflict(
  err: unknown,
): ReservationConflict | null {
  if (
    err instanceof ApiError &&
    err.status === 409 &&
    err.body &&
    typeof err.body === "object" &&
    "holder_alias" in err.body
  ) {
    return err.body as ReservationConflict;
  }
  return null;
}
