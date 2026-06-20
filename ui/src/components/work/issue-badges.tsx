"use client";

import {
  ISSUE_STATUS_LABELS,
  type AssigneeType,
  type IssueStatus,
} from "@/lib/api/types";
import { Avatar } from "@/components/ui/avatar";
import { useAssignee } from "./assignee-directory";
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
 * "Blocked" pill shown on cards/rows when an issue is held up by at least one
 * unfinished dependency. `count` (when known) is surfaced in the tooltip.
 */
export function BlockedBadge({ count }: { count?: number }) {
  const title =
    count && count > 0
      ? `Blocked by ${count} unfinished ${count === 1 ? "dependency" : "dependencies"}`
      : "Blocked by an unfinished dependency";
  return (
    <span className={`${styles.badge} ${styles.blocked}`} title={title}>
      Blocked
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
  // Resolve the (possibly JWT-subject) assignee id to a display name. The
  // issue's own `assignee_type` stays authoritative for the avatar colour; the
  // directory only supplies the human-readable label.
  const resolved = useAssignee(assigneeId);

  if (!assigneeId) {
    return (
      <span className={styles.assignee}>
        <Avatar label="" kind="unassigned" size="sm" />
        {showLabel && <span>Unassigned</span>}
      </span>
    );
  }

  const kind = assigneeType ?? resolved.kind ?? "human";
  return (
    <span
      className={styles.assignee}
      title={`${assigneeType ?? resolved.kind ?? "?"}: ${resolved.label}`}
    >
      <Avatar
        label={resolved.label}
        kind={kind === "agent" ? "agent" : "human"}
        size="sm"
      />
      {showLabel && <span>{resolved.label}</span>}
    </span>
  );
}
