"use client";

import { useState } from "react";

import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type Issue,
  type IssueStatus,
} from "@/lib/api/types";
import { IssueCard } from "./issue-card";
import styles from "./work.module.css";

/**
 * Kanban board: one column per issue status, issues bucketed by `status`.
 * Client-side bucketing keeps the board coherent even when the active status
 * filter is set (an empty column still renders so the workflow stays visible).
 *
 * Drag-and-drop: cards (IssueCard) are draggable and each column is a drop
 * target; dropping calls onStatusChange (optimistic move + PATCH). The card's
 * status <select> remains the keyboard-accessible fallback.
 */
export function BoardView({
  issues,
  onStatusChange,
  blockedIds,
}: {
  issues: Issue[];
  onStatusChange?: (issueId: string, status: IssueStatus) => void;
  /** Ids of issues blocked by an unfinished dependency (per-card badge). */
  blockedIds?: Set<string>;
}) {
  const [dragOver, setDragOver] = useState<string | null>(null);

  const byStatus = new Map<string, Issue[]>();
  for (const status of ISSUE_STATUSES) byStatus.set(status, []);
  for (const issue of issues) {
    const bucket = byStatus.get(issue.status);
    if (bucket) bucket.push(issue);
  }

  const handleDrop = (status: IssueStatus) => (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(null);
    const id = e.dataTransfer.getData("text/plain");
    if (!id) return;
    // Skip the PATCH when the card is dropped back on its own column.
    const current = issues.find((i) => i.issue_id === id)?.status;
    if (current !== status) onStatusChange?.(id, status);
  };

  return (
    <div className={styles.board}>
      {ISSUE_STATUSES.map((status) => {
        const column = byStatus.get(status) ?? [];
        const dropProps = onStatusChange
          ? {
              onDragOver: (e: React.DragEvent) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                if (dragOver !== status) setDragOver(status);
              },
              onDragLeave: (e: React.DragEvent) => {
                // Ignore leaves into child nodes; only clear on a true exit.
                if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                  setDragOver((s) => (s === status ? null : s));
                }
              },
              onDrop: handleDrop(status),
            }
          : {};
        return (
          <section
            key={status}
            className={`${styles.column}${dragOver === status ? ` ${styles.columnDragOver}` : ""}`}
            {...dropProps}
          >
            <header className={styles.columnHeader}>
              <span>{ISSUE_STATUS_LABELS[status]}</span>
              <span className={styles.count}>{column.length}</span>
            </header>
            <div className={styles.cardStack}>
              {column.map((issue) => (
                <IssueCard
                  key={issue.issue_id}
                  issue={issue}
                  onStatusChange={onStatusChange}
                  blocked={blockedIds?.has(issue.issue_id) ?? false}
                />
              ))}
              {column.length === 0 && (
                <p className={styles.columnEmpty}>No issues</p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
