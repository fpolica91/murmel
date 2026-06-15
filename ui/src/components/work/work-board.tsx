"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError, workApi } from "@/lib/api/client";
import type { Epic, Issue, IssueStatus, Story } from "@/lib/api/types";
import { BoardView } from "./board-view";
import { HierarchyBar } from "./hierarchy-bar";
import { ListView } from "./list-view";
import { NewIssueForm } from "./new-issue-form";
import { WorkFilters, type WorkFilterState } from "./work-filters";
import styles from "./work.module.css";

type ViewMode = "board" | "list";

/**
 * Top-level work surface: board/list toggle, assignee + status filters, and the
 * Epic -> Story -> Issue data load. Status/assignee filters are pushed to the
 * server query; epics + stories are loaded once to resolve titles in the list
 * grouping.
 */
export function WorkBoard() {
  const [view, setView] = useState<ViewMode>("board");
  const [filters, setFilters] = useState<WorkFilterState>({});

  const [issues, setIssues] = useState<Issue[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [stories, setStories] = useState<Story[]>([]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (active: WorkFilterState) => {
    setLoading(true);
    setError(null);
    try {
      const [issueList, epicList, storyList] = await Promise.all([
        workApi.listIssues({
          status: active.status,
          assignee_type: active.assignee_type,
          assignee_id: active.assignee_id,
          epic_id: active.epic_id,
          story_id: active.story_id,
        }),
        workApi.listEpics(),
        workApi.listStories(),
      ]);
      setIssues(issueList);
      setEpics(epicList);
      setStories(storyList);
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
  }, []);

  useEffect(() => {
    void load(filters);
  }, [filters, load]);

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
        void load(filters);
      }
    },
    [filters, load],
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
        </div>

        <WorkFilters value={filters} onChange={setFilters} />

        <span className={styles.spacer} />
        <button
          type="button"
          className="btn"
          style={{ width: "auto", marginTop: 0 }}
          onClick={() => void load(filters)}
        >
          Refresh
        </button>
      </div>

      <HierarchyBar epics={epics} onChanged={() => void load(filters)} />

      <NewIssueForm
        epics={epics}
        stories={stories}
        onCreated={() => void load(filters)}
      />

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <p className={styles.empty}>Loading work items…</p>
      ) : view === "board" ? (
        <BoardView issues={issues} onStatusChange={changeStatus} />
      ) : (
        <ListView issues={issues} epics={epics} stories={stories} />
      )}
    </div>
  );
}
