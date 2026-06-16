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
