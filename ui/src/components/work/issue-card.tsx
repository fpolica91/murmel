"use client";

import Link from "next/link";

import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type Issue,
  type IssueStatus,
} from "@/lib/api/types";
import { AssigneeChip } from "./issue-badges";
import styles from "./work.module.css";

/** Compact issue card. The title links to the detail view; the status select
 * moves the issue between columns (PATCH) without leaving the board. */
export function IssueCard({
  issue,
  onStatusChange,
}: {
  issue: Issue;
  onStatusChange?: (issueId: string, status: IssueStatus) => void;
}) {
  return (
    <div className={styles.card}>
      <Link
        href={`/dashboard/work/issues/${issue.issue_id}`}
        className={styles.cardTitle}
      >
        {issue.title}
      </Link>
      <div className={styles.cardMeta}>
        <AssigneeChip
          assigneeType={issue.assignee_type}
          assigneeId={issue.assignee_id}
          showLabel={false}
        />
        <span>{issue.assignee_id ?? "Unassigned"}</span>
        {issue.comment_count ? (
          <span className={styles.commentCount} title="Comments">
            💬 {issue.comment_count}
          </span>
        ) : null}
        {onStatusChange ? (
          <select
            className={styles.statusSelect}
            value={issue.status}
            onChange={(e) =>
              onStatusChange(issue.issue_id, e.target.value as IssueStatus)
            }
            aria-label="Change status"
          >
            {ISSUE_STATUSES.map((s) => (
              <option key={s} value={s}>
                {ISSUE_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
        ) : null}
      </div>
    </div>
  );
}
