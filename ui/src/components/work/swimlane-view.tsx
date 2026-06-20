"use client";

import { useState } from "react";

import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type Epic,
  type Issue,
  type IssueStatus,
} from "@/lib/api/types";
import { IssueCard } from "./issue-card";
import styles from "./work.module.css";

/** Sentinel epic key for the "No epic" catch-all row (mirrors list-view). */
const NO_EPIC = "__no_epic__";

/** A row of the swimlane grid: an epic (or the catch-all) plus a roll-up. */
interface Lane {
  /** `epic_id`, or NO_EPIC for the catch-all. */
  key: string;
  title: string;
  /** Epic id sent on reparent, or null to clear the epic (catch-all). */
  epicId: string | null;
  done: number;
  total: number;
}

/** Encode a drop target so a single dataTransfer id resolves both axes. */
function encodeCell(epicKey: string, status: IssueStatus): string {
  return `${epicKey}:${status}`;
}

/** Decode `${epicKey}:${status}` — epicKey may itself be a UUID, so split on
 *  the LAST colon to keep the key intact. */
function decodeCell(cell: string): { epicKey: string; status: IssueStatus } {
  const idx = cell.lastIndexOf(":");
  return {
    epicKey: cell.slice(0, idx),
    status: cell.slice(idx + 1) as IssueStatus,
  };
}

/**
 * 2-D swimlane board: rows are epics (plus a "No epic" catch-all), columns are
 * the four issue statuses, and each cell holds the issues that match both axes.
 * Cards (IssueCard) reuse the board's native HTML5 drag; here a drop target is
 * the (epic, status) intersection, so a drop can change `epic_id`, `status`, or
 * both in a single PATCH. The card's status <select> stays as the
 * keyboard-accessible fallback for status-only moves.
 */
export function SwimlaneView({
  issues,
  epics,
  onReparent,
  onStatusChange,
  blockedIds,
}: {
  issues: Issue[];
  epics: Epic[];
  /** Persist a card move across epic and/or status in one PATCH. */
  onReparent?: (
    issueId: string,
    update: { epic_id: string | null; status: IssueStatus },
  ) => void;
  /** Status-only move (drives IssueCard's keyboard <select> fallback). */
  onStatusChange?: (issueId: string, status: IssueStatus) => void;
  /** Ids of issues blocked by an unfinished dependency (per-card badge). */
  blockedIds?: Set<string>;
}) {
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Bucket issues by epic key (catch-all included) and, within an epic, by
  // status — so each cell read is O(1).
  const byEpicStatus = new Map<string, Map<string, Issue[]>>();
  const ensureLane = (key: string) => {
    let lane = byEpicStatus.get(key);
    if (!lane) {
      lane = new Map<string, Issue[]>();
      for (const status of ISSUE_STATUSES) lane.set(status, []);
      byEpicStatus.set(key, lane);
    }
    return lane;
  };
  // Seed real epics first so empty epics still render a row, in epic order.
  for (const epic of epics) ensureLane(epic.epic_id);
  for (const issue of issues) {
    const key = issue.epic_id ?? NO_EPIC;
    ensureLane(key).get(issue.status)?.push(issue);
  }

  // Build the row order: epics in their listed order, then the catch-all last
  // (only when it holds issues — an empty "No epic" row adds no signal).
  const epicTitle = new Map(epics.map((e) => [e.epic_id, e.title]));
  const laneKeys = epics.map((e) => e.epic_id);
  if (byEpicStatus.has(NO_EPIC)) laneKeys.push(NO_EPIC);

  const lanes: Lane[] = laneKeys.map((key) => {
    const lane = byEpicStatus.get(key);
    let done = 0;
    let total = 0;
    if (lane) {
      for (const [status, bucket] of lane) {
        total += bucket.length;
        if (status === "done") done += bucket.length;
      }
    }
    return {
      key,
      title: key === NO_EPIC ? "No epic" : (epicTitle.get(key) ?? key),
      epicId: key === NO_EPIC ? null : key,
      done,
      total,
    };
  });

  const handleDrop =
    (lane: Lane, status: IssueStatus) => (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(null);
      const id = e.dataTransfer.getData("text/plain");
      if (!id) return;
      const issue = issues.find((i) => i.issue_id === id);
      if (!issue) return;
      const epicChanged = (issue.epic_id ?? null) !== lane.epicId;
      const statusChanged = issue.status !== status;
      // Skip the PATCH when the drop lands on the card's own cell.
      if (!epicChanged && !statusChanged) return;
      onReparent?.(id, { epic_id: lane.epicId, status });
    };

  if (issues.length === 0 && epics.length === 0) {
    return <p className={styles.empty}>No issues match the current filters.</p>;
  }

  return (
    <div className={styles.swimlaneScroll}>
      <div
        className={styles.swimlane}
        style={{
          gridTemplateColumns: `var(--lane-head) repeat(${ISSUE_STATUSES.length}, minmax(200px, 1fr))`,
        }}
      >
        {/* Column header row: a spacer over the lane-header column, then one
            label per status. */}
        <div className={`${styles.swimCornerHead} ${styles.swimColHead}`} />
        {ISSUE_STATUSES.map((status) => (
          <div key={status} className={styles.swimColHead}>
            {ISSUE_STATUS_LABELS[status]}
          </div>
        ))}

        {lanes.map((lane) => (
          <div key={lane.key} className={styles.swimRow} role="row">
            <div className={styles.laneHead}>
              <span className={styles.laneTitle}>{lane.title}</span>
              <span
                className={styles.laneRollup}
                title={`${lane.done} of ${lane.total} done`}
              >
                {lane.done}/{lane.total}
              </span>
            </div>
            {ISSUE_STATUSES.map((status) => {
              const cell = encodeCell(lane.key, status);
              const bucket = byEpicStatus.get(lane.key)?.get(status) ?? [];
              const dropProps = onReparent
                ? {
                    onDragOver: (e: React.DragEvent) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      if (dragOver !== cell) setDragOver(cell);
                    },
                    onDragLeave: (e: React.DragEvent) => {
                      // Ignore leaves into child nodes; clear on a true exit.
                      if (
                        !e.currentTarget.contains(e.relatedTarget as Node)
                      ) {
                        setDragOver((c) => (c === cell ? null : c));
                      }
                    },
                    onDrop: handleDrop(lane, status),
                  }
                : {};
              return (
                <div
                  key={status}
                  role="gridcell"
                  className={`${styles.swimCell}${dragOver === cell ? ` ${styles.swimCellDragOver}` : ""}`}
                  {...dropProps}
                >
                  {bucket.map((issue) => (
                    <IssueCard
                      key={issue.issue_id}
                      issue={issue}
                      onStatusChange={onStatusChange}
                      blocked={blockedIds?.has(issue.issue_id) ?? false}
                    />
                  ))}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
