"use client";

import { useEffect, useState } from "react";

import { signIn, signUp } from "@/lib/auth-client";

/**
 * Email/password registration (+ the same SSO buttons as the login form).
 * Better Auth auto-signs-in on success, so we redirect straight to /dashboard.
 */
export function SignupForm() {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Preserve the invite/return target on the "Sign in" link (set after mount to
  // avoid a hydration mismatch on the href).
  const [loginHref, setLoginHref] = useState("/login");

  // Return-to after auth (e.g. an /invite/<token> link). Same-origin only.
  function callbackURL(): string {
    if (typeof window === "undefined") return "/dashboard";
    const cb = new URLSearchParams(window.location.search).get("callbackURL");
    return cb && cb.startsWith("/") && !cb.startsWith("//") ? cb : "/dashboard";
  }

  useEffect(() => {
    const cb = new URLSearchParams(window.location.search).get("callbackURL");
    if (cb && cb.startsWith("/") && !cb.startsWith("//")) {
      setLoginHref(`/login?callbackURL=${encodeURIComponent(cb)}`);
    }
  }, []);

  async function onSocial(provider: "github" | "google") {
    setError(null);
    await signIn.social({ provider, callbackURL: callbackURL() });
  }

  async function onCredentials(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    const cb = callbackURL();
    const { error } = await signUp.email({
      name: name.trim(),
      email,
      password,
      callbackURL: cb,
    });
    setBusy(false);
    if (error) {
      setError(error.message ?? "Sign-up failed");
      return;
    }
    window.location.href = cb;
  }

  return (
    <div>
      <button type="button" className="btn" onClick={() => onSocial("github")}>
        Continue with GitHub
      </button>
      <button type="button" className="btn" onClick={() => onSocial("google")}>
        Continue with Google
      </button>

      <div className="or-divider" role="separator" aria-label="or">
        <span>or</span>
      </div>

      <form onSubmit={onCredentials}>
        <label htmlFor="signup-name" className="field-label">
          Name
        </label>
        <input
          id="signup-name"
          className="btn"
          style={{ textAlign: "left", cursor: "text" }}
          type="text"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="name"
          required
        />
        <label htmlFor="signup-email" className="field-label">
          Email
        </label>
        <input
          id="signup-email"
          className="btn"
          style={{ textAlign: "left", cursor: "text" }}
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="email"
          required
        />
        <label htmlFor="signup-password" className="field-label">
          Password
        </label>
        <input
          id="signup-password"
          className="btn"
          style={{ textAlign: "left", cursor: "text" }}
          type="password"
          placeholder="At least 8 characters"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="new-password"
          minLength={8}
          required
        />
        <label htmlFor="signup-confirm" className="field-label">
          Confirm password
        </label>
        <input
          id="signup-confirm"
          className="btn"
          style={{ textAlign: "left", cursor: "text" }}
          type="password"
          placeholder="Re-enter password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          autoComplete="new-password"
          required
        />
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? "Creating account…" : "Create account"}
        </button>
      </form>

      {error ? (
        <p className="muted" style={{ color: "var(--danger)" }}>
          {error}
        </p>
      ) : null}

      <p className="muted" style={{ marginTop: "1rem", textAlign: "center" }}>
        Already have an account? <a href={loginHref}>Sign in</a>
      </p>
    </div>
  );
}
