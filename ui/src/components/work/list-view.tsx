"use client";

import { Fragment } from "react";
import { useRouter } from "next/navigation";

import type { Epic, Issue, Story } from "@/lib/api/types";
import { AssigneeChip, BlockedBadge, StatusBadge } from "./issue-badges";
import styles from "./work.module.css";

const NO_EPIC = "__no_epic__";
const NO_STORY = "__no_story__";

/**
 * Flat, grouped list of issues organized by the Epic -> Story hierarchy.
 * Issues with no epic/story fall into "Unassigned epic" / "Unassigned story"
 * group rows so nothing is hidden. Rows link to the issue-detail view.
 */
export function ListView({
  issues,
  epics,
  stories,
  blockedIds,
}: {
  issues: Issue[];
  epics: Epic[];
  stories: Story[];
  /** Ids of issues blocked by an unfinished dependency (per-row badge). */
  blockedIds?: Set<string>;
}) {
  const router = useRouter();

  const epicTitle = new Map(epics.map((e) => [e.epic_id, e.title]));
  const storyTitle = new Map(stories.map((s) => [s.story_id, s.title]));

  // Group: epic -> story -> issues[], preserving a stable display order.
  const grouped = new Map<string, Map<string, Issue[]>>();
  for (const issue of issues) {
    const epicKey = issue.epic_id ?? NO_EPIC;
    const storyKey = issue.story_id ?? NO_STORY;
    if (!grouped.has(epicKey)) grouped.set(epicKey, new Map());
    const storyBuckets = grouped.get(epicKey)!;
    if (!storyBuckets.has(storyKey)) storyBuckets.set(storyKey, []);
    storyBuckets.get(storyKey)!.push(issue);
  }

  if (issues.length === 0) {
    return <p className={styles.empty}>No issues match the current filters.</p>;
  }

  return (
    <div className={styles.listScroll}>
    <table className={styles.list}>
      <thead>
        <tr>
          <th>Issue</th>
          <th>Status</th>
          <th>Assignee</th>
        </tr>
      </thead>
      <tbody>
        {[...grouped.entries()].map(([epicKey, storyMap]) => (
          <Fragment key={epicKey}>
            <tr className={styles.groupRow}>
              <td colSpan={3}>
                Epic:{" "}
                {epicKey === NO_EPIC
                  ? "Unassigned epic"
                  : (epicTitle.get(epicKey) ?? epicKey)}
              </td>
            </tr>
            {[...storyMap.entries()].map(([storyKey, storyIssues]) => (
              <Fragment key={storyKey}>
                <tr className={styles.groupRow}>
                  <td colSpan={3} style={{ paddingLeft: "1.75rem" }}>
                    Story:{" "}
                    {storyKey === NO_STORY
                      ? "Unassigned story"
                      : (storyTitle.get(storyKey) ?? storyKey)}
                  </td>
                </tr>
                {storyIssues.map((issue) => (
                  <tr
                    key={issue.issue_id}
                    onClick={() =>
                      router.push(`/dashboard/work/issues/${issue.issue_id}`)
                    }
                  >
                    <td style={{ paddingLeft: "2.75rem" }}>{issue.title}</td>
                    <td>
                      <span
                        style={{
                          display: "inline-flex",
                          alignItems: "center",
                          gap: "0.35rem",
                        }}
                      >
                        <StatusBadge status={issue.status} />
                        {blockedIds?.has(issue.issue_id) ? (
                          <BlockedBadge />
                        ) : null}
                      </span>
                    </td>
                    <td>
                      <AssigneeChip
                        assigneeType={issue.assignee_type}
                        assigneeId={issue.assignee_id}
                      />
                    </td>
                  </tr>
                ))}
              </Fragment>
            ))}
          </Fragment>
        ))}
      </tbody>
    </table>
    </div>
  );
}
