/**
 * Pure, client-side aggregator for the per-agent contribution leaderboard.
 *
 * Everything here is computed over the existing token-authed, team-scoped
 * endpoints — `GET /v1/issues`, `GET /v1/participants`, and (optionally)
 * `GET /v1/claims`. There is NO backend support for ranking; this module is
 * the only real logic, kept pure so it is trivially unit-testable.
 *
 * The two non-trivial bits live here and nowhere else:
 *   1. `humanizeDuration` — average time-to-close (created_at -> updated_at on
 *      done issues), rendered as a terse "2d 3h" style string.
 *   2. `computeStreak` — the longest run of consecutive UTC days on which the
 *      agent completed at least one issue (dedupe-by-day, then walk the gaps).
 *
 * Mapping rule (mirrors the rest of the UI): an issue's `assignee_id` is the
 * alias for board-claimed work, but MCP-claimed work persists the JWT subject.
 * Participants carry `alias` and a `did:key:jwt-<subject>` routing DID, so we
 * index the roster on BOTH and only count assignees that resolve. Unassigned
 * issues and assignees with no roster match are ignored.
 */

import type { Issue } from "./api/types";
import type { Participant } from "./api/participants";

/** Minimal claim shape the aggregator needs (a subset of the API `Claim`). */
export interface ClaimLike {
  /** Team-unique alias of the workspace/agent holding the claim. */
  alias: string;
}

/** A single ranked row, one per resolved participant with any contribution. */
export interface LeaderboardRow {
  /** Stable identity key: the participant alias. */
  alias: string;
  /** Human-readable name (display_name, falling back to alias). */
  displayName: string;
  /** "human" | "agent" — authoritative, straight from the roster. */
  kind: Participant["kind"];
  /** Live presence flag from the roster (best-effort, not load-bearing). */
  online: boolean;
  /** Issues assigned to this participant in any state. */
  issuesWorked: number;
  /** Subset of `issuesWorked` whose status is `done`. */
  issuesDone: number;
  /** Done issues whose `updated_at` lands in the current (UTC) week. */
  completedThisWeek: number;
  /**
   * Average time-to-close in milliseconds over done issues with a valid
   * created_at -> updated_at span, or null when there is nothing to average.
   */
  avgCycleMs: number | null;
  /** Longest run of consecutive days (UTC) with at least one completion. */
  streakDays: number;
  /** Count of active claims currently held (0 when claims weren't supplied). */
  activeClaims: number;
  /**
   * Ranking score: weighted toward finished work, with recent throughput and
   * streaks as tie-breakers. Exposed so the UI can show it / debug ordering.
   */
  score: number;
}

const JWT_DID_PREFIX = "did:key:jwt-";

/** Extract the JWT subject from a `did:key:jwt-<subject>` routing DID. */
function subjectFromDid(did: string | null): string | null {
  if (!did) return null;
  return did.startsWith(JWT_DID_PREFIX) ? did.slice(JWT_DID_PREFIX.length) : null;
}

/** UTC `YYYY-MM-DD` key for a timestamp, or null when unparseable. */
function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/**
 * Longest run of consecutive calendar days (UTC) present in a set of completion
 * timestamps. Dedupe to day granularity, sort, then walk: each day exactly one
 * after the previous extends the run; any gap resets it. Returns 0 for none.
 *
 * Note this is the *longest* streak in the window, not the trailing/current
 * one — a stable "best run" reads better on a leaderboard than a streak that
 * silently drops to 0 the day after someone ships.
 */
export function computeStreak(completionIsos: Array<string | null>): number {
  const days = new Set<string>();
  for (const iso of completionIsos) {
    const k = dayKey(iso);
    if (k) days.add(k);
  }
  if (days.size === 0) return 0;

  const sorted = Array.from(days).sort();
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  let best = 1;
  let run = 1;
  for (let i = 1; i < sorted.length; i++) {
    const prev = Date.parse(sorted[i - 1]);
    const cur = Date.parse(sorted[i]);
    const deltaDays = Math.round((cur - prev) / MS_PER_DAY);
    if (deltaDays === 1) {
      run += 1;
      if (run > best) best = run;
    } else {
      run = 1;
    }
  }
  return best;
}

/**
 * Terse humanized duration ("just now", "3h 12m", "2d 4h", "5d"). Picks the two
 * most-significant non-zero units and stops there; returns "—" for null/invalid.
 */
export function humanizeDuration(ms: number | null): string {
  if (ms === null || Number.isNaN(ms) || ms < 0) return "—";
  if (ms < 60_000) return "just now";

  const totalMin = Math.floor(ms / 60_000);
  const days = Math.floor(totalMin / (60 * 24));
  const hours = Math.floor((totalMin % (60 * 24)) / 60);
  const mins = totalMin % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  // Only surface minutes when the span is short enough for them to matter.
  if (mins > 0 && days === 0) parts.push(`${mins}m`);

  return parts.slice(0, 2).join(" ") || "just now";
}

/** Start of the current ISO week (Monday 00:00 UTC) as epoch ms. */
function startOfWeekUtc(now: number): number {
  const d = new Date(now);
  const dow = d.getUTCDay(); // 0=Sun..6=Sat
  const sinceMonday = (dow + 6) % 7; // days since Monday
  return Date.UTC(
    d.getUTCFullYear(),
    d.getUTCMonth(),
    d.getUTCDate() - sinceMonday,
  );
}

/** Per-alias accumulator used while folding issues. */
interface Bucket {
  worked: number;
  done: number;
  completedThisWeek: number;
  cycleSumMs: number;
  cycleCount: number;
  completionIsos: Array<string | null>;
}

function emptyBucket(): Bucket {
  return {
    worked: 0,
    done: 0,
    completedThisWeek: 0,
    cycleSumMs: 0,
    cycleCount: 0,
    completionIsos: [],
  };
}

/**
 * Aggregate issues + roster (+ optional claims) into ranked leaderboard rows.
 *
 * Pure: no I/O, no clock unless injected. `now` defaults to `Date.now()` so the
 * "this week" window is testable. Rows are returned sorted by descending
 * `score`, then by issuesDone, then alias for a stable order. Only participants
 * with at least one resolved contribution (or an active claim) appear.
 *
 * @param issues  Result of `workApi.listIssues()` (whole-team, any status).
 * @param roster  Result of `listParticipants()` — humans AND agents.
 * @param claims  Optional result of `listClaims()`; counts active claims/agent.
 * @param now     Injectable clock (epoch ms) for the weekly window.
 */
export function computeLeaderboard(
  issues: Issue[],
  roster: Participant[],
  claims: ClaimLike[] = [],
  now: number = Date.now(),
): LeaderboardRow[] {
  // Index the roster by every key an issue might reference: the alias and the
  // JWT subject embedded in the routing DID. Both map back to the same alias.
  const keyToAlias = new Map<string, string>();
  const byAlias = new Map<string, Participant>();
  for (const p of roster) {
    if (!p.alias) continue;
    byAlias.set(p.alias, p);
    keyToAlias.set(p.alias, p.alias);
    const subject = subjectFromDid(p.did_key);
    if (subject) keyToAlias.set(subject, p.alias);
  }

  const weekStart = startOfWeekUtc(now);
  const buckets = new Map<string, Bucket>();

  for (const issue of issues) {
    // Only count assignees that resolve to a real roster entry. The roster is
    // authoritative for kind, so we deliberately ignore issue.assignee_type
    // here for the mapping and rely on the resolved participant.
    if (!issue.assignee_id) continue;
    const alias = keyToAlias.get(issue.assignee_id);
    if (!alias) continue;

    let b = buckets.get(alias);
    if (!b) {
      b = emptyBucket();
      buckets.set(alias, b);
    }
    b.worked += 1;

    if (issue.status === "done") {
      b.done += 1;
      b.completionIsos.push(issue.updated_at);

      const closedAt = Date.parse(issue.updated_at);
      if (!Number.isNaN(closedAt) && closedAt >= weekStart) {
        b.completedThisWeek += 1;
      }

      const openedAt = Date.parse(issue.created_at);
      if (
        !Number.isNaN(openedAt) &&
        !Number.isNaN(closedAt) &&
        closedAt >= openedAt
      ) {
        b.cycleSumMs += closedAt - openedAt;
        b.cycleCount += 1;
      }
    }
  }

  // Tally active claims per resolved alias (claims key on alias directly).
  const claimsByAlias = new Map<string, number>();
  for (const c of claims) {
    if (!c.alias) continue;
    const alias = keyToAlias.get(c.alias) ?? c.alias;
    if (!byAlias.has(alias)) continue; // ignore claims with no roster match
    claimsByAlias.set(alias, (claimsByAlias.get(alias) ?? 0) + 1);
  }

  // Build a row for every alias that has either work or a live claim.
  const aliases = new Set<string>([
    ...buckets.keys(),
    ...claimsByAlias.keys(),
  ]);

  const rows: LeaderboardRow[] = [];
  for (const alias of aliases) {
    const p = byAlias.get(alias);
    if (!p) continue; // defensive: only resolved participants
    const b = buckets.get(alias) ?? emptyBucket();
    const activeClaims = claimsByAlias.get(alias) ?? 0;
    const avgCycleMs =
      b.cycleCount > 0 ? Math.round(b.cycleSumMs / b.cycleCount) : null;
    const streakDays = computeStreak(b.completionIsos);

    // Weight finished work heaviest; reward recent throughput and consistency.
    // Active claims nudge ties (work in flight) without dominating outcomes.
    const score =
      b.done * 10 +
      b.completedThisWeek * 4 +
      streakDays * 2 +
      (b.worked - b.done) * 1 +
      activeClaims * 1;

    rows.push({
      alias,
      displayName: (p.display_name || p.alias || alias).trim() || alias,
      kind: p.kind,
      online: p.online,
      issuesWorked: b.worked,
      issuesDone: b.done,
      completedThisWeek: b.completedThisWeek,
      avgCycleMs,
      streakDays,
      activeClaims,
      score,
    });
  }

  rows.sort(
    (a, b) =>
      b.score - a.score ||
      b.issuesDone - a.issuesDone ||
      a.alias.localeCompare(b.alias),
  );
  return rows;
}
