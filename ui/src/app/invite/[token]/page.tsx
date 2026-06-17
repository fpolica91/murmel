import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";
import { AcceptInvite } from "@/components/accept-invite";

// Reads the live session per request.
export const dynamic = "force-dynamic";

/**
 * Invitation landing page. Requires a signed-in user — unauthenticated visitors
 * are sent to login/signup with a callback back here, so they can sign up (which
 * auto-creates their personal team) and then accept, landing in both teams.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    redirect(`/login?callbackURL=${encodeURIComponent(`/invite/${token}`)}`);
  }
  return (
    <div className="center">
      <div className="panel">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-word">aweb</span>
        </div>
        <AcceptInvite token={token} />
      </div>
    </div>
  );
}
