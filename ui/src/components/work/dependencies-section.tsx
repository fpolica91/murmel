"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

import { ApiError, workApi } from "@/lib/api/client";
import type {
  Issue,
  IssueDependencies,
  IssueDependencyRef,
} from "@/lib/api/types";
import { BlockedBadge, StatusBadge } from "./issue-badges";
import styles from "./work.module.css";

/**
 * Dependency editor for an issue. "Blocked by" are the issues holding this one
 * up (each removable); "Blocks" are the issues depending on this one. The
 * picker adds a new blocker from any other team issue; self and existing
 * blockers are excluded. All mutations go through the dependency REST routes and
 * re-read the fresh neighbours so the section stays in sync with the graph.
 */
export function DependenciesSection({ issueId }: { issueId: string }) {
  const [deps, setDeps] = useState<IssueDependencies | null>(null);
  const [candidates, setCandidates] = useState<Issue[]>([]);
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function run() {
      setError(null);
      try {
        const [d, all] = await Promise.all([
          workApi.getDependencies(issueId),
          // Candidate blockers: any other issue in the team.
          workApi.listIssues({}),
        ]);
        if (cancelled) return;
        setDeps(d);
        setCandidates(all);
      } catch (err) {
        if (cancelled) return;
        setError(depError(err, "Failed to load dependencies."));
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [issueId]);

  async function add() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    try {
      const fresh = await workApi.addDependency(issueId, picked);
      setDeps(fresh);
      setPicked("");
    } catch (err) {
      setError(depError(err, "Failed to add dependency."));
    } finally {
      setBusy(false);
    }
  }

  async function remove(dependsOnId: string) {
    setBusy(true);
    setError(null);
    try {
      const fresh = await workApi.removeDependency(issueId, dependsOnId);
      setDeps(fresh);
    } catch (err) {
      setError(depError(err, "Failed to remove dependency."));
    } finally {
      setBusy(false);
    }
  }

  const blockedBy = deps?.blocked_by ?? [];
  const blocks = deps?.blocks ?? [];
  const blockerIds = new Set(blockedBy.map((d) => d.issue_id));
  // Exclude self + issues that already block this one from the picker.
  const pickable = candidates.filter(
    (c) => c.issue_id !== issueId && !blockerIds.has(c.issue_id),
  );

  return (
    <div className={styles.deps}>
      {error ? <div className={styles.error}>{error}</div> : null}

      <div className={styles.depsGroup}>
        <h3 className={styles.depsHeading}>
          Blocked by
          {blockedBy.length ? <BlockedBadge count={blockedBy.length} /> : null}
        </h3>
        {blockedBy.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            Nothing is blocking this issue.
          </p>
        ) : (
          <ul className={styles.depsList}>
            {blockedBy.map((dep) => (
              <li key={dep.issue_id} className={styles.depsItem}>
                <DependencyLink dep={dep} />
                <button
                  type="button"
                  className={styles.depRemove}
                  disabled={busy}
                  aria-label={`Remove dependency on ${dep.title}`}
                  title="Remove dependency"
                  onClick={() => void remove(dep.issue_id)}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className={styles.depAdd}>
          <select
            className={styles.filterSelect}
            value={picked}
            disabled={busy || pickable.length === 0}
            aria-label="Add a blocking issue"
            onChange={(e) => setPicked(e.target.value)}
          >
            <option value="">
              {pickable.length === 0
                ? "No other issues"
                : "Add a blocking issue…"}
            </option>
            {pickable.map((c) => (
              <option key={c.issue_id} value={c.issue_id}>
                {c.title}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn-primary"
            style={{ width: "auto", marginTop: 0, fontSize: "0.78rem" }}
            disabled={busy || !picked}
            onClick={() => void add()}
          >
            {busy ? "Saving…" : "Add"}
          </button>
        </div>
      </div>

      <div className={styles.depsGroup}>
        <h3 className={styles.depsHeading}>Blocks</h3>
        {blocks.length === 0 ? (
          <p className="muted" style={{ margin: 0 }}>
            This issue isn&apos;t blocking anything.
          </p>
        ) : (
          <ul className={styles.depsList}>
            {blocks.map((dep) => (
              <li key={dep.issue_id} className={styles.depsItem}>
                <DependencyLink dep={dep} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A single dependency row: link to the issue detail + its status pill. */
function DependencyLink({ dep }: { dep: IssueDependencyRef }) {
  return (
    <span className={styles.depLink}>
      <Link href={`/dashboard/work/issues/${dep.issue_id}`}>{dep.title}</Link>
      <StatusBadge status={dep.status} />
    </span>
  );
}

function depError(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${err.message} (${err.status})`;
  if (err instanceof Error) return err.message;
  return fallback;
}
