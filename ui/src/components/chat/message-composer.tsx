"use client";

import { useState, type KeyboardEvent } from "react";

import styles from "./chat.module.css";

/**
 * Single-line-growing composer. Enter sends; Shift+Enter inserts a newline.
 * `onSend` is async; we disable while a send is in flight.
 */
export function MessageComposer({
  onSend,
  disabled,
  placeholder = "Write a message…",
}: {
  onSend: (body: string) => Promise<void>;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const [sending, setSending] = useState(false);

  const trimmed = value.trim();
  const canSend = trimmed.length > 0 && !sending && !disabled;

  async function submit() {
    if (!canSend) return;
    setSending(true);
    try {
      await onSend(trimmed);
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
    <div className={styles.composer}>
      <textarea
        className={styles.composerInput}
        rows={1}
        value={value}
        placeholder={placeholder}
        disabled={disabled || sending}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        className={styles.sendBtn}
        disabled={!canSend}
        onClick={() => void submit()}
      >
        {sending ? "Sending…" : "Send"}
      </button>
    </div>
  );
}
