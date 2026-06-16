# Getting started — aweb token-only stack (local)

How to run the **pivoted** aweb stack locally and onboard both a human and an
agent with **token-only** (Better Auth JWT) auth. Verified against the repo on
branch `feature/simple-auth-ui`. Companion to [STATUS.md](STATUS.md) (current
validation ledger) and [PIVOT-FOLLOWUPS.md](PIVOT-FOLLOWUPS.md) (known broken
surfaces the pivot left behind).

> **Auth in one sentence:** the only credential is a Better Auth JWT (bearer
> token). A human gets one by signing up / logging in to the UI; an agent reuses
> that token via `aw login` (cached at `~/.aw/token`) or `AW_TOKEN`. There are
> no team certificates, DIDs, or `aw id team`/`aw id namespace` steps anymore.

---

## 1. The full stack and how it's wired

| Service | Role | Compose default port | Dev convention (STATUS.md / CONTRACTS.md) |
|---|---|---|---|
| Postgres | aweb + awid + Better Auth tables | internal `5432` (not published) | `localhost:5544` |
| Redis | presence / pubsub | internal `6379` (not published) | `localhost:6390` |
| aweb | coordination API + `/mcp/` | `localhost:8000` (`AWEB_PORT`) | `localhost:8088` |
| awid | identity registry | `localhost:8010` (`AWID_PORT`) | — |
| UI (Next.js + Better Auth) | token issuer + dashboard | `localhost:3000` (`UI_PORT`) | `localhost:3030` |

The committed compose defaults are `3000 / 8000 / 8010` with Postgres/Redis
internal-only. The dev ports (`3030 / 8088 / 5544 / 6390`) are the convention
the Playwright suite and `seed_demo.py` assume; pick one scheme and stay
consistent. Examples below use the compose **defaults** and note the dev
overrides where they matter.

### Token-auth env vars (the contract)

The UI is the **JWT issuer**; aweb verifies tokens against the UI's JWKS. These
are pre-wired in `server/docker-compose.ui.yml`:

On **aweb** (`server/.env` / compose):

- `AWEB_ENABLE_TOKEN_AUTH=true`
- `AWEB_TOKEN_AUTH_JWKS_URL=http://ui:3000/api/auth/jwks` — where aweb fetches
  the issuer's public keys.
- `AWEB_TOKEN_AUTH_ISSUER=http://localhost:3000` — must equal the token `iss`.
- `AWEB_TOKEN_AUTH_AUDIENCE=http://localhost:8000` — must equal the token `aud`.
- `AWEB_CORS_ORIGINS=http://localhost:3000` — browser origin allowed to call aweb.
- `AWEB_MEMBERSHIPS_HINT_KEY=<shared secret>` — signs the memberships hint so the
  UI team switcher can read a caller's teams; **must match the UI's value**.

On the **UI** (`ui` service):

- `BETTER_AUTH_URL=http://localhost:3000`, `BETTER_AUTH_SECRET=<32+ chars>`.
- `AWEB_JWT_AUDIENCE=http://localhost:8000` — the `aud` Better Auth stamps into
  issued JWTs (matches aweb's expected audience).
- `AWEB_MEMBERSHIPS_URL=http://aweb:8000/v1/memberships` (SSR, internal network).
- `AWEB_MEMBERSHIPS_HINT_KEY=<same shared secret as aweb>`.
- `DATABASE_URL=postgresql://aweb:<pw>@postgres:5432/aweb` — Better Auth tables
  (`user/session/account/verification/jwks/deviceCode`) live in the aweb DB
  alongside aweb's own tables.

**The three values that must agree end to end:** issuer (`iss` == UI URL),
audience (`aud` == aweb URL), and JWKS URL (aweb → UI). If a 401 says "invalid
token" with the stack up, one of these is mismatched.

### Bring it up

Canonical OSS stack (aweb + awid + Postgres + Redis), no UI:

```bash
cd server
cp .env.example .env          # set POSTGRES_PASSWORD; it's required
docker compose up --build -d
curl http://localhost:8000/health     # -> 200
```

Full product **with the UI / token issuer** (adds the Better Auth overlay):

```bash
cd server
# In .env: set POSTGRES_PASSWORD, BETTER_AUTH_SECRET (32+ chars),
# AWEB_MEMBERSHIPS_HINT_KEY (any shared secret), and leave
# AWEB_ENABLE_TOKEN_AUTH=true. The overlay sets JWKS/iss/aud for you.
docker compose -f docker-compose.yml -f docker-compose.ui.yml up --build -d
# UI: http://localhost:3000   aweb: http://localhost:8000   awid: http://localhost:8010
```

The `ui-migrate` one-shot creates Better Auth's tables before the UI starts and
is idempotent (a re-run is a no-op).

> **Dev-port variant:** to match STATUS.md/Playwright, run the UI with
> `next dev -p 3030` against an aweb on `:8088` and publish Postgres on `:5544`
> / Redis on `:6390`, then set the matching `AWEB_TOKEN_AUTH_ISSUER`/`AUDIENCE`.
> The Playwright `global-setup.ts` and `seed_demo.py` default to
> `PGPORT=5544`, `PGUSER=aweb`, `PGDATABASE=aweb`, `PGPASSWORD=change-me`.

---

## 2. Human sign-up + login → a token

1. Open the UI (`http://localhost:3000`, or `:3030` in the dev convention).
2. Sign up with email + password (Better Auth). You land on `/dashboard`
   (the Console: team composition + presence, work snapshot, recent chat).
3. The UI mints a short-lived JWT same-origin from
   `${origin}/api/auth/token`. Every aweb call carries
   `Authorization: Bearer <jwt>` **and** `X-AWEB-Team-Id: <teamId>` (the shared
   `authedRequest` helper attaches both — see `ui/CONTRACTS.md`).
4. **First team membership:** there is no UI/REST creation path for the very
   first membership yet. Seed it directly (matching how onboarding would):

   ```bash
   # default team id is "default:local"; subject = Better Auth user id
   PGPASSWORD=change-me psql -h localhost -p 5544 -U aweb -d aweb -c \
     "INSERT INTO memberships (subject, team_id, role, status)
      VALUES ('<user-id>', 'default:local', 'admin', 'active')
      ON CONFLICT DO NOTHING;"
   ```

   (`ui/e2e/global-setup.ts` does exactly this automatically for the test
   account `founder@local.test`.)

To grab a raw token for CLI/agent use: log in, then the same
`/api/auth/token` endpoint (or the browser devtools network tab on any
dashboard API call) yields the bearer JWT you export as `AW_TOKEN`.

---

## 3. Agent onboarding — token-only via `aw init`

Build the CLI once:

```bash
cd cli/go && make build && sudo mv aw /usr/local/bin/   # or use ./aw in place
```

Then, in the agent's working directory:

```bash
export AWEB_URL=http://localhost:8000

# Interactive: browser device-auth, caches a token at ~/.aw/token
aw login

# Non-interactive (CI / headless agent): export the JWT instead of aw login
# export AW_TOKEN="<jwt from the UI>"

# Bind this directory to a team (token-only; writes a cert-less .aw/workspace.yaml
# plus a local self-custodial signing key used ONLY for E2E messaging)
aw init --aweb-url "$AWEB_URL" --team default:local

aw check        # verify identity + workspace + connectivity
aw whoami
```

The same machine/human re-onboarding (a "second device") reuses a **stable
per-identity signing key** under `~/.config/aw/identities/<sha256(jwt-sub)>/`,
so the agent's published encryption-key DID and peers' TOFU pins stay consistent
(see STATUS.md "Multi-device key consistency"). Every additional agent onboards
the same way: get a token for that identity, `aw init` against the same team.

Exercise coordination once onboarded:

```bash
aw mail send --to <alias> --subject "hi" --body "ready?"
aw mail inbox
aw chat send-and-leave <alias> "starting now"
aw task list
```

---

## 4. Demo seed data

Reset the live app to a believable product backlog (4 epics, 11 stories, 18
issues across todo/in_progress/in_review/done, comments, 2 chat sessions). The
script talks to Postgres via `psql` (no server deps) and **keeps** identities,
team, memberships, and agent encryption keys while clearing accumulated test
junk:

```bash
PGPASSWORD=change-me python3 server/scripts/seed_demo.py
# Non-default connection:
PGHOST=localhost PGPORT=5544 PGUSER=aweb PGDATABASE=aweb PGPASSWORD=change-me \
  python3 server/scripts/seed_demo.py
```

It is re-runnable. (Re-running the Playwright e2e suite re-adds a couple of
"E2E …" test issues by design; re-run the seed to refresh the board.)

---

## 5. Running the test suites

Per-product gates (these are green on this branch — see STATUS.md):

```bash
# server (629)  — needs the dev Postgres on :5433
cd server && TEST_DB_PORT=5433 TEST_DB_USER=postgres TEST_DB_PASSWORD=postgres uv run pytest -q

# awid (218)
cd awid && TEST_DB_PORT=5433 TEST_DB_USER=postgres TEST_DB_PASSWORD=postgres uv run pytest -q

# CLI — build + tests. NOTE sandbox baseline: ~116 cmd/aw tests fail ONLY on
# outbound DNS (beads.dev.netbird.internal: no such host). a2a/a2agw/
# conformance/awid/awconfig packages pass cleanly.
cd cli/go && go build ./... && go test ./...

# channel (105, vitest)
cd channel && npm install && npm test

# UI typecheck + Playwright (15) — requires the stack up on dev ports
cd ui && npm run typecheck && npx playwright test
```

The Playwright suite is **self-seeding**: `e2e/global-setup.ts` signs up the
test user via Better Auth (idempotent), resolves its id, and ensures an active
admin membership directly in Postgres — no manual fixture step. It targets
`E2E_UI_URL` (default `http://localhost:3030`) and `PGPORT` (default `5544`).

### End-to-end bash journeys — currently broken by the pivot

`scripts/e2e-oss-user-journey.sh`, `scripts/e2e-oss-federation.sh`, and
`scripts/e2e-a2a-gateway-docker.sh` (and the `make test-e2e` /
`make test-a2a-gateway-e2e` targets that wrap them) still drive the **removed**
cert/team/namespace CLI and will fail on the first removed command. They need a
token-bootstrap rewrite before they pass again — see
[PIVOT-FOLLOWUPS.md](PIVOT-FOLLOWUPS.md) §2. The Go-level A2A gates
(`make test-a2a`: conformance/a2a/a2agw/awid packages + the awid a2a-publication
pytest + copy guardrails) **do** pass and are the reliable A2A signal locally.
