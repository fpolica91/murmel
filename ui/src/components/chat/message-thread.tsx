"use client";

import { useEffect, useRef } from "react";

import type { ChatMessage } from "@/lib/api/chat";
import styles from "./chat.module.css";

function fmtTime(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  return new Date(t).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function MessageThread({
  messages,
  selfAlias,
  humanAliases,
  loading,
}: {
  messages: ChatMessage[];
  /** Current user's alias — messages from this alias render as "mine". */
  selfAlias: string | null;
  /** Aliases known to be HUMAN senders (for the agent/human tag). */
  humanAliases: Set<string>;
  loading: boolean;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to newest whenever the message set changes.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (loading && messages.length === 0) {
    return <div className={styles.placeholder}>Loading messages…</div>;
  }

  if (messages.length === 0) {
    return (
      <div className={styles.placeholder}>
        No messages yet. Say hello below.
      </div>
    );
  }

  return (
    <div className={styles.messages}>
      {messages.map((m) => {
        const mine = selfAlias != null && m.from_agent === selfAlias;
        const isHuman = humanAliases.has(m.from_agent);
        return (
          <div
            key={m.message_id}
            className={`${styles.msgRow} ${mine ? styles.mine : ""}`}
          >
            <div className={styles.msgMeta}>
              <span className={styles.msgAuthor}>
                {mine ? "You" : m.from_agent}
              </span>
              {!mine && (
                <span
                  className={`${styles.tag} ${
                    isHuman ? styles.human : styles.agent
                  }`}
                >
                  {isHuman ? "Human" : "Agent"}
                </span>
              )}
              <span>{fmtTime(m.timestamp)}</span>
            </div>
            <div className={styles.bubble}>{m.body || "(no content)"}</div>
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
