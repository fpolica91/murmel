"use client";

import styles from "./ui.module.css";

/**
 * Derive up to two initials from a display label, used by the shared Avatar.
 *
 * Rules (single source of truth for the whole app):
 *  - Strip parenthetical tokens like "(agent)" so "Ada (agent)" -> "AD",
 *    never "A(".
 *  - Keep only alphanumeric word characters, then take the first letter of the
 *    first two words; if there's only one word, take its first two characters.
 *  - Always upper-cased; falls back to "?" for an empty/garbage label.
 */
export function initials(label: string): string {
  // Drop parenthetical suffixes (e.g. "(agent)") before tokenizing.
  const withoutParens = label.replace(/\([^)]*\)/g, " ");
  // Split on any non-alphanumeric run so "·", "-", "_" etc. are separators.
  const parts = withoutParens
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

export type AvatarKind = "human" | "agent" | "unassigned";

/**
 * Shared circular avatar. One initials rule (see {@link initials}), one colour
 * system (accent for humans, violet for agents, muted for unassigned), used on
 * the board, issue detail, members, chat list, and chat thread.
 *
 * `size` controls the diameter; `online` overlays a presence dot when defined.
 */
export function Avatar({
  label,
  kind = "agent",
  size = "md",
  online,
  className,
}: {
  label: string;
  kind?: AvatarKind;
  size?: "sm" | "md" | "lg";
  /** When provided, renders a presence dot (green online, muted offline). */
  online?: boolean;
  className?: string;
}) {
  const kindClass =
    kind === "human"
      ? styles.avatarHuman
      : kind === "unassigned"
        ? styles.avatarUnassigned
        : styles.avatarAgent;
  const sizeClass =
    size === "sm" ? styles.avatarSm : size === "lg" ? styles.avatarLg : styles.avatarMd;
  const content = kind === "unassigned" ? "—" : initials(label);

  if (online === undefined) {
    return (
      <span
        className={`${styles.avatar} ${kindClass} ${sizeClass} ${className ?? ""}`}
        aria-hidden="true"
      >
        {content}
      </span>
    );
  }

  return (
    <span className={`${styles.avatarWrap} ${className ?? ""}`}>
      <span
        className={`${styles.avatar} ${kindClass} ${sizeClass}`}
        aria-hidden="true"
      >
        {content}
      </span>
      <span
        className={`${styles.presenceDot} ${online ? styles.presenceOnline : ""}`}
        aria-hidden="true"
      />
    </span>
  );
}
