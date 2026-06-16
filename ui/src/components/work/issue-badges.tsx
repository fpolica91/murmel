"use client";

import {
  ISSUE_STATUS_LABELS,
  type AssigneeType,
  type IssueStatus,
} from "@/lib/api/types";
import { Avatar } from "@/components/ui/avatar";
import styles from "./work.module.css";

/** Coloured status pill used in cards, rows, and the detail sidebar. */
export function StatusBadge({ status }: { status: IssueStatus }) {
  return (
    <span className={`${styles.badge} ${styles[status]}`}>
      {ISSUE_STATUS_LABELS[status]}
    </span>
  );
}

/**
 * Assignee chip: the shared Avatar (colour-coded by human vs agent, one
 * initials rule) plus the id. Renders an "Unassigned" placeholder when no
 * assignee is set.
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
        <Avatar label="" kind="unassigned" size="sm" />
        {showLabel && <span>Unassigned</span>}
      </span>
    );
  }

  return (
    <span
      className={styles.assignee}
      title={`${assigneeType ?? "?"}: ${assigneeId}`}
    >
      <Avatar
        label={assigneeId}
        kind={assigneeType === "agent" ? "agent" : "human"}
        size="sm"
      />
      {showLabel && <span>{assigneeId}</span>}
    </span>
  );
}
