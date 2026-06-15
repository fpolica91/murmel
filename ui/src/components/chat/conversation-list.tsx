"use client";

import type { SessionListItem } from "@/lib/api/chat";
import styles from "./chat.module.css";

/**
 * A normalized row the list renders, merged from the chat-native session list
 * (gives us `sender_waiting` + the canonical participant set) and the
 * conversations surface (gives us preview + unread). Keyed by session id.
 */
export interface ConversationRow {
  sessionId: string;
  /** Aliases of the OTHER participants (you are excluded). */
  peers: string[];
  lastActivity: string;
  preview: string;
  lastFrom: string;
  unread: number;
  senderWaiting: boolean;
}

function relTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const diff = Date.now() - t;
  const min = Math.floor(diff / 60000);
  if (min < 1) return "now";
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  return new Date(t).toLocaleDateString();
}

export function ConversationList({
  rows,
  activeSessionId,
  onSelect,
}: {
  rows: ConversationRow[];
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
}) {
  if (rows.length === 0) {
    return <div className={styles.empty}>No conversations yet</div>;
  }

  return (
    <ul className={styles.list}>
      {rows.map((row) => {
        const names = row.peers.length > 0 ? row.peers.join(", ") : "Direct chat";
        const preview = row.preview
          ? row.lastFrom
            ? `${row.lastFrom}: ${row.preview}`
            : row.preview
          : "No messages yet";
        return (
          <li key={row.sessionId}>
            <button
              type="button"
              className={`${styles.convItem} ${
                row.sessionId === activeSessionId ? styles.active : ""
              }`}
              onClick={() => onSelect(row.sessionId)}
            >
              <div className={styles.convTop}>
                <span className={styles.convNames}>{names}</span>
                <span className={styles.convTime}>
                  {row.senderWaiting && (
                    <span
                      className={styles.waitingDot}
                      title="Peer is waiting for a reply"
                    />
                  )}{" "}
                  {relTime(row.lastActivity)}
                </span>
              </div>
              <div className={styles.convTop}>
                <span className={styles.convPreview}>{preview}</span>
                {row.unread > 0 && (
                  <span className={styles.unread}>{row.unread}</span>
                )}
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/** Helper: peers of a chat-native session row, excluding the current user. */
export function sessionPeers(
  session: SessionListItem,
  selfAlias: string | null,
): string[] {
  return session.participants.filter((p) => p && p !== selfAlias);
}
