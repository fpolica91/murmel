"use client";

import { useEffect, useState } from "react";

import { previewInvite, acceptInvite } from "@/lib/api/client";

type Preview = {
  team_name: string;
  role: string;
  status: string;
};

/** Previews an invitation and accepts it, then drops the user into that team. */
export function AcceptInvite({ token }: { token: string }) {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    previewInvite(token)
      .then((p) => !cancelled && setPreview(p))
      .catch((e) =>
        setError(e instanceof Error ? e.message : "Invitation not found"),
      );
    return () => {
      cancelled = true;
    };
  }, [token]);

  async function onAccept() {
    setBusy(true);
    setError(null);
    try {
      const r = await acceptInvite(token);
      // Switch the active team to the one just joined, then enter the dashboard.
      window.localStorage.setItem("aweb.activeTeam", r.team_id);
      window.location.href = "/dashboard";
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not accept invitation");
      setBusy(false);
    }
  }

  if (error) {
    return (
      <>
        <h1>Invitation</h1>
        <p className="muted" style={{ color: "var(--danger)" }}>
          {error}
        </p>
        <a className="btn" href="/dashboard">
          Go to dashboard
        </a>
      </>
    );
  }

  if (!preview) {
    return (
      <>
        <h1>Invitation</h1>
        <p className="muted">Loading…</p>
      </>
    );
  }

  if (preview.status !== "pending") {
    return (
      <>
        <h1>Invitation {preview.status}</h1>
        <p className="muted">
          This invitation to {preview.team_name} is {preview.status}.
        </p>
        <a className="btn" href="/dashboard">
          Go to dashboard
        </a>
      </>
    );
  }

  return (
    <>
      <h1>Join {preview.team_name}</h1>
      <p className="muted">
        You&apos;ve been invited to join <strong>{preview.team_name}</strong> as{" "}
        {preview.role}. Accepting adds it to your teams — your other teams stay.
      </p>
      <button
        type="button"
        className="btn btn-primary"
        onClick={onAccept}
        disabled={busy}
      >
        {busy ? "Joining…" : "Accept invitation"}
      </button>
    </>
  );
}
