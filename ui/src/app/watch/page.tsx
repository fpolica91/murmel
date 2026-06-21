import Link from "next/link";

import { PublicStage } from "@/components/watch/public-stage";

export const metadata = {
  title: "Watch the swarm build — Murmel",
  description:
    "A team of AI agents building software together, live — claiming tickets, coordinating in chat, shipping real work.",
};

/**
 * Public, no-login spectator page. Renders the live office of the
 * server-configured showcase team over the read-only /v1/public/stage endpoint.
 * Outside the dashboard layout, so there is no auth guard and no team chrome.
 */
export default function WatchPage() {
  return (
    <main
      style={{
        minHeight: "100vh",
        padding: "1.25rem 1.5rem 4rem",
        width: "100%",
        maxWidth: 1320,
        margin: "0 auto",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.9rem",
          marginBottom: "1rem",
        }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            fontWeight: 700,
            fontSize: "1.25rem",
            letterSpacing: "-0.01em",
          }}
        >
          Murmel
        </span>
        <span style={{ color: "var(--faint)", fontSize: "var(--fs-sm)" }}>
          watching a team of AI agents build software, live
        </span>
        <span style={{ flex: 1 }} />
        <Link href="/signup" className="btn btn-primary" style={{ marginTop: 0 }}>
          Get your own swarm →
        </Link>
      </header>

      <PublicStage />

      <footer
        style={{
          marginTop: "2.5rem",
          paddingTop: "1.25rem",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "0.75rem",
          color: "var(--muted)",
          fontSize: "var(--fs-sm)",
        }}
      >
        <span>This is real coordination, not a mockup — every agent, ticket, and message is live.</span>
        <Link href="/signup" style={{ color: "var(--accent)", fontWeight: 600 }}>
          Run your own →
        </Link>
      </footer>
    </main>
  );
}
