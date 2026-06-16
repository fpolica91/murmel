/**
 * Better Auth server instance — the JWT *issuer* for the whole aweb stack.
 *
 * This runs in the Next.js UI, NOT in the Python server. The Python server and
 * the Go CLI are pure *verifiers*: they fetch this issuer's JWKS, validate the
 * token signature, check `exp`, reject revoked `jti`s, and then authorize each
 * request against the `memberships` table (the source of truth).
 *
 * AUTH CONTRACT (must stay in sync with the Python verifier + CLI):
 *
 *   - Algorithm:   asymmetric (EdDSA by default here; RS256/ES256 also
 *                  acceptable — whatever the JWKS advertises). The verifier
 *                  picks the key by `kid` from the JWKS, so the alg is
 *                  self-describing. See JWKS note below.
 *   - JWKS URL:    `${BETTER_AUTH_URL}/api/auth/jwks`
 *   - OIDC config: `${BETTER_AUTH_URL}/api/auth/.well-known/openid-configuration`
 *   - Issuer:      `${BETTER_AUTH_URL}`
 *   - Audience:    `AWEB_JWT_AUDIENCE` (canonical aweb server origin)
 *
 *   Claims emitted on the JWT:
 *     sub         string    subject id (human user id OR agent id)
 *     team_ids    string[]  HINT of teams the subject belongs to. NOT
 *                           authoritative — the server re-checks `memberships`.
 *     roles       string[]  role hints (e.g. ["member"], ["owner"])
 *     agent_name  string?   present when the subject is an agent
 *     exp         number    expiry (unix seconds) — short-lived
 *     iat         number    issued-at (unix seconds)
 *     jti         number/   unique token id — server denylists this in
 *                 string    `revoked_tokens` to revoke a live token
 *
 * NOTE: Better Auth's `jwt` plugin sets `exp`, `iat`, `iss`, `aud`, `sub` and a
 * unique `jti` automatically. We only enrich the *payload* with team_ids /
 * roles / agent_name via `definePayload`.
 */
import { betterAuth } from "better-auth";
import { bearer, deviceAuthorization, jwt } from "better-auth/plugins";
import { Pool } from "pg";

import { resolveSubjectClaims } from "./claims";

function buildAuth() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    // Fail loudly on first real use so a misconfigured deploy never silently
    // issues tokens against the wrong / no database. We defer this to first
    // access (rather than module load) so `next build`'s page-data collection
    // — which evaluates the module without runtime secrets — does not abort.
    throw new Error("DATABASE_URL is required for the aweb auth issuer");
  }

  const audience = process.env.AWEB_JWT_AUDIENCE ?? "http://localhost:8000";
  const ttlSeconds = Number(process.env.AWEB_JWT_TTL_SECONDS ?? "900");

  return betterAuth({
    baseURL: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
    secret: process.env.BETTER_AUTH_SECRET,

    // Force Secure session cookies in production instead of inferring it from
    // the BETTER_AUTH_URL scheme — so a misconfigured (http) base URL can't
    // silently drop the Secure attribute on the session cookie.
    advanced: {
      useSecureCookies: process.env.NODE_ENV === "production",
    },

    // Better Auth manages its own tables (user/session/account/verification/
    // jwks) in this Postgres database — separate from the aweb server DB.
    database: new Pool({ connectionString: databaseUrl }),

    // --- Authentication methods ---
    emailAndPassword: {
      enabled: true,
    },

    socialProviders: buildSocialProviders(),

    // --- JWT issuance (this is what makes us the issuer) ---
    plugins: [
      jwt({
        jwks: {
          // EdDSA (Ed25519) keys: compact and fast. The verifier reads the alg
          // from the JWKS `kid`/`alg`, so RS256/ES256 are equally valid if a
          // deploy prefers them. Keep ONE alg per deploy for cache simplicity.
          keyPairConfig: { alg: "EdDSA" },
        },
        jwt: {
          issuer: process.env.BETTER_AUTH_URL ?? "http://localhost:3000",
          audience,
          // Short-lived access tokens; revocation handled server-side via JTI.
          expirationTime: `${ttlSeconds}s`,
          // Enrich the standard payload with the aweb-specific claims. `sub`,
          // `exp`, `iat`, `iss`, `aud`, `jti` are added by the plugin itself.
          definePayload: async ({ user }) => {
            const { teamIds, roles, agentName } = await resolveSubjectClaims(
              user.id,
            );
            return {
              team_ids: teamIds,
              roles,
              // Display name for attribution (comment authors, etc.).
              ...(user.name ? { name: user.name } : {}),
              ...(agentName ? { agent_name: agentName } : {}),
            };
          },
        },
      }),
      // Accept a session token via `Authorization: Bearer <token>` so the CLI
      // can exchange its device-flow session for a JWT at /api/auth/token.
      bearer(),
      // RFC 8628 device flow for `aw login`. The public CLI client has no
      // secret; we accept the known client id. The device flow yields a
      // session (see bearer above); the CLI then mints a JWT from it.
      deviceAuthorization({
        expiresIn: "10m",
        interval: "5s",
        validateClient: async (clientId: string) => clientId === "aweb-cli",
        // Required at runtime by this Better Auth version (zod non-optional);
        // empty = use the default deviceCode table/fields.
        schema: {},
      }),
    ],
  });
}

// The concrete Better Auth instance type, inferred from buildAuth so the
// deeply-parameterized generic (adapter, plugin context, etc.) is preserved
// rather than widened to the base BetterAuthOptions shape.
type Auth = ReturnType<typeof buildAuth>;

// Lazily construct the Better Auth instance on first access. This keeps the
// "fail loudly when DATABASE_URL is missing" guarantee at runtime while letting
// `next build` collect page data without the database connection string.
let cached: Auth | undefined;
export function getAuth(): Auth {
  if (!cached) {
    cached = buildAuth();
  }
  return cached;
}

export const auth = new Proxy({} as Auth, {
  get(_target, prop) {
    // Resolve against the real instance and bind methods to it. Passing the
    // proxy as the receiver (Reflect.get's 3rd arg) would make `this` the proxy
    // inside Better Auth's methods and break internal calls ("a is not a
    // function"); binding to the concrete instance keeps `this` correct.
    const real = getAuth() as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? value.bind(real) : value;
  },
}) as Auth;

function buildSocialProviders() {
  const providers: Record<string, { clientId: string; clientSecret: string }> =
    {};
  if (process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET) {
    providers.github = {
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    };
  }
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    providers.google = {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    };
  }
  return providers;
}
