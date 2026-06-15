"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/http";
import { listAgents, listMembers } from "@/lib/api/members";
import type { Agent, Member } from "@/lib/api/members";
import type { AssigneeType } from "@/lib/api/types";
import styles from "./issue-thread.module.css";

/**
 * Assignee picker — pick the human or agent who owns an issue and PATCH the
 * issue's `assignee_type`/`assignee_id`.
 *
 * Roster sources (CONTRACTS.md §2):
 *   - listAgents(teamId)  -> agents WITH presence; any caller.
 *   - listMembers(teamId) -> human members; ADMIN-ONLY (403 otherwise).
 *
 * Graceful degradation: a 403 from `listMembers` means the caller is not an
 * admin, so we hide the human options and show a muted note. Agents stay
 * available to everyone.
 *
 * Identity stored in `assignee_id`:
 *   - agents -> the agent `alias` (display parity with comment authors).
 *   - humans -> the member `subject` (Better Auth user id; no alias exists).
 */
export function AssigneePicker({
  teamId,
  assigneeType,
  assigneeId,
  disabled,
  onAssign,
}: {
  teamId: string | null;
  assigneeType: AssigneeType | null;
  assigneeId: string | null;
  disabled?: boolean;
  onAssign: (
    type: AssigneeType | null,
    id: string | null,
  ) => void | Promise<void>;
}) {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [membersLocked, setMembersLocked] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected value, encoded as "type:id" (or "" for unassigned) so a single
  // <select> can mix humans and agents without ambiguity.
  const current = assigneeType && assigneeId
    ? `${assigneeType}:${assigneeId}`
    : "";
  const [selected, setSelected] = useState(current);

  // Re-sync the local selection if the issue's assignment changes upstream.
  useEffect(() => {
    setSelected(current);
  }, [current]);

  useEffect(() => {
    let cancelled = false;
    if (!teamId) {
      setAgents([]);
      setMembers([]);
      setLoading(false);
      return;
    }

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const ags = await listAgents(teamId);
        if (!cancelled) setAgents(ags);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? `Could not load agents (${err.status}).`
              : "Could not load agents.",
          );
        }
      }

      // Human members are admin-only; degrade silently to agents-only on 403.
      try {
        const mems = await listMembers(teamId as string);
        if (!cancelled) {
          setMembers(mems);
          setMembersLocked(false);
        }
      } catch (err) {
        if (!cancelled) {
          setMembers([]);
          setMembersLocked(
            err instanceof ApiError && err.status === 403,
          );
        }
      }

      if (!cancelled) setLoading(false);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const dirty = selected !== current;

  // If the current assignee isn't in either roster (e.g. an agent that has
  // since left, or a free-form id), surface it so the select doesn't silently
  // reset to "Unassigned".
  const currentIsKnown = useMemo(() => {
    if (!current) return true;
    const inAgents = agents.some((a) => `agent:${a.alias}` === current);
    const inMembers = members.some((m) => `human:${m.subject}` === current);
    return inAgents || inMembers;
  }, [current, agents, members]);

  function apply() {
    if (!selected) {
      void onAssign(null, null);
      return;
    }
    const idx = selected.indexOf(":");
    const type = selected.slice(0, idx) as AssigneeType;
    const id = selected.slice(idx + 1);
    void onAssign(type, id);
  }

  const busy = Boolean(disabled);

  return (
    <div className={styles.assignBox}>
      <select
        className={styles.assignSelect}
        value={selected}
        disabled={busy || loading}
        onChange={(e) => setSelected(e.target.value)}
        aria-label="Assignee"
      >
        <option value="">Unassigned</option>

        {!currentIsKnown && current ? (
          <option value={current}>
            {assigneeType === "human" ? "Human" : "Agent"}: {assigneeId}
          </option>
        ) : null}

        {agents.length > 0 ? (
          <optgroup label="Agents">
            {agents.map((a) => (
              <option key={`agent:${a.alias}`} value={`agent:${a.alias}`}>
                {a.alias}
                {a.online ? " ●" : ""}
              </option>
            ))}
          </optgroup>
        ) : null}

        {members.length > 0 ? (
          <optgroup label="Humans">
            {members.map((m) => (
              <option key={`human:${m.subject}`} value={`human:${m.subject}`}>
                {shortSubject(m.subject)} ({m.role})
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>

      <button
        type="button"
        className="btn btn-primary"
        style={{ width: "auto", marginTop: 0, fontSize: "0.78rem" }}
        disabled={busy || loading || !dirty}
        onClick={apply}
      >
        {busy ? "Saving…" : "Assign"}
      </button>

      {loading ? <p className={styles.assignNote}>Loading roster…</p> : null}
      {error ? <p className={styles.assignNote}>{error}</p> : null}
      {membersLocked ? (
        <p className={styles.assignNote}>
          Human member list requires admin — showing agents only.
        </p>
      ) : null}
      {!loading && agents.length === 0 && members.length === 0 && !error ? (
        <p className={styles.assignNote}>No assignable members.</p>
      ) : null}
    </div>
  );
}

/** Truncate a long Better Auth subject for display. */
function shortSubject(subject: string): string {
  if (subject.length <= 12) return subject;
  return `${subject.slice(0, 6)}…${subject.slice(-4)}`;
}
