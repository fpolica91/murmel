"use client";

import { useState } from "react";

import { useTeam } from "@/components/team-context";
import styles from "./cli.module.css";

const INSTALL =
  "curl -fsSL https://raw.githubusercontent.com/fpolica91/aw/main/install.sh | bash";

function Cmd({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(children);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      /* clipboard unavailable (insecure context) — user can select manually */
    }
  }
  return (
    <div className={styles.cmd}>
      <code className="mono">{children}</code>
      <button
        type="button"
        className={styles.copy}
        onClick={copy}
        aria-label="Copy command"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

/** Step-by-step "connect the CLI" guide with copy-to-clipboard commands. */
export function CliSetup() {
  const { activeTeam } = useTeam();
  const team = activeTeam ?? "<your-team>";

  return (
    <div className={styles.wrap}>
      <p className="muted">
        Drive Murmel from your terminal — discover work, claim issues, chat, and
        coordinate with agents. macOS &amp; Linux, no clone required.
      </p>

      <ol className={styles.steps}>
        <li className={styles.step}>
          <span className={styles.num}>1</span>
          <div className={styles.body}>
            <h3>Install</h3>
            <p className="muted">
              One line — downloads a prebuilt binary to{" "}
              <code className="mono">/usr/local/bin/murmel</code>. Already configured
              for this deployment.
            </p>
            <Cmd>{INSTALL}</Cmd>
          </div>
        </li>

        <li className={styles.step}>
          <span className={styles.num}>2</span>
          <div className={styles.body}>
            <h3>Sign in</h3>
            <p className="muted">
              Opens this site in your browser to approve, then caches a token at{" "}
              <code className="mono">~/.murmel/token</code>.
            </p>
            <Cmd>murmel login</Cmd>
          </div>
        </li>

        <li className={styles.step}>
          <span className={styles.num}>3</span>
          <div className={styles.body}>
            <h3>Bind a folder to your team</h3>
            <p className="muted">
              Run inside the project directory you want to coordinate from.
            </p>
            <Cmd>{`murmel init --team ${team}`}</Cmd>
          </div>
        </li>

        <li className={styles.step}>
          <span className={styles.num}>4</span>
          <div className={styles.body}>
            <h3>You&apos;re connected</h3>
            <p className="muted">A few commands to start:</p>
            <Cmd>murmel whoami</Cmd>
            <Cmd>murmel work ready</Cmd>
            <Cmd>murmel issue list</Cmd>
            <Cmd>murmel chat pending</Cmd>
          </div>
        </li>

        <li className={styles.step}>
          <span className={styles.num}>5</span>
          <div className={styles.body}>
            <h3>Connect a Claude Code agent (MCP)</h3>
            <p className="muted">
              Give a Claude Code agent the native Murmel tools — issues, chat,
              mail, work — over MCP. Run this once in your project, then restart
              Claude Code and run <code className="mono">/mcp</code> to confirm{" "}
              <code className="mono">murmel</code> is connected. Auth uses your
              cached <code className="mono">murmel login</code> token
              (auto-refreshing) — no certificate needed.
            </p>
            <Cmd>claude mcp add murmel -- murmel mcp-serve</Cmd>
          </div>
        </li>
      </ol>

      <p className={`muted ${styles.foot}`}>
        Tip: if you&apos;ve set a custom server URL in your shell environment, unset
        it so the CLI uses this deployment.
      </p>
    </div>
  );
}
