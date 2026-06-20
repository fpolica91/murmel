"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useTeam } from "@/components/team-context";
import { listMemories, type Memory } from "@/lib/api/memories";
import { MemoryCard } from "./memory-card";
import { MemoryModal } from "./memory-modal";
import styles from "./memory.module.css";

const POLL_MS = 15000;

/**
 * The team knowledge base, for humans. A debounced search box, a tag-chip
 * facet strip (OR filter), and a list of expandable note cards. "New" and each
 * card's "Edit" open the create/edit modal. Agents read/write the same store
 * over MCP (`memory_search` / `memory_save`); this is the human window onto it.
 */
export function MemoryBoard() {
  const { activeTeam } = useTeam();
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Memory | null>(null);

  // Debounce the search box (250ms) before it hits the server.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(query.trim()), 250);
    return () => clearTimeout(id);
  }, [query]);

  // Latest request args, read by the poller without re-subscribing.
  const argsRef = useRef({ q: debouncedQuery, tags: selectedTags });
  argsRef.current = { q: debouncedQuery, tags: selectedTags };

  const refresh = useCallback(async () => {
    if (!activeTeam) {
      setMemories([]);
      setLoading(false);
      return;
    }
    try {
      const { q, tags } = argsRef.current;
      const result = await listMemories(activeTeam, { q, tags });
      setMemories(result);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load memories.");
    } finally {
      setLoading(false);
    }
  }, [activeTeam]);

  // Refetch on team / query / tag change, plus a slow poll so a teammate's
  // (or an agent's) new note appears without a manual reload.
  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh, debouncedQuery, selectedTags]);

  // Facet chips: every tag present in the current results, plus any selected
  // tag (so it stays toggleable even when it narrows the set to itself).
  const chipTags = useMemo(() => {
    const set = new Set<string>(selectedTags);
    for (const m of memories) for (const t of m.tags) set.add(t);
    return Array.from(set).sort();
  }, [memories, selectedTags]);

  function toggleTag(tag: string) {
    setSelectedTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  }

  function openNew() {
    setEditing(null);
    setModalOpen(true);
  }
  function openEdit(m: Memory) {
    setEditing(m);
    setModalOpen(true);
  }

  return (
    <div className={styles.board}>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search the team's knowledge…"
          aria-label="Search memories"
        />
        <button
          type="button"
          className="btn btn-primary"
          onClick={openNew}
          style={{ marginTop: 0, whiteSpace: "nowrap", width: "auto" }}
        >
          New memory
        </button>
      </div>

      {chipTags.length > 0 ? (
        <div className={styles.tags}>
          {chipTags.map((t) => (
            <button
              type="button"
              key={t}
              className={`${styles.tag} ${selectedTags.includes(t) ? styles.tagActive : ""}`}
              onClick={() => toggleTag(t)}
            >
              {t}
            </button>
          ))}
        </div>
      ) : null}

      {error ? <div className={styles.error}>{error}</div> : null}

      {loading && memories.length === 0 ? (
        <p className="muted">Loading…</p>
      ) : memories.length === 0 ? (
        <div className={styles.empty}>
          Team memory is a shared knowledge base. When you learn something useful
          — a quirk in the codebase, a workflow that saved time, a fact about an
          external system — save it here. Agents read it on session start, so the
          whole team inherits what anyone learns.
        </div>
      ) : (
        <div className={styles.list}>
          {memories.map((m) => (
            <MemoryCard key={m.memory_id} memory={m} onEdit={openEdit} />
          ))}
        </div>
      )}

      {modalOpen ? (
        <MemoryModal
          memory={editing}
          teamId={activeTeam}
          onClose={() => setModalOpen(false)}
          onSaved={() => void refresh()}
        />
      ) : null}
    </div>
  );
}
