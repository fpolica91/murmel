"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { ApiError, workApi } from "@/lib/api/client";
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type AssigneeType,
  type Epic,
  type Issue,
  type IssueStatus,
  type Story,
  type UpdateIssueInput,
} from "@/lib/api/types";
import { StatusBadge } from "./issue-badges";
import styles from "./work.module.css";

/**
 * Issue-detail view. The sidebar is actionable: assign to a human/agent, change
 * status, and edit the description — the same issue agents read/write over the
 * API/MCP. Resolves the parent epic/story titles for the breadcrumb.
 */
export function IssueDetail({ issueId }: { issueId: string }) {
  const [issue, setIssue] = useState<Issue | null>(null);
  const [epic, setEpic] = useState<Epic | null>(null);
  const [story, setStory] = useState<Story | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
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

  async function patch(input: UpdateIssueInput) {
    if (!issue) return;
    setSaving(true);
    setError(null);
    try {
      const updated = await workApi.updateIssue(issue.issue_id, input);
      setIssue(updated);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : "Update failed.",
      );
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return <p className={styles.empty}>Loading issue…</p>;
  }

  if (error && !issue) {
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

      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.detailGrid}>
        <article className={styles.detailMain}>
          <h1 className={styles.detailTitle}>{issue.title}</h1>
          <div className={styles.cardMeta} style={{ marginBottom: "1.25rem" }}>
            <StatusBadge status={issue.status} />
            <span>·</span>
            <span>Updated {formatDate(issue.updated_at)}</span>
          </div>

          <h2 className={styles.sectionTitle}>Description</h2>
          <DescriptionField
            key={issue.issue_id}
            value={issue.description}
            saving={saving}
            onSave={(description) => patch({ description })}
          />

          <h2 className={styles.sectionTitle}>Activity</h2>
          <div className={styles.activityThread}>
            Activity thread coming soon. Comments and status history will appear
            here.
          </div>
        </article>

        <aside className={styles.sidebar}>
          <div className={styles.sidebarField}>
            <h3>Assignee</h3>
            <AssigneeField
              key={`${issue.assignee_type}:${issue.assignee_id}`}
              assigneeType={issue.assignee_type}
              assigneeId={issue.assignee_id}
              saving={saving}
              onSave={(assignee_type, assignee_id) =>
                patch({ assignee_type, assignee_id })
              }
            />
          </div>

          <div className={styles.sidebarField}>
            <h3>Status</h3>
            <select
              className={styles.statusSelect}
              style={{ marginLeft: 0 }}
              value={issue.status}
              disabled={saving}
              onChange={(e) => patch({ status: e.target.value as IssueStatus })}
              aria-label="Change status"
            >
              {ISSUE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {ISSUE_STATUS_LABELS[s]}
                </option>
              ))}
            </select>
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

/** Assign to a human or agent (or clear). The id is free-form so a human can
 * assign work to an agent by name — the signature human↔agent interaction. */
function AssigneeField({
  assigneeType,
  assigneeId,
  saving,
  onSave,
}: {
  assigneeType: AssigneeType | null;
  assigneeId: string | null;
  saving: boolean;
  onSave: (type: AssigneeType | null, id: string | null) => void;
}) {
  const [type, setType] = useState<"" | AssigneeType>(assigneeType ?? "");
  const [id, setId] = useState(assigneeId ?? "");

  const dirty = (type || "") !== (assigneeType ?? "") || id !== (assigneeId ?? "");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.4rem" }}>
      <select
        className={styles.statusSelect}
        style={{ marginLeft: 0 }}
        value={type}
        disabled={saving}
        onChange={(e) => setType(e.target.value as "" | AssigneeType)}
        aria-label="Assignee type"
      >
        <option value="">Unassigned</option>
        <option value="human">Human</option>
        <option value="agent">Agent</option>
      </select>
      {type ? (
        <input
          className={styles.newIssueInput}
          style={{ maxWidth: "100%", fontSize: "0.78rem" }}
          value={id}
          disabled={saving}
          onChange={(e) => setId(e.target.value)}
          placeholder={type === "agent" ? "agent name/id" : "user id"}
          aria-label="Assignee id"
        />
      ) : null}
      <button
        type="button"
        className="btn btn-primary"
        style={{ width: "auto", marginTop: 0, fontSize: "0.78rem" }}
        disabled={saving || !dirty || (Boolean(type) && !id.trim())}
        onClick={() =>
          onSave(type || null, type ? id.trim() : null)
        }
      >
        {saving ? "Saving…" : "Assign"}
      </button>
    </div>
  );
}

/** Inline description editor. */
function DescriptionField({
  value,
  saving,
  onSave,
}: {
  value: string;
  saving: boolean;
  onSave: (description: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <div>
        {value ? (
          <p className={styles.description}>{value}</p>
        ) : (
          <p className={styles.empty} style={{ textAlign: "left", padding: 0 }}>
            No description provided.
          </p>
        )}
        <button
          type="button"
          className="btn"
          style={{ width: "auto", marginTop: "0.5rem", fontSize: "0.78rem" }}
          onClick={() => {
            setDraft(value);
            setEditing(true);
          }}
        >
          Edit
        </button>
      </div>
    );
  }

  return (
    <div>
      <textarea
        className={styles.newIssueInput}
        style={{ maxWidth: "100%", width: "100%", minHeight: "6rem" }}
        value={draft}
        disabled={saving}
        onChange={(e) => setDraft(e.target.value)}
        aria-label="Description"
      />
      <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem" }}>
        <button
          type="button"
          className="btn btn-primary"
          style={{ width: "auto", marginTop: 0, fontSize: "0.78rem" }}
          disabled={saving}
          onClick={() => {
            onSave(draft);
            setEditing(false);
          }}
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          className="btn"
          style={{ width: "auto", marginTop: 0, fontSize: "0.78rem" }}
          disabled={saving}
          onClick={() => setEditing(false)}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString();
}
