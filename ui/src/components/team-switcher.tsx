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
  padding: "0.3rem 0.55rem",
  fontSize: "var(--fs-xs)",
  cursor: "pointer",
  whiteSpace: "nowrap",
};

// Compact, square icon-button for the default (collapsed) rename affordance.
const iconBtnStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flex: "0 0 auto",
  width: "1.85rem",
  height: "1.85rem",
  border: "1px solid var(--border-strong)",
  background: "var(--control)",
  color: "var(--muted)",
  borderRadius: "var(--radius-sm)",
  fontSize: "var(--fs-sm)",
  lineHeight: 1,
  cursor: "pointer",
};

// Primary affordance inside the editor (Save).
const saveBtnStyle: React.CSSProperties = {
  ...btnStyle,
  border: "1px solid var(--accent)",
  background: "var(--accent-weak)",
  color: "var(--accent)",
};

// Row that holds the select + rename trigger, and the inline editor controls.
const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "0.4rem",
  width: "100%",
};

const inputStyle: React.CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  background: "var(--control)",
  color: "var(--text)",
  border: "1px solid var(--border-strong)",
  borderRadius: "var(--radius-sm)",
  padding: "0.4rem 0.6rem",
  fontSize: "var(--fs-sm)",
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
        <label
          className="muted"
          htmlFor="team-rename"
          style={{ marginRight: 6 }}
        >
          Team
        </label>
        <div style={rowStyle}>
          <input
            id="team-rename"
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
            style={inputStyle}
          />
          <button
            type="button"
            style={saveBtnStyle}
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
        </div>
        {error ? (
          <span
            className="muted"
            style={{ color: "var(--danger)", fontSize: "var(--fs-xs)" }}
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
      <div style={rowStyle}>
        <select
          id="team-select"
          value={activeTeam ?? ""}
          onChange={(e) => setActiveTeam(e.target.value)}
          style={{ flex: "1 1 auto", minWidth: 0 }}
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
            style={iconBtnStyle}
            onClick={startEdit}
            aria-label="Rename team"
            title="Rename team"
          >
            ✎
          </button>
        ) : null}
      </div>
    </div>
  );
}
