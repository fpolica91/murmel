"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { computeLeaderboard, type LeaderboardRow } from "@/lib/leaderboard";
import type { Participant } from "@/lib/api/participants";
import type { Claim } from "@/lib/api/claims";
import type { Issue } from "@/lib/api/types";
import { deriveStage } from "./stage-derive";
import { StageView } from "./stage-view";
import { useShipDetector } from "./use-ship";
import styles from "./suggest.module.css";

const API_BASE = (
  process.env.NEXT_PUBLIC_AWEB_API_URL ?? "http://localhost:8000"
).replace(/\/+$/, "");
const POLL_MS = 4000;
const TALK_WINDOW_MS = 6 * 60_000;

interface StagePayload {
  team: string;
  participants: Array<{
    kind: "human" | "agent";
    alias: string;
    display_name: string;
    agent_id: string | null;
    role: string | null;
    agent_type: string;
    online: boolean;
  }>;
  issues: Array<{
    issue_id: string;
    title: string;
    status: Issue["status"];
    assignee_type: Issue["assignee_type"];
    assignee_id: string | null;
    created_at: string | null;
    updated_at: string | null;
  }>;
  claims: Array<{ task_ref: string; alias: string; claimed_at: string | null }>;
  chat: Array<{ from: string; body: string; ts: string | null }>;
  suggestions?: Array<{ idea: string; ts: number }>;
}

/**
 * Public, no-login live office (mounted at /watch). Fetches the read-only
 * server-configured showcase team via /v1/public/stage — the ONLY surface that
 * shows the whole team's chatter without auth — and renders the shared
 * {@link StageView}. 404 means no showcase team is configured.
 */
export function PublicStage() {
  const [rows, setRows] = useState<LeaderboardRow[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [roster, setRoster] = useState<Participant[]>([]);
  const [says, setSays] = useState<Record<string, { text: string; ts: string }>>(
    {},
  );
  const [team, setTeam] = useState("the team");
  const [suggestions, setSuggestions] = useState<
    Array<{ idea: string; ts: number }>
  >([]);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "off" | "err">(
    "loading",
  );

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/v1/public/stage`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 404) {
        setState("off");
        return;
      }
      if (!res.ok) {
        setState((s) => (s === "ok" ? "ok" : "err"));
        return;
      }
      const d: StagePayload = await res.json();

      const iss: Issue[] = d.issues.map((i) => ({
        issue_id: i.issue_id,
        team_id: "",
        epic_id: null,
        story_id: null,
        title: i.title,
        description: "",
        status: i.status,
        assignee_type: i.assignee_type,
        assignee_id: i.assignee_id,
        created_at: i.created_at ?? "",
        updated_at: i.updated_at ?? "",
      }));
      const ros: Participant[] = d.participants.map((p) => ({
        kind: p.kind,
        alias: p.alias,
        display_name: p.display_name,
        agent_id: p.agent_id,
        did_key: null,
        did_aw: null,
        address: null,
        role: p.role,
        agent_type: p.agent_type,
        online: p.online,
        status: p.online ? "active" : "offline",
        last_seen: null,
      }));
      const clm: Claim[] = d.claims.map((c) => ({
        task_ref: c.task_ref,
        workspace_id: "",
        alias: c.alias,
        human_name: null,
        claimed_at: c.claimed_at ?? "",
        team_id: "",
      }));

      // most recent line per sender within the window (chat is newest-first)
      const sayMap: Record<string, { text: string; ts: string }> = {};
      for (const m of d.chat) {
        if (!m.from || !m.body || !m.ts) continue;
        if (Date.now() - new Date(m.ts).getTime() > TALK_WINDOW_MS) continue;
        if (!sayMap[m.from]) sayMap[m.from] = { text: m.body, ts: m.ts };
      }

      setRows(computeLeaderboard(iss, ros, clm));
      setIssues(iss);
      setClaims(clm);
      setRoster(ros);
      setSays(sayMap);
      setTeam(d.team || "the team");
      setSuggestions(d.suggestions ?? []);
      setState("ok");
    } catch {
      setState((s) => (s === "ok" ? "ok" : "err"));
    }
  }, []);

  const submitIdea = useCallback(async () => {
    const idea = draft.trim();
    if (!idea || submitting) return;
    setSubmitting(true);
    setNotice(null);
    try {
      const res = await fetch(`${API_BASE}/v1/public/stage/suggest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ idea }),
      });
      if (res.status === 429) {
        setNotice("Easy there — a few per minute. Try again shortly.");
        return;
      }
      if (!res.ok) {
        setNotice("Couldn’t add that. Try again.");
        return;
      }
      setDraft("");
      // optimistic: show it at the top immediately
      setSuggestions((prev) => [{ idea, ts: Date.now() / 1000 }, ...prev].slice(0, 20));
      setNotice("Added — watch for it on the board ↓");
      void refresh();
    } catch {
      setNotice("Couldn’t reach the stage. Try again.");
    } finally {
      setSubmitting(false);
    }
  }, [draft, submitting, refresh]);

  useEffect(() => {
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const ship = useShipDetector(rows, issues);
  const view = useMemo(
    () => deriveStage({ rows, issues, claims, roster, says }, team),
    [rows, issues, claims, roster, says, team],
  );

  if (state === "loading") return <p className="muted">Opening the office…</p>;
  if (state === "off")
    return (
      <p className="muted">
        No live stage is running right now — check back soon.
      </p>
    );
  if (state === "err" && rows.length === 0)
    return <p className="muted">Couldn’t reach the stage. Retrying…</p>;

  return (
    <>
      <section className={styles.suggest}>
        <div className={styles.suggestRow}>
          <input
            className={styles.input}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitIdea();
            }}
            maxLength={200}
            placeholder="💡 Suggest what they build next — e.g. “a pomodoro timer”"
            aria-label="Suggest a build"
          />
          <button
            className={styles.btn}
            onClick={() => void submitIdea()}
            disabled={submitting || !draft.trim()}
          >
            {submitting ? "Adding…" : "Suggest"}
          </button>
        </div>
        {notice ? <div className={styles.notice}>{notice}</div> : null}
        {suggestions.length > 0 ? (
          <div className={styles.queue} aria-label="Recent suggestions">
            <span className={styles.queueLabel}>Up next</span>
            {suggestions.slice(0, 8).map((s, i) => (
              <span key={`${s.ts}-${i}`} className={styles.chip} title={s.idea}>
                {s.idea}
              </span>
            ))}
          </div>
        ) : null}
      </section>
      <StageView view={view} rows={rows} ship={ship} />
    </>
  );
}
