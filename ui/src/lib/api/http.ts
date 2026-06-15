/**
 * Shared authed HTTP helper for the collaboration UI.
 *
 * This mirrors the token-mint + Bearer + team-header pattern in `client.ts`,
 * but is reusable by feature modules (chat, members, issue collaboration)
 * without coupling them to the work-hierarchy `workApi` surface.
 *
 * The aweb Python server verifies the short-lived JWT minted by this UI's
 * Better Auth handler at `/api/auth/token`. We fetch that token (same-origin,
 * cookie-authenticated) and attach it as a Bearer credential, plus the active
 * team id as `X-AWEB-Team-Id`, on every server call.
 *
 * Base URL: `NEXT_PUBLIC_AWEB_API_URL` (the aweb server origin). Falls back to
 * the local default `http://localhost:8088`.
 *
 * NOTE: This file is a SHARED helper. Do NOT edit it from a feature lane.
 */

const API_BASE = (
  process.env.NEXT_PUBLIC_AWEB_API_URL ?? "http://localhost:8088"
).replace(/\/+$/, "");

/** Matches TeamProvider's STORAGE_KEY in components/team-context.tsx. */
const ACTIVE_TEAM_STORAGE_KEY = "aweb.activeTeam";

/** The team-scoping header the aweb server reads (mirrors client.ts). */
const TEAM_HEADER = "x-aweb-team-id";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Mint (or reuse) a JWT for the current session via Better Auth's local token
 * endpoint. Same-origin so the session cookie is sent automatically. Returns
 * null when no session / token is available (callers should treat that as
 * unauthenticated rather than crash).
 */
export async function getAccessToken(): Promise<string | null> {
  try {
    const origin = typeof window !== "undefined" ? window.location.origin : "";
    const res = await fetch(`${origin}/api/auth/token`, {
      method: "GET",
      credentials: "include",
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { token?: string };
    return data.token ?? null;
  } catch {
    return null;
  }
}

/** Read the active team id from localStorage (set by the team switcher). */
function readActiveTeamId(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ACTIVE_TEAM_STORAGE_KEY);
}

export interface AuthedRequestOptions {
  method?: string;
  query?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  /**
   * Active team id to scope the request to. Prefer passing this explicitly
   * from `useTeam().activeTeam` in client components. When omitted, falls back
   * to the persisted team id in localStorage.
   */
  teamId?: string | null;
  signal?: AbortSignal;
}

/**
 * Perform an authenticated request against the aweb server.
 *
 * - Prefixes `NEXT_PUBLIC_AWEB_API_URL`.
 * - Attaches `Authorization: Bearer <jwt>` (minted same-origin).
 * - Attaches `X-AWEB-Team-Id` from `opts.teamId` (or localStorage fallback).
 * - Serializes `body` as JSON; parses JSON responses; returns `undefined` for
 *   204 No Content.
 * - Throws `ApiError(status, detail, body)` on non-2xx.
 *
 * @example
 *   const { agents } = await authedRequest<ListAgentsResponse>(
 *     `/v1/agents`,
 *     { teamId },
 *   );
 */
export async function authedRequest<T>(
  path: string,
  opts: AuthedRequestOptions = {},
): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;

  const teamId =
    opts.teamId !== undefined ? opts.teamId : readActiveTeamId();
  if (teamId) headers[TEAM_HEADER] = teamId;

  const res = await fetch(url.toString(), {
    method: opts.method ?? "GET",
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    signal: opts.signal,
  });

  if (res.status === 204) return undefined as T;

  let payload: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = text;
    }
  }

  if (!res.ok) {
    const detail =
      (payload as { detail?: string })?.detail ??
      `Request failed: ${res.status} ${res.statusText}`;
    throw new ApiError(res.status, detail, payload);
  }

  return payload as T;
}
