/**
 * Typed client for the aweb server REST contract.
 *
 * The aweb Python server is a *verifier*: it accepts the short-lived JWT minted
 * by this UI's Better Auth handler at `/api/auth/token`. We fetch that token
 * (same-origin, cookie-authenticated) and attach it as a Bearer credential on
 * every server call. The live server need not be running for type-checking /
 * rendering — calls simply reject at runtime when it is unavailable.
 *
 * Base URL: `NEXT_PUBLIC_AWEB_API_URL` (the aweb server origin). Falls back to
 * the local default. This must match the `aud` the server verifies
 * (`AWEB_JWT_AUDIENCE`).
 */

import type {
  CreateIssueInput,
  Epic,
  EpicListResponse,
  Issue,
  IssueListFilters,
  IssueListResponse,
  Story,
  StoryListResponse,
  UpdateIssueInput,
  UpdateIssueStatusInput,
} from "./types";

const API_BASE = (
  process.env.NEXT_PUBLIC_AWEB_API_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");

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
 * endpoint. Same-origin so the session cookie is sent automatically.
 */
async function getAccessToken(): Promise<string | null> {
  try {
    const origin =
      typeof window !== "undefined" ? window.location.origin : "";
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

interface RequestOptions {
  method?: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const token = await getAccessToken();
  const url = new URL(`${API_BASE}${path}`);
  if (opts.query) {
    for (const [key, value] of Object.entries(opts.query)) {
      if (value !== undefined && value !== "") {
        url.searchParams.set(key, value);
      }
    }
  }

  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  if (token) headers["authorization"] = `Bearer ${token}`;
  // Scope the request to the active team so multi-team subjects hit the right
  // team (single-team subjects work without it via the server's sole-membership
  // fallback). Key mirrors TeamProvider's STORAGE_KEY ("aweb.activeTeam").
  const activeTeam =
    typeof window !== "undefined"
      ? window.localStorage.getItem("aweb.activeTeam")
      : null;
  if (activeTeam) headers["x-aweb-team-id"] = activeTeam;

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

/** Strongly-typed surface over the work-hierarchy endpoints. */
export const workApi = {
  // ----- Epics -----------------------------------------------------------
  async listEpics(filters: { status?: string } = {}): Promise<Epic[]> {
    const res = await request<EpicListResponse>("/v1/epics", {
      query: { status: filters.status },
    });
    return res.epics ?? [];
  },

  async getEpic(epicId: string): Promise<Epic> {
    return request<Epic>(`/v1/epics/${encodeURIComponent(epicId)}`);
  },

  // ----- Stories ---------------------------------------------------------
  async listStories(
    filters: { status?: string; epic_id?: string } = {},
  ): Promise<Story[]> {
    const res = await request<StoryListResponse>("/v1/stories", {
      query: { status: filters.status, epic_id: filters.epic_id },
    });
    return res.stories ?? [];
  },

  async getStory(storyId: string): Promise<Story> {
    return request<Story>(`/v1/stories/${encodeURIComponent(storyId)}`);
  },

  // ----- Issues ----------------------------------------------------------
  async listIssues(filters: IssueListFilters = {}): Promise<Issue[]> {
    const res = await request<IssueListResponse>("/v1/issues", {
      query: {
        status: filters.status,
        assignee_type: filters.assignee_type,
        assignee_id: filters.assignee_id,
        epic_id: filters.epic_id,
        story_id: filters.story_id,
      },
    });
    return res.issues ?? [];
  },

  async getIssue(issueId: string): Promise<Issue> {
    return request<Issue>(`/v1/issues/${encodeURIComponent(issueId)}`);
  },

  async createIssue(input: CreateIssueInput): Promise<Issue> {
    return request<Issue>("/v1/issues", { method: "POST", body: input });
  },

  async updateIssue(
    issueId: string,
    input: UpdateIssueInput,
  ): Promise<Issue> {
    return request<Issue>(`/v1/issues/${encodeURIComponent(issueId)}`, {
      method: "PATCH",
      body: input,
    });
  },

  async updateIssueStatus(
    issueId: string,
    input: UpdateIssueStatusInput,
  ): Promise<Issue> {
    return request<Issue>(`/v1/issues/${encodeURIComponent(issueId)}`, {
      method: "PATCH",
      body: input,
    });
  },
};
