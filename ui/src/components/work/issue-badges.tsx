"use client";

import {
  ISSUE_STATUS_LABELS,
  type AssigneeType,
  type IssueStatus,
} from "@/lib/api/types";
import styles from "./work.module.css";

/** Coloured status pill used in cards, rows, and the detail sidebar. */
export function StatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      {ISSUE_STATUS_LABELS[status]}
    </span>
  );
}

function initials(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Assignee chip: an avatar (colour-coded by human vs agent) plus the id.
 * Renders an "Unassigned" placeholder when no assignee is set.
 */
export function AssigneeChip({
  assigneeType,
  assigneeId,
  showLabel = true,
}: {
  assigneeType: AssigneeType | null;
  assigneeId: string | null;
  showLabel?: boolean;
}) {
  if (!assigneeId) {
    return (
      <span className={styles.assignee}>
        <span className={`${styles.avatar} ${styles.unassigned}`}>—</span>
        {showLabel && <span>Unassigned</span>}
      </span>
    );
  }

  const kindClass = assigneeType === "agent" ? styles.agent : "";
  return (
    <span className={styles.assignee} title={`${assigneeType ?? "?"}: ${assigneeId}`}>
      <span className={`${styles.avatar} ${kindClass}`}>
        {initials(assigneeId)}
      </span>
      {showLabel && <span>{assigneeId}</span>}
    </span>
  );
}
