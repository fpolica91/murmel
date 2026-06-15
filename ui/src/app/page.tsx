import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { auth } from "@/lib/auth";

// Reads the session (and thus the request `headers`) and connects to the auth
// database — never prerender this at build time.
export const dynamic = "force-dynamic";

/**
 * Root: send authenticated users to the dashboard shell, everyone else to login.
 */
export default async function Home() {
  const session = await auth.api.getSession({ headers: await headers() });
  if (session) {
    redirect("/dashboard");
  }
  redirect("/login");
}
