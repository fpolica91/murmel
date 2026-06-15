"use client";

import { useState } from "react";

import { ApiError, workApi } from "@/lib/api/client";
import type { Epic, Story } from "@/lib/api/types";
import styles from "./work.module.css";

/**
 * Inline "new issue" form. Creates an issue in the active team (the API client
 * scopes by the X-AWEB-Team-Id header) and calls onCreated so the board
 * reloads. Optional epic/story selectors nest the issue into the hierarchy
 * (the story list is filtered by the chosen epic). A human creating work here
 * lands on the same board agents read/write over the API/MCP.
 */
export function NewIssueForm({
  epics,
  stories,
  onCreated,
}: {
  epics: Epic[];
  stories: Story[];
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [epicId, setEpicId] = useState("");
  const [storyId, setStoryId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Stories selectable for the issue: those under the chosen epic (or all when
  // no epic is chosen).
  const storyOptions = epicId
    ? stories.filter((s) => s.epic_id === epicId)
    : stories;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = title.trim();
    if (!trimmed) return;
    setBusy(true);
    setError(null);
    try {
      await workApi.createIssue({
        title: trimmed,
        epic_id: epicId || null,
        story_id: storyId || null,
      });
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
      {epics.length > 0 ? (
        <select
          className={styles.statusSelect}
          style={{ marginLeft: 0 }}
          value={epicId}
          onChange={(e) => {
            setEpicId(e.target.value);
            setStoryId("");
          }}
          aria-label="Epic"
        >
          <option value="">No epic</option>
          {epics.map((epic) => (
            <option key={epic.epic_id} value={epic.epic_id}>
              {epic.title}
            </option>
          ))}
        </select>
      ) : null}
      {storyOptions.length > 0 ? (
        <select
          className={styles.statusSelect}
          style={{ marginLeft: 0 }}
          value={storyId}
          onChange={(e) => setStoryId(e.target.value)}
          aria-label="Story"
        >
          <option value="">No story</option>
          {storyOptions.map((story) => (
            <option key={story.story_id} value={story.story_id}>
              {story.title}
            </option>
          ))}
        </select>
      ) : null}
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
