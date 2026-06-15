"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { signOut } from "@/lib/auth-client";
import { TeamSwitcher } from "@/components/team-switcher";

const NAV_LINKS = [
  { href: "/dashboard", label: "Console" },
  { href: "/dashboard/work", label: "Work" },
  { href: "/dashboard/chat", label: "Chat" },
  { href: "/dashboard/members", label: "Members" },
] as const;

function DashboardNav() {
  const pathname = usePathname();

  function isActive(href: string) {
    // Exact match for the Console root; prefix match for the section roots so
    // nested routes (e.g. /dashboard/work/issues/123) keep their tab active.
    if (href === "/dashboard") {
      return pathname === "/dashboard";
    }
    return pathname === href || pathname.startsWith(`${href}/`);
  }

  return (
    <nav className="topnav">
      {NAV_LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={`topnav-link${isActive(link.href) ? " active" : ""}`}
          aria-current={isActive(link.href) ? "page" : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}

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
        <DashboardNav />
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
