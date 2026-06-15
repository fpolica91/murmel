/**
 * Better Auth catch-all handler. This single route exposes the entire auth
 * surface under /api/auth/*, including the endpoints the aweb verifiers rely on:
 *
 *   GET  /api/auth/jwks                                -> JWKS public keys
 *   GET  /api/auth/.well-known/openid-configuration    -> OIDC discovery
 *   GET  /api/auth/token                               -> mint a JWT (session)
 *   POST /api/auth/sign-in/social                      -> SSO login start
 *   ...and the rest of Better Auth's routes.
 */
import { toNextJsHandler } from "better-auth/next-js";

import { getAuth } from "@/lib/auth";

// Live auth endpoints (JWKS, token minting, sign-in) — always per-request.
export const dynamic = "force-dynamic";

// `toNextJsHandler` expects the Better Auth *handler function* (`auth.handler`),
// not the auth object. Build it per request from the lazily-constructed
// instance so `next build` never needs DATABASE_URL (getAuth() memoizes).
export async function GET(request: Request) {
  return toNextJsHandler(getAuth().handler).GET(request);
}

export async function POST(request: Request) {
  return toNextJsHandler(getAuth().handler).POST(request);
}
