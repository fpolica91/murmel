"use client";

import { use, useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { ApiError, workApi } from "@/lib/api/client";
import type { AssigneeType, Issue } from "@/lib/api/types";
import { useTeam } from "@/components/team-context";
import { AssigneePicker } from "@/components/work/assignee-picker";
import { IssueThread } from "@/components/work/issue-thread";
import { StatusBadge } from "@/components/work/issue-badges";
import workStyles from "@/components/work/work.module.css";

/**
 * Issue-detail route: renders the issue, an assignee picker (which PATCHes the
 * issue's assignee_type/assignee_id), and the conversation thread below it.
 *
 * The page fetches the issue client-side via the typed `workApi` so it can keep
 * the assignment in sync after a PATCH. The thread + assignee roster are scoped
 * by the active team from `useTeam()`.
 */
export default function IssueDetailPage({
  params,
}: {
  params: Promise<{ issueId: string }>;
}) {
  const { issueId } = use(params);
  const { activeTeam } = useTeam();

  const [issue, setIssue] = useState<Issue | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const loaded = await workApi.getIssue(issueId);
      setIssue(loaded);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : "Failed to load issue.",
      );
    } finally {
      setLoading(false);
    }
  }, [issueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const assign = useCallback(
    async (type: AssigneeType | null, id: string | null) => {
      if (!issue) return;
      setSaving(true);
      setError(null);
      try {
        const updated = await workApi.updateIssue(issue.issue_id, {
          assignee_type: type,
          assignee_id: id,
        });
        setIssue(updated);
      } catch (err) {
        setError(
          err instanceof ApiError
            ? `${err.message} (${err.status})`
            : "Failed to update assignee.",
        );
      } finally {
        setSaving(false);
      }
    },
    [issue],
  );

  if (loading) {
    return <p className={workStyles.empty}>Loading issue…</p>;
  }

  if (error && !issue) {
    return (
      <div>
        <div className={workStyles.error}>{error}</div>
        <p style={{ marginTop: "1rem" }}>
          <Link href="/dashboard/work" className="btn" style={{ width: "auto" }}>
            Back to board
          </Link>
        </p>
      </div>
    );
  }

  if (!issue) {
    return <p className={workStyles.empty}>Issue not found.</p>;
  }

  return (
    <div>
      <nav className={workStyles.breadcrumb} aria-label="Breadcrumb">
        <Link href="/dashboard/work">Work</Link>
        <span>/</span>
        <span>{issue.title}</span>
      </nav>

      {error ? <div className={workStyles.error}>{error}</div> : null}

      <div className={workStyles.detailGrid}>
        <article className={workStyles.detailMain}>
          <h1 className={workStyles.detailTitle}>{issue.title}</h1>
          <div
            className={workStyles.cardMeta}
            style={{ marginBottom: "1.25rem" }}
          >
            <StatusBadge status={issue.status} />
            <span>·</span>
            <span>Updated {formatDate(issue.updated_at)}</span>
          </div>

          {issue.description ? (
            <>
              <h2 className={workStyles.sectionTitle}>Description</h2>
              <p className={workStyles.description}>{issue.description}</p>
            </>
          ) : null}

          <h2 className={workStyles.sectionTitle}>Conversation</h2>
          <IssueThread issueId={issue.issue_id} teamId={activeTeam} />
        </article>

        <aside className={workStyles.sidebar}>
          <div className={workStyles.sidebarField}>
            <h3>Assignee</h3>
            <AssigneePicker
              teamId={activeTeam}
              assigneeType={issue.assignee_type}
              assigneeId={issue.assignee_id}
              disabled={saving}
              onAssign={assign}
            />
          </div>

          <div className={workStyles.sidebarField}>
            <h3>Status</h3>
            <p className="muted" style={{ margin: 0 }}>
              {issue.status}
            </p>
          </div>

          <div className={workStyles.sidebarField}>
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
