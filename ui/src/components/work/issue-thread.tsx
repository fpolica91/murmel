"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@/lib/api/http";
import { addComment, listComments } from "@/lib/api/comments";
import type { IssueComment } from "@/lib/api/comments";
import { Avatar } from "@/components/ui/avatar";
import { KindBadge } from "@/components/ui/badge";
import { stripAuthorPrefix } from "@/components/ui/message-bubble";
import { Markdown } from "@/components/ui/markdown";
import styles from "./issue-thread.module.css";

/**
 * Issue conversation thread + composer (AUDIT.md §3.4).
 *
 * This is the human<->agent discussion surface on an issue: a comment posted
 * here and a comment posted by an agent (via the `issues_comment_add` MCP tool)
 * land in the same thread. We render each comment with the author alias, body,
 * and time, and visually distinguish agents from humans.
 *
 * Agent vs human: each comment carries an AUTHORITATIVE `author_kind`
 * ("human" | "agent") resolved server-side from the author alias against the
 * participant directory. The UI keys on `author_kind` and NEVER guesses by
 * matching the alias against a roster. Legacy/unresolved comments may omit
 * `author_kind`; we fall back to "agent" (the server's own default).
 */
export function IssueThread({
  issueId,
  teamId,
}: {
  issueId: string;
  teamId: string | null;
}) {
  const [comments, setComments] = useState<IssueComment[]>([]);
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
            <CommentRow key={c.comment_id} comment={c} />
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

function CommentRow({ comment }: { comment: IssueComment }) {
  // Authoritative author kind from the server; default "agent" for legacy rows.
  const kind = (comment.author_kind ?? "agent") === "human" ? "human" : "agent";
  // Drop a redundant "Author:" prefix when it just repeats the rendered author
  // (the header already shows the name + kind badge) — fixes M6.
  const body = stripAuthorPrefix(comment.body, comment.author);
  return (
    <li className={styles.comment}>
      <Avatar label={comment.author} kind={kind} size="md" />
      <div className={styles.commentBubble}>
        <div className={styles.commentMeta}>
          <span className={styles.commentAuthor}>{comment.author}</span>
          <KindBadge kind={kind} />
          {comment.created_at ? (
            <span className={styles.commentTime}>
              {formatTime(comment.created_at)}
            </span>
          ) : null}
        </div>
        <div className={styles.commentBody}>
          <Markdown>{body}</Markdown>
        </div>
      </div>
    </li>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
