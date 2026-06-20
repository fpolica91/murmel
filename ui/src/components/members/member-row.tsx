"use client";

import type { Participant } from "@/lib/api/participants";
import { Avatar } from "@/components/ui/avatar";
import { KindBadge } from "@/components/ui/badge";
import styles from "./members.module.css";

/**
 * A single roster row, rendered from a unified `Participant` (AUDIT.md §3.1).
 *
 * The human-vs-agent split is the AUTHORITATIVE `kind` — never guessed. Humans
 * carry a real `display_name`; presence (online/status/last_seen) applies to
 * any participant that heartbeats — a signed-in human or a live agent.
 */
export type RosterEntry = { participant: Participant };

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

export function MemberRow({ participant }: { participant: Participant }) {
  const p = participant;
  const isHuman = p.kind === "human";
  const name = p.display_name || p.alias;
  // Presence applies to any participant that heartbeats (human or agent).
  const online = p.online;
  const lastSeen = relativeTime(p.last_seen);

  // N9: show a role chip on every row for section symmetry — humans fall back
  // to a neutral "member" placeholder when the directory carries no role.
  const roleLabel = p.role || (isHuman ? "member" : null);

  return (
    <div className={styles.row}>
      <Avatar
        label={name}
        kind={isHuman ? "human" : "agent"}
        size="lg"
        online={online}
      />

      <div className={styles.identity}>
        <div className={styles.nameLine}>
          <span className={styles.name}>{name}</span>
          <KindBadge kind={isHuman ? "human" : "agent"} />
          {roleLabel ? <span className={styles.role}>{roleLabel}</span> : null}
        </div>
        {p.address ? (
          <span className={`${styles.subline} mono`}>{p.address}</span>
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
          {online ? p.status || "online" : p.status || "offline"}
        </span>
        {!online && lastSeen ? (
          <span className={styles.lastSeen}>seen {lastSeen}</span>
        ) : null}
      </div>
    </div>
  );
}
