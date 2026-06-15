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

import { auth } from "@/lib/auth";

// Live auth endpoints (JWKS, token minting, sign-in) — always per-request.
export const dynamic = "force-dynamic";

export const { GET, POST } = toNextJsHandler(auth);
