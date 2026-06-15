"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@/lib/api/http";
import { addComment, listComments } from "@/lib/api/comments";
import type { IssueComment } from "@/lib/api/comments";
import { listAgents } from "@/lib/api/members";
import styles from "./issue-thread.module.css";

/**
 * Issue conversation thread + composer (CONTRACTS.md §3a/3b).
 *
 * This is the human<->agent discussion surface on an issue: a comment posted
 * here and a comment posted by an agent (via the `issues_comment_add` MCP tool)
 * land in the same thread. We render each comment with the author alias, body,
 * and time, and visually distinguish agents from humans.
 *
 * Agent vs human: comments only carry an `author` alias. We classify an author
 * as an *agent* when its alias is present in `listAgents(teamId)` (the agents
 * roster); everyone else is rendered as a human. Agents have no flag on the
 * comment payload itself, so the roster is the only signal available without
 * the admin-only members endpoint.
 */
export function IssueThread({
  issueId,
  teamId,
}: {
  issueId: string;
  teamId: string | null;
}) {
  const [comments, setComments] = useState<IssueComment[]>([]);
  const [agentAliases, setAgentAliases] = useState<Set<string>>(new Set());
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!teamId) {
      setComments([]);
      setLoading(false);
      return;
    }
    try {
      const list = await listComments(issueId, teamId);
      setComments(list);
      setError(null);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : "Failed to load comments.",
      );
    } finally {
      setLoading(false);
    }
  }, [issueId, teamId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Roster of agent aliases, used purely to tag a comment author as an agent.
  // Failure here is non-fatal — authors just render as humans.
  useEffect(() => {
    let cancelled = false;
    if (!teamId) return;
    void (async () => {
      try {
        const agents = await listAgents(teamId);
        if (!cancelled) {
          setAgentAliases(new Set(agents.map((a) => a.alias)));
        }
      } catch {
        if (!cancelled) setAgentAliases(new Set());
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed || !teamId) return;
    setBusy(true);
    setError(null);
    try {
      await addComment(issueId, trimmed, teamId);
      setBody("");
      await load();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : "Failed to post comment.",
      );
    } finally {
      setBusy(false);
    }
  }

  const isEmpty = !loading && comments.length === 0;

  if (!teamId) {
    return (
      <p className={styles.empty}>Select a team to view this conversation.</p>
    );
  }

  return (
    <div>
      {loading ? (
        <p className={styles.empty}>Loading conversation…</p>
      ) : isEmpty ? (
        <div className={styles.thread}>
          <p className={styles.emptyThread}>
            No comments yet. Start the conversation.
          </p>
        </div>
      ) : (
        <ul className={styles.thread}>
          {comments.map((c) => (
            <CommentRow
              key={c.comment_id}
              comment={c}
              isAgent={agentAliases.has(c.author)}
            />
          ))}
        </ul>
      )}

      <form onSubmit={submit} className={styles.composer}>
        <textarea
          className={styles.composerInput}
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment…"
          aria-label="New comment"
        />
        <div className={styles.composerActions}>
          <button
            type="submit"
            className="btn btn-primary"
            style={{ width: "auto", marginTop: 0 }}
            disabled={busy || !body.trim()}
          >
            {busy ? "Posting…" : "Comment"}
          </button>
          {error ? <span className={styles.errorInline}>{error}</span> : null}
        </div>
      </form>
    </div>
  );
}

function CommentRow({
  comment,
  isAgent,
}: {
  comment: IssueComment;
  isAgent: boolean;
}) {
  const initial = comment.author.trim().slice(0, 1).toUpperCase() || "?";
  return (
    <li className={styles.comment}>
      <div
        className={`${styles.avatar} ${isAgent ? styles.avatarAgent : styles.avatarHuman}`}
        aria-hidden
      >
        {initial}
      </div>
      <div className={styles.commentBubble}>
        <div className={styles.commentMeta}>
          <span className={styles.commentAuthor}>{comment.author}</span>
          <span
            className={`${styles.kindBadge} ${isAgent ? styles.kindAgent : styles.kindHuman}`}
          >
            {isAgent ? "agent" : "human"}
          </span>
          {comment.created_at ? (
            <span className={styles.commentTime}>
              {formatTime(comment.created_at)}
            </span>
          ) : null}
        </div>
        <div className={styles.commentBody}>{comment.body}</div>
      </div>
    </li>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
