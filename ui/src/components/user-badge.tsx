"use client";

import { usePresence } from "@/components/use-presence";

/**
 * Signed-in user badge for the sidebar footer. Renders an online dot (green
 * when the presence hook reports online, muted otherwise) followed by the user
 * display name.
 *
 * This is the single mount point for `usePresence()` — mounting it here means
 * the heartbeat owner lives in the always-present shell footer, so the human
 * stays online for the lifetime of the dashboard session.
 */
export function UserBadge({ userName }: { userName: string }) {
  const { online } = usePresence();

  return (
    <div className="user-badge">
      <span
        className={`online-dot${online ? " online" : ""}`}
        aria-hidden="true"
      />
      <span className="user-badge-name" title={userName}>
        {userName}
      </span>
    </div>
  );
}
