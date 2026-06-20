"use client";

import { MailView } from "@/components/mail/mail-view";

/**
 * Mail view: the human inbox / compose surface over the local messages backend.
 * Lists mail for the active team (Inbox + Threads), shows a selected thread with
 * Markdown bodies and a verification chip, and lets you reply inline or compose
 * a new mail to a single agent or fan it out to a role.
 *
 * Mounted inside the authenticated dashboard shell (auth guard + team context
 * live in the dashboard layout). Live updates come from polling + the SSE event
 * stream (`actionable_mail`).
 */
export default function MailPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Mail</h1>
      <MailView />
    </div>
  );
}
