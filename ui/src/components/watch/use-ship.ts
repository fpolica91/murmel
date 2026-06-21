import { useEffect, useRef, useState } from "react";

import type { LeaderboardRow } from "@/lib/leaderboard";
import type { Issue } from "@/lib/api/types";
import type { ShipEvent } from "./stage-view";

/**
 * Fires a 🚀 SHIPPED event when any agent's done-count ticks up. Seeds silently
 * on the first non-empty frame so pre-existing completions don't trigger a
 * burst storm on load. Auto-dismisses after ~5s.
 */
export function useShipDetector(
  rows: LeaderboardRow[],
  issues: Issue[],
): ShipEvent | null {
  const [ship, setShip] = useState<ShipEvent | null>(null);
  const seen = useRef<Map<string, number> | null>(null);
  const key = useRef(0);

  useEffect(() => {
    if (!rows.length) return;
    const next = new Map(rows.map((r) => [r.alias, r.issuesDone]));
    const prev = seen.current;
    seen.current = next;
    if (!prev) return; // first populated frame: baseline only
    for (const r of rows) {
      if (r.issuesDone > (prev.get(r.alias) ?? 0)) {
        const last = [...issues].reverse().find((i) => i.status === "done");
        key.current += 1;
        setShip({
          key: key.current,
          name: r.displayName,
          title: last?.title ?? "a ticket",
        });
      }
    }
  }, [rows, issues]);

  useEffect(() => {
    if (!ship) return;
    const t = setTimeout(() => setShip(null), 5200);
    return () => clearTimeout(t);
  }, [ship]);

  return ship;
}
