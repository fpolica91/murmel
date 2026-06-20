"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter } from "next/navigation";

import { ApiError, workApi } from "@/lib/api/client";
import type { Epic, Issue, Story } from "@/lib/api/types";
import { useTeam } from "@/components/team-context";
import { AssigneeDirectoryProvider } from "@/components/work/assignee-directory";
import { EpicDetail } from "./epic-detail";
import { EpicList, type EpicRollup } from "./epic-list";
import styles from "./epics.module.css";

/** Deep-link query key: `?epic=<epic_id>` selects an epic on load. */
const EPIC_PARAM = "epic";

/**
 * Master/detail epic burndown. Loads the team's epics, all its issues, and all
 * its stories in one pass, buckets issues by `epic_id` to compute a per-epic
 * done/total rollup (status === "done" over the epic's issue count), and shows
 * the selected epic's child issues on the right.
 *
 * Read-only over the existing endpoints via the shared `workApi`:
 *   GET /v1/epics, GET /v1/issues, GET /v1/stories.
 *
 * Team scoping: re-fetches whenever `useTeam().activeTeam` changes (the workApi
 * request layer attaches the active-team header + bearer token). Selection is
 * mirrored to `?epic=<id>` so a row is deep-linkable / shareable.
 */
export function EpicsOverview() {
  const { activeTeam } = useTeam();
  const router = useRouter();
  const pathname = usePathname();

  const [epics, setEpics] = useState<Epic[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [stories, setStories] = useState<Story[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Read the initial `?epic=` selection from the URL on mount. Done via
  // `window.location` (client-only) rather than `useSearchParams` to avoid a
  // Suspense/CSR-bailout coupling for this component.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromUrl = new URLSearchParams(window.location.search).get(EPIC_PARAM);
    if (fromUrl) setSelectedId(fromUrl);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [epicList, issueList, storyList] = await Promise.all([
        workApi.listEpics(),
        workApi.listIssues(),
        workApi.listStories(),
      ]);
      setEpics(epicList);
      setIssues(issueList);
      setStories(storyList);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : err instanceof Error
            ? err.message
            : "Failed to load epics.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  // Reload on mount and whenever the active team changes.
  useEffect(() => {
    void load();
  }, [load, activeTeam]);

  // Bucket issues by epic_id -> per-epic done/total rollup.
  const rollups = useMemo<EpicRollup[]>(() => {
    const totals = new Map<string, { done: number; total: number }>();
    for (const issue of issues) {
      if (!issue.epic_id) continue;
      const bucket = totals.get(issue.epic_id) ?? { done: 0, total: 0 };
      bucket.total += 1;
      if (issue.status === "done") bucket.done += 1;
      totals.set(issue.epic_id, bucket);
    }
    return epics.map((epic) => {
      const bucket = totals.get(epic.epic_id) ?? { done: 0, total: 0 };
      return { epic, done: bucket.done, total: bucket.total };
    });
  }, [epics, issues]);

  // Resolve the effective selection: the deep-linked/selected epic if it still
  // exists, otherwise fall back to the first epic.
  const selectedEpic = useMemo<Epic | null>(() => {
    if (epics.length === 0) return null;
    return epics.find((e) => e.epic_id === selectedId) ?? epics[0];
  }, [epics, selectedId]);

  // Keep the URL in sync with the effective selection (shareable deep link),
  // without pushing history entries.
  useEffect(() => {
    if (!selectedEpic || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get(EPIC_PARAM) === selectedEpic.epic_id) return;
    params.set(EPIC_PARAM, selectedEpic.epic_id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [selectedEpic, pathname, router]);

  const detailIssues = useMemo(
    () =>
      selectedEpic
        ? issues.filter((i) => i.epic_id === selectedEpic.epic_id)
        : [],
    [issues, selectedEpic],
  );

  const detailStories = useMemo(
    () =>
      selectedEpic
        ? stories.filter((s) => s.epic_id === selectedEpic.epic_id)
        : [],
    [stories, selectedEpic],
  );

  return (
    <div>
      <div className={styles.toolbar}>
        <span className={styles.spacer} />
        <button
          type="button"
          className="btn"
          style={{ width: "auto", marginTop: 0 }}
          onClick={() => void load()}
        >
          Refresh
        </button>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      {loading ? (
        <p className={styles.empty}>Loading epics…</p>
      ) : epics.length === 0 ? (
        <p className={styles.empty}>No epics yet.</p>
      ) : (
        <AssigneeDirectoryProvider>
          <div className={styles.masterDetail}>
            <EpicList
              rollups={rollups}
              selectedId={selectedEpic?.epic_id ?? null}
              onSelect={setSelectedId}
            />
            {selectedEpic ? (
              <EpicDetail
                epic={selectedEpic}
                issues={detailIssues}
                stories={detailStories}
              />
            ) : (
              <p className={styles.empty}>Select an epic to see its issues.</p>
            )}
          </div>
        </AssigneeDirectoryProvider>
      )}
    </div>
  );
}
