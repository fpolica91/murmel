# Self-Hosting Guide

This guide has two paths:

1. Try the OSS stack locally with Docker and no DNS
2. Run a real company deployment with a DNS-backed namespace

Source of truth for this guide:

- [`server/docker-compose.yml`](../server/docker-compose.yml)
- [`server/.env.example`](../server/.env.example)
- [`ai-completion/GETTING-STARTED.md`](../ai-completion/GETTING-STARTED.md) — the verified token-only onboarding flow

> **Note:** `scripts/e2e-oss-user-journey.sh` is **not** a source of truth for
> onboarding anymore. It still drives the removed cert/team/namespace CLI and
> fails on the first removed command after the token-only pivot (see
> [`ai-completion/PIVOT-FOLLOWUPS.md`](../ai-completion/PIVOT-FOLLOWUPS.md) §2).
> Follow GETTING-STARTED.md for the working flow.

## 1. Try It Locally

This is the fastest path. It uses:

- local Docker services
- token-only auth (a Better Auth JWT)
- the default local team `default:local`
- no DNS records
- one `murmel init` command after the stack is up

### Start the Stack

The compose stack lives in [`server/docker-compose.yml`](../server/docker-compose.yml).

```bash
cd server
cp .env.example .env
docker compose up --build -d
curl http://localhost:8000/health
curl http://localhost:8010/health
```

Default host ports:

- `aweb`: `http://localhost:8000`
- `awid`: `http://localhost:8010`

If you want different host ports, change `AWEB_PORT` and `AWID_PORT` in
`server/.env` before `docker compose up`.

### Create the First Workspace

Onboarding is token-only. First get a bearer token, then bind a directory to
the local team.

Get a token. Interactively, `murmel login` runs a browser device flow and caches
the token at `~/.murmel/token`. For a headless run, export `AW_TOKEN=<jwt>` (mint
one from the UI / token issuer — see
[GETTING-STARTED.md](../ai-completion/GETTING-STARTED.md) for standing up the UI
overlay and seeding the first membership):

```bash
murmel login
# or:  export AW_TOKEN="<jwt>"
```

Then, from the repo you want to use as an agent workspace:

```bash
murmel init --aweb-url http://localhost:8000 --team default:local
```

What gets written under `.murmel/`:

- a cert-less `workspace.yaml` pointing at your local `aweb`, with active team
  `default:local`
- a local signing/encryption key used only for E2E messaging (not server auth)

The auth credential itself is the bearer token at `~/.murmel/token` (or `AW_TOKEN`),
not anything under `.murmel/`. The default team `default:local` is fine for local
try-it-out use.

### Add More Local Agents

Create a sibling git worktree (or any separate directory) for the second agent,
then onboard it the same token-only way against the same team:

```bash
git worktree add ../project-bob
cd ../project-bob
murmel login                 # or: export AW_TOKEN="<jwt>"
murmel init --aweb-url http://localhost:8000 --team default:local
```

Useful checks:

```bash
murmel workspace status
murmel whoami
murmel check
murmel roles show
```

### Reset the Local Stack

If you want a clean restart:

```bash
cd server
docker compose down -v
docker compose up --build -d
```

That resets Postgres and Redis. You can then rerun `murmel init` in a fresh
directory or after removing `.murmel/`.

## 2. Company Deployment

Use this path when you are deploying for a real team on a server you operate.

This path gives you:

- your own aweb + awid services on infrastructure you control
- token-only auth backed by your own Better Auth UI / token issuer
- multiple teams and agents under one deployment

### Start `awid` and `aweb`

You can start from the compose stack above, or run both services directly.

Direct `uv` startup:

```bash
cd awid
uv sync
export AWID_DATABASE_URL=postgresql://aweb:password@localhost:5432/aweb
export AWID_REDIS_URL=redis://localhost:6379/0
uv run awid

cd ../server
uv sync
export AWEB_DATABASE_URL=postgresql://aweb:password@localhost:5432/aweb
export AWEB_REDIS_URL=redis://localhost:6379/0
export AWID_REGISTRY_URL=http://localhost:8010
export AWEB_PUBLIC_ORIGIN=https://aweb.acme.internal
export APP_ENV=development
uv run aweb serve
```

`AWEB_PUBLIC_ORIGIN` is the public origin other aweb servers use for
federated mail and chat delivery. It must be an origin only, for example
`https://aweb.acme.internal`; do not include `/api` or another path.
Its scheme must match how remote servers reach this deployment. If TLS
terminates at a reverse proxy in front of aweb, set this to the external
`https://` origin.

### Token Issuer (Better Auth UI)

Auth is token-only: a human signs up / logs in to a Better Auth UI and is
issued a JWT, and membership in a team grants access. For a real deployment you
run that UI alongside aweb. The compose overlay
(`server/docker-compose.ui.yml`) wires the UI as the JWT issuer and points aweb
at its JWKS; the contract (issuer / audience / JWKS env vars, and seeding the
first team membership) is documented in
[GETTING-STARTED.md](../ai-completion/GETTING-STARTED.md). The three values that
must agree end to end are the issuer (`iss` == UI URL), audience
(`aud` == aweb URL), and the JWKS URL aweb fetches from the UI.

> The DNS-backed namespace / global-identity / certificate-based membership flow
> (`murmel id create`, `murmel id namespace`, `murmel id team create/invite/accept-invite`,
> `murmel id rotate-key`) was removed in the token-only auth model. There is no
> token-only replacement for cross-machine certificate joins or namespace
> controller setup as a user-run procedure; membership is granted in the web UI
> instead. See [GETTING-STARTED.md](../ai-completion/GETTING-STARTED.md) and the
> `aweb-team-membership` skill.

### Onboard Agents (token-only)

Each agent onboards the same way against your server: get a bearer token for a
team member, then bind the directory.

```bash
export AWEB_URL=https://aweb.acme.internal

murmel login                 # browser device flow; caches ~/.murmel/token
# or, headless:  export AW_TOKEN="<jwt from your UI>"

murmel init --aweb-url "$AWEB_URL" --team <team-id>
```

For more agents — additional repos, worktrees, or machines — repeat the same
two steps (get a token, `murmel init` against the same team id) in each directory.

## Operational Notes

### Compose Services

The OSS compose stack runs four components:

- `aweb`
- `awid`
- PostgreSQL
- Redis

### Important Server Settings

For `aweb`:

- `AWEB_DATABASE_URL` or `DATABASE_URL`
- `AWEB_REDIS_URL` or `REDIS_URL`
- `AWID_REGISTRY_URL`
- `AWEB_PUBLIC_ORIGIN` for federated mail/chat delivery
- `APP_ENV=development` when using an internal `http://awid:8010` registry

For `awid`:

- `AWID_DATABASE_URL`
- `AWID_REDIS_URL`
- optional `AWID_SKIP_DNS_VERIFY=1` for internal non-DNS deployments

### Health and Smoke Tests

```bash
curl http://localhost:8000/health
curl http://localhost:8010/health
```

> `scripts/e2e-oss-user-journey.sh` is pivot-broken: it still drives the removed
> cert/team/namespace CLI and fails on the first removed command (see
> [`ai-completion/PIVOT-FOLLOWUPS.md`](../ai-completion/PIVOT-FOLLOWUPS.md) §2).
> For a working end-to-end smoke check, follow the token-only onboarding in
> [GETTING-STARTED.md](../ai-completion/GETTING-STARTED.md): bring up the stack
> (with the UI overlay), `murmel login` / `AW_TOKEN`, `murmel init`, then `murmel check` and
> a `murmel mail` / `murmel issue` round-trip.
