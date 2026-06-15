"use client";

import type { Agent, Member } from "@/lib/api/members";
import styles from "./members.module.css";

/**
 * A single roster row. Two shapes feed this:
 *
 *   - kind === "agent": an AI teammate from GET /v1/agents. Carries presence
 *     (online/status/last_seen) and a human-readable alias.
 *   - kind === "human": a human membership from GET /v1/teams/{id}/members
 *     (admin-only). NO presence and NO display name — only `subject`/role/
 *     status exist, so we show a truncated subject + role.
 */
export type RosterEntry =
  | { kind: "agent"; agent: Agent }
  | { kind: "human"; member: Member };

/** Pick up to two initials for the avatar from a label. */
function initials(label: string): string {
  const cleaned = label.replace(/[^a-zA-Z0-9 ]/g, " ").trim();
  if (!cleaned) return "?";
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2);
  return (parts[0][0] + parts[1][0]).slice(0, 2);
}

/** Truncate a long opaque id (e.g. Better Auth subject) for display. */
function truncId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 8)}…${id.slice(-4)}`;
}

/** Relative "last seen" label from an ISO timestamp. */
function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function MemberRow({ entry }: { entry: RosterEntry }) {
  if (entry.kind === "agent") {
    const a = entry.agent;
    const name = a.alias || a.agent_id;
    const online = a.online;
    // role_name is the friendly label; fall back to role slug.
    const roleLabel = a.role_name || a.role;
    // A short context line: human owner (if any) and where it runs.
    const contextBits: string[] = [];
    if (a.human_name) contextBits.push(a.human_name);
    if (a.repo) contextBits.push(a.repo);
    else if (a.workspace_type) contextBits.push(a.workspace_type);
    const lastSeen = relativeTime(a.last_seen);

    return (
      <div className={styles.row}>
        <div className={styles.avatarWrap}>
          <span className={`${styles.avatar} ${styles.agent}`}>
            {initials(name)}
          </span>
          <span
            className={`${styles.dot} ${online ? styles.online : ""}`}
            aria-hidden="true"
          />
        </div>

        <div className={styles.identity}>
          <div className={styles.nameLine}>
            <span className={styles.name}>{name}</span>
            <span className={`${styles.tag} ${styles.agent}`}>AI agent</span>
            {roleLabel ? <span className={styles.role}>{roleLabel}</span> : null}
          </div>
          {contextBits.length > 0 ? (
            <span className={styles.subline}>{contextBits.join(" · ")}</span>
          ) : null}
        </div>

        <div className={styles.presence}>
          <span
            className={`${styles.statusBadge} ${online ? styles.online : ""}`}
          >
            <span
              className={`${styles.statusDot} ${online ? styles.online : ""}`}
              aria-hidden="true"
            />
            {online ? a.status || "online" : a.status || "offline"}
          </span>
          {!online && lastSeen ? (
            <span className={styles.lastSeen}>seen {lastSeen}</span>
          ) : null}
        </div>
      </div>
    );
  }

  // Human membership — no presence, no display name.
  const m = entry.member;
  return (
    <div className={styles.row}>
      <div className={styles.avatarWrap}>
        <span className={`${styles.avatar} ${styles.human}`}>
          {initials(m.subject)}
        </span>
      </div>

      <div className={styles.identity}>
        <div className={styles.nameLine}>
          <span className={`${styles.name} ${styles.mono}`}>
            {truncId(m.subject)}
          </span>
          <span className={`${styles.tag} ${styles.human}`}>Human</span>
          {m.role ? <span className={styles.role}>{m.role}</span> : null}
        </div>
        <span className={styles.subline}>Membership · no live presence</span>
      </div>

      <div className={styles.presence}>
        <span className={styles.statusBadge}>{m.status || "active"}</span>
      </div>
    </div>
  );
}
