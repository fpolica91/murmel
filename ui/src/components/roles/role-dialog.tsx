"use client";

import { useState } from "react";

import { Markdown } from "@/components/ui/markdown";
import {
  normalizeRoleName,
  validateRoleName,
  type RoleDefinition,
} from "@/lib/api/roles";
import styles from "./roles.module.css";

/**
 * Create / edit a single coordination role. `initial === null` is create mode
 * (the name field is editable + validated); edit mode locks the name (renaming
 * is a delete + create, which would orphan the key, so we disallow it inline)
 * and offers Delete-with-confirm.
 *
 * `playbook_md` has an Edit | Preview toggle; Preview renders through the shared
 * <Markdown> component. The dialog itself does NO network I/O — it hands the
 * normalized name + definition (or a delete signal) back to the manager, which
 * owns the copy-on-write POST + activate. This keeps the version-conflict
 * handling in one place.
 */
export function RoleDialog({
  initial,
  existingNames,
  onClose,
  onSave,
  onDelete,
  busy,
  error,
}: {
  /** The role being edited, or null to create a new one. */
  initial: { name: string; def: RoleDefinition } | null;
  /** All current role keys — used to reject a duplicate name on create. */
  existingNames: string[];
  onClose: () => void;
  /** Persist: the manager upserts `name -> def` into a fresh bundle. */
  onSave: (name: string, def: RoleDefinition) => void;
  /** Remove this role from the bundle (edit mode only). */
  onDelete: (name: string) => void;
  /** A save/delete is in flight — disables the controls. */
  busy: boolean;
  /** Surfaced server/concurrency error from the manager. */
  error: string | null;
}) {
  const isEdit = initial !== null;
  const [name, setName] = useState(initial?.name ?? "");
  const [title, setTitle] = useState(initial?.def.title ?? "");
  const [playbook, setPlaybook] = useState(initial?.def.playbook_md ?? "");
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [localErr, setLocalErr] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  function handleSave() {
    setLocalErr(null);
    const normalized = normalizeRoleName(name);
    const nameErr = validateRoleName(name);
    if (nameErr) {
      setLocalErr(nameErr);
      return;
    }
    // On create, the normalized key must not collide with an existing role.
    if (!isEdit && existingNames.includes(normalized)) {
      setLocalErr(`A role named "${normalized}" already exists.`);
      return;
    }
    if (!title.trim()) {
      setLocalErr("Title is required.");
      return;
    }
    onSave(normalized, { title: title.trim(), playbook_md: playbook });
  }

  function handleDelete() {
    if (!isEdit || !initial) return;
    onDelete(initial.name);
  }

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.modalHead}>
          <h2 className={styles.modalTitle}>
            {isEdit ? `Edit role` : "New role"}
          </h2>
          <div className={styles.tabs}>
            <button
              type="button"
              className={`${styles.tab} ${tab === "edit" ? styles.tabActive : ""}`}
              onClick={() => setTab("edit")}
            >
              Edit
            </button>
            <button
              type="button"
              className={`${styles.tab} ${tab === "preview" ? styles.tabActive : ""}`}
              onClick={() => setTab("preview")}
            >
              Preview
            </button>
          </div>
        </div>

        <div className={styles.modalBody}>
          <div>
            <div className={styles.label}>Role key</div>
            <input
              className={`${styles.input} ${styles.inputMono}`}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. backend, code-reviewer"
              maxLength={50}
              disabled={isEdit}
              autoFocus={!isEdit}
            />
            <div className={styles.hint}>
              {isEdit
                ? "The key is the stable selector agents pass to roles_show; it can't be renamed here."
                : "1–2 words, letters/numbers with hyphens or underscores. Lowercased automatically."}
            </div>
          </div>

          <div>
            <div className={styles.label}>Title</div>
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Human-readable name, e.g. Backend Engineer"
              maxLength={256}
              autoFocus={isEdit}
            />
          </div>

          <div>
            <div className={styles.label}>Playbook (markdown)</div>
            {tab === "edit" ? (
              <textarea
                className={styles.textarea}
                value={playbook}
                onChange={(e) => setPlaybook(e.target.value)}
                placeholder="What this role does, how it coordinates, what it owns. Agents read this verbatim."
              />
            ) : (
              <div className={styles.preview}>
                {playbook ? (
                  <Markdown>{playbook}</Markdown>
                ) : (
                  <span className="muted">(nothing to preview)</span>
                )}
              </div>
            )}
          </div>

          {(localErr || error) ? (
            <div className={styles.error}>{localErr ?? error}</div>
          ) : null}
        </div>

        <div className={styles.modalFoot}>
          {isEdit ? (
            confirmDelete ? (
              <div className={styles.confirm}>
                <span>Delete this role?</span>
                <button
                  type="button"
                  className="btn"
                  onClick={handleDelete}
                  disabled={busy}
                  style={{ marginTop: 0, width: "auto", color: "var(--danger-text)" }}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => setConfirmDelete(false)}
                  disabled={busy}
                  style={{ marginTop: 0, width: "auto" }}
                >
                  Keep
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                style={{ marginTop: 0, width: "auto", color: "var(--danger-text)" }}
              >
                Delete
              </button>
            )
          ) : null}
          <div className={styles.spacer} />
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
            style={{ marginTop: 0, width: "auto" }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            disabled={busy}
            style={{ marginTop: 0, width: "auto" }}
          >
            {busy ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
