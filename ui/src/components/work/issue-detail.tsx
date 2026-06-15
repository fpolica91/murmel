"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { ApiError, workApi } from "@/lib/api/client";
import type { Epic, Issue, Story } from "@/lib/api/types";
import { AssigneeChip, StatusBadge } from "./issue-badges";
import styles from "./work.module.css";

/**
 * Issue-detail view: description, an activity-thread placeholder (the comments
 * endpoint is a later story), and the assignee + hierarchy context in the
 * sidebar. Resolves the parent epic/story titles for the breadcrumb.
 */
export function IssueDetail({ issueId }: { issueId: string }) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [epic, setEpic] = useState<Epic | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const loaded = await workApi.getIssue(issueId);
        if (cancelled) return;
        setIssue(loaded);

        // Resolve parents for the breadcrumb; failures here are non-fatal.
        const [epicResult, storyResult] = await Promise.allSettled([
          loaded.epic_id
            ? workApi.getEpic(loaded.epic_id)
            : Promise.resolve(null),
          loaded.story_id
            ? workApi.getStory(loaded.story_id)
            : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (epicResult.status === "fulfilled") setEpic(epicResult.value);
        if (storyResult.status === "fulfilled") setStory(storyResult.value);
      } catch (err) {
        if (cancelled) return;
        const message =
          err instanceof ApiError
            ? `${err.message} (${err.status})`
            : err instanceof Error
              ? err.message
              : "Failed to load issue.";
        setError(message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  if (loading) {
    return <p className={styles.empty}>Loading issue…</p>;
  }

  if (error) {
    return (
      <div>
        <div className={styles.error}>{error}</div>
        <p style={{ marginTop: "1rem" }}>
          <Link href="/dashboard/work" className="btn" style={{ width: "auto" }}>
            Back to board
          </Link>
        </p>
      </div>
    );
  }

  if (!issue) {
    return <p className={styles.empty}>Issue not found.</p>;
  }

  return (
    <div>
      <nav className={styles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/dashboard/work">Work</Link>
        <span>/</span>
        <span>{epic ? epic.title : "No epic"}</span>
        <span>/</span>
        <span>{story ? story.title : "No story"}</span>
      </nav>

      <div className={styles.detailGrid}>
        <article className={styles.detailMain}>
          <h1 className={styles.detailTitle}>{issue.title}</h1>
          <div className={styles.cardMeta} style={{ marginBottom: "1.25rem" }}>
            <StatusBadge status={issue.status} />
            <span>·</span>
            <span>Updated {formatDate(issue.updated_at)}</span>
          </div>

          <h2 className={styles.sectionTitle}>Description</h2>
          {issue.description ? (
            <p className={styles.description}>{issue.description}</p>
          ) : (
            <p className={styles.empty} style={{ textAlign: "left", padding: 0 }}>
              No description provided.
            </p>
          )}

          <h2 className={styles.sectionTitle}>Activity</h2>
          <div className={styles.activityThread}>
            Activity thread coming soon. Comments and status history will appear
            here.
          </div>
        </article>

        <aside className={styles.sidebar}>
          <div className={styles.sidebarField}>
            <h3>Assignee</h3>
            <AssigneeChip
              assigneeType={issue.assignee_type}
              assigneeId={issue.assignee_id}
            />
          </div>

          <div className={styles.sidebarField}>
            <h3>Status</h3>
            <StatusBadge status={issue.status} />
          </div>

          <div className={styles.sidebarField}>
            <h3>Epic</h3>
            <p className="muted" style={{ margin: 0 }}>
              {epic ? epic.title : "—"}
            </p>
          </div>

          <div className={styles.sidebarField}>
            <h3>Story</h3>
            <p className="muted" style={{ margin: 0 }}>
              {story ? story.title : "—"}
            </p>
          </div>

          <div className={styles.sidebarField}>
            <h3>Created</h3>
            <p className="muted" style={{ margin: 0 }}>
              {formatDate(issue.created_at)}
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
