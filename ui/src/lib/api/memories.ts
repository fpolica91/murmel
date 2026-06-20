/**
 * Typed wrappers for the team shared-memory endpoints.
 *
 *   - listMemories(teamId, {q, tags, assignee_alias}) -> GET    /v1/memories
 *   - getMemory(id, teamId)                           -> GET    /v1/memories/{id}
 *   - createMemory(input, teamId)                     -> POST   /v1/memories
 *   - updateMemory(id, patch, teamId)                 -> PATCH  /v1/memories/{id}
 *   - deleteMemory(id, teamId)                        -> DELETE /v1/memories/{id}
 *
 * Memory is the team's shared knowledge base: agents read it on session start
 * (via the `memory_search` MCP tool) and write what they learn; this UI is the
 * human window onto the same store. Calls go through the shared `authedRequest`
 * helper (Bearer JWT + `X-AWEB-Team-Id`), so the team id is passed explicitly.
 * `created_by_alias` is stamped server-side from the caller — never sent.
 */

import { authedRequest } from "./http";

export interface Memory {
  memory_id: string;
  team_id: string;
  title: string;
  body_md: string;
  tags: string[];
  /** Alias of the author (human or agent), filled server-side. */
  created_by_alias: string | null;
  /** Optional per-agent scope: renders "private to X". A soft signal, not an ACL. */
  assignee_alias: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListMemoriesResponse {
  memories: Memory[];
}

export interface CreateMemoryInput {
  title: string;
  body_md?: string;
  tags?: string[];
  assignee_alias?: string | null;
}

export interface UpdateMemoryPatch {
  title?: string;
  body_md?: string;
  tags?: string[];
  assignee_alias?: string | null;
}

/** List team memories. Empty `q` returns most-recent-first (session-start order). */
export async function listMemories(
  teamId: string | null,
  opts: { q?: string; tags?: string[]; assignee_alias?: string } = {},
): Promise<Memory[]> {
  const res = await authedRequest<ListMemoriesResponse>("/v1/memories", {
    teamId,
    query: {
      q: opts.q || undefined,
      // The server takes a comma-separated `tag` (OR-facet); join the chip set.
      tag: opts.tags && opts.tags.length ? opts.tags.join(",") : undefined,
      assignee_alias: opts.assignee_alias || undefined,
    },
  });
  return res.memories ?? [];
}

export function getMemory(id: string, teamId: string | null): Promise<Memory> {
  return authedRequest<Memory>(`/v1/memories/${encodeURIComponent(id)}`, {
    teamId,
  });
}

export function createMemory(
  input: CreateMemoryInput,
  teamId: string | null,
): Promise<Memory> {
  return authedRequest<Memory>("/v1/memories", {
    method: "POST",
    teamId,
    body: input,
  });
}

export function updateMemory(
  id: string,
  patch: UpdateMemoryPatch,
  teamId: string | null,
): Promise<Memory> {
  return authedRequest<Memory>(`/v1/memories/${encodeURIComponent(id)}`, {
    method: "PATCH",
    teamId,
    body: patch,
  });
}

export function deleteMemory(id: string, teamId: string | null): Promise<void> {
  return authedRequest<void>(`/v1/memories/${encodeURIComponent(id)}`, {
    method: "DELETE",
    teamId,
  });
}
