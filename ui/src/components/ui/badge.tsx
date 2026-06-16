"use client";

import styles from "./ui.module.css";

export type ParticipantKind = "human" | "agent";

/** Canonical human-readable labels for a participant kind. One source string. */
export const KIND_LABELS: Record<ParticipantKind, string> = {
  human: "Human",
  agent: "AI agent",
};

/**
 * Shared human/agent tag. Renders the SAME text everywhere ("Human" /
 * "AI agent") so the board, members, chat thread, and issue conversation never
 * disagree (fixes M3). Colour-coded by kind.
 */
export function KindBadge({
  kind,
  className,
}: {
  kind: ParticipantKind;
  className?: string;
}) {
  const kindClass = kind === "human" ? styles.kindHuman : styles.kindAgent;
  return (
    <span className={`${styles.kindBadge} ${kindClass} ${className ?? ""}`}>
      {KIND_LABELS[kind]}
    </span>
  );
}

/** Per-message trust signal (server `message_verification_status`). */
export type VerificationStatus =
  | "verified"
  | "verified_server"
  | "verified_legacy"
  | "unverified"
  | "failed";

/**
 * Subtle per-message verification pill, visually consistent with KindBadge.
 * `verified`/`verified_legacy` render a quiet "Verified"; `verified_server`
 * reads "Verified (server)"; `unverified` a muted "Unverified"; `failed` a
 * warning. Any unknown/missing value renders nothing (back-compat).
 */
export function VerificationBadge({
  status,
  className,
}: {
  status?: string;
  className?: string;
}) {
  let label: string;
  let toneClass: string;
  switch (status) {
    case "verified":
    case "verified_legacy":
      label = "Verified";
      toneClass = styles.verifyOk;
      break;
    case "verified_server":
      label = "Verified (server)";
      toneClass = styles.verifyOk;
      break;
    case "unverified":
      label = "Unverified";
      toneClass = styles.verifyMuted;
      break;
    case "failed":
      label = "Verification failed";
      toneClass = styles.verifyFail;
      break;
    default:
      return null;
  }
  return (
    <span className={`${styles.kindBadge} ${toneClass} ${className ?? ""}`}>
      {label}
    </span>
  );
}
