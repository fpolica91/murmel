"use client";

import { useState } from "react";

import {
  createMemory,
  deleteMemory,
  updateMemory,
  type Memory,
} from "@/lib/api/memories";
import { Markdown } from "@/components/ui/markdown";
import styles from "./memory.module.css";

/**
 * Create / edit / delete a memory. `memory === null` is create mode. The body
 * field has an Edit | Preview toggle (preview is pre-wrap for now; the markdown
 * win upgrades it). On success, `onSaved` refreshes the board.
 */
export function MemoryModal({
  memory,
  teamId,
  onClose,
  onSaved,
}: {
  memory: Memory | null;
  teamId: string | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = memory !== null;
  const [title, setTitle] = useState(memory?.title ?? "");
  const [body, setBody] = useState(memory?.body_md ?? "");
  const [tagsText, setTagsText] = useState((memory?.tags ?? []).join(", "));
  const [assignee, setAssignee] = useState(memory?.assignee_alias ?? "");
  const [tab, setTab] = useState<"edit" | "preview">("edit");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const tags = tagsText
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  async function onSave() {
    if (!title.trim()) {
      setErr("Title is required.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const payload = {
        title: title.trim(),
        body_md: body,
        tags,
        assignee_alias: assignee.trim() || null,
      };
      if (isEdit && memory) {
        await updateMemory(memory.memory_id, payload, teamId);
      } else {
        await createMemory(payload, teamId);
      }
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Save failed.");
      setBusy(false);
    }
  }

  async function onDelete() {
    if (!isEdit || !memory) return;
    setBusy(true);
    setErr(null);
    try {
      await deleteMemory(memory.memory_id, teamId);
      onSaved();
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed.");
      setBusy(false);
    }
  }

  return (
    <div
      className={styles.overlay}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={styles.modal} role="dialog" aria-modal="true">
        <div className={styles.modalHead}>
          <h2 className={styles.modalTitle}>{isEdit ? "Edit memory" : "New memory"}</h2>
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
            <div className={styles.label}>Title</div>
            <input
              className={styles.input}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What did you learn?"
              maxLength={256}
              autoFocus
            />
          </div>

          <div>
            <div className={styles.label}>Body (markdown)</div>
            {tab === "edit" ? (
              <textarea
                className={styles.textarea}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                placeholder="The detail — a codebase quirk, a workflow, a fact about an external system."
              />
            ) : (
              <div className={styles.preview}>
                {body ? (
                  <Markdown>{body}</Markdown>
                ) : (
                  <span className="muted">(nothing to preview)</span>
                )}
              </div>
            )}
          </div>

          <div>
            <div className={styles.label}>Tags (comma-separated)</div>
            <input
              className={styles.input}
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="infra, onboarding, gotcha"
            />
          </div>

          <div>
            <div className={styles.label}>Private to (optional agent alias)</div>
            <input
              className={styles.input}
              value={assignee}
              onChange={(e) => setAssignee(e.target.value)}
              placeholder="leave blank for the whole team"
            />
          </div>

          {err ? <div className={styles.error}>{err}</div> : null}
        </div>

        <div className={styles.modalFoot}>
          {isEdit ? (
            <button
              type="button"
              className="btn"
              onClick={onDelete}
              disabled={busy}
              style={{ marginTop: 0, color: "var(--danger-text)" }}
            >
              Delete
            </button>
          ) : null}
          <div className={styles.spacer} />
          <button
            type="button"
            className="btn"
            onClick={onClose}
            disabled={busy}
            style={{ marginTop: 0 }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onSave}
            disabled={busy}
            style={{ marginTop: 0 }}
          >
            {busy ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
