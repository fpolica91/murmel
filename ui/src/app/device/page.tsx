"use client";

import { useEffect, useState } from "react";

import { useSession } from "@/lib/auth-client";

/**
 * Device-authorization approval page (RFC 8628 verification URI).
 *
 * `aw login` opens `/device?user_code=XXXX`. The signed-in user confirms the
 * code shown in their terminal and approves; Better Auth then binds the device
 * code to this user's session, and the CLI's poll of /api/auth/device/token
 * succeeds. Approval requires a session (the POST carries the session cookie).
 */
type Status = "idle" | "working" | "approved" | "denied" | "error";

export default function DevicePage() {
  const { data: session, isPending } = useSession();
  const [userCode, setUserCode] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const code = new URLSearchParams(window.location.search).get("user_code");
    if (code) setUserCode(code.toUpperCase());
  }, []);

  function errOf(body: {
    error_description?: string;
    message?: string;
  }): string | undefined {
    return body.error_description ?? body.message;
  }

  async function act(action: "approve" | "deny") {
    setStatus("working");
    setError(null);
    const code = userCode.trim();
    try {
      // Step 1: claim the device code with this verifying session. The
      // approve/deny endpoints reject a code that has not first been claimed
      // via GET /device while signed in.
      const claim = await fetch(
        `/api/auth/device?user_code=${encodeURIComponent(code)}`,
        { credentials: "include", headers: { accept: "application/json" } },
      );
      if (!claim.ok) {
        const body = (await claim.json().catch(() => ({}))) as {
          error_description?: string;
          message?: string;
        };
        setError(errOf(body) ?? `Could not find that code (${claim.status})`);
        setStatus("error");
        return;
      }
      // Step 2: approve or deny.
      const res = await fetch(`/api/auth/device/${action}`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userCode: code }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error_description?: string;
          message?: string;
        };
        setError(errOf(body) ?? `Request failed (${res.status})`);
        setStatus("error");
        return;
      }
      setStatus(action === "approve" ? "approved" : "denied");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStatus("error");
    }
  }

  if (isPending) {
    return (
      <div className="center">
        <div className="panel">Loading…</div>
      </div>
    );
  }

  if (!session) {
    const next =
      typeof window !== "undefined"
        ? encodeURIComponent(window.location.pathname + window.location.search)
        : "";
    return (
      <div className="center">
        <div className="panel">
          <h1>Device sign-in</h1>
          <p className="muted">Sign in first, then approve the device.</p>
          <a className="btn btn-primary" href={`/login?redirect=${next}`}>
            Sign in
          </a>
        </div>
      </div>
    );
  }

  if (status === "approved") {
    return (
      <div className="center">
        <div className="panel">
          <h1>Approved ✓</h1>
          <p className="muted">Return to your terminal — you are signed in.</p>
        </div>
      </div>
    );
  }

  if (status === "denied") {
    return (
      <div className="center">
        <div className="panel">
          <h1>Denied</h1>
          <p className="muted">The device sign-in request was denied.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="center">
      <div className="panel">
        <h1>Approve device sign-in</h1>
        <p className="muted">
          A device is requesting to sign in as <b>{session.user.email}</b>.
          Confirm the code shown in your terminal.
        </p>
        <input
          className="btn"
          style={{ textAlign: "left", cursor: "text", letterSpacing: "0.2em" }}
          value={userCode}
          onChange={(e) => setUserCode(e.target.value.toUpperCase())}
          placeholder="CODE"
          autoComplete="one-time-code"
        />
        <button
          className="btn btn-primary"
          disabled={status === "working" || !userCode.trim()}
          onClick={() => act("approve")}
        >
          {status === "working" ? "Approving…" : "Approve"}
        </button>
        <button
          className="btn"
          disabled={status === "working"}
          onClick={() => act("deny")}
        >
          Deny
        </button>
        {error ? (
          <p className="muted" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
      </div>
    </div>
  );
}
