"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";

import type { InboxMessage } from "@/lib/api/mail";
import { Markdown } from "@/components/ui/markdown";
import { VerificationBadge } from "@/components/ui/badge";
import styles from "./mail.module.css";

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

/**
 * Renders a mail thread oldest -> newest. Each message shows a
 * `from_alias -> to_alias` header, a relative time, a Markdown body, and a
 * verification chip. For local token-auth mail the server stamps
 * `verified_server`, which the shared VerificationBadge renders as a plain
 * "Verified (server)" pill (NOT "Ed25519").
 *
 * The footer is an inline reply box that posts back into this conversation.
 * Reply is only offered when the thread has a real `conversationId` (legacy
 * single-message mail has no continuation-capable id).
 */
export function MailThread({
  messages,
  conversationId,
  loading,
  onReply,
}: {
  messages: InboxMessage[];
  conversationId: string | null;
  loading: boolean;
  onReply: (conversationId: string, body: string) => Promise<void>;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  return (
    <>
      {loading && messages.length === 0 ? (
        <div className={styles.placeholder}>Loading messages…</div>
      ) : messages.length === 0 ? (
        <div className={styles.placeholder}>This thread has no messages.</div>
      ) : (
        <div className={styles.messages}>
          {messages.map((m) => (
            <div key={m.message_id} className={styles.msg}>
              <div className={styles.msgHead}>
                <span className={styles.msgFrom}>{m.from_alias}</span>
                <span className={styles.msgArrow}>→</span>
                <span className={styles.msgTo}>{m.to_alias}</span>
                <VerificationBadge status={m.verification_status} />
                <span className={styles.msgTime}>{fmtTime(m.created_at)}</span>
              </div>
              <div className={styles.msgBody}>
                <Markdown>{m.body || "(no content)"}</Markdown>
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      )}

      {conversationId ? (
        <ReplyBox conversationId={conversationId} onReply={onReply} />
      ) : (
        <div className={styles.reply}>
          <span className={styles.note}>
            This is a legacy message with no conversation thread; replies are
            unavailable.
          </span>
        </div>
      )}
    </>
  );
}

/**
 * Inline reply composer. Enter sends; Shift+Enter inserts a newline. Disabled
 * while a send is in flight; clears on success.
 */
function ReplyBox({
  conversationId,
  onReply,
}: {
  conversationId: string;
  onReply: (conversationId: string, body: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);

  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !sending;

  async function submit() {
    if (!canSend) return;
    setSending(true);
    try {
      await onReply(conversationId, trimmed);
      setValue("");
    } finally {
      setSending(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
    }
  }

  return (
    <div className={styles.reply}>
      <textarea
        className={styles.replyInput}
        rows={1}
        value={value}
        placeholder="Reply…"
        disabled={sending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className={styles.primaryBtn}
        disabled={!canSend}
        onClick={() => void submit()}
      >
        {sending ? "Sending…" : "Reply"}
      </button>
    </div>
  );
}
