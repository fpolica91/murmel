"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useTeam } from "@/components/team-context";
import { Avatar } from "@/components/ui/avatar";
import { workApi } from "@/lib/api/client";
import { listParticipants } from "@/lib/api/participants";
import { listClaims } from "@/lib/api/claims";
import {
  computeLeaderboard,
  humanizeDuration,
  type LeaderboardRow,
} from "@/lib/leaderboard";
import styles from "./leaderboard.module.css";

const POLL_MS = 30000;

/** Medal ornament per podium rank (1-indexed). */
const MEDALS = ["🥇", "🥈", "🥉"];

/**
 * Per-agent contribution leaderboard. Fetches the team's issues, the
 * participant roster, and active claims in parallel, then ranks everyone purely
 * client-side via {@link computeLeaderboard} — there is NO backend ranking.
 * Top three get a podium; the rest fall into a dense table. Slow-polls so a
 * teammate's fresh completion shows up without a manual reload.
 */
export function Leaderboard() {
  const { activeTeam } = useTeam();
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!activeTeam) {
      setRows([]);
      setLoading(false);
      return;
    }
    try {
      // Claims are best-effort: a failure there must not blank the board, so it
      // degrades to an empty list rather than rejecting the whole Promise.all.
      const [issues, roster, claims] = await Promise.all([
        workApi.listIssues(),
        listParticipants(activeTeam),
        listClaims(activeTeam).catch(() => []),
      ]);
      setRows(computeLeaderboard(issues, roster, claims));
      setError(null);
    } catch (e) {
      setError(
        e instanceof Error ? e.message : "Failed to load the leaderboard.",
      );
    } finally {
      setLoading(false);
    }
  }, [activeTeam]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const podium = useMemo(() => rows.slice(0, 3), [rows]);
  const rest = useMemo(() => rows.slice(3), [rows]);

  if (error) {
    return <div className={styles.error}>{error}</div>;
  }

  if (loading && rows.length === 0) {
    return <p className="muted">Loading…</p>;
  }

  if (rows.length === 0) {
    return (
      <div className={styles.empty}>
        No contributions yet. As agents and teammates pick up issues and mark
        them done, this board ranks who is moving the work — by issues
        completed, weekly throughput, average time-to-close, and completion
        streaks.
      </div>
    );
  }

  return (
    <div className={styles.board}>
      {/* Podium: top 3, centre slot raised. Render order puts #1 in the middle
          while keeping #2 / #3 on the flanks via flex ordering. */}
      <ol className={styles.podium} aria-label="Top contributors">
        {podium.map((row, i) => (
          <li
            key={row.alias}
            className={`${styles.podiumSlot} ${styles[`rank${i + 1}` as const] ?? ""}`}
          >
            <span className={styles.medal} aria-hidden="true">
              {MEDALS[i]}
            </span>
            <Avatar
              label={row.displayName}
              kind={row.kind === "agent" ? "agent" : "human"}
              size="lg"
              online={row.online}
            />
            <span className={styles.podiumName} title={row.alias}>
              {row.displayName}
            </span>
            <span className={styles.podiumScore}>
              {row.issuesDone} done
            </span>
            <div className={styles.podiumMeta}>
              <span>{row.completedThisWeek} this week</span>
              <span>·</span>
              <span>{humanizeDuration(row.avgCycleMs)} avg</span>
              {row.streakDays > 1 ? (
                <>
                  <span>·</span>
                  <span className={styles.streak}>🔥 {row.streakDays}d</span>
                </>
              ) : null}
            </div>
          </li>
        ))}
      </ol>

      {rest.length > 0 ? (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.rankCol}>#</th>
                <th>Contributor</th>
                <th className={styles.num}>Worked</th>
                <th className={styles.num}>Done</th>
                <th className={styles.num}>This week</th>
                <th className={styles.num}>Avg close</th>
                <th className={styles.num}>Streak</th>
                <th className={styles.num}>Active</th>
              </tr>
            </thead>
            <tbody>
              {rest.map((row, i) => (
                <tr key={row.alias}>
                  <td className={styles.rankCol}>{i + 4}</td>
                  <td>
                    <span className={styles.who}>
                      <Avatar
                        label={row.displayName}
                        kind={row.kind === "agent" ? "agent" : "human"}
                        size="sm"
                        online={row.online}
                      />
                      <span
                        className={styles.whoName}
                        title={row.alias}
                      >
                        {row.displayName}
                      </span>
                    </span>
                  </td>
                  <td className={styles.num}>{row.issuesWorked}</td>
                  <td className={styles.num}>{row.issuesDone}</td>
                  <td className={styles.num}>{row.completedThisWeek}</td>
                  <td className={styles.num}>
                    {humanizeDuration(row.avgCycleMs)}
                  </td>
                  <td className={styles.num}>
                    {row.streakDays > 1 ? `${row.streakDays}d` : "—"}
                  </td>
                  <td className={styles.num}>
                    {row.activeClaims > 0 ? row.activeClaims : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}
