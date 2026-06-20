"use client";

import { useCallback, useEffect, useState } from "react";

import { useTeam } from "@/components/team-context";
import { Markdown } from "@/components/ui/markdown";
import { ApiError } from "@/lib/api/http";
import {
  activateRolesBundle,
  createRolesBundle,
  deleteRole,
  fetchActiveRoles,
  resetRoles,
  upsertRole,
  ROLES_CONFLICT_STATUS,
  type RoleDefinition,
  type RolesBundle,
} from "@/lib/api/roles";
import { RoleDialog } from "./role-dialog";
import styles from "./roles.module.css";

/** Editable in-memory view of the active bundle + its concurrency token. */
interface ActiveState {
  /** The active version id — passed as `base_team_roles_id` on the next write. */
  baseId: string;
  version: number;
  bundle: RolesBundle;
}

/**
 * The human window onto the team's coordination-role bundle (what agents read
 * via `roles_show`). Lists each role as a card (title + role key) you can
 * expand to read its rendered playbook. "New role" and each card's "Edit" open
 * the dialog.
 *
 * Saves are COPY-ON-WRITE: we clone the active bundle, upsert/delete the one
 * role, POST it as a new version with `base_team_roles_id` = the id we read,
 * then activate the returned id. If the active version moved under us the POST
 * 409s — we show a "roles changed" banner and refetch so the human re-applies
 * onto fresh state rather than clobbering a teammate's edit.
 */
export function RolesManager() {
  const { activeTeam } = useTeam();
  const [state, setState] = useState<ActiveState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    if (!activeTeam) {
      setState(null);
      setLoading(false);
      return;
    }
    try {
      const res = await fetchActiveRoles(activeTeam);
      setState({
        baseId: res.team_roles_id,
        version: res.version,
        bundle: { roles: res.roles ?? {}, adapters: res.adapters ?? {} },
      });
      setError(null);
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.message} (${e.status})`
          : e instanceof Error
            ? e.message
            : "Failed to load roles.",
      );
    } finally {
      setLoading(false);
    }
  }, [activeTeam]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  function toggle(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function openNew() {
    setEditingName(null);
    setSaveError(null);
    setDialogOpen(true);
  }
  function openEdit(name: string) {
    setEditingName(name);
    setSaveError(null);
    setDialogOpen(true);
  }
  function closeDialog() {
    if (saving) return;
    setDialogOpen(false);
    setEditingName(null);
    setSaveError(null);
  }

  /**
   * Persist `nextBundle` as a new active version. On 409 (the base moved),
   * close the dialog, raise the conflict banner, and refetch.
   */
  const persist = useCallback(
    async (nextBundle: RolesBundle): Promise<boolean> => {
      if (!state) return false;
      setSaving(true);
      setSaveError(null);
      setConflict(false);
      try {
        const created = await createRolesBundle(
          nextBundle,
          state.baseId,
          activeTeam,
        );
        await activateRolesBundle(created.team_roles_id, activeTeam);
        await load();
        return true;
      } catch (e) {
        if (e instanceof ApiError && e.status === ROLES_CONFLICT_STATUS) {
          setDialogOpen(false);
          setEditingName(null);
          setConflict(true);
          await load();
          return false;
        }
        setSaveError(
          e instanceof ApiError
            ? `${e.message} (${e.status})`
            : e instanceof Error
              ? e.message
              : "Save failed.",
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [state, activeTeam, load],
  );

  async function handleSave(name: string, def: RoleDefinition) {
    if (!state) return;
    const next = upsertRole(state.bundle, name, def);
    const ok = await persist(next);
    if (ok) {
      setDialogOpen(false);
      setEditingName(null);
    }
  }

  async function handleDelete(name: string) {
    if (!state) return;
    const next = deleteRole(state.bundle, name);
    const ok = await persist(next);
    if (ok) {
      setDialogOpen(false);
      setEditingName(null);
    }
  }

  async function handleReset() {
    if (!activeTeam || resetting) return;
    setResetting(true);
    setError(null);
    setConflict(false);
    try {
      await resetRoles(activeTeam);
      await load();
    } catch (e) {
      setError(
        e instanceof ApiError
          ? `${e.message} (${e.status})`
          : e instanceof Error
            ? e.message
            : "Reset failed.",
      );
    } finally {
      setResetting(false);
    }
  }

  const roles = state ? Object.entries(state.bundle.roles) : [];
  const roleNames = state ? Object.keys(state.bundle.roles) : [];
  const editingInitial =
    editingName && state && state.bundle.roles[editingName]
      ? { name: editingName, def: state.bundle.roles[editingName] }
      : null;

  return (
    <div className={styles.board}>
      <div className={styles.toolbar}>
        <p className={styles.intro}>
          Coordination roles are the playbooks agents read with{" "}
          <code className="mono">roles_show</code>. Curate them here — each
          change writes a new version of the bundle.
        </p>
        <span className={styles.spacerInline} />
        <button
          type="button"
          className="btn"
          onClick={() => void handleReset()}
          disabled={resetting || !activeTeam}
          style={{ marginTop: 0, width: "auto", whiteSpace: "nowrap" }}
        >
          {resetting ? "Resetting…" : "Reset to defaults"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={openNew}
          disabled={!state}
          style={{ marginTop: 0, width: "auto", whiteSpace: "nowrap" }}
        >
          New role
        </button>
      </div>

      {conflict ? (
        <div className={styles.conflict}>
          The team&apos;s roles changed while you were editing — re-reading the
          latest version. Re-apply your change on top of it.
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}

      {loading ? (
        <p className="muted">Loading…</p>
      ) : !activeTeam ? (
        <div className={styles.empty}>Select a team to manage its roles.</div>
      ) : roles.length === 0 ? (
        <div className={styles.empty}>
          No coordination roles yet. Roles are the shared playbooks agents read
          on session start — define one per function (backend, reviewer,
          coordinator…) so the whole team coordinates the same way. Click
          “New role” to add the first, or “Reset to defaults” to start from the
          platform bundle.
        </div>
      ) : (
        <div className={styles.list}>
          {roles.map(([name, def]) => {
            const isOpen = expanded.has(name);
            return (
              <div key={name} className={styles.card}>
                <div className={styles.cardHead}>
                  <button
                    type="button"
                    className={styles.cardTitle}
                    onClick={() => toggle(name)}
                    aria-expanded={isOpen}
                  >
                    <span>{def.title || name}</span>
                    <span className={styles.roleKey}>{name}</span>
                  </button>
                  <button
                    type="button"
                    className={styles.editBtn}
                    onClick={() => openEdit(name)}
                  >
                    Edit
                  </button>
                </div>

                {isOpen ? (
                  <div className={styles.body}>
                    {def.playbook_md ? (
                      <Markdown>{def.playbook_md}</Markdown>
                    ) : (
                      <span className="muted">(no playbook)</span>
                    )}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}

      {dialogOpen ? (
        <RoleDialog
          initial={editingInitial}
          existingNames={roleNames}
          onClose={closeDialog}
          onSave={(name, def) => void handleSave(name, def)}
          onDelete={(name) => void handleDelete(name)}
          busy={saving}
          error={saveError}
        />
      ) : null}
    </div>
  );
}
