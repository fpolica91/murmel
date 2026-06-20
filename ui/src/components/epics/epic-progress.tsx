"use client";

import styles from "./epics.module.css";

/**
 * Small presentational done/total burndown indicator: a thin filled bar plus a
 * "done/total" numeric readout. Pure UI — the caller computes `done`/`total`
 * (issues whose status === "done", over the issue count for the epic).
 *
 * Guards a zero-total epic (no issues yet) so the bar renders empty rather than
 * dividing by zero, and clamps the fill to [0, 100]%.
 */
export function EpicProgress({
  done,
  total,
  size = "md",
}: {
  done: number;
  total: number;
  /** "sm" trims the bar width for the dense master rows; "md" for the detail. */
  size?: "sm" | "md";
}) {
  const pct = total > 0 ? Math.min(100, Math.max(0, (done / total) * 100)) : 0;
  const complete = total > 0 && done >= total;
  const label = `${done}/${total} issues done`;

  return (
    <span
      className={`${styles.progress} ${size === "sm" ? styles.progressSm : ""}`}
      title={label}
      role="img"
      aria-label={label}
    >
      <span className={styles.progressTrack}>
        <span
          className={`${styles.progressFill} ${complete ? styles.progressDone : ""}`}
          style={{ width: `${pct}%` }}
        />
      </span>
      <span className={styles.progressCount}>
        {done}/{total}
      </span>
    </span>
  );
}
