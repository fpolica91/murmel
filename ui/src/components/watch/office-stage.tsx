"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { useTeam } from "@/components/team-context";
import { workApi } from "@/lib/api/client";
import { listParticipants, type Participant } from "@/lib/api/participants";
import { listClaims, type Claim } from "@/lib/api/claims";
import { listChatSessions, listSessionMessages } from "@/lib/api/chat";
import { subscribeEvents } from "@/lib/events/eventStream";
import { computeLeaderboard, type LeaderboardRow } from "@/lib/leaderboard";
import type { Issue } from "@/lib/api/types";
import { deriveStage } from "./stage-derive";
import { StageView } from "./stage-view";
import { useShipDetector } from "./use-ship";

const POLL_MS = 5000;
const TALK_WINDOW_MS = 6 * 60_000;

/**
 * Authed live office (mounted at /dashboard/watch). Polls the same team-scoped
 * endpoints as the dashboard and feeds the shared {@link StageView}. NOTE: chat
 * here is scoped to the viewer's own sessions — the public stage is what shows
 * the whole team's chatter.
 */
export function OfficeStage() {
  const { activeTeam } = useTeam();
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [roster, setRoster] = useState<Participant[]>([]);
  const [says, setSays] = useState<Record<string, { text: string; ts: string }>>(
    {},
  );
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!activeTeam) {
      setRows([]);
      setLoading(false);
      return;
    }
    try {
      const [iss, ros, clm] = await Promise.all([
        workApi.listIssues(),
        listParticipants(activeTeam),
        listClaims(activeTeam).catch(() => [] as Claim[]),
      ]);
      setRows(computeLeaderboard(iss, ros, clm));
      setIssues(iss);
      setClaims(clm);
      setRoster(ros);

      try {
        const sessions = await listChatSessions(activeTeam);
        const recent = sessions
          .filter(
            (s) =>
              Date.now() - new Date(s.last_activity).getTime() < TALK_WINDOW_MS,
          )
          .sort(
            (a, b) =>
              new Date(b.last_activity).getTime() -
              new Date(a.last_activity).getTime(),
          )
          .slice(0, 6);
        const latest = await Promise.all(
          recent.map((s) =>
            listSessionMessages(activeTeam, s.session_id, { limit: 6 })
              .then((m) => m[m.length - 1] ?? null)
              .catch(() => null),
          ),
        );
        const map: Record<string, { text: string; ts: string }> = {};
        for (const m of latest) {
          if (!m || !m.body) continue;
          if (Date.now() - new Date(m.timestamp).getTime() > TALK_WINDOW_MS)
            continue;
          const ex = map[m.from_agent];
          if (!ex || new Date(m.timestamp).getTime() > new Date(ex.ts).getTime())
            map[m.from_agent] = { text: m.body, ts: m.timestamp };
        }
        setSays(map);
      } catch {
        /* bubbles best-effort */
      }
    } catch {
      /* keep last good frame */
    } finally {
      setLoading(false);
    }
  }, [activeTeam]);

  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    const unsub = activeTeam
      ? subscribeEvents(activeTeam, () => void refresh())
      : () => {};
    return () => {
      clearInterval(id);
      unsub();
    };
  }, [refresh, activeTeam]);

  const ship = useShipDetector(rows, issues);
  const view = useMemo(
    () =>
      deriveStage(
        { rows, issues, claims, roster, says },
        activeTeam?.split(":")[0] ?? "the team",
      ),
    [rows, issues, claims, roster, says, activeTeam],
  );

  if (loading && rows.length === 0) {
    return <p className="muted">Opening the office…</p>;
  }
  return <StageView view={view} rows={rows} ship={ship} />;
}
