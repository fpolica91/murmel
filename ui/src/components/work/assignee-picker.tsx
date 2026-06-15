"use client";

import { useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/http";
import { listParticipants } from "@/lib/api/participants";
import type { Participant } from "@/lib/api/participants";
import type { AssigneeType } from "@/lib/api/types";
import styles from "./issue-thread.module.css";

/**
 * Assignee picker — pick the human or agent who owns an issue and PATCH the
 * issue's `assignee_type`/`assignee_id`.
 *
 * Roster source (AUDIT.md §3.1/§3.3): the unified, non-admin participant
 * directory `GET /v1/participants`. It returns BOTH humans (`kind:"human"`)
 * and agents (`kind:"agent"`), so no admin-gated member lookup and no graceful
 * degradation are needed — any team member can assign to anyone.
 *
 * Identity stored in `assignee_id` is the participant's team-unique `alias`
 * for BOTH humans and agents (display parity with comment authors and chat
 * targets). `assignee_type` mirrors the participant `kind`.
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
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selected value, encoded as "type:alias" (or "" for unassigned) so a single
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
      setParticipants([]);
      setLoading(false);
      return;
    }

    async function run() {
      setLoading(true);
      setError(null);
      try {
        const list = await listParticipants(teamId);
        if (!cancelled) setParticipants(list);
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof ApiError
              ? `Could not load participants (${err.status}).`
              : "Could not load participants.",
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [teamId]);

  const humans = useMemo(
    () => participants.filter((p) => p.kind === "human"),
    [participants],
  );
  const agents = useMemo(
    () => participants.filter((p) => p.kind === "agent"),
    [participants],
  );

  const dirty = selected !== current;

  // If the current assignee isn't in the directory (e.g. someone who has since
  // left, or a free-form id), surface it so the select doesn't silently reset
  // to "Unassigned".
  const currentIsKnown = useMemo(() => {
    if (!current) return true;
    return participants.some((p) => `${p.kind}:${p.alias}` === current);
  }, [current, participants]);

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

        {humans.length > 0 ? (
          <optgroup label="Humans">
            {humans.map((p) => (
              <option key={`human:${p.alias}`} value={`human:${p.alias}`}>
                {p.display_name || p.alias}
              </option>
            ))}
          </optgroup>
        ) : null}

        {agents.length > 0 ? (
          <optgroup label="Agents">
            {agents.map((p) => (
              <option key={`agent:${p.alias}`} value={`agent:${p.alias}`}>
                {p.display_name || p.alias}
                {p.online ? " ●" : ""}
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
      {!loading && participants.length === 0 && !error ? (
        <p className={styles.assignNote}>No assignable participants.</p>
      ) : null}
    </div>
  );
}
