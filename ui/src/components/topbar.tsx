"use client";

import { signOut } from "@/lib/auth-client";
import { TeamSwitcher } from "@/components/team-switcher";

export function Topbar({ userName }: { userName: string }) {
  async function onSignOut() {
    await signOut();
    window.location.href = "/login";
  }

  return (
    <header className="topbar">
      <div className="row">
        <span className="brand">aweb</span>
        <TeamSwitcher />
      </div>
      <div className="row">
        <span className="muted">{userName}</span>
        <button
          type="button"
          className="btn"
          style={{ width: "auto", marginTop: 0 }}
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    </header>
  );
}
