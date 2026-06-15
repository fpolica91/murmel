"use client";

import Link from "next/link";

import type { Issue } from "@/lib/api/types";
import { AssigneeChip } from "./issue-badges";
import styles from "./work.module.css";

/** Compact, clickable issue card used in the board columns. */
export function IssueCard({ issue }: { issue: Issue }) {
  return (
    <Link
      href={`/dashboard/work/issues/${issue.issue_id}`}
      className={styles.card}
    >
      <div className={styles.cardTitle}>{issue.title}</div>
      <div className={styles.cardMeta}>
        <AssigneeChip
          assigneeType={issue.assignee_type}
          assigneeId={issue.assignee_id}
          showLabel={false}
        />
        <span>{issue.assignee_id ?? "Unassigned"}</span>
      </div>
    </Link>
  );
}
