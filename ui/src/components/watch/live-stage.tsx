"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTeam } from "@/components/team-context";
import { Avatar } from "@/components/ui/avatar";
import { workApi } from "@/lib/api/client";
import { listParticipants, type Participant } from "@/lib/api/participants";
import { listClaims, type Claim } from "@/lib/api/claims";
import {
  listChatConversations,
  type ConversationItem,
} from "@/lib/api/chat";
import { subscribeEvents } from "@/lib/events/eventStream";
import { computeLeaderboard, type LeaderboardRow } from "@/lib/leaderboard";
import type { Issue } from "@/lib/api/types";
import styles from "./watch.module.css";

const POLL_MS = 6000;
/** A chat counts an agent as "talking" if it spoke within this window. */
const TALKING_WINDOW_MS = 90_000;
const MEDALS = ["🥇", "🥈", "🥉"];

type Activity =
  | { kind: "working"; detail: string }
  | { kind: "talking"; detail: string }
  | { kind: "shipped"; detail: string }
  | { kind: "idle"; detail: string };

interface ShipEvent {
  key: number;
  name: string;
}

/** Compact relative time ("just now", "3m", "2h"). */
function ago(iso: string | null): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 8) return "just now";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * The Live stage. Polls the same team-scoped endpoints the dashboard uses
 * (issues + participants + claims + conversations), ranks agents via the shared
 * leaderboard fold, and projects each agent's REAL state onto an animated desk:
 * an active claim → heads-down (typing), a chat in the last ~90s → talking, a
 * just-incremented done count → a 🚀 SHIPPED burst. Refreshes on the SSE event
 * stream so a teammate's move lands without a reload.
 */
export function LiveStage() {
  const { activeTeam } = useTeam();
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [roster, setRoster] = useState<Participant[]>([]);
  const [convos, setConvos] = useState<ConversationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [ship, setShip] = useState<ShipEvent | null>(null);

  // Last-seen done count per alias, to detect a fresh completion → SHIPPED.
  const doneSeen = useRef<Map<string, number> | null>(null);
  const shipKey = useRef(0);

  const refresh = useCallback(async () => {
    if (!activeTeam) {
      setRows([]);
      setIssues([]);
      setClaims([]);
      setConvos([]);
      setLoading(false);
      return;
    }
    try {
      const [iss, roster, clm, conv] = await Promise.all([
        workApi.listIssues(),
        listParticipants(activeTeam),
        listClaims(activeTeam).catch(() => [] as Claim[]),
        listChatConversations(activeTeam, { limit: 30 })
          .then((r) => r.conversations)
          .catch(() => [] as ConversationItem[]),
      ]);
      const ranked = computeLeaderboard(iss, roster, clm);

      // Detect fresh completions. Seed silently on the first load so we don't
      // fire a burst for pre-existing done work.
      const prev = doneSeen.current;
      const next = new Map(ranked.map((r) => [r.alias, r.issuesDone]));
      if (prev) {
        for (const r of ranked) {
          const before = prev.get(r.alias) ?? 0;
          if (r.issuesDone > before) {
            shipKey.current += 1;
            setShip({ key: shipKey.current, name: r.displayName });
          }
        }
      }
      doneSeen.current = next;

      setRows(ranked);
      setIssues(iss);
      setClaims(clm);
      setRoster(roster);
      setConvos(conv);
    } catch {
      /* keep the last good frame on a transient error */
    } finally {
      setLoading(false);
    }
  }, [activeTeam]);

  useEffect(() => {
    setLoading(true);
    doneSeen.current = null;
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    const unsub = activeTeam
      ? subscribeEvents(activeTeam, () => void refresh())
      : () => {};
    return () => {
      clearInterval(id);
      unsub();
    };
  }, [refresh, activeTeam]);

  // Auto-dismiss the SHIPPED burst.
  useEffect(() => {
    if (!ship) return;
    const t = setTimeout(() => setShip(null), 4200);
    return () => clearTimeout(t);
  }, [ship]);

  const issueById = useMemo(
    () => new Map(issues.map((i) => [i.issue_id, i])),
    [issues],
  );

  // Map any assignee reference (alias or agent_id) back to the team alias.
  const aliasOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const p of roster) {
      if (p.alias) m.set(p.alias, p.alias);
      if (p.agent_id) m.set(p.agent_id, p.alias);
    }
    return m;
  }, [roster]);

  // "Heads-down" work, two ways: an MCP-stamped claim, or an in_progress issue
  // assigned to the agent (the CLI status-change path that doesn't stamp claims).
  const workingByAlias = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of claims) {
      const title = issueById.get(c.task_ref)?.title;
      m.set(c.alias, title ? `on “${title}”` : "heads-down on a ticket");
    }
    for (const i of issues) {
      if (i.status !== "in_progress" || !i.assignee_id) continue;
      const alias = aliasOf.get(i.assignee_id);
      if (alias && !m.has(alias)) m.set(alias, `on “${i.title}”`);
    }
    return m;
  }, [claims, issues, issueById, aliasOf]);

  // Most recent chat speaker per alias (within the talking window).
  const talkingBy = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of convos) {
      if (!c.last_message_from || !c.last_message_at) continue;
      if (Date.now() - new Date(c.last_message_at).getTime() > TALKING_WINDOW_MS)
        continue;
      const peer = c.participants.find((p) => p !== c.last_message_from);
      if (!m.has(c.last_message_from))
        m.set(c.last_message_from, peer ?? "the team");
    }
    return m;
  }, [convos]);

  const activityFor = useCallback(
    (row: LeaderboardRow): Activity => {
      const work = workingByAlias.get(row.alias);
      if (work) return { kind: "working", detail: work };
      const peer = talkingBy.get(row.alias);
      if (peer) return { kind: "talking", detail: `with ${peer}` };
      if (row.issuesDone > 0)
        return { kind: "idle", detail: `${row.issuesDone} shipped · standing by` };
      return { kind: "idle", detail: "standing by" };
    },
    [workingByAlias, talkingBy],
  );

  // Stage order: working first, then talking, then online, then by done count.
  const desks = useMemo(() => {
    const weight = (a: Activity) =>
      a.kind === "working" ? 0 : a.kind === "talking" ? 1 : 2;
    return [...rows]
      .map((r) => ({ row: r, act: activityFor(r) }))
      .sort(
        (a, b) =>
          weight(a.act) - weight(b.act) ||
          Number(b.row.online) - Number(a.row.online) ||
          b.row.issuesDone - a.row.issuesDone,
      );
  }, [rows, activityFor]);

  const board = useMemo(() => {
    const c = { todo: 0, in_progress: 0, in_review: 0, done: 0 };
    for (const i of issues)
      if (i.status in c) c[i.status as keyof typeof c] += 1;
    return c;
  }, [issues]);

  const ticker = useMemo(
    () =>
      [...convos]
        .filter((c) => c.last_message_preview && c.last_message_from)
        .sort(
          (a, b) =>
            new Date(b.last_message_at).getTime() -
            new Date(a.last_message_at).getTime(),
        )
        .slice(0, 8),
    [convos],
  );

  const working = desks.filter((d) => d.act.kind === "working").length;
  const shippedTotal = rows.reduce((n, r) => n + r.issuesDone, 0);
  const teamLabel = activeTeam?.split(":")[0] ?? "the team";

  if (loading && rows.length === 0) {
    return <p className="muted">Tuning into the stage…</p>;
  }

  if (rows.length === 0) {
    return (
      <div className={styles.emptyWrap}>
        <div className={styles.liveTag}>
          <span className={styles.dot} /> LIVE
        </div>
        <h2 className={styles.emptyTitle}>The stage is set — no agents on it yet</h2>
        <p className="muted">
          When agents join <strong>{teamLabel}</strong> and start claiming work,
          they’ll show up here building in real time.
        </p>
      </div>
    );
  }

  return (
    <div className={styles.stage}>
      {/* marquee */}
      <header className={styles.head}>
        <div className={styles.headLeft}>
          <span className={styles.liveTag}>
            <span className={styles.dot} /> LIVE
          </span>
          <div>
            <h1 className={styles.title}>The swarm, building live</h1>
            <p className={styles.sub}>
              {rows.length} agents on <strong>{teamLabel}</strong> ·{" "}
              <span className={styles.working}>{working} heads-down</span> ·{" "}
              {shippedTotal} shipped
            </p>
          </div>
        </div>
        <div className={styles.boardStrip} aria-label="Board">
          {(
            [
              ["To do", board.todo, "todo"],
              ["In progress", board.in_progress, "wip"],
              ["In review", board.in_review, "rev"],
              ["Done", board.done, "done"],
            ] as const
          ).map(([label, n, cls]) => (
            <div key={label} className={`${styles.boardCell} ${styles[cls]}`}>
              <span className={styles.boardNum}>{n}</span>
              <span className={styles.boardLabel}>{label}</span>
            </div>
          ))}
        </div>
      </header>

      <div className={styles.body}>
        {/* the office floor */}
        <section className={styles.floor} aria-label="Agents">
          {desks.map(({ row, act }) => (
            <article
              key={row.alias}
              className={`${styles.desk} ${styles[`desk_${act.kind}`]}`}
              title={`${row.displayName} — ${act.detail}`}
            >
              <div className={styles.deskTop}>
                <Avatar
                  label={row.displayName}
                  kind={row.kind === "agent" ? "agent" : "human"}
                  size="md"
                  online={row.online}
                />
                <span className={styles.glyph} aria-hidden="true">
                  {act.kind === "working"
                    ? "⌨️"
                    : act.kind === "talking"
                      ? "💬"
                      : "☕"}
                </span>
              </div>
              <div className={styles.deskName} title={row.alias}>
                {row.displayName}
              </div>
              {row.kind === "agent" ? (
                <span className={styles.roleChip}>agent</span>
              ) : (
                <span className={`${styles.roleChip} ${styles.human}`}>human</span>
              )}
              <div className={styles.statusLine}>
                {act.kind === "working" ? (
                  <span className={styles.typing} aria-hidden="true">
                    <i /> <i /> <i />
                  </span>
                ) : null}
                <span className={styles.statusText}>
                  {act.kind === "working"
                    ? act.detail
                    : act.kind === "talking"
                      ? `talking ${act.detail}`
                      : act.detail}
                </span>
              </div>
            </article>
          ))}
        </section>

        {/* the robots, talking — the screenshot bait */}
        <aside className={styles.side}>
          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Chatter</span>
              <span className={styles.panelHint}>live</span>
            </div>
            <ul className={styles.ticker}>
              {ticker.length === 0 ? (
                <li className={styles.tickerEmpty}>…quiet for now</li>
              ) : (
                ticker.map((c) => (
                  <li key={c.conversation_id ?? c.last_message_at} className={styles.msg}>
                    <span className={styles.msgFrom}>{c.last_message_from}</span>
                    <span className={styles.msgBody}>{c.last_message_preview}</span>
                    <span className={styles.msgTime}>{ago(c.last_message_at)}</span>
                  </li>
                ))
              )}
            </ul>
          </div>

          <div className={styles.panel}>
            <div className={styles.panelHead}>
              <span className={styles.panelTitle}>Leaderboard</span>
              <span className={styles.panelHint}>today</span>
            </div>
            <ol className={styles.lb}>
              {rows.slice(0, 5).map((r, i) => (
                <li key={r.alias} className={styles.lbRow}>
                  <span className={styles.lbRank}>{MEDALS[i] ?? i + 1}</span>
                  <Avatar
                    label={r.displayName}
                    kind={r.kind === "agent" ? "agent" : "human"}
                    size="sm"
                    online={r.online}
                  />
                  <span className={styles.lbName} title={r.alias}>
                    {r.displayName}
                  </span>
                  <span className={styles.lbScore}>{r.issuesDone}</span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>

      {/* SHIPPED burst */}
      {ship ? (
        <div key={ship.key} className={styles.shipped} role="status">
          <span className={styles.shippedRocket}>🚀</span>
          <span className={styles.shippedText}>
            <strong>{ship.name}</strong> just shipped a ticket
          </span>
        </div>
      ) : null}
    </div>
  );
}
