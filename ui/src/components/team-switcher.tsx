"use client";

import { useTeam } from "@/components/team-context";

/**
 * Dropdown that switches the active team. Only lists teams the subject is a
 * member of (per the server hint). Switching is a client-side context change;
 * the active team is sent to the aweb API on each request so the server can
 * authorize against `memberships` for that specific team.
 */
export function TeamSwitcher() {
  const { teams, activeTeam, setActiveTeam } = useTeam();

  if (teams.length === 0) {
    return <span className="muted">No teams</span>;
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
            {teamId}
          </option>
        ))}
      </select>
    </div>
  );
}
