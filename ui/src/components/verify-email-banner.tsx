"use client";

import { useState } from "react";

import { authClient } from "@/lib/auth-client";

export function VerifyEmailBanner({ email }: { email: string }) {
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);

  async function onResend() {
    setStatus("sending");
    setError(null);
    const { error } = await authClient.sendVerificationEmail({
      email,
      callbackURL: "/dashboard",
    });
    if (error) {
      setError(error.message ?? "Could not send verification email");
      setStatus("error");
      return;
    }
    setStatus("sent");
  }

  return (
    <div
      role="status"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        padding: "0.6rem 0.9rem",
        marginBottom: "1rem",
        background: "rgba(227, 179, 65, 0.1)",
        border: "1px solid var(--warn)",
        borderRadius: "var(--radius-md, 10px)",
        fontSize: "var(--fs-2xs, 13px)",
      }}
    >
      <span style={{ color: "var(--warn-text)" }}>
        Verify your email <strong>{email}</strong> to secure your account.
      </span>
      {status === "sent" ? (
        <span style={{ marginLeft: "auto", color: "var(--good-text, var(--good))" }}>
          Sent — check your inbox.
        </span>
      ) : (
        <button
          type="button"
          className="btn"
          onClick={onResend}
          disabled={status === "sending"}
          style={{ marginLeft: "auto" }}
        >
          {status === "sending" ? "Sending…" : "Resend verification email"}
        </button>
      )}
      {error ? (
        <span className="muted" style={{ color: "var(--danger)" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
