"use client";

import { useState } from "react";

import { useTeam } from "@/components/team-context";
import { renameTeam } from "@/lib/api/client";

const ADMIN_ROLES = new Set(["owner", "admin"]);

const btnStyle: React.CSSProperties = {
  border: "1px solid var(--border-strong)",
  background: "var(--control)",
  color: "var(--muted)",
  borderRadius: "var(--radius-sm)",
  padding: "0.2rem 0.45rem",
  fontSize: "var(--fs-xs)",
  cursor: "pointer",
  marginLeft: 4,
};

/**
 * Dropdown that switches the active team (showing each team's friendly
 * display_name), plus an inline rename for owners/admins. Switching is a
 * client-side context change; the active team is sent to the aweb API on each
 * request so the server authorizes against `memberships` for that team. Rename
 * PATCHes /v1/teams/{id} — the server re-checks the owner/admin role.
 */
export function TeamSwitcher() {
  const {
    teams,
    activeTeam,
    setActiveTeam,
    teamLabels,
    teamRoles,
    renameTeamLabel,
  } = useTeam();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (teams.length === 0) {
    return <span className="muted">No teams</span>;
  }

  const labelFor = (id: string) => teamLabels[id] ?? id;
  const canRename =
    !!activeTeam &&
    ADMIN_ROLES.has((teamRoles[activeTeam] ?? "").toLowerCase());

  function startEdit() {
    if (!activeTeam) return;
    setDraft(labelFor(activeTeam));
    setError(null);
    setEditing(true);
  }

  async function save() {
    if (!activeTeam) return;
    const name = draft.trim();
    if (!name || name === labelFor(activeTeam)) {
      setEditing(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await renameTeam(activeTeam, name);
      renameTeamLabel(activeTeam, name);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Rename failed");
    } finally {
      setBusy(false);
    }
  }

  if (editing) {
    return (
      <div className="team-switcher">
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void save();
            if (e.key === "Escape") setEditing(false);
          }}
          disabled={busy}
          maxLength={80}
          aria-label="Team name"
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          type="button"
          style={btnStyle}
          onClick={() => void save()}
          disabled={busy}
        >
          {busy ? "…" : "Save"}
        </button>
        <button
          type="button"
          style={btnStyle}
          onClick={() => setEditing(false)}
          disabled={busy}
        >
          Cancel
        </button>
        {error ? (
          <span
            className="muted"
            style={{ color: "var(--danger)", marginLeft: 6 }}
          >
            {error}
          </span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="team-switcher">
      <label className="muted" htmlFor="team-select" style={{ marginRight: 6 }}>
        Team
      </label>
      <select
        id="team-select"
        value={activeTeam ?? ""}
        onChange={(e) => setActiveTeam(e.target.value)}
      >
        {teams.map((teamId) => (
          <option key={teamId} value={teamId}>
            {labelFor(teamId)}
          </option>
        ))}
      </select>
      {canRename ? (
        <button
          type="button"
          style={btnStyle}
          onClick={startEdit}
          aria-label="Rename team"
          title="Rename team"
        >
          ✎
        </button>
      ) : null}
    </div>
  );
}
