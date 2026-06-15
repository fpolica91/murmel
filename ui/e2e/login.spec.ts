import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * The whole point of the auth pivot, exercised through a real browser:
 *   - protected routes bounce to /login when unauthenticated
 *   - bad credentials are rejected
 *   - a correct login lands on the team dashboard and the SAME session lets a
 *     human (and, over the API/MCP, an agent) create work on the board.
 *
 * No certificates anywhere — the Better Auth JWT issued to the browser session
 * is what authorizes the aweb server calls the work board makes underneath.
 */
const EMAIL = process.env.E2E_EMAIL ?? "founder@local.test";
const PASSWORD = process.env.E2E_PASSWORD ?? "Test1234!pass";
const ART = "e2e/artifacts";

mkdirSync(ART, { recursive: true });

test.describe("aweb token-only auth — automated browser E2E", () => {
  test("unauthenticated /dashboard redirects to /login", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page).toHaveURL(/\/login/);
    await expect(
      page.getByRole("heading", { name: "Sign in to aweb" }),
    ).toBeVisible();
  });

  test("wrong password is rejected, stays on /login", async ({ page }) => {
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByPlaceholder("Password").fill("WRONGpass123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByText(/invalid|failed|incorrect/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
    await page.screenshot({ path: `${ART}/01-wrong-password.png` });
  });

  test("login → dashboard → create an issue on the work board", async ({
    page,
  }) => {
    // --- log in through the rendered UI ---
    await page.goto("/login");
    await page.getByPlaceholder("you@example.com").fill(EMAIL);
    await page.getByPlaceholder("Password").fill(PASSWORD);
    await page.screenshot({ path: `${ART}/02-login-filled.png` });
    await page.getByRole("button", { name: "Sign in" }).click();

    // --- team dashboard ---
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 15_000 });
    await expect(
      page.getByRole("heading", { name: "Team console" }),
    ).toBeVisible();
    // Team scope is live: the switcher is set to our team and the body echoes it.
    await expect(page.getByRole("combobox")).toHaveValue("default:local");
    await expect(page.getByText(/Active team:/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
    await page.screenshot({ path: `${ART}/03-dashboard.png` });

    // --- create an issue through the board UI (drives aweb REST under the JWT) ---
    await page.goto("/dashboard/work");
    await expect(page.getByRole("heading", { name: "Work" })).toBeVisible();
    const title = `E2E auto issue ${Date.now()}`;
    await page.getByLabel("New issue title").fill(title);
    await page.getByRole("button", { name: "Add issue" }).click();

    // the new issue must render back on the board (round-trips through the server)
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: `${ART}/04-work-board-issue.png`, fullPage: true });
  });
});
