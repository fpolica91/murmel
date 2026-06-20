"use client";

import { useEffect, useMemo, useState } from "react";

import type { Agent } from "@/lib/api/members";
import {
  sendNewMail,
  sendMailToRole,
  type MailPriority,
  type SendMailResult,
} from "@/lib/api/mail";
import { ApiError } from "@/lib/api/http";
import styles from "./mail.module.css";

type Mode = "single" | "role";

const PRIORITIES: MailPriority[] = ["low", "normal", "high", "urgent"];

/** Role identifier for an agent (role takes precedence over role_name). */
function agentRoleKey(agent: Agent): string {
  return (agent.role || agent.role_name || "").trim();
}

function errMessage(err: unknown, fallback: string): string {
  if (err instanceof ApiError) return `${err.message} (${err.status})`;
  if (err instanceof Error) return err.message;
  return fallback;
}

/**
 * Compose modal. Toggle between a SINGLE recipient (pick one agent alias) and a
 * ROLE fan-out (pick a distinct role; the mail goes to every agent in it).
 *
 * Single send -> sendNewMail. Role send -> sendMailToRole, then a per-recipient
 * delivered/failed RESULTS view that stays up until the user dismisses it (we
 * never auto-close on a fan-out, so partial failures are visible). On a
 * successful single send we close and let the parent refresh + select the new
 * thread.
 */
export function MailComposer({
  teamId,
  agents,
  onClose,
  onSent,
}: {
  teamId: string | null;
  agents: Agent[];
  onClose: () => void;
  /** Called after a successful SINGLE send so the parent can refresh/select. */
  onSent: (result: { conversation_id: string | null }) => void;
}) {
  const [mode, setMode] = useState<Mode>("single");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [priority, setPriority] = useState<MailPriority>("normal");

  // Distinct roles present on the team, sorted; agents sorted by alias.
  const roles = useMemo(() => {
    const set = new Set<string>();
    for (const a of agents) {
      const key = agentRoleKey(a);
      if (key) set.add(key);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [agents]);

  const sortedAgents = useMemo(
    () => [...agents].sort((a, b) => a.alias.localeCompare(b.alias)),
    [agents],
  );

  const [toAlias, setToAlias] = useState<string>("");
  const [roleKey, setRoleKey] = useState<string>("");

  // Seed the pickers once the directory arrives (and keep a valid selection).
  useEffect(() => {
    if (!toAlias && sortedAgents[0]) setToAlias(sortedAgents[0].alias);
  }, [sortedAgents, toAlias]);
  useEffect(() => {
    if (!roleKey && roles[0]) setRoleKey(roles[0]);
  }, [roles, roleKey]);

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<SendMailResult[] | null>(null);

  const recipientChosen = mode === "single" ? toAlias !== "" : roleKey !== "";
  const canSend = recipientChosen && body.trim().length > 0 && !sending;

  async function submit() {
    if (!canSend) return;
    setSending(true);
    setError(null);
    try {
      if (mode === "single") {
        const res = await sendNewMail(teamId, {
          to_alias: toAlias,
          subject: subject.trim(),
          body: body.trim(),
          priority,
        });
        onSent({ conversation_id: res.conversation_id });
        onClose();
      } else {
        const res = await sendMailToRole(teamId, roleKey, {
          subject: subject.trim(),
          body: body.trim(),
          priority,
        });
        // Show the per-recipient outcome and keep the modal open.
        setResults(res);
      }
    } catch (err) {
      setError(errMessage(err, "Failed to send mail."));
    } finally {
      setSending(false);
    }
  }

  // ---- Results view (role fan-out) ---------------------------------------
  if (results) {
    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    return (
      <div
        className={styles.modalOverlay}
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className={styles.modal}>
          <div className={styles.modalHeader}>
            <h2 className={styles.modalTitle}>Sent to “{roleKey}”</h2>
            <button
              type="button"
              className={styles.closeBtn}
              aria-label="Close"
              onClick={onClose}
            >
              ×
            </button>
          </div>
          <p className={styles.resultsSummary}>
            {results.length === 0
              ? "No agents matched that role."
              : `${okCount} delivered${failCount > 0 ? `, ${failCount} failed` : ""}.`}
          </p>
          {results.length > 0 && (
            <div className={styles.results}>
              {results.map((r) => (
                <div key={r.alias} className={styles.resultRow}>
                  <span className={styles.resultAlias}>{r.alias}</span>
                  {r.ok ? (
                    <span className={styles.resultOk}>Delivered</span>
                  ) : (
                    <span className={styles.resultFail} title={r.error}>
                      Failed
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
          <div className={styles.modalActions}>
            <button type="button" className={styles.primaryBtn} onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ---- Compose form ------------------------------------------------------
  return (
    <div
      className={styles.modalOverlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>New mail</h2>
          <button
            type="button"
            className={styles.closeBtn}
            aria-label="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className={styles.modeToggle}>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === "single" ? styles.modeActive : ""}`}
            onClick={() => setMode("single")}
          >
            Single agent
          </button>
          <button
            type="button"
            className={`${styles.modeBtn} ${mode === "role" ? styles.modeActive : ""}`}
            onClick={() => setMode("role")}
          >
            Role
          </button>
        </div>

        {mode === "single" ? (
          <div className={styles.field}>
            <label className={styles.label}>To (agent)</label>
            {sortedAgents.length === 0 ? (
              <p className={styles.note}>No agents on this team to mail.</p>
            ) : (
              <select
                className={styles.select}
                value={toAlias}
                onChange={(e) => setToAlias(e.target.value)}
                disabled={sending}
              >
                {sortedAgents.map((a) => (
                  <option key={a.agent_id} value={a.alias}>
                    {a.alias}
                    {a.role || a.role_name ? ` · ${a.role || a.role_name}` : ""}
                  </option>
                ))}
              </select>
            )}
          </div>
        ) : (
          <div className={styles.field}>
            <label className={styles.label}>To (role)</label>
            {roles.length === 0 ? (
              <p className={styles.note}>No roles assigned on this team.</p>
            ) : (
              <select
                className={styles.select}
                value={roleKey}
                onChange={(e) => setRoleKey(e.target.value)}
                disabled={sending}
              >
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {r}
                  </option>
                ))}
              </select>
            )}
            <span className={styles.note}>
              Sends one mail to every agent in this role.
            </span>
          </div>
        )}

        <div className={styles.field}>
          <label className={styles.label}>Subject</label>
          <input
            className={styles.input}
            value={subject}
            placeholder="Subject (optional)"
            disabled={sending}
            onChange={(e) => setSubject(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Message</label>
          <textarea
            className={styles.textarea}
            value={body}
            placeholder="Write your message… (Markdown supported)"
            disabled={sending}
            onChange={(e) => setBody(e.target.value)}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label}>Priority</label>
          <select
            className={styles.select}
            value={priority}
            onChange={(e) => setPriority(e.target.value as MailPriority)}
            disabled={sending}
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </div>

        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.modalActions}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={onClose}
            disabled={sending}
          >
            Cancel
          </button>
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={!canSend}
            onClick={() => void submit()}
          >
            {sending ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
