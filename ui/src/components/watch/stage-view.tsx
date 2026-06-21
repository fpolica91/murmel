"use client";

import type { LeaderboardRow } from "@/lib/leaderboard";
import { initials, type StageView as StageViewData } from "./stage-derive";
import styles from "./office.module.css";

const MEDALS = ["🥇", "🥈", "🥉"];
const CONFETTI = Array.from({ length: 16 }, (_, i) => i);

export interface ShipEvent {
  key: number;
  name: string;
  title: string;
}

/**
 * Presentational live office — little people at desks animated by state
 * (working monitor + scrolling code, talking speech bubble, idle ☕), a kanban
 * rail, a leaderboard, and a 🚀 confetti burst. Pure: all data arrives as props
 * from either the authed or public container.
 */
export function StageView({
  view,
  rows,
  ship,
}: {
  view: StageViewData;
  rows: LeaderboardRow[];
  ship: ShipEvent | null;
}) {
  const { teamLabel, nowBuilding, workingCount, shippedTotal, desks, columns } =
    view;

  return (
    <div className={styles.room}>
      <header className={styles.marquee}>
        <span className={styles.live}>
          <span className={styles.liveDot} /> LIVE
        </span>
        <div className={styles.nowBuilding}>
          {nowBuilding ? (
            <>
              <span className={styles.nbLabel}>NOW BUILDING</span>
              <span className={styles.nbTitle}>{nowBuilding}</span>
            </>
          ) : (
            <span className={styles.nbLabel}>{teamLabel} · between builds</span>
          )}
        </div>
        <div className={styles.tally}>
          <b>{workingCount}</b> heads-down · <b>{shippedTotal}</b> shipped
        </div>
      </header>

      <div className={styles.split}>
        <section className={styles.floor} aria-label="The office floor">
          <div className={styles.floorGrid} aria-hidden="true" />
          <div className={styles.desks}>
            {desks.map(({ row, state, work, say }) => (
              <div
                key={row.alias}
                className={`${styles.station} ${styles[state]}`}
                title={`${row.displayName} — ${
                  state === "working"
                    ? `on ${work}`
                    : state === "talking"
                      ? "in chat"
                      : "standing by"
                }`}
              >
                {state === "talking" && say ? (
                  <div className={styles.bubble}>
                    <span className={styles.bubbleText}>{say}</span>
                  </div>
                ) : state === "idle" ? (
                  <div className={styles.zzz} aria-hidden="true">
                    ☕
                  </div>
                ) : null}

                <div className={styles.person}>
                  <div
                    className={`${styles.head} ${
                      row.kind === "agent" ? styles.agent : styles.human
                    }`}
                  >
                    {initials(row.displayName)}
                    {row.online ? <span className={styles.onDot} /> : null}
                  </div>
                  <div
                    className={`${styles.torso} ${
                      row.kind === "agent" ? styles.agentBg : styles.humanBg
                    }`}
                  />
                </div>

                <div className={styles.desk}>
                  <div className={styles.monitor}>
                    {state === "working" ? (
                      <div className={styles.code} aria-hidden="true">
                        <i style={{ width: "70%" }} />
                        <i style={{ width: "45%" }} />
                        <i style={{ width: "85%" }} />
                        <i style={{ width: "55%" }} />
                        <i style={{ width: "75%" }} />
                      </div>
                    ) : (
                      <div className={styles.screenOff} aria-hidden="true" />
                    )}
                  </div>
                  <div className={styles.deskTop} />
                </div>

                <div className={styles.plate}>
                  <span className={styles.plateName}>{row.displayName}</span>
                  <span className={styles.plateStat}>
                    {state === "working"
                      ? "typing…"
                      : state === "talking"
                        ? "talking"
                        : `${row.issuesDone} shipped`}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </section>

        <aside className={styles.side}>
          <div className={styles.board}>
            <div className={styles.boardHead}>The board</div>
            <div className={styles.cols}>
              {(
                [
                  ["To do", columns.todo, "ctodo"],
                  ["Doing", columns.doing, "cdoing"],
                  ["Done", columns.done, "cdone"],
                ] as const
              ).map(([label, list, cls]) => (
                <div key={label} className={`${styles.col} ${styles[cls]}`}>
                  <div className={styles.colHead}>
                    {label} <span>{list.length}</span>
                  </div>
                  <div className={styles.chips}>
                    {list.map((i) => (
                      <div
                        key={i.issue_id}
                        className={styles.chip}
                        title={i.title}
                      >
                        {i.title}
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.lbPanel}>
            <div className={styles.boardHead}>Leaderboard</div>
            <ol className={styles.lb}>
              {rows.slice(0, 5).map((r, i) => (
                <li key={r.alias} className={styles.lbRow}>
                  <span className={styles.lbRank}>{MEDALS[i] ?? i + 1}</span>
                  <span
                    className={`${styles.lbDot} ${
                      r.kind === "agent" ? styles.agentBg : styles.humanBg
                    }`}
                  />
                  <span className={styles.lbName}>{r.displayName}</span>
                  <span className={styles.lbScore}>{r.issuesDone}</span>
                </li>
              ))}
            </ol>
          </div>
        </aside>
      </div>

      {ship ? (
        <div key={ship.key} className={styles.shipWrap} role="status">
          <div className={styles.confetti} aria-hidden="true">
            {CONFETTI.map((n) => (
              <span key={n} className={styles[`c${n % 8}` as const]} />
            ))}
          </div>
          <div className={styles.shipBanner}>
            <span className={styles.shipRocket}>🚀</span>
            <span>
              <strong>{ship.name}</strong> shipped{" "}
              <span className={styles.shipTitle}>“{ship.title}”</span>
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}
