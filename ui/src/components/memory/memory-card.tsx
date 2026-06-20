"use client";

import { useState } from "react";

import type { Memory } from "@/lib/api/memories";
import { Markdown } from "@/components/ui/markdown";
import styles from "./memory.module.css";

/** Compact relative time ("3h", "2d", "just now") from an ISO timestamp. */
function relativeTime(iso: string | null): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * One memory note. Collapsed: title + byline + tags + optional "private to X"
 * badge. Click the title to expand the body inline. The body renders as
 * pre-wrap text for now; the markdown win swaps a real renderer in here.
 */
export function MemoryCard({
  memory,
  onEdit,
}: {
  memory: Memory;
  onEdit: (m: Memory) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <button
          type="button"
          className={styles.cardTitle}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
        >
          {memory.title}
        </button>
        <button
          type="button"
          className={styles.editBtn}
          onClick={() => onEdit(memory)}
        >
          Edit
        </button>
      </div>

      <div className={styles.byline}>
        {memory.created_by_alias ? <span>{memory.created_by_alias}</span> : null}
        {memory.created_by_alias ? <span>·</span> : null}
        <span>{relativeTime(memory.updated_at)}</span>
        {memory.assignee_alias ? (
          <span className={styles.private}>private to {memory.assignee_alias}</span>
        ) : null}
      </div>

      {memory.tags.length > 0 ? (
        <div className={styles.cardTags}>
          {memory.tags.map((t) => (
            <span key={t} className={styles.cardTag}>
              {t}
            </span>
          ))}
        </div>
      ) : null}

      {open ? (
        <div className={styles.body}>
          {memory.body_md ? (
            <Markdown>{memory.body_md}</Markdown>
          ) : (
            <span className="muted">(no content)</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
