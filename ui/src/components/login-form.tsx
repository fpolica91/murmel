"use client";

import { useState } from "react";

import { signIn } from "@/lib/auth-client";

/**
 * SSO + email/password login. Social buttons render only when the matching
 * provider env vars are configured on the server (Better Auth returns an error
 * for unconfigured providers, so we show them optimistically).
 */
export function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Return-to after auth (e.g. an /invite/<token> link). Only same-origin
  // relative paths to avoid open redirects.
  function callbackURL(): string {
    if (typeof window === "undefined") return "/dashboard";
    const cb = new URLSearchParams(window.location.search).get("callbackURL");
    return cb && cb.startsWith("/") && !cb.startsWith("//") ? cb : "/dashboard";
  }

  async function onSocial(provider: "github" | "google") {
    setError(null);
    await signIn.social({ provider, callbackURL: callbackURL() });
  }

  async function onCredentials(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const cb = callbackURL();
    const { error } = await signIn.email({ email, password, callbackURL: cb });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Sign-in failed");
      return;
    }
    window.location.href = cb;
  }

  return (
    <div>
      <button
        type="button"
        className="btn"
        onClick={() => onSocial("github")}
      >
        Continue with GitHub
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => onSocial("google")}
      >
        Continue with Google
      </button>

      <div className="or-divider" role="separator" aria-label="or">
        <span>or</span>
      </div>

      <form onSubmit={onCredentials}>
        <label htmlFor="login-email" className="field-label">
          Email
        </label>
        <input
          id="login-email"
          className="btn"
          style={{ textAlign: "left", cursor: "text" }}
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <label htmlFor="login-password" className="field-label">
          Password
        </label>
        <input
          id="login-password"
          className="btn"
          style={{ textAlign: "left", cursor: "text" }}
          type="password"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
        <button
          type="submit"
          className="btn btn-primary"
          disabled={busy}
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      {error ? (
        <p className="muted" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      <p className="muted" style={{ marginTop: "1rem", textAlign: "center" }}>
        Don&apos;t have an account? <a href="/signup">Sign up</a>
      </p>
    </div>
  );
}
