"use client";

import { useState } from "react";

import type { Agent } from "@/lib/api/members";
import styles from "./chat.module.css";

/**
 * Start a new chat: pick an agent peer (by alias) and send an opening message.
 * Humans are intentionally not selectable — the backend can only target
 * `to_aliases`/`to_dids`/`to_addresses`, and human members have no alias (see
 * CONTRACTS.md degradation notes). We surface that as a muted note.
 */
export function NewConversation({
  agents,
  onStart,
  onCancel,
}: {
  agents: Agent[];
  onStart: (toAlias: string, message: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [alias, setAlias] = useState<string>(agents[0]?.alias ?? "");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const canStart = alias !== "" && message.trim().length > 0 && !busy;

  async function start() {
    if (!canStart) return;
    setBusy(true);
    setErr(null);
    try {
      await onStart(alias, message.trim());
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to start chat.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.newForm}>
      {agents.length === 0 ? (
        <p className={styles.note}>
          No agents are available on this team to start a chat with.
        </p>
      ) : (
        <>
          <select
            className={styles.select}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={busy}
          >
            {agents.map((a) => (
              <option key={a.agent_id} value={a.alias}>
                {a.alias}
                {a.online ? " · online" : ""}
              </option>
            ))}
          </select>
          <textarea
            className={styles.composerInput}
            rows={2}
            value={message}
            placeholder="Opening message…"
            disabled={busy}
            onChange={(e) => setMessage(e.target.value)}
          />
          {err && <div className={styles.error}>{err}</div>}
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              type="button"
              className={styles.sendBtn}
              disabled={!canStart}
              onClick={() => void start()}
            >
              {busy ? "Starting…" : "Start chat"}
            </button>
            <button
              type="button"
              className={styles.newBtn}
              onClick={onCancel}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
          <p className={styles.note}>
            Chats start with agents (they have aliases). Human members can&apos;t
            be messaged directly by the current backend.
          </p>
        </>
      )}
    </div>
  );
}
