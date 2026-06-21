"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

import { ApiError, workApi } from "@/lib/api/client";
import {
  ISSUE_STATUSES,
  ISSUE_STATUS_LABELS,
  type Issue,
  type IssueStatus,
} from "@/lib/api/types";
import { listParticipants, type Participant } from "@/lib/api/participants";
import {
  listChatConversations,
  type ConversationItem,
} from "@/lib/api/chat";
import { useTeam } from "@/components/team-context";
import { Avatar } from "@/components/ui/avatar";
import { StatusBadge } from "@/components/work/issue-badges";
import styles from "./console.module.css";

/** Render an ISO timestamp as a compact relative label ("3h ago"). */
function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 0) return "just now";
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.floor(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(iso).toLocaleDateString();
}

interface ConsoleData {
  participants: Participant[];
  issues: Issue[];
  conversations: ConversationItem[];
}

/**
 * Console — the at-a-glance team home. Composes ONLY real endpoints:
 *
 *   - GET /v1/participants  -> humans vs AI agents, who's online (team overview)
 *   - GET /v1/issues        -> status counts + most-recent issues (work snapshot)
 *   - GET /v1/conversations -> recent chat activity (recent activity feed)
 *
 * No fabricated activity: the recent-activity column is built from real recent
 * issues (by updated_at, with their real comment counts) and real recent chat
 * conversations. When neither has data, an honest empty state shows instead.
 */
export function ConsoleHome() {
  const { activeTeam, teams } = useTeam();
  const [data, setData] = useState<ConsoleData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (teamId: string) => {
    setLoading(true);
    setError(null);
    try {
      // Conversations are best-effort: a team with chat disabled or empty must
      // not blank the whole Console, so we degrade that strand to [] on failure.
      const [participants, issues, conversations] = await Promise.all([
        listParticipants(teamId),
        workApi.listIssues(),
        listChatConversations(teamId, { limit: 5 })
          .then((r) => r.conversations ?? [])
          .catch(() => [] as ConversationItem[]),
      ]);
      setData({ participants, issues, conversations });
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : err instanceof Error
            ? err.message
            : "Failed to load the team console.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeTeam) {
      setData(null);
      setLoading(false);
      return;
    }
    void load(activeTeam);
  }, [activeTeam, load]);

  if (teams.length === 0) {
    return (
      <div className={styles.page}>
        <Header team={null} onRefresh={null} />
        <div className={styles.emptyPanel}>
          You are not a member of any team yet. Ask an owner to add you, then
          reload.
        </div>
      </div>
    );
  }

  if (!activeTeam) {
    return (
      <div className={styles.page}>
        <Header team={null} onRefresh={null} />
        <div className={styles.emptyPanel}>
          Select a team from the switcher to see its console.
        </div>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className={styles.page}>
        <Header team={activeTeam} onRefresh={null} />
        <div className={styles.emptyPanel}>Loading team console…</div>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className={styles.page}>
        <Header team={activeTeam} onRefresh={() => void load(activeTeam)} />
        <div className={styles.errorPanel}>{error}</div>
      </div>
    );
  }

  const participants = data?.participants ?? [];
  const issues = data?.issues ?? [];
  const conversations = data?.conversations ?? [];

  const humans = participants.filter((p) => p.kind === "human");
  const agents = participants.filter((p) => p.kind === "agent");
  const onlineCount = participants.filter((p) => p.online).length;

  // Status counts over the whole team backlog.
  const counts: Record<IssueStatus, number> = {
    todo: 0,
    in_progress: 0,
    in_review: 0,
    done: 0,
    blocked: 0,
    deferred: 0,
  };
  for (const issue of issues) counts[issue.status] += 1;

  // Most-recently-touched issues (server returns newest-ish; we sort defensively).
  const recentIssues = [...issues]
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    )
    .slice(0, 6);

  const openCount = counts.todo + counts.in_progress + counts.in_review;

  return (
    <div className={styles.page}>
      <Header team={activeTeam} onRefresh={() => void load(activeTeam)} />

      {error ? <div className={styles.errorBanner}>{error}</div> : null}

      {/* ---- Stat strip ---- */}
      <div className={styles.statGrid}>
        <StatCard
          label="Teammates"
          value={participants.length}
          hint={`${humans.length} human · ${agents.length} agent`}
        />
        <StatCard
          label="Online now"
          value={onlineCount}
          hint={onlineCount === 1 ? "1 active" : `${onlineCount} active`}
          accent="online"
        />
        <StatCard
          label="Open work"
          value={openCount}
          hint={`${counts.done} done`}
        />
        <StatCard
          label="In progress"
          value={counts.in_progress}
          hint={`${counts.in_review} in review`}
          accent="progress"
        />
      </div>

      <div className={styles.columns}>
        {/* ---- Left: work snapshot ---- */}
        <section className={styles.panel}>
          <div className={styles.panelHead}>
            <h2 className={styles.panelTitle}>Work snapshot</h2>
            <Link href="/dashboard/work" className={styles.panelLink}>
              Open board →
            </Link>
          </div>

          <div className={styles.statusRow}>
            {ISSUE_STATUSES.map((s) => (
              <Link
                key={s}
                href="/dashboard/work"
                className={styles.statusChip}
              >
                <span className={`${styles.statusDot} ${styles[s]}`} />
                <span className={styles.statusCount}>{counts[s]}</span>
                <span className={styles.statusLabel}>
                  {ISSUE_STATUS_LABELS[s]}
                </span>
              </Link>
            ))}
          </div>

          <h3 className={styles.subhead}>Recent issues</h3>
          {recentIssues.length === 0 ? (
            <div className={styles.empty}>
              No issues yet.{" "}
              <Link href="/dashboard/work" className={styles.inlineLink}>
                Create the first one →
              </Link>
            </div>
          ) : (
            <ul className={styles.issueList}>
              {recentIssues.map((issue) => (
                <li key={issue.issue_id} className={styles.issueRow}>
                  <Avatar
                    label={issue.assignee_id ?? ""}
                    kind={
                      !issue.assignee_id
                        ? "unassigned"
                        : issue.assignee_type === "agent"
                          ? "agent"
                          : "human"
                    }
                    size="sm"
                  />
                  <Link
                    href={`/dashboard/work/issues/${issue.issue_id}`}
                    className={styles.issueTitle}
                  >
                    {issue.title}
                  </Link>
                  {issue.comment_count ? (
                    <span className={styles.commentCount} title="Comments">
                      💬 {issue.comment_count}
                    </span>
                  ) : null}
                  <span className={styles.issueTime}>
                    {relativeTime(issue.updated_at)}
                  </span>
                  <StatusBadge status={issue.status} />
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ---- Right: team + recent activity + quick actions ---- */}
        <div className={styles.side}>
          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Team</h2>
              <Link href="/dashboard/members" className={styles.panelLink}>
                All members →
              </Link>
            </div>
            {participants.length === 0 ? (
              <div className={styles.empty}>
                No teammates yet. People and agents appear here once they join.
              </div>
            ) : (
              <ul className={styles.peopleList}>
                {[...participants]
                  .sort((a, b) => {
                    if (a.online !== b.online) return a.online ? -1 : 1;
                    return (a.display_name || a.alias).localeCompare(
                      b.display_name || b.alias,
                    );
                  })
                  .slice(0, 6)
                  .map((p) => (
                    <li key={p.alias} className={styles.personRow}>
                      <Avatar
                        label={p.display_name || p.alias}
                        kind={p.kind}
                        size="sm"
                        online={p.online}
                      />
                      <span className={styles.personName}>
                        {p.display_name || p.alias}
                      </span>
                      <span className={styles.personKind}>
                        {p.kind === "human" ? "Human" : "AI agent"}
                      </span>
                    </li>
                  ))}
              </ul>
            )}
          </section>

          <section className={styles.panel}>
            <div className={styles.panelHead}>
              <h2 className={styles.panelTitle}>Recent activity</h2>
              <Link href="/dashboard/chat" className={styles.panelLink}>
                Open chat →
              </Link>
            </div>
            {conversations.length === 0 ? (
              <div className={styles.empty}>
                No recent conversations. Start one from{" "}
                <Link href="/dashboard/chat" className={styles.inlineLink}>
                  Chat →
                </Link>
              </div>
            ) : (
              <ul className={styles.activityList}>
                {conversations.map((c) => (
                  <li
                    key={c.conversation_id ?? c.last_message_at}
                    className={styles.activityRow}
                  >
                    <span className={styles.activityFrom}>
                      {c.last_message_from || "—"}
                    </span>
                    <span className={styles.activityPreview}>
                      {c.last_message_preview || "(no preview)"}
                    </span>
                    <span className={styles.activityTime}>
                      {relativeTime(c.last_message_at)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className={styles.panel}>
            <h2 className={styles.panelTitle}>Quick actions</h2>
            <div className={styles.actions}>
              <Link href="/dashboard/work" className={styles.actionBtn}>
                View work board
              </Link>
              <Link href="/dashboard/chat" className={styles.actionBtn}>
                Open chat
              </Link>
              <Link href="/dashboard/members" className={styles.actionBtn}>
                Manage members
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function Header({
  team,
  onRefresh,
}: {
  team: string | null;
  onRefresh: (() => void) | null;
}) {
  return (
    <div className={styles.header}>
      <div>
        <h1 className={styles.h1}>Console</h1>
        <p className={styles.sub}>
          {team ? (
            <>
              At-a-glance overview for{" "}
              <strong className={styles.teamName}>{team}</strong>.
            </>
          ) : (
            "At-a-glance overview for your team."
          )}
        </p>
      </div>
      {onRefresh ? (
        <button
          type="button"
          className="btn"
          style={{ width: "auto", marginTop: 0 }}
          onClick={onRefresh}
        >
          Refresh
        </button>
      ) : null}
    </div>
  );
}

function StatCard({
  label,
  value,
  hint,
  accent,
}: {
  label: string;
  value: number;
  hint?: string;
  accent?: "online" | "progress";
}) {
  const accentClass =
    accent === "online"
      ? styles.statOnline
      : accent === "progress"
        ? styles.statProgress
        : "";
  return (
    <div className={`${styles.statCard} ${accentClass}`}>
      <span className={styles.statLabel}>{label}</span>
      <span className={styles.statValue}>{value}</span>
      {hint ? <span className={styles.statHint}>{hint}</span> : null}
    </div>
  );
}
