"use client";

import type { MailPriority } from "@/lib/api/mail";
import styles from "./mail.module.css";

/**
 * A normalized mail row the list renders. The controller builds these from
 * either the inbox (grouped by conversation) or the mail-conversations surface,
 * so this component is source-agnostic and just renders.
 */
export interface MailRow {
  /** Stable key + selection id (conversation_id, or a legacy message id). */
  id: string;
  /** The conversation_id to open a thread, when this row has one. */
  conversationId: string | null;
  subject: string;
  /** "from -> to" for inbox, or last_message_from for sent/threads. */
  people: string;
  lastActivity: string;
  unread: number;
  priority?: MailPriority;
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

export function MailList({
  rows,
  activeId,
  onSelect,
  emptyLabel,
}: {
  rows: MailRow[];
  activeId: string | null;
  onSelect: (row: MailRow) => void;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <div className={styles.empty}>{emptyLabel}</div>;
  }

  return (
    <ul className={styles.list}>
      {rows.map((row) => {
        const unread = row.unread > 0;
        const subject = row.subject || "(no subject)";
        const prioClass =
          row.priority === "high"
            ? styles.prioHigh
            : row.priority === "urgent"
              ? styles.prioUrgent
              : "";
        return (
          <li key={row.id}>
            <button
              type="button"
              className={`${styles.row} ${row.id === activeId ? styles.active : ""}`}
              onClick={() => onSelect(row)}
            >
              <div className={styles.rowTop}>
                <span
                  className={`${styles.rowSubject} ${unread ? styles.unread : ""}`}
                >
                  {unread && <span className={styles.unreadDot} aria-hidden />}
                  {subject}
                </span>
                <span className={styles.rowTime}>{relTime(row.lastActivity)}</span>
              </div>
              <div className={styles.rowMeta}>
                <span className={styles.rowPeople}>{row.people}</span>
                <span style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  {row.priority && row.priority !== "normal" && (
                    <span className={`${styles.prio} ${prioClass}`}>
                      {row.priority}
                    </span>
                  )}
                  {row.unread > 0 && (
                    <span className={styles.rowUnread}>{row.unread}</span>
                  )}
                </span>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
