# aweb UI (`ui/`)

Next.js (App Router) + React + TypeScript app that is the **JWT issuer** for the
whole aweb stack, using [Better Auth](https://www.better-auth.com/). It provides:

- SSO / email-password **login**
- A **JWKS** endpoint the aweb Python server and Go CLI use to verify tokens
- A **team switcher** shell for authenticated users

> Better Auth runs **here**, not in the Python server. The server and CLI are
> verifiers only.

---

## Quick start

```bash
cd ui
cp .env.example .env.local        # then fill in secrets
npm install                       # (or pnpm/yarn install)

# create Better Auth's own tables in DATABASE_URL
npm run db:migrate                # wraps: npx @better-auth/cli migrate

npm run dev                       # http://localhost:3000
```

Then open <http://localhost:3000>:

- unauthenticated → `/login`
- authenticated → `/dashboard` (top bar has the team switcher + sign out)

### Other scripts

| script              | purpose                                  |
| ------------------- | ---------------------------------------- |
| `npm run dev`       | dev server on :3000                      |
| `npm run build`     | production build                         |
| `npm run start`     | run the production build                 |
| `npm run typecheck` | `tsc --noEmit`                           |
| `npm run lint`      | `next lint`                              |
| `npm run db:migrate`| create/update Better Auth tables         |

---

## The auth contract (keep server + CLI in sync)

A request is authenticated by a JWT issued here and verified downstream.

### Endpoints exposed by this app

| URL | what it is |
| --- | --- |
| `${BETTER_AUTH_URL}/api/auth/jwks` | **JWKS** — public keys for token verification. Cache with a TTL. |
| `${BETTER_AUTH_URL}/api/auth/.well-known/openid-configuration` | OIDC discovery (points at the JWKS + issuer). |
| `${BETTER_AUTH_URL}/api/auth/token` | mint a JWT for the current session (used by clients/CLI). |
| `${BETTER_AUTH_URL}/api/auth/*` | the rest of Better Auth (sign-in/out, social, etc.). |

With the default local config:

- **JWKS URL:** `http://localhost:3000/api/auth/jwks`
- **Issuer (`iss`):** `http://localhost:3000` (value of `BETTER_AUTH_URL`)
- **Audience (`aud`):** value of `AWEB_JWT_AUDIENCE` (e.g. `http://localhost:8000`)
- **Algorithm:** `EdDSA` by default (Ed25519). `RS256` / `ES256` are also
  acceptable — set `keyPairConfig.alg` in `src/lib/auth.ts`. The verifier MUST
  select the key by `kid` from the JWKS and honor that key's `alg`; do not
  hard-code an algorithm on the verifier side.

### Claims emitted on the JWT

| claim | type | meaning |
| --- | --- | --- |
| `sub` | string | subject id — a human user id **or** an agent id |
| `team_ids` | string[] | **hint** of the subject's teams. NOT authoritative. |
| `roles` | string[] | role hints, e.g. `["member"]`, `["owner"]` |
| `agent_name` | string? | present only when the subject is an agent |
| `iss` | string | issuer = `BETTER_AUTH_URL` |
| `aud` | string | audience = `AWEB_JWT_AUDIENCE` |
| `exp` | number | expiry (unix seconds) — short-lived (`AWEB_JWT_TTL_SECONDS`, default 900) |
| `iat` | number | issued-at (unix seconds) |
| `jti` | string/number | unique token id (for revocation) |

### Required server / CLI verification order

This UI only **issues** tokens. The verifier (Python server + Go CLI) MUST:

1. Validate the signature against the **JWKS** (select key by `kid`; cache keys
   with a TTL).
2. Check `exp` (and reject if `iss` / `aud` don't match the configured issuer
   and the server's own origin).
3. Reject if `jti` is present in the `revoked_tokens` denylist table.
4. Authorize for team `T` **iff** `memberships` has a row
   `(subject = sub, team_id = T, status = 'active')`.

> `team_ids` / `roles` in the token are **hints only**. The `memberships` table
> (migration `003_simple_auth.sql`) is the **source of truth** for
> authorization. Never authorize off the claim alone.

---

## Environment variables

See `.env.example`. Summary:

| var | required | purpose |
| --- | --- | --- |
| `BETTER_AUTH_URL` | yes | public origin → issuer + JWKS base |
| `BETTER_AUTH_SECRET` | yes | cookie/session secret (`openssl rand -base64 32`) |
| `DATABASE_URL` | yes | Postgres for Better Auth's **own** tables (separate from the aweb server DB) |
| `AWEB_JWT_AUDIENCE` | yes | `aud` stamped on issued tokens = aweb server origin |
| `AWEB_JWT_TTL_SECONDS` | no | access-token lifetime (default 900) |
| `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` | no | GitHub SSO |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | no | Google SSO |
| `AWEB_MEMBERSHIPS_URL` | no | optional endpoint to populate `team_ids`/`roles` hints; if unset the hints are empty and the server still authorizes via `memberships` |

---

## Layout

```
ui/
├── package.json
├── next.config.mjs
├── tsconfig.json
├── .env.example
├── scripts/migrate.mjs
└── src/
    ├── app/
    │   ├── layout.tsx
    │   ├── globals.css
    │   ├── page.tsx                       # redirect → /login or /dashboard
    │   ├── login/page.tsx
    │   ├── dashboard/layout.tsx           # auth guard + team shell
    │   ├── dashboard/page.tsx
    │   └── api/auth/[...all]/route.ts     # Better Auth handler (JWKS lives here)
    ├── components/
    │   ├── login-form.tsx                 # SSO + email/password
    │   ├── topbar.tsx
    │   ├── team-switcher.tsx
    │   └── team-context.tsx               # active-team React context
    └── lib/
        ├── auth.ts                        # Better Auth server (issuer config)
        ├── auth-client.ts                 # browser client
        └── claims.ts                      # resolves team_ids/roles hints
```

## Notes / integration TODOs

- `src/lib/claims.ts` currently emits **empty** `team_ids`/`roles` hints unless
  `AWEB_MEMBERSHIPS_URL` is set. This is safe (server authorizes via
  `memberships`), but the team switcher will be empty until hints are wired.
  Either point `AWEB_MEMBERSHIPS_URL` at a server endpoint that returns a
  subject's active teams, or replace the stub with a direct read-only query of
  the aweb DB `memberships` table.
- Token revocation: a "sign out everywhere" / "revoke token" action should
  insert the token's `jti` into the server's `revoked_tokens` table. That write
  belongs to the server lane; this UI just surfaces the action.
