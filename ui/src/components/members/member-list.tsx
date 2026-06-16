"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@/lib/api/http";
import { listParticipants, type Participant } from "@/lib/api/participants";
import { useTeam } from "@/components/team-context";
import { MemberRow } from "./member-row";
import styles from "./members.module.css";

/**
 * Team roster: humans and AI agents side-by-side as teammates.
 *
 * Sources the unified participant directory (AUDIT.md §3.1):
 *   - listParticipants(teamId) -> GET /v1/participants
 *
 * This is NON-admin: it returns BOTH humans (`kind:"human"`) and agents
 * (`kind:"agent"`) to any team member, each with an AUTHORITATIVE `kind` and a
 * real `display_name`. No 403 degradation, no raw auth subject as a name, and
 * no alias-guessing. Agents carry live presence; humans report offline.
 */
export function MemberList() {
  const { activeTeam } = useTeam();

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (teamId: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await listParticipants(teamId);
      setParticipants(list);
    } catch (err) {
      const message =
        err instanceof ApiError
          ? `${err.message} (${err.status})`
          : err instanceof Error
            ? err.message
            : "Failed to load team members.";
      setError(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!activeTeam) {
      setParticipants([]);
      setLoading(false);
      return;
    }
    void load(activeTeam);
  }, [activeTeam, load]);

  if (!activeTeam) {
    return (
      <div className={styles.empty}>
        Select a team to see who is on it.
      </div>
    );
  }

  if (loading) {
    return <div className={styles.loading}>Loading team roster…</div>;
  }

  if (error) {
    return <div className={styles.error}>{error}</div>;
  }

  if (participants.length === 0) {
    return (
      <div className={styles.empty}>
        No teammates yet. People and agents appear here once they join this
        team.
      </div>
    );
  }

  const humans = participants.filter((p) => p.kind === "human");
  const agents = participants.filter((p) => p.kind === "agent");

  // Online agents first, then by display name for a stable, scannable order.
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.display_name || a.alias).localeCompare(b.display_name || b.alias);
  });
  // Humans by display name.
  const sortedHumans = [...humans].sort((a, b) =>
    (a.display_name || a.alias).localeCompare(b.display_name || b.alias),
  );

  const total = participants.length;
  // Online count derives from the SAME `online` flag the rows render (B2):
  // count every participant — human or agent — that is currently online, so
  // the header agrees with the per-row status badges.
  const onlineCount = participants.filter((p) => p.online).length;

  return (
    <div>
      <div className={styles.toolbar}>
        <span className={styles.countPill}>{total} total</span>
        <span className={styles.countPill}>{onlineCount} online</span>
      </div>

      {sortedHumans.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionLabel}>
            Humans
            <span className={styles.count}>{sortedHumans.length}</span>
          </h2>
          <div className={styles.list}>
            {sortedHumans.map((p) => (
              <MemberRow key={p.alias} participant={p} />
            ))}
          </div>
        </section>
      ) : null}

      {sortedAgents.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionLabel}>
            AI agents
            <span className={styles.count}>{sortedAgents.length}</span>
          </h2>
          <div className={styles.list}>
            {sortedAgents.map((p) => (
              <MemberRow key={p.alias} participant={p} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
