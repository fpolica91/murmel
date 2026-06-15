import { defineConfig, devices } from "@playwright/test";

/**
 * Fully-automated browser E2E for the token-only auth flow. No human, no certs:
 * a real Chromium drives the rendered UI (login → dashboard → work board) and
 * the same Better Auth JWT authorizes the aweb REST/MCP server underneath.
 *
 * Assumes the local stack is up (UI on :3030, aweb on :8088, Postgres on :5544,
 * per docker-compose + `next dev -p 3030`). `global-setup` self-seeds the test
 * account + team membership idempotently, so `npx playwright test` is one shot.
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  outputDir: "./e2e/.trace",
  use: {
    baseURL: process.env.E2E_UI_URL ?? "http://localhost:3030",
    headless: true,
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
