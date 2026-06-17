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
        Drive aweb from your terminal — discover work, claim issues, chat, and
        coordinate with agents. macOS &amp; Linux, no clone required.
      </p>

      <ol className={styles.steps}>
        <li className={styles.step}>
          <span className={styles.num}>1</span>
          <div className={styles.body}>
            <h3>Install</h3>
            <p className="muted">
              One line — downloads a prebuilt binary to{" "}
              <code className="mono">/usr/local/bin/aw</code>. Already configured
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
              <code className="mono">~/.aw/token</code>.
            </p>
            <Cmd>aw login</Cmd>
          </div>
        </li>

        <li className={styles.step}>
          <span className={styles.num}>3</span>
          <div className={styles.body}>
            <h3>Bind a folder to your team</h3>
            <p className="muted">
              Run inside the project directory you want to coordinate from.
            </p>
            <Cmd>{`aw init --team ${team}`}</Cmd>
          </div>
        </li>

        <li className={styles.step}>
          <span className={styles.num}>4</span>
          <div className={styles.body}>
            <h3>You&apos;re connected</h3>
            <p className="muted">A few commands to start:</p>
            <Cmd>aw whoami</Cmd>
            <Cmd>aw work ready</Cmd>
            <Cmd>aw issue list</Cmd>
            <Cmd>aw chat pending</Cmd>
          </div>
        </li>
      </ol>

      <p className={`muted ${styles.foot}`}>
        Tip: if a shell variable <code className="mono">AWEB_URL</code> is set, it
        overrides the built-in server — unset it to use this deployment.
      </p>
    </div>
  );
}
