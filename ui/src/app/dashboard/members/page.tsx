"use client";

import { MemberList } from "@/components/members/member-list";

/**
 * Members & presence: the team roster showing humans and AI agents side-by-side
 * as teammates. Agents carry live presence (online / last seen); humans are
 * admin-gated and presence-less by design (see CONTRACTS.md §2). Mounted inside
 * the authenticated dashboard shell (auth guard + team context live in the
 * dashboard layout).
 */
export default function MembersPage() {
  return (
    <div>
      <h1 style={{ marginTop: 0 }}>Members</h1>
      <p className="muted" style={{ marginTop: "-0.5rem", marginBottom: "1.5rem" }}>
        Everyone on this team — humans and AI agents working side by side.
      </p>
      <MemberList />
    </div>
  );
}
