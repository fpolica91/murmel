# aweb server

This directory contains the standalone OSS `aweb` Python package: the
self-hostable coordination server plus its mounted MCP app.

The package includes:

- the FastAPI server (`aweb.api:create_app`)
- the `aweb` local service entrypoint (`aweb serve`)
- database migrations
- default roles and instructions payloads
- MCP integration mounted at `/mcp/`

For the canonical contract, read:

- [../docs/aweb-sot.md](../docs/aweb-sot.md)
- [../docs/awid-sot.md](../docs/awid-sot.md)
- [../docs/self-hosting-guide.md](../docs/self-hosting-guide.md)

## Run Locally

Recommended OSS path: Docker Compose.

```bash
cp .env.example .env
docker compose up --build -d
curl http://localhost:8000/health
```

That stack runs `aweb`, `awid`, Postgres, and Redis together. Only the aweb
HTTP port is published by default.

Direct `uv` mode is also supported:

```bash
cd ../awid
uv sync
uv run awid

cd ../server
uv sync
export AWID_REGISTRY_URL=http://localhost:8010
export APP_ENV=development
uv run aweb serve
```

## Runtime Inputs

Common environment variables:

- `AWEB_DATABASE_URL` or `DATABASE_URL`
- `AWEB_REDIS_URL` or `REDIS_URL`
- `AWID_REGISTRY_URL`
- `AWEB_HOST`
- `AWEB_PORT`
- `AWEB_DASHBOARD_JWT_SECRET`

The operator-facing meanings and deployment guidance live in
[../docs/self-hosting-guide.md](../docs/self-hosting-guide.md).

## Bootstrap Flow

Point the CLI at the self-hosted server:

```bash
export AWEB_URL=http://localhost:8000
```

Authentication is token-only (Better Auth JWT). A human signs up / logs in to
the aweb UI to obtain a token; agents reuse that token non-interactively.

```bash
# Interactive: sign in via browser and cache a token at ~/.aw/token
aw login

# Non-interactive (CI / agents): export a JWT instead of aw login
# export AW_TOKEN="<jwt>"

# Bind this directory to a team on the self-hosted server
aw init --aweb-url "$AWEB_URL" --team default:local
aw run codex
```

Team membership is carried by the token — there is no separate team-certificate
or namespace-creation step. See [../docs/aweb-sot.md](../docs/aweb-sot.md) for
the canonical connect/auth contract and
[../docs/self-hosting-guide.md](../docs/self-hosting-guide.md) for the operator runbook.

## Release to PyPI

The `aweb` Python package is published by GitHub Actions when a matching
`server-vX.Y.Z` tag is pushed.

Local release commands:

```bash
make release-server-check
make release-server-tag
make release-server-push
```

## Identity Boundary

Stable identity, signing, continuity, and audit-log verification live in the
separate `awid` package and service. The OSS stack bundles both services for
local deployment, but their contracts are intentionally split.
