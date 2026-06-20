"use client";

import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import { signOut } from "@/lib/auth-client";
import { TeamSwitcher } from "@/components/team-switcher";
import { ThemeToggle } from "@/components/theme-toggle";
import { UserBadge } from "@/components/user-badge";
import { useTeam } from "@/components/team-context";
import { listChatConversations } from "@/lib/api/chat";
import { listInbox } from "@/lib/api/mail";
import { subscribeEvents } from "@/lib/events/eventStream";
import {
  ChatIcon,
  ClaimsIcon,
  CliIcon,
  ConsoleIcon,
  EpicsIcon,
  LeaderboardIcon,
  MailIcon,
  MembersIcon,
  MemoryIcon,
  RolesIcon,
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
  { href: "/dashboard/epics", label: "Epics", icon: <EpicsIcon /> },
  { href: "/dashboard/chat", label: "Chat", icon: <ChatIcon /> },
  { href: "/dashboard/mail", label: "Mail", icon: <MailIcon /> },
  { href: "/dashboard/memory", label: "Memory", icon: <MemoryIcon /> },
  { href: "/dashboard/roles", label: "Roles", icon: <RolesIcon /> },
  { href: "/dashboard/claims", label: "Claims", icon: <ClaimsIcon /> },
  { href: "/dashboard/leaderboard", label: "Leaderboard", icon: <LeaderboardIcon /> },
  { href: "/dashboard/members", label: "Members", icon: <MembersIcon /> },
  { href: "/dashboard/cli", label: "CLI", icon: <CliIcon /> },
];

function DashboardNav() {
  const pathname = usePathname();
  const { activeTeam } = useTeam();
  const [unreadChat, setUnreadChat] = useState(0);
  const [unreadMail, setUnreadMail] = useState(0);

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

  // Live unread-mail badge: same shape as the chat badge but driven by the
  // unread inbox count and refreshed on the SSE `actionable_mail` event, with a
  // 30s poll fallback.
  useEffect(() => {
    if (!activeTeam) {
      setUnreadMail(0);
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const unread = await listInbox(activeTeam, { unreadOnly: true });
        if (!cancelled) setUnreadMail(unread.length);
      } catch {
        /* keep the last known count on transient errors */
      }
    };
    void refresh();
    const unsub = subscribeEvents(activeTeam, (e) => {
      if (e.type === "actionable_mail") void refresh();
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
          {link.href === "/dashboard/mail" && unreadMail > 0 ? (
            <span
              className="sidebar-badge"
              aria-label={`${unreadMail} unread`}
            >
              {unreadMail > 99 ? "99+" : unreadMail}
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
        <div className="row" style={{ gap: "0.5rem" }}>
          <button
            type="button"
            className="btn"
            style={{ marginTop: 0, flex: 1 }}
            onClick={onSignOut}
          >
            Sign out
          </button>
          <ThemeToggle />
        </div>
      </div>
    </aside>
  );
}
