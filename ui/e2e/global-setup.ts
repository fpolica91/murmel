import { execSync } from "node:child_process";

/**
 * Self-seed the E2E account so the suite is fully automated (no human, no
 * pre-existing state). Idempotent:
 *   1. Sign up the test user via Better Auth (tolerate "already exists").
 *   2. Resolve its id from the auth `user` table.
 *   3. Ensure the team + an active admin membership exist (memberships are the
 *      authoritative authz set the aweb server reads).
 *
 * The membership row has no UI/REST creation path yet, so we seed it directly
 * in Postgres — the one infra touch, matching how a real onboarding/admin flow
 * would provision the first team.
 */
const UI = process.env.E2E_UI_URL ?? "http://localhost:3030";
const EMAIL = process.env.E2E_EMAIL ?? "founder@local.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "Test1234!pass";
const TEAM = process.env.E2E_TEAM ?? "default:local";

const PG_BASE = [
  `PGPASSWORD=${process.env.PGPASSWORD ?? "change-me"}`,
  "psql",
  `-h ${process.env.PGHOST ?? "localhost"}`,
  `-p ${process.env.PGPORT ?? "5544"}`,
  `-U ${process.env.PGUSER ?? "aweb"}`,
  `-d ${process.env.PGDATABASE ?? "aweb"}`,
  "-tAc",
].join(" ");

function psql(sql: string): string {
  return execSync(`${PG_BASE} "${sql.replace(/"/g, '\\"')}"`, {
    encoding: "utf8",
  }).trim();
}

export default async function globalSetup(): Promise<void> {
  // 1. Sign up (200 = created; 4xx = already exists — both acceptable).
  try {
    const res = await fetch(`${UI}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Founder" }),
    });
    console.log(`[e2e setup] sign-up ${EMAIL} -> HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[e2e setup] sign-up request failed (continuing): ${String(err)}`);
  }

  // 2. Resolve the user id (auth table is the case-sensitive "user").
  const userId = psql(`SELECT id FROM aweb."user" WHERE email='${EMAIL}' LIMIT 1`);
  if (!userId) {
    throw new Error(`[e2e setup] user ${EMAIL} not found after sign-up — is the UI/DB up?`);
  }

  // 3. Team + active admin membership (idempotent).
  psql(
    `INSERT INTO aweb.teams (team_id, namespace, team_name, team_did_key) ` +
      `VALUES ('${TEAM}','local','default','did:key:zPLACEHOLDER') ` +
      `ON CONFLICT (team_id) DO NOTHING`,
  );
  psql(
    `INSERT INTO aweb.memberships (subject, team_id, role, status) ` +
      `VALUES ('${userId}','${TEAM}','admin','active') ` +
      `ON CONFLICT (subject, team_id) DO UPDATE SET role='admin', status='active'`,
  );

  console.log(`[e2e setup] ready: user=${userId} team=${TEAM} (admin/active)`);
}
