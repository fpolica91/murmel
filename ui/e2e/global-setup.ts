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

/**
 * Sign up a user (idempotent — "already exists" is fine), resolve its id, and
 * ensure an active membership on the team. Returns the resolved user id so the
 * caller can post-process the participant row (e.g. mark an account as an agent).
 */
async function ensureUser(
  email: string,
  name: string,
  role: "admin" | "member",
): Promise<string> {
  try {
    const res = await fetch(`${UI}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD, name }),
    });
    console.log(`[e2e setup] sign-up ${email} -> HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[e2e setup] sign-up ${email} failed (continuing): ${String(err)}`);
  }
  const userId = psql(`SELECT id FROM aweb."user" WHERE email='${email}' LIMIT 1`);
  if (!userId) {
    throw new Error(`[e2e setup] user ${email} not found after sign-up — is the UI/DB up?`);
  }
  psql(
    `INSERT INTO aweb.memberships (subject, team_id, role, status) ` +
      `VALUES ('${userId}','${TEAM}','${role}','active') ` +
      `ON CONFLICT (subject, team_id) DO UPDATE SET role='${role}', status='active'`,
  );
  // Trigger human-participant provisioning by minting a JWT and hitting an
  // authed endpoint (the provisioning funnel upserts the agents row).
  try {
    const signin = await fetch(`${UI}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: PASSWORD }),
    });
    const cookie = (signin.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");
    const tokRes = await fetch(`${UI}/api/auth/token`, {
      headers: { accept: "application/json", cookie },
    });
    const tok = (await tokRes.json()) as { token?: string };
    if (tok.token) {
      await fetch(`${process.env.E2E_AWEB_URL ?? "http://localhost:8088"}/v1/participants`, {
        headers: { Authorization: `Bearer ${tok.token}`, "X-AWEB-Team-Id": TEAM },
      });
    }
  } catch (err) {
    console.warn(`[e2e setup] provision ${email} failed (continuing): ${String(err)}`);
  }
  return userId;
}

export default async function globalSetup(): Promise<void> {
  // Team must exist first (memberships FK).
  psql(
    `INSERT INTO aweb.teams (team_id, namespace, team_name, team_did_key) ` +
      `VALUES ('${TEAM}','local','default','did:key:zPLACEHOLDER') ` +
      `ON CONFLICT (team_id) DO NOTHING`,
  );

  // Two humans: founder (admin) + mia (member).
  const founderId = await ensureUser(EMAIL, "Founder", "admin");
  await ensureUser("mia@local.test", "Mia", "member");

  // Two agents: ada + bob. They onboard the same way (sign up + membership +
  // first authenticated request), then their participant rows are marked
  // agent_type='agent' (the participant/agents path) so the directory reports
  // kind='agent'. The provisioning upsert never overwrites agent_type, so this
  // sticks across re-auth.
  const adaId = await ensureUser("ada@local.test", "Ada (agent)", "member");
  const bobId = await ensureUser("bob@local.test", "Bob (agent)", "member");
  psql(
    `UPDATE aweb.agents SET agent_type='agent', human_name='Ada AI', role='engineer' ` +
      `WHERE did_key='did:key:jwt-${adaId}' AND deleted_at IS NULL`,
  );
  psql(
    `UPDATE aweb.agents SET agent_type='agent', human_name='Bob AI', role='reviewer' ` +
      `WHERE did_key='did:key:jwt-${bobId}' AND deleted_at IS NULL`,
  );

  console.log(
    `[e2e setup] ready: founder=${founderId} + mia (humans), ada/bob (agents) on ${TEAM}`,
  );
}
