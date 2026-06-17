"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { signOut } from "@/lib/auth-client";
import { TeamSwitcher } from "@/components/team-switcher";
import { UserBadge } from "@/components/user-badge";
import { useTeam } from "@/components/team-context";
import { listChatConversations } from "@/lib/api/chat";
import { subscribeEvents } from "@/lib/events/eventStream";
import {
  ChatIcon,
  CliIcon,
  ConsoleIcon,
  MembersIcon,
  WorkIcon,
} from "@/components/icons";

/** Primary nav entries. Moved here from the retired top bar. */
const NAV_LINKS: ReadonlyArray<{
  href: string;
  label: string;
  icon: ReactNode;
}> = [
  { href: "/dashboard", label: "Console", icon: <ConsoleIcon /> },
  { href: "/dashboard/work", label: "Work", icon: <WorkIcon /> },
  { href: "/dashboard/chat", label: "Chat", icon: <ChatIcon /> },
  { href: "/dashboard/members", label: "Members", icon: <MembersIcon /> },
  { href: "/dashboard/cli", label: "CLI", icon: <CliIcon /> },
];

function DashboardNav() {
  const pathname = usePathname();
  const { activeTeam } = useTeam();
  const [unreadChat, setUnreadChat] = useState(0);

  // Live unread-chat badge: refresh on the SSE event stream (actionable_chat),
  // with a slow poll as a fallback so a dropped stream still updates eventually.
  useEffect(() => {
    if (!activeTeam) {
      setUnreadChat(0);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const { conversations } = await listChatConversations(activeTeam);
        if (!cancelled) {
          setUnreadChat(
            conversations.reduce((n, c) => n + (c.unread_count || 0), 0),
          );
        }
      } catch {
        /* keep the last known count on transient errors */
      }
    };
    void refresh();
    const unsub = subscribeEvents(activeTeam, (e) => {
      if (e.type === "actionable_chat") void refresh();
    });
    const id = setInterval(() => void refresh(), 30000);
    return () => {
      cancelled = true;
      unsub();
      clearInterval(id);
    };
  }, [activeTeam]);

  function isActive(href: string) {
    // Exact match for the Console root; prefix match for the section roots so
    // nested routes (e.g. /dashboard/work/issues/123) keep their tab active.
    if (href === "/dashboard") {
      return pathname === "/dashboard";
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="sidebar-nav">
      {NAV_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`sidebar-link${isActive(link.href) ? " active" : ""}`}
          aria-current={isActive(link.href) ? "page" : undefined}
        >
          {link.icon}
          <span>{link.label}</span>
          {link.href === "/dashboard/chat" && unreadChat > 0 ? (
            <span
              className="sidebar-badge"
              aria-label={`${unreadChat} unread`}
            >
              {unreadChat > 99 ? "99+" : unreadChat}
            </span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/**
 * Linear-style left rail: brand wordmark, full-width team switcher, primary
 * nav, a flex spacer, and a bottom-pinned footer with the signed-in user
 * (online dot via the presence hook) + Sign out.
 */
export function AppSidebar({ userName }: { userName: string }) {
  async function onSignOut() {
    await signOut();
    window.location.href = "/login";
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">Murmel</div>
      <div className="sidebar-team">
        <TeamSwitcher />
      </div>
      <DashboardNav />
      <div className="sidebar-spacer" />
      <div className="sidebar-footer">
        <UserBadge userName={userName} />
        <button
          type="button"
          className="btn"
          style={{ marginTop: 0 }}
          onClick={onSignOut}
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}
