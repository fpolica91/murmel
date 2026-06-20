"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useTeam } from "@/components/team-context";
import { listClaims, type Claim } from "@/lib/api/claims";
import {
  asReservationConflict,
  listReservations,
  releaseReservation,
  type Reservation,
} from "@/lib/api/reservations";
import { subscribeEvents } from "@/lib/events/eventStream";
import styles from "./claims.module.css";

/** Refetch cadence for the live monitor. */
const POLL_MS = 5000;
/** Reservation event types that should trigger an out-of-band refetch. */
const RESERVATION_EVENTS = new Set([
  "reservation.acquired",
  "reservation.released",
  "reservation.renewed",
]);

/** Compact relative time ("just now", "3m ago") from an ISO timestamp. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/** Format a TTL in whole seconds as "M:SS" (or "H:MM:SS" past an hour). */
function formatTtl(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hrs = Math.floor(s / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  if (hrs > 0) return `${hrs}:${pad(mins)}:${pad(secs)}`;
  return `${mins}:${pad(secs)}`;
}

/**
 * Live "who-holds-what right now" monitor.
 *
 * Top: active task/issue claims (who is working on what; read-only — claims
 * don't expire and have no release). Bottom: resource reservations (soft TTL
 * locks) with a 1s client-side countdown that is reconciled to the server's
 * `ttl_remaining_seconds` on every refetch, and a holder-only "×" release that
 * surfaces the real holder on a 409.
 *
 * Refreshes on a ~5s poll plus an SSE subscription that refetches on any
 * `reservation.*` event so a teammate's acquire/release shows up promptly.
 */
export function ClaimsMonitor() {
  const { activeTeam } = useTeam();
  const [claims, setClaims] = useState<Claim[]>([]);
  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // The wall-clock instant `ttl_remaining_seconds` was sampled from the server,
  // so the local ticker can derive a live remaining value without drifting.
  const fetchedAtRef = useRef<number>(Date.now());
  // Forces a re-render every second to advance the countdown.
  const [, setTick] = useState(0);
  // Per-resource release state: which key is in-flight and any per-row error.
  const [releasing, setReleasing] = useState<Set<string>>(new Set());
  const [rowError, setRowError] = useState<Record<string, string>>({});

  const refresh = useCallback(async () => {
    if (!activeTeam) {
      setClaims([]);
      setReservations([]);
      setLoading(false);
      return;
    }
    try {
      const [claimRows, reservationRows] = await Promise.all([
        listClaims(activeTeam),
        listReservations(activeTeam),
      ]);
      setClaims(claimRows);
      setReservations(reservationRows);
      fetchedAtRef.current = Date.now();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load claims & locks.");
    } finally {
      setLoading(false);
    }
  }, [activeTeam]);

  // Initial load + steady poll so the monitor stays current.
  useEffect(() => {
    setLoading(true);
    void refresh();
    const id = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(id);
  }, [refresh]);

  // 1s ticker to advance the TTL countdown between refetches.
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, []);

  // SSE: any reservation lifecycle event for this team triggers a refetch so
  // an acquire/release/renew elsewhere reflects without waiting for the poll.
  useEffect(() => {
    if (!activeTeam) return;
    const unsubscribe = subscribeEvents(activeTeam, (ev) => {
      if (RESERVATION_EVENTS.has(ev.type)) void refresh();
    });
    return unsubscribe;
  }, [activeTeam, refresh]);

  // Live remaining TTL: server value minus the seconds elapsed locally since
  // the sample, floored at 0. Reconciles cleanly each refetch.
  function liveTtl(r: Reservation): number {
    const elapsed = (Date.now() - fetchedAtRef.current) / 1000;
    return Math.max(0, r.ttl_remaining_seconds - elapsed);
  }

  async function onRelease(r: Reservation) {
    if (!activeTeam || releasing.has(r.resource_key)) return;
    setReleasing((prev) => new Set(prev).add(r.resource_key));
    setRowError((prev) => {
      const next = { ...prev };
      delete next[r.resource_key];
      return next;
    });
    try {
      await releaseReservation(r.resource_key, activeTeam);
      // Optimistically drop it; the next refetch confirms.
      setReservations((prev) =>
        prev.filter((x) => x.resource_key !== r.resource_key),
      );
      void refresh();
    } catch (e) {
      const conflict = asReservationConflict(e);
      const msg = conflict
        ? `Held by ${conflict.holder_alias} — only the holder can release.`
        : e instanceof Error
          ? e.message
          : "Failed to release.";
      setRowError((prev) => ({ ...prev, [r.resource_key]: msg }));
      // A 409 means our view is stale; pull the current holder in.
      void refresh();
    } finally {
      setReleasing((prev) => {
        const next = new Set(prev);
        next.delete(r.resource_key);
        return next;
      });
    }
  }

  return (
    <div className={styles.monitor}>
      {error ? <div className={styles.error}>{error}</div> : null}

      {/* --- Active work (claims) --- */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Active work (claims)</h2>
          <span className={styles.count}>{claims.length}</span>
        </div>
        <p className={styles.sectionHint}>
          Who is actively working on which task or issue right now. Claims clear
          when the work moves on — they aren&apos;t released by hand.
        </p>

        {loading && claims.length === 0 ? (
          <p className="muted">Loading…</p>
        ) : claims.length === 0 ? (
          <div className={styles.empty}>
            No active claims. When an agent claims work and marks it in progress,
            it shows up here as a live marker of who is on what.
          </div>
        ) : (
          <ul className={styles.list}>
            {claims.map((c) => (
              <li key={`${c.workspace_id}:${c.task_ref}`} className={styles.row}>
                <div className={styles.rowMain}>
                  <code className={styles.resourceKey}>{c.task_ref}</code>
                  <div className={styles.byline}>
                    <span className={styles.holder}>{c.alias}</span>
                    {c.human_name ? (
                      <span className={styles.faint}>({c.human_name})</span>
                    ) : null}
                    <span className={styles.faint}>·</span>
                    <span className={styles.faint}>
                      claimed {relativeTime(c.claimed_at)}
                    </span>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- Resource locks (reservations) --- */}
      <section className={styles.section}>
        <div className={styles.sectionHead}>
          <h2 className={styles.sectionTitle}>Resource locks (reservations)</h2>
          <span className={styles.count}>{reservations.length}</span>
        </div>
        <p className={styles.sectionHint}>
          Soft TTL locks on shared resources. The countdown ticks live and
          expires the lock automatically. Only the holder can release early.
        </p>

        {loading && reservations.length === 0 ? (
          <p className="muted">Loading…</p>
        ) : reservations.length === 0 ? (
          <div className={styles.empty}>
            No active reservations. Agents take a short-lived lock on a resource
            (a file, a migration slot, an external system) before touching it, so
            two workspaces don&apos;t collide.
          </div>
        ) : (
          <ul className={styles.list}>
            {reservations.map((r) => {
              const remaining = liveTtl(r);
              const expiring = remaining <= 60;
              const isReleasing = releasing.has(r.resource_key);
              const err = rowError[r.resource_key];
              return (
                <li key={r.resource_key} className={styles.row}>
                  <div className={styles.rowMain}>
                    <code className={styles.resourceKey}>{r.resource_key}</code>
                    <div className={styles.byline}>
                      <span className={styles.holder}>{r.holder_alias}</span>
                      {r.reason ? (
                        <>
                          <span className={styles.faint}>·</span>
                          <span className={styles.faint}>{r.reason}</span>
                        </>
                      ) : null}
                      <span className={styles.faint}>·</span>
                      <span className={styles.faint}>
                        acquired {relativeTime(r.acquired_at)}
                      </span>
                    </div>
                    {err ? <div className={styles.rowError}>{err}</div> : null}
                  </div>

                  <div className={styles.rowAside}>
                    <span
                      className={`${styles.ttl} ${expiring ? styles.ttlExpiring : ""}`}
                      title={`Expires ${new Date(r.expires_at).toLocaleString()}`}
                    >
                      {remaining <= 0 ? "expired" : formatTtl(remaining)}
                    </span>
                    <button
                      type="button"
                      className={styles.release}
                      onClick={() => void onRelease(r)}
                      disabled={isReleasing}
                      aria-label={`Release ${r.resource_key}`}
                      title="Release (holder only)"
                    >
                      {isReleasing ? "…" : "×"}
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
