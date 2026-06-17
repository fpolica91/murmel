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
      setEmail("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create invitation");
    } finally {
      setBusy(false);
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
    <section style={{ marginBottom: "2rem" }}>
      <h2 style={{ fontSize: "var(--fs-md)", marginBottom: "0.5rem" }}>
        Invite to this team
      </h2>
      <form
        onSubmit={onSend}
        style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
      >
        <input
          type="email"
          placeholder="teammate@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="off"
          required
          style={{ flex: "1 1 220px", minWidth: 0 }}
        />
        <select value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="member">Member</option>
          <option value="admin">Admin</option>
        </select>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Inviting…" : "Send invite"}
        </button>
      </form>

      {error ? (
        <p className="muted" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      {lastLink ? (
        <p className="muted" style={{ marginTop: "0.75rem" }}>
          Invite link (share it):{" "}
          <code className="mono" style={{ wordBreak: "break-all" }}>
            {lastLink}
          </code>
        </p>
      ) : null}

      {invites.length > 0 ? (
        <ul style={{ listStyle: "none", padding: 0, marginTop: "1rem" }}>
          {invites.map((inv) => (
            <li
              key={inv.token}
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
                padding: "0.35rem 0",
              }}
            >
              <span style={{ flex: 1 }}>
                {inv.email}{" "}
                <span className="muted">· {inv.role} · pending</span>
              </span>
              <button
                type="button"
                className="btn"
                style={{ marginTop: 0, width: "auto", padding: "0.25rem 0.6rem" }}
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
