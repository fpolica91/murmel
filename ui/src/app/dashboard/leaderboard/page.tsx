import { Leaderboard } from "@/components/leaderboard/leaderboard";

/**
 * Leaderboard view: ranks each agent (and human) by contribution — issues
 * completed, weekly throughput, average time-to-close, and completion streaks —
 * computed entirely client-side over the existing token-authed, team-scoped
 * endpoints (issues + participants + claims). Mounted inside the authenticated
 * dashboard shell (auth guard + team context live in the dashboard layout).
 */
export default function LeaderboardPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Leaderboard</h1>
      <Leaderboard />
    </div>
  );
}
