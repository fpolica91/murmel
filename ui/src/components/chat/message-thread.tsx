"use client";

import { useEffect, useRef } from "react";

import type { ChatMessage } from "@/lib/api/chat";
import { MessageBubble } from "@/components/ui/message-bubble";
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
  peerAliases,
  kindByAlias,
  loading,
}: {
  messages: ChatMessage[];
  /**
   * Aliases of the OTHER participants in this session (the server excludes the
   * caller from the participant set). A message is "mine" when its sender is
   * NOT one of these peers — reliable even for a 1:1 session.
   */
  peerAliases: Set<string>;
  /**
   * Directory-backed fallback for a message's sender kind, keyed by alias. Used
   * ONLY when the server did not stamp `from_kind` on the message (pre-contract
   * server). The authoritative signal is `message.from_kind` (AUDIT.md §3.2);
   * the UI keys on that and never guesses by alias-matching.
   */
  kindByAlias: Map<string, "human" | "agent">;
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
        const mine = !peerAliases.has(m.from_agent);
        // Authoritative: server-stamped from_kind. Fall back to the directory
        // lookup, then to "agent" for legacy/unresolved senders.
        const kind =
          m.from_kind ?? kindByAlias.get(m.from_agent) ?? "agent";
        return (
          <MessageBubble
            key={m.message_id}
            body={m.body}
            author={m.from_agent}
            kind={kind}
            time={fmtTime(m.timestamp)}
            mine={mine}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
