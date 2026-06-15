/**
 * Browser-side Better Auth client. Use these hooks/methods from client
 * components for sign-in, sign-out, and session access.
 */
"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  // Same-origin: the Next.js app hosts the auth handler at /api/auth/*.
  baseURL:
    typeof window !== "undefined"
      ? window.location.origin
      : (process.env.NEXT_PUBLIC_BETTER_AUTH_URL ?? "http://localhost:3000"),
});

export const { signIn, signOut, signUp, useSession, getSession } = authClient;
