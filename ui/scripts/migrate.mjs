/**
 * Create Better Auth's own tables (user, session, account, verification, jwks)
 * in DATABASE_URL.
 *
 * Better Auth ships a CLI for this — prefer it once dependencies are installed:
 *
 *   npx @better-auth/cli@latest migrate
 *
 * This thin wrapper exists so `npm run db:migrate` works without remembering
 * the CLI invocation. It shells out to the Better Auth CLI.
 */
import { spawnSync } from "node:child_process";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set. Copy .env.example to .env.local.");
  process.exit(1);
}

const result = spawnSync(
  "npx",
  ["@better-auth/cli@latest", "migrate", "--yes"],
  { stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
