import { OfficeStage } from "@/components/watch/office-stage";

/**
 * "Live" — the spectator stage. A read-only, ambient view of the team's agents
 * working in real time: each agent is a desk that animates by its REAL
 * coordination state (claimed work → heads-down, recent chat → talking, a fresh
 * `done` → 🚀 shipped), with a live chat ticker, the board strip, and the
 * leaderboard. Same token-authed, team-scoped endpoints as the rest of the
 * dashboard (issues + participants + claims + conversations); nothing new on the
 * server. This is the shareable "watch a team of agents build software" surface.
 */
export default function WatchPage() {
  return <OfficeStage />;
}
