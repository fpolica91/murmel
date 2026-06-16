import { ConsoleHome } from "@/components/console/console-home";

/**
 * Console — the dashboard home. An at-a-glance overview scoped to the active
 * team: team composition + presence (GET /v1/participants), a work snapshot
 * with status counts and the most-recent issues (GET /v1/issues), recent chat
 * activity (GET /v1/conversations), and quick links into Work / Chat / Members.
 *
 * The team switcher in the sidebar drives `useTeam()` inside <ConsoleHome />;
 * the auth guard + team context live in the dashboard layout.
 */
export default function DashboardPage() {
  return <ConsoleHome />;
}
