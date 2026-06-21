"use client";

import { useState } from "react";
import Link from "next/link";

import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type Issue,
  type IssueStatus,
} from "@/lib/api/types";
import { AssigneeChip, BlockedBadge } from "./issue-badges";
import styles from "./work.module.css";

/** Compact issue card. The title links to the detail view; the card is
 * draggable between columns (drop = PATCH via onStatusChange) and the status
 * select is the keyboard-accessible fallback for the same move. A "Blocked"
 * badge shows when the issue is held up by an unfinished dependency. */
export function IssueCard({
  issue,
  onStatusChange,
  blocked = false,
}: {
  issue: Issue;
  onStatusChange?: (issueId: string, status: IssueStatus) => void;
  blocked?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  // Only draggable when a status-change handler is wired (board view).
  const draggable = !!onStatusChange;

  return (
    <div
      className={`${styles.card}${dragging ? ` ${styles.cardDragging}` : ""}`}
      draggable={draggable}
      onDragStart={
        draggable
          ? (e) => {
              e.dataTransfer.setData("text/plain", issue.issue_id);
              e.dataTransfer.effectAllowed = "move";
              setDragging(true);
            }
          : undefined
      }
      onDragEnd={draggable ? () => setDragging(false) : undefined}
    >
      <Link
        href={`/dashboard/work/issues/${issue.issue_id}`}
        className={styles.cardTitle}
        draggable={false}
      >
        {issue.pinned ? (
          <span className={styles.pin} title="Pinned" aria-label="Pinned">
            📌{" "}
          </span>
        ) : null}
        {issue.title}
      </Link>
      <div className={styles.cardMeta}>
        <AssigneeChip
          assigneeType={issue.assignee_type}
          assigneeId={issue.assignee_id}
        />
        {blocked || issue.is_blocked ? <BlockedBadge /> : null}
        {issue.comment_count ? (
          <span className={styles.commentCount} title="Comments">
            💬 {issue.comment_count}
          </span>
        ) : null}
        {onStatusChange ? (
          <span className={styles.moveControl} title="Move to column">
            <select
              className={styles.moveSelect}
              value={issue.status}
              onChange={(e) =>
                onStatusChange(issue.issue_id, e.target.value as IssueStatus)
              }
              aria-label="Change status"
            >
              {ISSUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  Move to {ISSUE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
          </span>
        ) : null}
      </div>
    </div>
  );
}
