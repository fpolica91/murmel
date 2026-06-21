/**
 * Pure derivation for the live office scene — shared by the authed
 * (`OfficeStage`) and public (`PublicStage`) containers so the visual and the
 * logic stay identical regardless of data source. No React, no I/O.
 */
import type { LeaderboardRow } from "@/lib/leaderboard";
import type { Issue } from "@/lib/api/types";

export type StageState = "working" | "talking" | "idle";

/** What a desk needs to render — every team agent gets one, ranked or not. */
export interface DeskAgent {
  alias: string;
  displayName: string;
  kind: "human" | "agent";
  online: boolean;
  issuesDone: number;
}

export interface Desk {
  row: DeskAgent;
  state: StageState;
  work: string | null;
  say: string | null;
}

export interface StageColumns {
  todo: Issue[];
  doing: Issue[];
  done: Issue[];
}

export interface StageView {
  teamLabel: string;
  nowBuilding: string | null;
  workingCount: number;
  shippedTotal: number;
  desks: Desk[];
  columns: StageColumns;
}

/** Minimal claim/roster shapes the derive needs (both data sources satisfy). */
export interface MiniClaim {
  task_ref: string;
  alias: string;
}
export interface MiniParticipant {
  alias: string;
  agent_id: string | null;
  display_name: string;
  kind: "human" | "agent";
  online: boolean;
}

export interface StageInput {
  rows: LeaderboardRow[];
  issues: Issue[];
  claims: MiniClaim[];
  roster: MiniParticipant[];
  /** alias -> most recent chat line + timestamp (already windowed) */
  says: Record<string, { text: string; ts: string }>;
}

/** Two initials, ignoring an "(agent)" suffix. */
export function initials(name: string): string {
  return (
    name
      .replace(/\(agent\)/i, "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

export function deriveStage(input: StageInput, teamLabel: string): StageView {
  const { rows, issues, claims, roster, says } = input;

  // any assignee reference (alias or agent_id) -> alias
  const aliasOf = new Map<string, string>();
  for (const p of roster) {
    if (p.alias) aliasOf.set(p.alias, p.alias);
    if (p.agent_id) aliasOf.set(p.agent_id, p.alias);
  }

  // heads-down: an active claim OR an in_progress issue assigned to the agent
  const workByAlias = new Map<string, string>();
  for (const c of claims) {
    const t = issues.find((i) => i.issue_id === c.task_ref)?.title;
    workByAlias.set(c.alias, t ?? "a ticket");
  }
  for (const i of issues) {
    if (i.status !== "in_progress" || !i.assignee_id) continue;
    const a = aliasOf.get(i.assignee_id);
    if (a && !workByAlias.has(a)) workByAlias.set(a, i.title);
  }

  // Desks cover EVERY team agent (so idle ones still appear and can talk),
  // with completion stats merged in from the leaderboard fold.
  const doneByAlias = new Map(rows.map((r) => [r.alias, r.issuesDone]));
  const weight = (s: StageState) =>
    s === "working" ? 0 : s === "talking" ? 1 : 2;
  const desks: Desk[] = roster
    .map((p) => {
      const row: DeskAgent = {
        alias: p.alias,
        displayName: p.display_name || p.alias,
        kind: p.kind,
        online: p.online,
        issuesDone: doneByAlias.get(p.alias) ?? 0,
      };
      const work = workByAlias.get(p.alias) ?? null;
      const say = says[p.alias]?.text ?? null;
      const state: StageState = work ? "working" : say ? "talking" : "idle";
      return { row, state, work, say };
    })
    .sort(
      (a, b) =>
        weight(a.state) - weight(b.state) ||
        Number(b.row.online) - Number(a.row.online) ||
        b.row.issuesDone - a.row.issuesDone,
    );

  const columns: StageColumns = {
    todo: issues.filter((i) => i.status === "todo").slice(0, 6),
    doing: issues
      .filter((i) => i.status === "in_progress" || i.status === "in_review")
      .slice(0, 6),
    done: issues
      .filter((i) => i.status === "done")
      .slice(-6)
      .reverse(),
  };

  const workingCount = desks.filter((d) => d.state === "working").length;
  const shippedTotal = rows.reduce((n, r) => n + r.issuesDone, 0);
  const nowBuilding =
    desks.find((d) => d.state === "working")?.work ??
    issues.find((i) => i.status === "in_progress")?.title ??
    null;

  return { teamLabel, nowBuilding, workingCount, shippedTotal, desks, columns };
}
