"use client";

import { useEffect, useRef, useState } from "react";

import { useTeam } from "@/components/team-context";
import { sendHeartbeat } from "@/lib/api/presence";

/** Re-ping cadence — comfortably inside the server TTL (120s) for one missed-ping margin. */
const PRESENCE_PING_MS = 45_000;

/**
 * Owns the presence heartbeat for the signed-in human. Mounted ONCE in the
 * dashboard shell (via <UserBadge/>).
 *
 * Lifecycle:
 *  - On mount (and whenever the active team changes): POST a heartbeat.
 *  - Then every PRESENCE_PING_MS while the tab stays mounted + visible.
 *  - On `visibilitychange` -> "visible": re-ping immediately and resume the
 *    interval. When hidden, pause the interval (no need to keep a hidden tab
 *    online — presence expires naturally after the TTL).
 *  - Clear the interval on unmount.
 *
 * Exposes `{ online }`: true after a successful heartbeat, false on a failed or
 * aborted heartbeat. Drives the sidebar's own online dot.
 */
export function usePresence(): { online: boolean } {
  const { activeTeam } = useTeam();
  const [online, setOnline] = useState(false);

  useEffect(() => {
    if (!activeTeam) {
      setOnline(false);
      return;
    }

    let intervalId: ReturnType<typeof setInterval> | null = null;
    const controller = new AbortController();
    let cancelled = false;

    async function ping() {
      try {
        await sendHeartbeat(activeTeam, controller.signal);
        if (!cancelled) setOnline(true);
      } catch {
        if (!cancelled) setOnline(false);
      }
    }

    function startInterval() {
      if (intervalId !== null) return;
      intervalId = setInterval(() => {
        void ping();
      }, PRESENCE_PING_MS);
    }

    function stopInterval() {
      if (intervalId !== null) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function onVisibilityChange() {
      if (document.visibilityState === "visible") {
        void ping();
        startInterval();
      } else {
        stopInterval();
      }
    }

    // Initial heartbeat + interval (only run the interval while visible).
    void ping();
    if (document.visibilityState === "visible") {
      startInterval();
    }

    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      controller.abort();
      stopInterval();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [activeTeam]);

  return { online };
}
