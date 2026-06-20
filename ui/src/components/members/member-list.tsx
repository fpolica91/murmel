"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { ApiError } from "@/lib/api/http";
import { listParticipants, type Participant } from "@/lib/api/participants";
import { fetchActiveRoles } from "@/lib/api/roles";
import {
  listWorkspaces,
  setWorkspaceRole,
  type Workspace,
} from "@/lib/api/workspaces";
import { useTeam } from "@/components/team-context";
import { MemberRow, type RoleControl } from "./member-row";
import styles from "./members.module.css";

/**
 * Team roster: humans and AI agents side-by-side as teammates, plus the
 * operator ROLE-ASSIGNMENT control plane for agents.
 *
 * Sources the unified participant directory (AUDIT.md §3.1):
 *   - listParticipants(teamId) -> GET /v1/participants
 *
 * This is NON-admin: it returns BOTH humans (`kind:"human"`) and agents
 * (`kind:"agent"`) to any team member, each with an AUTHORITATIVE `kind` and a
 * real `display_name`. No 403 degradation, no raw auth subject as a name, and
 * no alias-guessing. Agents carry live presence; humans report offline.
 *
 * Role control (agents only): each agent row gets a picker to set its
 * coordination role from the team's role catalog. Two extra reads back it:
 *   - fetchActiveRoles(teamId) -> the role CATALOG (active bundle role keys;
 *     falls back to the distinct roles already in use when the bundle is empty)
 *   - listWorkspaces(teamId)   -> the alias -> workspace_id map. We use the
 *     UNFILTERED list so OFFLINE agents stay editable (participants carry the
 *     `alias` but not the `workspace_id` the PATCH targets).
 * Assignment is `setWorkspaceRole` (PATCH /v1/workspaces/{id} {role_name}).
 * It is optimistic — the PATCH does NOT refresh Redis presence, so we also
 * reload the roster in the background to reconcile.
 */
export function MemberList() {
  const { activeTeam } = useTeam();

  const [participants, setParticipants] = useState<Participant[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Optimistic per-alias role overrides + per-row busy / error state for the
  // role picker. Keyed by alias (the team-unique selector the rows use).
  const [roleOverrides, setRoleOverrides] = useState<Record<string, string>>(
    {},
  );
  const [roleBusy, setRoleBusy] = useState<Record<string, boolean>>({});
  const [roleErrors, setRoleErrors] = useState<Record<string, string>>({});

  const load = useCallback(async (teamId: string) => {
    setLoading(true);
    setError(null);
    try {
      // Roster is required; the role-control reads degrade gracefully (a
      // failure there should not blank the whole roster — agents still render
      // read-only). `listParticipants` is the hard dependency.
      const [list, ws, roles] = await Promise.all([
        listParticipants(teamId),
        listWorkspaces(teamId).catch(() => [] as Workspace[]),
        fetchActiveRoles(teamId)
          .then((r) => Object.keys(r.roles ?? {}))
          .catch(() => [] as string[]),
      ]);
      setParticipants(list);
      setWorkspaces(ws);
      setCatalog(roles);
      // A fresh load is the source of truth; drop optimistic overrides so the
      // server-reconciled roles win.
      setRoleOverrides({});
      setRoleErrors({});
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
      setWorkspaces([]);
      setCatalog([]);
      setLoading(false);
      return;
    }
    void load(activeTeam);
  }, [activeTeam, load]);

  // alias -> workspace row (the PATCH target + its current server role).
  const workspaceByAlias = useMemo(() => {
    const map = new Map<string, Workspace>();
    for (const w of workspaces) map.set(w.alias, w);
    return map;
  }, [workspaces]);

  // The assignable role catalog. Prefer the active roles-bundle keys; when the
  // bundle is empty, fall back to the distinct roles already assigned across
  // the team (workspaces + participants) so the picker is never empty when
  // roles exist in practice. Sorted for a stable, scannable order.
  const roleCatalog = useMemo(() => {
    const names = new Set<string>(catalog);
    if (names.size === 0) {
      for (const w of workspaces) {
        if (w.role_name) names.add(w.role_name);
        else if (w.role) names.add(w.role);
      }
      for (const p of participants) {
        if (p.role) names.add(p.role);
      }
    }
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [catalog, workspaces, participants]);

  const assignRole = useCallback(
    async (alias: string, workspaceId: string, roleName: string) => {
      if (!activeTeam) return;
      // Optimistic: reflect the new role immediately, mark the row busy.
      setRoleOverrides((m) => ({ ...m, [alias]: roleName }));
      setRoleErrors((m) => {
        const next = { ...m };
        delete next[alias];
        return next;
      });
      setRoleBusy((m) => ({ ...m, [alias]: true }));

      try {
        await setWorkspaceRole(workspaceId, roleName, activeTeam);
        // Reconcile from the server (PATCH doesn't refresh Redis presence; a
        // reload re-derives the canonical role and clears the override).
        void load(activeTeam);
      } catch (err) {
        // Roll back the optimistic value and surface the error on the row.
        setRoleOverrides((m) => {
          const next = { ...m };
          delete next[alias];
          return next;
        });
        const message =
          err instanceof ApiError
            ? `${err.message} (${err.status})`
            : err instanceof Error
              ? err.message
              : "Failed to set role.";
        setRoleErrors((m) => ({ ...m, [alias]: message }));
      } finally {
        setRoleBusy((m) => {
          const next = { ...m };
          delete next[alias];
          return next;
        });
      }
    },
    [activeTeam, load],
  );

  // Build the role-control wiring for one agent participant, or undefined when
  // the agent has no backing workspace (nothing to PATCH) — that row stays
  // read-only. Humans never get a control.
  const roleControlFor = useCallback(
    (p: Participant): RoleControl | undefined => {
      if (p.kind !== "agent") return undefined;
      const ws = workspaceByAlias.get(p.alias);
      if (!ws) return undefined;
      const current =
        roleOverrides[p.alias] ?? ws.role_name ?? ws.role ?? p.role ?? null;
      return {
        catalog: roleCatalog,
        current,
        busy: Boolean(roleBusy[p.alias]),
        error: roleErrors[p.alias] ?? null,
        onAssign: (roleName: string) =>
          void assignRole(p.alias, ws.workspace_id, roleName),
      };
    },
    [
      workspaceByAlias,
      roleCatalog,
      roleOverrides,
      roleBusy,
      roleErrors,
      assignRole,
    ],
  );

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
              <MemberRow
                key={p.alias}
                participant={p}
                roleControl={roleControlFor(p)}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
