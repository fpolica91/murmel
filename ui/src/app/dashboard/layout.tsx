import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { resolveSubjectClaims } from "@/lib/claims";
import { TeamProvider } from "@/components/team-context";
import { AppSidebar } from "@/components/app-sidebar";

// Guards on the live session (reads request `headers` + the auth database), so
// the whole dashboard subtree must render per-request, not at build time.
export const dynamic = "force-dynamic";

/**
 * Authenticated shell. Guards the route, loads the caller's team hints, and
 * mounts the left sidebar (team switcher + nav + user badge) beside the
 * scrolling content column.
 */
export default async function DashboardLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect("/login");
  }

  const { teamIds } = await resolveSubjectClaims(session.user.id);

  return (
    <TeamProvider teams={teamIds}>
      <div className="dashboard-shell">
        <AppSidebar userName={session.user.name ?? session.user.email} />
        <main className="content">{children}</main>
      </div>
    </TeamProvider>
  );
}
