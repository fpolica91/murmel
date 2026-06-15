"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, workApi } from "@/lib/api/client";
import type { Comment } from "@/lib/api/types";
import styles from "./work.module.css";

/**
 * Issue comment thread — the human<->agent discussion surface. Comments posted
 * here (or by an agent via the issues_comment_add MCP tool) share the same
 * thread, so a human and an agent coordinate on the same issue.
 */
export function CommentsThread({ issueId }: { issueId: string }) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setComments(await workApi.listComments(issueId));
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : "Failed to load comments.",
      );
    } finally {
      setLoading(false);
    }
  }, [issueId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = body.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await workApi.addComment(issueId, trimmed);
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

  return (
    <div>
      {loading ? (
        <p className={styles.empty} style={{ textAlign: "left", padding: 0 }}>
          Loading comments…
        </p>
      ) : comments.length === 0 ? (
        <p className={styles.empty} style={{ textAlign: "left", padding: 0 }}>
          No comments yet.
        </p>
      ) : (
        <ul className={styles.comments}>
          {comments.map((c) => (
            <li key={c.comment_id} className={styles.comment}>
              <div className={styles.commentMeta}>
                <span className={styles.commentAuthor}>{c.author}</span>
                {c.created_at ? (
                  <span>{new Date(c.created_at).toLocaleString()}</span>
                ) : null}
              </div>
              <div className={styles.commentBody}>{c.body}</div>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={submit} style={{ marginTop: "0.75rem" }}>
        <textarea
          className={styles.newIssueInput}
          style={{ maxWidth: "100%", width: "100%", minHeight: "4.5rem" }}
          value={body}
          disabled={busy}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Add a comment…"
          aria-label="New comment"
        />
        <button
          type="submit"
          className="btn btn-primary"
          style={{ width: "auto", marginTop: "0.5rem" }}
          disabled={busy || !body.trim()}
        >
          {busy ? "Posting…" : "Comment"}
        </button>
        {error ? (
          <span className={styles.error} style={{ marginLeft: "0.5rem" }}>
            {error}
          </span>
        ) : null}
      </form>
    </div>
  );
}
