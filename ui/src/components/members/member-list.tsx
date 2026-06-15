"use client";

import { useCallback, useEffect, useState } from "react";

import { ApiError } from "@/lib/api/http";
import { listAgents, listMembers } from "@/lib/api/members";
import type { Agent, Member } from "@/lib/api/members";
import { useTeam } from "@/components/team-context";
import { MemberRow } from "./member-row";
import styles from "./members.module.css";

/**
 * Team roster: humans and AI agents side-by-side as teammates.
 *
 * Data sources (see CONTRACTS.md §2):
 *   - listAgents(teamId)  -> agents WITH presence (any caller).
 *   - listMembers(teamId) -> human memberships, ADMIN-ONLY (may 403).
 *
 * Degradation: a 403 on listMembers means the caller is not an admin. We still
 * render the full agent roster and surface a muted note explaining the humans
 * list needs admin. Humans have no presence/display name by design, so their
 * rows only show subject + role + status.
 */
export function MemberList() {
  const { activeTeam } = useTeam();

  const [agents, setAgents] = useState<Agent[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  /** True when listMembers returned 403 (caller is not an admin). */
  const [membersForbidden, setMembersForbidden] = useState(false);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (teamId: string) => {
    setLoading(true);
    setError(null);
    setMembersForbidden(false);
    try {
      // Agents are the load-bearing call; humans are best-effort (admin-gated).
      const agentList = await listAgents(teamId);
      setAgents(agentList);

      try {
        const memberList = await listMembers(teamId);
        setMembers(memberList);
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) {
          setMembersForbidden(true);
          setMembers([]);
        } else {
          // Non-403 failures on the humans list shouldn't blank the page;
          // just drop humans and keep going (agents already loaded).
          setMembers([]);
        }
      }
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
      setAgents([]);
      setMembers([]);
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

  const total = agents.length + members.length;

  if (total === 0) {
    return (
      <div className={styles.empty}>
        No teammates yet. Agents appear here once a workspace joins this team
        {membersForbidden ? "" : ", and human members once they are invited"}.
      </div>
    );
  }

  // Online agents first, then by alias for a stable, scannable order.
  const sortedAgents = [...agents].sort((a, b) => {
    if (a.online !== b.online) return a.online ? -1 : 1;
    return (a.alias || a.agent_id).localeCompare(b.alias || b.agent_id);
  });
  const onlineCount = agents.filter((a) => a.online).length;

  return (
    <div>
      <div className={styles.toolbar}>
        <span className={styles.countPill}>{total} total</span>
        {agents.length > 0 ? (
          <span className={styles.countPill}>{onlineCount} online</span>
        ) : null}
      </div>

      {membersForbidden ? (
        <p className={styles.note}>
          Human member list requires admin — showing AI agents only. Humans also
          have no live presence on this surface.
        </p>
      ) : null}

      {sortedAgents.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionLabel}>
            AI agents
            <span className={styles.count}>{sortedAgents.length}</span>
          </h2>
          <div className={styles.list}>
            {sortedAgents.map((a) => (
              <MemberRow key={a.agent_id} entry={{ kind: "agent", agent: a }} />
            ))}
          </div>
        </section>
      ) : null}

      {members.length > 0 ? (
        <section className={styles.section}>
          <h2 className={styles.sectionLabel}>
            Humans
            <span className={styles.count}>{members.length}</span>
          </h2>
          <div className={styles.list}>
            {members.map((m) => (
              <MemberRow
                key={m.subject}
                entry={{ kind: "human", member: m }}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
