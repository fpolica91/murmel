import { ClaimsMonitor } from "@/components/claims/claims-monitor";

/**
 * Claims & Locks: a live "who-holds-what right now" view. Two sections —
 * active task/issue claims (who is working on what) and resource reservations
 * (soft TTL locks, with a holder-only release). Mounted inside the
 * authenticated dashboard shell (auth guard + team context live in the
 * dashboard layout).
 */
export default function ClaimsPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Claims &amp; Locks</h1>
      <ClaimsMonitor />
    </div>
  );
}
