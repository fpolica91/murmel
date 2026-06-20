"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, workApi } from "@/lib/api/client";
import type { Epic, Issue, IssueStatus, Story } from "@/lib/api/types";
import { BoardView } from "./board-view";
import { HierarchyBar } from "./hierarchy-bar";
import { ListView } from "./list-view";
import { NewIssueForm } from "./new-issue-form";
import { SwimlaneView } from "./swimlane-view";
import {
  WorkFilters,
  type WorkFilterState,
  type WorkLens,
} from "./work-filters";
import styles from "./work.module.css";

type ViewMode = "board" | "list" | "swimlane";

/**
 * Top-level work surface: board/list toggle, a work lens (All / Ready /
 * Blocked), assignee + status filters, and the Epic -> Story -> Issue data
 * load. Status/assignee filters are pushed to the server query; the Ready /
 * Blocked lenses are server-computed slices of the dependency graph. We always
 * load the blocked set so every card shows a "Blocked" badge regardless of the
 * active lens. Epics + stories are loaded to resolve titles in the list
 * grouping.
 */
export function WorkBoard() {
  const [view, setView] = useState<ViewMode>("board");
  const [lens, setLens] = useState<WorkLens>("all");
  const [filters, setFilters] = useState<WorkFilterState>({});

  const [issues, setIssues] = useState<Issue[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  // Ids of issues blocked by an unfinished dependency (drives the per-card
  // "Blocked" badge). Always loaded, even when the lens is "all".
  const [blockedIds, setBlockedIds] = useState<Set<string>>(new Set());

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (activeLens: WorkLens, active: WorkFilterState) => {
      setLoading(true);
      setError(null);
      try {
        const issuesP =
          activeLens === "ready"
            ? workApi.listReady()
            : activeLens === "blocked"
              ? workApi.listBlocked()
              : workApi.listIssues({
                  status: active.status,
                  assignee_type: active.assignee_type,
                  assignee_id: active.assignee_id,
                  epic_id: active.epic_id,
                  story_id: active.story_id,
                });
        const [issueList, epicList, storyList, blockedList] = await Promise.all([
          issuesP,
          workApi.listEpics(),
          workApi.listStories(),
          // Reuse the lens result when it already IS the blocked set.
          activeLens === "blocked" ? issuesP : workApi.listBlocked(),
        ]);
        setIssues(issueList);
        setEpics(epicList);
        setStories(storyList);
        setBlockedIds(new Set(blockedList.map((i) => i.issue_id)));
      } catch (err) {
        const message =
          err instanceof ApiError
            ? `${err.message} (${err.status})`
            : err instanceof Error
              ? err.message
              : "Failed to load work items.";
        setError(message);
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    void load(lens, filters);
  }, [lens, filters, load]);

  const changeStatus = useCallback(
    async (issueId: string, status: IssueStatus) => {
      // Optimistic: reflect the move immediately, then persist + reload.
      setIssues((prev) =>
        prev.map((i) => (i.issue_id === issueId ? { ...i, status } : i)),
      );
      try {
        await workApi.updateIssueStatus(issueId, { status });
      } catch (err) {
        setError(
          err instanceof ApiError
            ? `${err.message} (${err.status})`
            : "Failed to update status.",
        );
      } finally {
        void load(lens, filters);
      }
    },
    [lens, filters, load],
  );

  // Swimlane drop: a card can cross an epic row and/or a status column, so this
  // persists `epic_id` + `status` together in ONE PATCH (workApi.updateIssue).
  const reparent = useCallback(
    async (
      issueId: string,
      update: { epic_id: string | null; status: IssueStatus },
    ) => {
      // Optimistic: reflect the new epic + status immediately, then persist.
      setIssues((prev) =>
        prev.map((i) =>
          i.issue_id === issueId
            ? { ...i, epic_id: update.epic_id, status: update.status }
            : i,
        ),
      );
      try {
        await workApi.updateIssue(issueId, update);
      } catch (err) {
        setError(
          err instanceof ApiError
            ? `${err.message} (${err.status})`
            : "Failed to move issue.",
        );
      } finally {
        void load(lens, filters);
      }
    },
    [lens, filters, load],
  );

  return (
    <div>
      <div className={styles.toolbar}>
        <div className={styles.viewToggle}>
          <button
            type="button"
            className={view === "board" ? styles.active : ""}
            onClick={() => setView("board")}
          >
            Board
          </button>
          <button
            type="button"
            className={view === "list" ? styles.active : ""}
            onClick={() => setView("list")}
          >
            List
          </button>
          <button
            type="button"
            className={view === "swimlane" ? styles.active : ""}
            onClick={() => setView("swimlane")}
          >
            Swimlane
          </button>
        </div>

        <WorkFilters
          value={filters}
          onChange={setFilters}
          lens={lens}
          onLensChange={setLens}
          epics={epics}
          stories={stories}
        />

        <span className={styles.spacer} />
        <button
          type="button"
          className="btn"
          style={{ width: "auto", marginTop: 0 }}
          onClick={() => void load(lens, filters)}
        >
          Refresh
        </button>
      </div>

      {/* Create controls grouped on one row (N5): the new-issue form and the
          "+ Epic / Story" trigger share a left-aligned row instead of the
          Epic/Story button floating orphaned on its own line. */}
      <div className={styles.createRow}>
        <NewIssueForm
          epics={epics}
          stories={stories}
          onCreated={() => void load(lens, filters)}
        />
        <HierarchyBar epics={epics} onChanged={() => void load(lens, filters)} />
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <p className={styles.empty}>Loading work items…</p>
      ) : view === "board" ? (
        <BoardView
          issues={issues}
          onStatusChange={changeStatus}
          blockedIds={blockedIds}
        />
      ) : view === "swimlane" ? (
        <SwimlaneView
          issues={issues}
          epics={epics}
          onReparent={reparent}
          onStatusChange={changeStatus}
          blockedIds={blockedIds}
        />
      ) : (
        <ListView
          issues={issues}
          epics={epics}
          stories={stories}
          blockedIds={blockedIds}
        />
      )}
    </div>
  );
}
