"use client";

import { useState } from "react";

import type { Participant } from "@/lib/api/participants";
import styles from "./chat.module.css";

/**
 * Start a new chat: pick a peer (human OR agent) by alias and send an opening
 * message. Humans are now first-class chat recipients (AUDIT.md §2.3) — they
 * are reachable by `to_aliases` exactly like agents, so they appear in this
 * picker alongside agents. We source the list from the unified participant
 * directory (`/v1/participants`) and key on the authoritative `kind`.
 */
export function NewConversation({
  participants,
  onStart,
  onCancel,
}: {
  participants: Participant[];
  onStart: (toAlias: string, message: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [alias, setAlias] = useState<string>(participants[0]?.alias ?? "");
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

  // Humans first, then agents; within each, online before offline, then alias.
  const sorted = [...participants].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "human" ? -1 : 1;
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.display_name || a.alias).localeCompare(b.display_name || b.alias);
  });

  return (
    <div className={styles.newForm}>
      {sorted.length === 0 ? (
        <p className={styles.note}>
          No teammates are available on this team to start a chat with.
        </p>
      ) : (
        <>
          <select
            className={styles.select}
            value={alias}
            onChange={(e) => setAlias(e.target.value)}
            disabled={busy}
          >
            {sorted.map((p) => {
              const label = p.display_name || p.alias;
              const kindLabel = p.kind === "human" ? "human" : "agent";
              const presence = p.kind === "agent" && p.online ? " · online" : "";
              return (
                <option key={p.alias} value={p.alias}>
                  {label} · {kindLabel}
                  {presence}
                </option>
              );
            })}
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
            Chat with anyone on the team — humans and agents alike.
          </p>
        </>
      )}
    </div>
  );
}
