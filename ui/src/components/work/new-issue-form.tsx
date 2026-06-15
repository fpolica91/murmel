"use client";

import { useState } from "react";

import { ApiError, workApi } from "@/lib/api/client";
import styles from "./work.module.css";

/**
 * Inline "new issue" form. Creates an issue in the active team (the API client
 * scopes by the X-AWEB-Team-Id header) and calls onCreated so the board
 * reloads. A human creating work here lands on the same board agents read/write
 * over the API/MCP.
 */
export function NewIssueForm({ onCreated }: { onCreated: () => void }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await workApi.createIssue({ title: trimmed });
      setTitle("");
      onCreated();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : err instanceof Error
            ? err.message
            : "Failed to create issue.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={styles.newIssue} onSubmit={submit}>
      <input
        className={styles.newIssueInput}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="New issue title…"
        aria-label="New issue title"
      />
      <button
        type="submit"
        className="btn btn-primary"
        style={{ width: "auto", marginTop: 0 }}
        disabled={busy || !title.trim()}
      >
        {busy ? "Adding…" : "Add issue"}
      </button>
      {error ? (
        <span className={styles.error} style={{ marginLeft: "0.5rem" }}>
          {error}
        </span>
      ) : null}
    </form>
  );
}
