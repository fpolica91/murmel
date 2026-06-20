"use client";

import type { Participant } from "@/lib/api/participants";
import { Avatar } from "@/components/ui/avatar";
import { KindBadge } from "@/components/ui/badge";
import styles from "./members.module.css";

/**
 * A single roster row, rendered from a unified `Participant` (AUDIT.md §3.1).
 *
 * The human-vs-agent split is the AUTHORITATIVE `kind` — never guessed. Humans
 * carry a real `display_name`; presence (online/status/last_seen) applies to
 * any participant that heartbeats — a signed-in human or a live agent.
 */
export type RosterEntry = { participant: Participant };

/**
 * Operator role-assignment control wiring, threaded down from `MemberList`.
 * Present only for AGENT rows whose `alias` resolves to a workspace_id (so the
 * role is actually assignable). When absent — humans, or an agent with no
 * backing workspace — the row falls back to the read-only role chip.
 *
 * `catalog` is the team's assignable role names (active roles-bundle keys, else
 * the distinct roles already in use). `current` is the role the row should show
 * (the optimistic value held by the parent). `busy` disables the picker while a
 * PATCH is in flight; `error` surfaces a failed assignment. `onAssign` fires
 * with the chosen role name.
 */
export interface RoleControl {
  catalog: string[];
  current: string | null;
  busy: boolean;
  error: string | null;
  onAssign: (roleName: string) => void;
}

/** Relative "last seen" label from an ISO timestamp. */
function relativeTime(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return null;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function MemberRow({
  participant,
  roleControl,
}: {
  participant: Participant;
  /** Operator role picker, present only for assignable agent rows. */
  roleControl?: RoleControl;
}) {
  const p = participant;
  const isHuman = p.kind === "human";
  const name = p.display_name || p.alias;
  // Presence applies to any participant that heartbeats (human or agent).
  const online = p.online;
  const lastSeen = relativeTime(p.last_seen);

  // When an operator role picker is wired, it OWNS the role display for this
  // row (it renders the assignable control). Otherwise fall back to the static
  // chip — N9: show a role chip on every row for section symmetry; humans fall
  // back to a neutral "member" placeholder when the directory carries no role.
  const roleLabel = p.role || (isHuman ? "member" : null);
  const showRoleChip = !roleControl && roleLabel;

  return (
    <div className={styles.row}>
      <Avatar
        label={name}
        kind={isHuman ? "human" : "agent"}
        size="lg"
        online={online}
      />

      <div className={styles.identity}>
        <div className={styles.nameLine}>
          <span className={styles.name}>{name}</span>
          <KindBadge kind={isHuman ? "human" : "agent"} />
          {showRoleChip ? (
            <span className={styles.role}>{roleLabel}</span>
          ) : null}
        </div>
        {p.address ? (
          <span className={`${styles.subline} mono`}>{p.address}</span>
        ) : null}
      </div>

      {roleControl ? (
        <RolePicker alias={p.alias} control={roleControl} />
      ) : null}

      <div className={styles.presence}>
        <span
          className={`${styles.statusBadge} ${online ? styles.online : ""}`}
        >
          <span
            className={`${styles.statusDot} ${online ? styles.online : ""}`}
            aria-hidden="true"
          />
          {online ? p.status || "online" : p.status || "offline"}
        </span>
        {!online && lastSeen ? (
          <span className={styles.lastSeen}>seen {lastSeen}</span>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The operator role picker rendered on an assignable agent row. A native
 * `<select>` whose options are the role catalog, with two synthesized entries:
 *
 *   - an empty "no role" placeholder, shown only while the agent has no role
 *     assigned yet (this surface is assign-only — it does not offer clearing an
 *     existing role, deferred per the brief);
 *   - the agent's CURRENT role when it is not in the catalog, so the control
 *     truthfully reflects the live value instead of silently snapping to a
 *     different option.
 *
 * Choosing an option fires `onAssign`; the parent does the optimistic update +
 * PATCH + reconcile, and feeds `current`/`busy`/`error` back down.
 */
function RolePicker({
  alias,
  control,
}: {
  alias: string;
  control: RoleControl;
}) {
  const { catalog, current, busy, error, onAssign } = control;

  // Build the option set: catalog + (current role if off-catalog).
  const options = [...catalog];
  if (current && !options.includes(current)) {
    options.unshift(current);
  }

  const value = current ?? "";

  return (
    <div className={styles.roleControl}>
      <select
        className={styles.roleSelect}
        aria-label={`Coordination role for ${alias}`}
        value={value}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value;
          // Ignore the placeholder and re-selecting the same role.
          if (!next || next === current) return;
          onAssign(next);
        }}
      >
        {current ? null : (
          <option value="">{busy ? "Assigning…" : "Set role…"}</option>
        )}
        {options.map((roleName) => (
          <option key={roleName} value={roleName}>
            {roleName}
          </option>
        ))}
      </select>
      {error ? <span className={styles.roleError}>{error}</span> : null}
    </div>
  );
}
