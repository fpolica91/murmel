"use client";

import { useState } from "react";

import { ApiError, workApi } from "@/lib/api/client";
import type { Epic } from "@/lib/api/types";
import styles from "./work.module.css";

/**
 * Create epics and stories so issues can be organized into the
 * Epic -> Story -> Issue hierarchy. Collapsed by default to keep the board
 * uncluttered; calls onChanged so the board reloads its epics/stories.
 */
export function HierarchyBar({
  epics,
  onChanged,
}: {
  epics: Epic[];
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [epicTitle, setEpicTitle] = useState("");
  const [storyTitle, setStoryTitle] = useState("");
  const [storyEpic, setStoryEpic] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onChanged();
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : err instanceof Error
            ? err.message
            : "Request failed.",
      );
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn"
        style={{ width: "auto", marginTop: 0 }}
        onClick={() => setOpen(true)}
      >
        + Epic / Story
      </button>
    );
  }

  return (
    <div className={styles.hierarchyBar}>
      <div className={styles.hierarchyRow}>
        <span className={styles.hierarchyLabel}>Epic</span>
        <input
          className={styles.newIssueInput}
          value={epicTitle}
          onChange={(e) => setEpicTitle(e.target.value)}
          placeholder="Epic title…"
          aria-label="Epic title"
        />
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: "auto", marginTop: 0 }}
          disabled={busy || !epicTitle.trim()}
          onClick={() =>
            run(async () => {
              await workApi.createEpic({ title: epicTitle.trim() });
              setEpicTitle("");
            })
          }
        >
          Add epic
        </button>
      </div>

      <div className={styles.hierarchyRow}>
        <span className={styles.hierarchyLabel}>Story</span>
        <input
          className={styles.newIssueInput}
          value={storyTitle}
          onChange={(e) => setStoryTitle(e.target.value)}
          placeholder="Story title…"
          aria-label="Story title"
        />
        <select
          className={styles.statusSelect}
          style={{ marginLeft: 0 }}
          value={storyEpic}
          onChange={(e) => setStoryEpic(e.target.value)}
          aria-label="Story epic"
        >
          <option value="">No epic</option>
          {epics.map((epic) => (
            <option key={epic.epic_id} value={epic.epic_id}>
              {epic.title}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: "auto", marginTop: 0 }}
          disabled={busy || !storyTitle.trim()}
          onClick={() =>
            run(async () => {
              await workApi.createStory({
                title: storyTitle.trim(),
                epic_id: storyEpic || null,
              });
              setStoryTitle("");
            })
          }
        >
          Add story
        </button>
      </div>

      {error ? <div className={styles.error}>{error}</div> : null}

      <button
        type="button"
        className="btn"
        style={{ width: "auto", marginTop: 0 }}
        onClick={() => setOpen(false)}
      >
        Done
      </button>
    </div>
  );
}
