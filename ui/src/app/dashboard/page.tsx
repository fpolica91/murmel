"use client";

import { useTeam } from "@/components/team-context";

/**
 * Placeholder dashboard content scoped to the active team. The team switcher in
 * the top bar drives `useTeam()`. Real team views (work, mail, roles) are
 * layered on top of this shell by later stories.
 */
export default function DashboardPage() {
  const { activeTeam, teams } = useTeam();

  return (
    <div className="panel" style={{ maxWidth: "none" }}>
      <h1>Team console</h1>
      {teams.length === 0 ? (
        <p className="muted">
          You are not a member of any team yet. Ask an owner to add you, then
          reload.
        </p>
      ) : (
        <p className="muted">
          Active team: <strong>{activeTeam ?? "—"}</strong> (
          {teams.length} total). Use the switcher above to change context.
        </p>
      )}
    </div>
  );
}
