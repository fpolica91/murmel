"use client";

import { useCallback, useEffect, useState } from "react";

import { useTeam } from "@/components/team-context";
import {
  createInvite,
  listInvites,
  revokeInvite,
  type TeamInvite,
} from "@/lib/api/client";

const ADMIN_ROLES = new Set(["owner", "admin"]);

/* Token-driven control styling, kept inline so the shared globals.css (owned by
   another lane) stays untouched. Matches the dark, tight, restrained system. */
const controlStyle: React.CSSProperties = {
  height: 38,
  padding: "0 0.7rem",
  background: "var(--control)",
  color: "var(--text)",
  border: "1px solid var(--border)",
  borderRadius: "var(--radius-sm)",
  fontSize: "var(--fs-sm)",
  fontFamily: "inherit",
};

/** Owner/admin panel: invite by email, show the link, list + revoke pending. */
export function InvitePanel() {
  const { activeTeam, teamRoles } = useTeam();
  const canInvite =
    !!activeTeam && ADMIN_ROLES.has((teamRoles[activeTeam] ?? "").toLowerCase());

  const [email, setEmail] = useState("");
  const [role, setRole] = useState("member");
  const [invites, setInvites] = useState<TeamInvite[]>([]);
  const [lastLink, setLastLink] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(async () => {
    if (!activeTeam || !canInvite) return;
    try {
      const r = await listInvites(activeTeam);
      setInvites(r.invitations);
    } catch {
      /* leave the last known list on transient errors */
    }
  }, [activeTeam, canInvite]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!canInvite) return null;

  const linkFor = (token: string) =>
    typeof window !== "undefined"
      ? `${window.location.origin}/invite/${token}`
      : `/invite/${token}`;

  async function onSend(e: React.FormEvent) {
    e.preventDefault();
    if (!activeTeam || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const inv = await createInvite(
        activeTeam,
        email.trim().toLowerCase(),
        role,
      );
      setLastLink(linkFor(inv.token));
      setCopied(false);
      setEmail("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create invitation");
    } finally {
      setBusy(false);
    }
  }

  async function onCopy() {
    if (!lastLink) return;
    try {
      await navigator.clipboard.writeText(lastLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the link stays visible to copy manually */
    }
  }

  async function onRevoke(token: string) {
    if (!activeTeam) return;
    try {
      await revokeInvite(activeTeam, token);
      await refresh();
    } catch {
      /* ignore — refresh will reconcile */
    }
  }

  return (
    <section style={{ marginBottom: "var(--space-8)" }}>
      <h2
        style={{
          fontSize: "var(--fs-2xs)",
          fontWeight: 600,
          textTransform: "uppercase",
          letterSpacing: "0.04em",
          color: "var(--muted)",
          margin: "0 0 var(--space-3)",
        }}
      >
        Invite to this team
      </h2>

      <form
        onSubmit={onSend}
        style={{
          display: "flex",
          gap: "var(--space-2)",
          flexWrap: "wrap",
          alignItems: "center",
        }}
      >
        <input
          type="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          required
          style={{ ...controlStyle, flex: "1 1 220px", minWidth: 0 }}
        />
        <select
          value={role}
          onChange={(e) => setRole(e.target.value)}
          style={{ ...controlStyle, flex: "0 0 auto", cursor: "pointer" }}
        >
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy}
          style={{ width: "auto", marginTop: 0, flex: "0 0 auto" }}
        >
          {busy ? "Inviting…" : "Send invite"}
        </button>
      </form>

      {error ? (
        <p
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--space-2)",
            margin: "var(--space-3) 0 0",
            fontSize: "var(--fs-xs)",
            color: "var(--danger-text)",
          }}
        >
          <span aria-hidden>⚠</span>
          {error}
        </p>
      ) : null}

      {lastLink ? (
        <div style={{ marginTop: "var(--space-4)" }}>
          <p
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--space-2)",
              margin: "0 0 var(--space-2)",
              fontSize: "var(--fs-xs)",
              color: "var(--good-text)",
            }}
          >
            <span aria-hidden>✓</span>
            Invitation created — share this link
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "stretch",
              gap: "var(--space-2)",
              flexWrap: "wrap",
            }}
          >
            <code
              className="mono"
              title={lastLink}
              style={{
                flex: "1 1 240px",
                minWidth: 0,
                display: "inline-flex",
                alignItems: "center",
                padding: "0 0.7rem",
                height: 34,
                background: "var(--control)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-pill)",
                color: "var(--muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {lastLink}
            </code>
            <button
              type="button"
              className="btn"
              onClick={onCopy}
              style={{
                width: "auto",
                marginTop: 0,
                flex: "0 0 auto",
                padding: "0 0.85rem",
                height: 34,
                fontSize: "var(--fs-sm)",
              }}
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ) : null}

      {invites.length > 0 ? (
        <ul
          style={{
            listStyle: "none",
            padding: 0,
            margin: "var(--space-5) 0 0",
            display: "flex",
            flexDirection: "column",
            gap: "var(--space-2)",
          }}
        >
          {invites.map((inv) => (
            <li
              key={inv.token}
              style={{
                display: "flex",
                gap: "var(--space-3)",
                alignItems: "center",
                padding: "0.55rem 0.8rem",
                background: "var(--panel)",
                border: "1px solid var(--border)",
                borderRadius: "var(--radius-md)",
              }}
            >
              <span
                style={{
                  flex: 1,
                  minWidth: 0,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  fontSize: "var(--fs-sm)",
                }}
              >
                {inv.email}
              </span>
              <span
                style={{
                  display: "inline-block",
                  padding: "0.08rem 0.5rem",
                  borderRadius: "var(--radius-pill)",
                  border: "1px solid var(--border)",
                  background: "var(--control)",
                  color: "var(--muted)",
                  fontSize: "var(--fs-3xs)",
                }}
              >
                {inv.role}
              </span>
              <span
                style={{ color: "var(--faint)", fontSize: "var(--fs-2xs)" }}
              >
                pending
              </span>
              <button
                type="button"
                className="btn"
                style={{
                  marginTop: 0,
                  width: "auto",
                  flex: "0 0 auto",
                  padding: "0.28rem 0.7rem",
                  fontSize: "var(--fs-xs)",
                  color: "var(--danger-text)",
                }}
                onClick={() => onRevoke(inv.token)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
