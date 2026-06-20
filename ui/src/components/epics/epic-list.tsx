"use client";

import type { Epic } from "@/lib/api/types";
import { EpicProgress } from "./epic-progress";
import styles from "./epics.module.css";

/** An epic plus its client-computed issue rollup (done over total). */
export interface EpicRollup {
  epic: Epic;
  done: number;
  total: number;
}

/**
 * Generic status pill for an epic. Epic status is a free-form string
 * (open/closed/...), NOT the todo/in_progress/in_review/done set used for
 * issues — so this renders a neutral badge keyed only loosely on a couple of
 * well-known closed-ish states for colour, falling back to neutral.
 */
export function EpicStatusBadge({ status }: { status: string }) {
  const key = status.trim().toLowerCase();
  const tone =
    key === "closed" || key === "done" || key === "completed"
      ? styles.statusDone
      : key === "open" || key === "active" || key === "in_progress"
        ? styles.statusOpen
        : "";
  return <span className={`${styles.statusBadge} ${tone}`}>{status}</span>;
}

/**
 * Master column: one selectable row per epic = title + a generic status badge +
 * a done/total progress indicator. The selected epic is highlighted; clicking a
 * row (or activating it via keyboard) calls `onSelect`.
 */
export function EpicList({
  rollups,
  selectedId,
  onSelect,
}: {
  rollups: EpicRollup[];
  selectedId: string | null;
  onSelect: (epicId: string) => void;
}) {
  if (rollups.length === 0) {
    return <p className={styles.empty}>No epics yet.</p>;
  }

  return (
    <ul className={styles.epicList}>
      {rollups.map(({ epic, done, total }) => {
        const selected = epic.epic_id === selectedId;
        return (
          <li key={epic.epic_id}>
            <button
              type="button"
              className={`${styles.epicRow} ${selected ? styles.epicRowSelected : ""}`}
              aria-current={selected ? "true" : undefined}
              onClick={() => onSelect(epic.epic_id)}
            >
              <span className={styles.epicRowMain}>
                <span className={styles.epicRowTitle}>{epic.title}</span>
                <EpicStatusBadge status={epic.status} />
              </span>
              <EpicProgress done={done} total={total} size="sm" />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
