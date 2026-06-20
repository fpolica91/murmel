"use client";

import { Fragment } from "react";
import Link from "next/link";

import type { Epic, Issue, Story } from "@/lib/api/types";
import { AssigneeChip, StatusBadge } from "@/components/work/issue-badges";
import { EpicProgress } from "./epic-progress";
import { EpicStatusBadge } from "./epic-list";
import styles from "./epics.module.css";

const NO_STORY = "__no_story__";

/**
 * Detail pane for the selected epic: its title + a generic status badge and the
 * done/total rollup, then the epic's child issues as a clickable, status-tagged
 * list. Issues are grouped under their story (stories with no issues are
 * omitted; issues with no story fall into an "Unassigned story" group so
 * nothing is hidden). Each issue links to its existing detail route.
 *
 * Reuses the work components' StatusBadge + AssigneeChip for issues (their
 * status IS the todo/in_progress/in_review/done set); the epic's own status is
 * free-form and uses the generic EpicStatusBadge.
 */
export function EpicDetail({
  epic,
  issues,
  stories,
}: {
  epic: Epic;
  issues: Issue[];
  stories: Story[];
}) {
  const done = issues.filter((i) => i.status === "done").length;

  const storyTitle = new Map(stories.map((s) => [s.story_id, s.title]));

  // Group this epic's issues by story, preserving first-seen order.
  const byStory = new Map<string, Issue[]>();
  for (const issue of issues) {
    const key = issue.story_id ?? NO_STORY;
    if (!byStory.has(key)) byStory.set(key, []);
    byStory.get(key)!.push(issue);
  }

  return (
    <section className={styles.detail} aria-label={`Epic ${epic.title}`}>
      <header className={styles.detailHeader}>
        <h2 className={styles.detailTitle}>{epic.title}</h2>
        <div className={styles.detailMeta}>
          <EpicStatusBadge status={epic.status} />
          <EpicProgress done={done} total={issues.length} />
        </div>
      </header>

      {issues.length === 0 ? (
        <p className={styles.empty}>No issues under this epic yet.</p>
      ) : (
        <div className={styles.issueGroups}>
          {[...byStory.entries()].map(([storyKey, storyIssues]) => (
            <Fragment key={storyKey}>
              <h3 className={styles.storyHeading}>
                {storyKey === NO_STORY
                  ? "Unassigned story"
                  : (storyTitle.get(storyKey) ?? storyKey)}
              </h3>
              <ul className={styles.issueList}>
                {storyIssues.map((issue) => (
                  <li key={issue.issue_id}>
                    <Link
                      href={`/dashboard/work/issues/${issue.issue_id}`}
                      className={styles.issueRow}
                    >
                      <span className={styles.issueTitle}>{issue.title}</span>
                      <span className={styles.issueRowMeta}>
                        <StatusBadge status={issue.status} />
                        <AssigneeChip
                          assigneeType={issue.assignee_type}
                          assigneeId={issue.assignee_id}
                        />
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            </Fragment>
          ))}
        </div>
      )}
    </section>
  );
}
