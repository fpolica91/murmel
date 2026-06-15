# Running the integrated stack (server + UI + auth)

How to stand up the full simplified-auth product locally: the aweb server, the
awid registry, Postgres/Redis, and the Next.js UI that is the Better Auth **JWT
issuer**. This is the exact wiring verified end-to-end (browser login → Work
board loads issues created via the API/MCP).

## Quickest path: one command

The whole product — server, awid, Postgres, Redis, **and the UI** (Better Auth
issuer), all wired — comes up with one command via the opt-in overlay:

```bash
cd server
cp .env.example .env            # set POSTGRES_PASSWORD (+ BETTER_AUTH_SECRET / AWEB_MEMBERSHIPS_HINT_KEY for non-local)
docker compose -f docker-compose.yml -f docker-compose.ui.yml up --build -d
# open http://localhost:3000  (sign up, then have an admin add your membership)
```

The overlay (`docker-compose.ui.yml`) runs Better Auth's migration as a one-shot
`ui-migrate` service, starts the `ui` service, and wires the server's token-auth
+ CORS to it (JWKS fetched internally at `ui:3000`; `iss`/`aud` are the
browser-facing URLs). The sections below explain the same wiring for running the
pieces by hand.

Two planes:

- **Issuer plane** — the Next.js app (`ui/`) runs Better Auth, holds the signing
  key, serves JWKS, and mints EdDSA JWTs.
- **Verifier plane** — the aweb server and `aw` CLI verify those JWTs against the
  issuer's JWKS and authorize via the `memberships` table. They never sign.

## 1. Start the backend stack

```bash
cd server
cp .env.example .env
docker compose up --build -d
curl localhost:8000/health   # {"status":"ok",...}
```

**Gotcha — leaked registry URL.** If a shell env exports
`AWID_REGISTRY_URL`/`AWEB_URL` (e.g. an internal host), it overrides compose and
the `aweb` container crash-loops on "Failed to reach AWID registry". Pin it:

```bash
AWID_REGISTRY_URL=http://awid:8010 AWID_PUBLIC_REGISTRY_URL=http://awid:8010 \
  docker compose up -d aweb
```

## 2. Better Auth database

Better Auth keeps its own tables (`user`, `session`, `account`, `verification`,
`jwks`) in a **separate** database from aweb.

```bash
# Any reachable Postgres with a superuser works; e.g. a throwaway:
docker run -d --name aweb-testdb -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_USER=postgres -p 5433:5432 postgres:16-alpine
docker exec aweb-testdb psql -U postgres -c "CREATE DATABASE aweb_auth;"

cd ui
cp .env.example .env.local        # then fill in the values below
npm install
npm run db:migrate                # creates Better Auth tables (needs DATABASE_URL exported)
```

`ui/.env.local`:

```
BETTER_AUTH_URL=http://localhost:3000
BETTER_AUTH_SECRET=<openssl rand -hex 32>
DATABASE_URL=postgres://postgres:postgres@localhost:5433/aweb_auth
AWEB_JWT_AUDIENCE=http://localhost:8000
AWEB_MEMBERSHIPS_URL=http://localhost:8000/v1/memberships
AWEB_MEMBERSHIPS_HINT_KEY=<shared secret, see step 4>
```

## 3. Run the UI

```bash
cd ui
npm run build && npm run start    # production on :3000
# or: npm run dev                 # dev on :3000
```

**Deploy as a container.** `ui/Dockerfile` builds a lean Next.js standalone
image (no secrets needed at build time). Supply the runtime env at `docker run`:

```bash
docker build -t aweb-ui ui
docker run -p 3000:3000 \
  -e BETTER_AUTH_URL=https://your-ui-host \
  -e BETTER_AUTH_SECRET=... -e DATABASE_URL=postgres://... \
  -e AWEB_JWT_AUDIENCE=https://your-aweb-host \
  -e AWEB_MEMBERSHIPS_URL=https://your-aweb-host/v1/memberships \
  -e AWEB_MEMBERSHIPS_HINT_KEY=... \
  aweb-ui
```

**Gotcha — stale `.next`.** Running `npm run build` (production) and then
`npm run dev` (or vice versa) leaves a `.next` whose chunks the other mode
404s → the page renders but **never hydrates** (forms do native submits). If
that happens: `rm -rf ui/.next` and restart in one mode only.

Verify the issuer:

```bash
curl localhost:3000/api/auth/jwks   # populates after the first token is minted
```

## 4. Point the verifiers at the issuer

Restart `aweb` with the token-auth + CORS + hint env. Inside Docker the
container reaches the host-run UI via `host.docker.internal`:

```bash
cd server
AWID_REGISTRY_URL=http://awid:8010 AWID_PUBLIC_REGISTRY_URL=http://awid:8010 \
AWEB_ENABLE_TOKEN_AUTH=true \
AWEB_TOKEN_AUTH_JWKS_URL=http://host.docker.internal:3000/api/auth/jwks \
AWEB_TOKEN_AUTH_ISSUER=http://localhost:3000 \
AWEB_TOKEN_AUTH_AUDIENCE=http://localhost:8000 \
AWEB_CORS_ORIGINS=http://localhost:3000 \
AWEB_MEMBERSHIPS_HINT_KEY=<same secret as ui/.env.local> \
  docker compose up -d aweb
```

| Env var | Plane | Purpose |
| --- | --- | --- |
| `AWEB_TOKEN_AUTH_JWKS_URL` | server | where to fetch the issuer's public keys |
| `AWEB_TOKEN_AUTH_ISSUER` / `_AUDIENCE` | server | enforce `iss`/`aud` (optional but recommended) |
| `AWEB_CORS_ORIGINS` | server | allow the browser at `:3000` to call the API |
| `AWEB_MEMBERSHIPS_HINT_KEY` | both | shared secret for `/v1/memberships` (UI team switcher) |

Algorithm note: Better Auth defaults to **EdDSA**; the server accepts
RS256/ES256/EdDSA and selects the key by `kid` from the JWKS.

## 5. Seed a team + membership

Authorization is the `memberships` table (the JWT `team_ids` claim is only a
hint). After a user signs up in the browser, grab their Better Auth user id and:

```bash
docker compose exec -T postgres psql -U aweb -d aweb -c \
 "INSERT INTO aweb.teams (team_id, namespace, team_name, team_did_key)
  VALUES ('default:local','local','default','did:key:zSEED') ON CONFLICT DO NOTHING;
  INSERT INTO aweb.memberships (subject, team_id, role, status)
  VALUES ('<better-auth-user-id>','default:local','member','active') ON CONFLICT DO NOTHING;"
```

## 6. Use it

Open <http://localhost:3000> → sign in → the team switcher shows the seeded
team → **Work** loads the Epic→Story→Issue board, reading the same issues agents
create over the REST/MCP API.

## Tests

```bash
# server (needs a superuser Postgres for pgdbm fixtures; defaults to postgres/postgres@localhost:5432)
cd server && TEST_DB_HOST=localhost TEST_DB_PORT=5433 TEST_DB_USER=postgres \
  TEST_DB_PASSWORD=postgres uv run pytest -q
cd cli/go && env -u AWEB_URL -u AWID_REGISTRY_URL go test ./...   # unset the leaked vars
cd ui && npm run typecheck && npm run build
```

## Known remaining work

- **`aw login` (CLI device flow) — WORKING.** Implemented and verified
  end-to-end. The UI enables the `deviceAuthorization` + `bearer` plugins and
  serves a `/device` approval page; the CLI runs the RFC 8628 device flow
  (JSON bodies), gets a Better Auth **session** token, then exchanges it for a
  JWT via `GET /api/auth/token` (Bearer = session, enabled by the `bearer`
  plugin) and caches the JWT (session kept as the refresh credential). Run:
  ```bash
  cd ui && npm run db:migrate    # adds the deviceCode table (one-time)
  aw login --issuer http://localhost:3000/api/auth
  # open the printed /device?user_code=... URL, approve while signed in
  ```
  The cached JWT at `~/.aw/token` authorizes against aweb (verified: created an
  issue → 201). **Auto-attach is wired:** the awid client takes an injected
  bearer provider (`SetBearerProvider`); the command layer installs one
  (`bearerTokenProvider` → `LoadValidToken` + a refresher that re-mints from the
  cached session at `/api/auth/token`). When a workspace resolves but has no
  team certificate, `resolveClientSelection` falls back to a bearer client, so
  `aw` commands auto-attach + auto-refresh the token (and send `X-AWEB-Team-Id`).
  The cert path is unchanged. `resolveClient` also falls back to a bearer client
  (base URL from `AWEB_URL`) for a fully workspace-less user. **Caveat:** many
  commands (e.g. `aw task list`) resolve via `resolveClientSelection`, which
  requires a `.aw/` workspace and errors before the bearer fallback. Full
  workspace-less support is a broader change — decoupling those commands from
  the workspace `Selection` so they can run on a bearer token + `AWEB_URL`
  alone. The realistic bearer scenario (a joined team with a workspace but no
  certificate) is already covered by the `resolveClientSelection` fallback.
- **Multi-team `X-AWEB-Team-Id`.** The UI API client sends the bearer token but
  not the team header; single-team users work via the server's sole-membership
  fallback. Multi-team users need the active team threaded from the team-context
  into the client and sent as `X-AWEB-Team-Id`.
- **E4 cutover.** The team-certificate auth path remains, additive, alongside
  token auth. Removing it is a separate planned step.
