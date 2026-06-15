"use client";

import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type Issue,
} from "@/lib/api/types";
import { IssueCard } from "./issue-card";
import styles from "./work.module.css";

/**
 * Kanban board: one column per issue status, issues bucketed by `status`.
 * Client-side bucketing keeps the board coherent even when the active status
 * filter is set (an empty column still renders so the workflow stays visible).
 */
export function BoardView({ issues }: { issues: Issue[] }) {
  const byStatus = new Map<string, Issue[]>();
  for (const status of ISSUE_STATUSES) byStatus.set(status, []);
  for (const issue of issues) {
    const bucket = byStatus.get(issue.status);
    if (bucket) bucket.push(issue);
  }

  return (
    <div className={styles.board}>
      {ISSUE_STATUSES.map((status) => {
        const column = byStatus.get(status) ?? [];
        return (
          <section key={status} className={styles.column}>
            <header className={styles.columnHeader}>
              <span>{ISSUE_STATUS_LABELS[status]}</span>
              <span className={styles.count}>{column.length}</span>
            </header>
            <div className={styles.cardStack}>
              {column.map((issue) => (
                <IssueCard key={issue.issue_id} issue={issue} />
              ))}
              {column.length === 0 && (
                <p className={styles.empty} style={{ padding: "0.75rem" }}>
                  No issues
                </p>
              )}
            </div>
          </section>
        );
      })}
    </div>
  );
}
