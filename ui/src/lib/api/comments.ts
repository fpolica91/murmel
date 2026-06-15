/**
 * Typed wrappers for the issue-comment endpoints, per CONTRACTS.md §3a/3b.
 *
 *   - listComments(issueId, teamId)        -> GET  /v1/issues/{id}/comments
 *   - addComment(issueId, body, teamId)    -> POST /v1/issues/{id}/comments
 *
 * Comments are the human<->agent discussion surface on an issue: an agent
 * posting via the `issues_comment_add` MCP tool and a human posting from this
 * UI share the same thread. `author` is the caller's alias (human or agent);
 * the server fills it in from the authenticated identity, so we never send it.
 *
 * These go through the shared `authedRequest` helper (Bearer JWT + the
 * `X-AWEB-Team-Id` header) — they do NOT use the work-hierarchy `workApi`
 * client, so the team id must be passed through explicitly.
 */

import { authedRequest } from "./http";

/** A single comment on an issue. `created_at` is ISO-8601 (or null). */
export interface IssueComment {
  comment_id: string;
  issue_id: string;
  /** Alias of the author (human or agent). */
  author: string;
  body: string;
  created_at: string | null;
}

export interface ListCommentsResponse {
  issue_id: string;
  comments: IssueComment[];
}

/**
 * List the comments on an issue, oldest-first.
 * `GET /v1/issues/{issue_id}/comments`.
 */
export async function listComments(
  issueId: string,
  teamId: string | null,
): Promise<IssueComment[]> {
  const res = await authedRequest<ListCommentsResponse>(
    `/v1/issues/${encodeURIComponent(issueId)}/comments`,
    { teamId },
  );
  return res.comments ?? [];
}

/**
 * Post a comment on an issue (1–16384 chars). The author is the authenticated
 * caller; the server fills it in. Returns the created comment.
 * `POST /v1/issues/{issue_id}/comments`.
 */
export async function addComment(
  issueId: string,
  body: string,
  teamId: string | null,
): Promise<IssueComment> {
  return authedRequest<IssueComment>(
    `/v1/issues/${encodeURIComponent(issueId)}/comments`,
    { method: "POST", teamId, body: { body } },
  );
}
