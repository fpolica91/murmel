"use client";

import { useEffect, useState } from "react";

/** localStorage key the no-flash script in layout.tsx also reads. */
const STORAGE_KEY = "murmel.theme";

type Theme = "light" | "dark";

/** Resolve the theme already applied to the DOM (set by the no-flash script or
 * a prior toggle). Falls back to the OS preference so the icon is correct even
 * when nothing is persisted yet. */
function resolveTheme(): Theme {
  if (typeof document !== "undefined") {
    const attr = document.documentElement.dataset.theme;
    if (attr === "light" || attr === "dark") return attr;
  }
  if (typeof window !== "undefined" && window.matchMedia) {
    return window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  }
  return "dark";
}

/** Sun (light) / moon (dark) toggle. Flips document.documentElement's
 * data-theme and persists the choice. Tokenized via globals.css — no
 * hardcoded colors. */
export function ThemeToggle() {
  // Start as null so server and first client render agree (avoids a hydration
  // mismatch); the real value is read from the DOM after mount.
  const [theme, setTheme] = useState<Theme | null>(null);

  useEffect(() => {
    setTheme(resolveTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === "light" ? "dark" : "light";
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / storage disabled — toggle still applies for this view */
    }
    setTheme(next);
  }

  // Pre-mount: render a stable, inert placeholder so layout doesn't shift.
  const isLight = theme === "light";
  const label = isLight ? "Switch to dark theme" : "Switch to light theme";

  return (
    <button
      type="button"
      className="btn theme-toggle"
      onClick={toggle}
      aria-label={label}
      title={label}
      aria-pressed={theme === null ? undefined : isLight}
      style={{
        width: "auto",
        marginTop: 0,
        padding: "0.42rem 0.55rem",
        flex: "0 0 auto",
        lineHeight: 0,
      }}
    >
      {isLight ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg
      width={16}
      height={16}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  );
}
