import { createHmac } from "node:crypto"

import { expect, test, type Page } from "@playwright/test"

import { E2E_PASSWORD, e2eNextAuthSecret } from "./support/environment"
import { closeRoleRenameNoticeWhenShown, expectStatus, signIn, testDatabaseUrl } from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * Getting back into an account, two ways.
 *
 * - **Forced change** (`plans/OF-KE-password-change-without-email-verification.md`):
 *   a flagged account is held at `/change-password`, refused by every other
 *   API path, and released only by setting a new password — after which the
 *   old one no longer signs in.
 * - **Self-service reset** (`plans/OF-AUTH-self-service-password-reset.md`):
 *   from the Order Portal's profile menu, a code is emailed, entered, and a new
 *   password set.
 *
 * Neither environment this suite runs in has an email service, so delivery
 * fails closed and the server retires the challenge — exactly as it must when a
 * code reaches nobody. The spec stands in for the mailbox: once the server has
 * done that, it plants a code it knows, computed with the same HMAC the server
 * checks against, and reopens the challenge. Everything after that — the
 * verify step, the reset token, the password write, the sign-in — is the
 * application's own path, untouched.
 */

const KEY = "pwd"
const FORCED_NEW_PASSWORD = "E2E-Forced-Change-2026!"
const RESET_NEW_PASSWORD = "E2E-Self-Reset-2026!"
const KNOWN_CODE = "246810"

let tenant: Tenant

async function signInWith(page: Page, username: string, password: string): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(password)
  await closeRoleRenameNoticeWhenShown(page)
  await page.getByRole("button", { name: /sign in/i }).click()
}

async function mustChangePassword(userId: string): Promise<boolean> {
  const [row] = await queryTestDb<{ flag: boolean }>(
    testDatabaseUrl(),
    "SELECT must_change_password AS flag FROM users WHERE id = $1",
    [userId],
  )
  return row.flag
}

/** Stand in for the inbox: plant a known code on the account's latest challenge. */
async function deliverKnownCode(userId: string): Promise<void> {
  // Wait for the server to finish with the challenge it created — in an
  // environment with no email service, that means retiring it.
  await expect.poll(async () => {
    const [challenge] = await queryTestDb<{ consumed: boolean }>(
      testDatabaseUrl(),
      `SELECT consumed_at IS NOT NULL AS consumed FROM password_reset_challenges
        WHERE subject_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    )
    return challenge?.consumed ?? false
  }, { timeout: 150_000 }).toBe(true)

  const [challenge] = await queryTestDb<{ id: string }>(
    testDatabaseUrl(),
    "SELECT id FROM password_reset_challenges WHERE subject_id = $1 ORDER BY created_at DESC LIMIT 1",
    [userId],
  )
  const digest = createHmac("sha256", e2eNextAuthSecret())
    .update(`oneflowe-password-reset:v1:code:${challenge.id}:${KNOWN_CODE}`)
    .digest("hex")
  await queryTestDb(
    testDatabaseUrl(),
    "UPDATE password_reset_challenges SET code_digest = $2, consumed_at = NULL, attempts = 0 WHERE id = $1",
    [challenge.id, digest],
  )
}

test.describe.serial("password recovery", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [{ key: "main", budgetCents: 10_000_000 }],
      users: [
        { key: "flagged", role: "BRANCH_ADMIN", branch: "main", mustChangePassword: true },
        { key: "op", role: "ORDER_PORTAL", branch: "main" },
      ],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("a flagged account is held at /change-password until it sets a new password", async ({ page }) => {
    test.slow()
    const flagged = tenant.users.flagged
    await signInWith(page, flagged.username, E2E_PASSWORD)
    await expect(page).toHaveURL(/\/change-password/, { timeout: 150_000 })

    // Held there: the dashboard sends it back, and the API refuses it.
    await page.goto("/dashboard")
    await expect(page).toHaveURL(/\/change-password/, { timeout: 150_000 })
    const refused = await expectStatus(await page.request.get("/api/v1/orders?limit=1"), 403)
    expect(refused.code).toBe("PASSWORD_CHANGE_REQUIRED")

    await page.getByRole("textbox", { name: "Current Password" }).fill(E2E_PASSWORD)
    await page.getByRole("textbox", { name: "New Password", exact: true }).fill(FORCED_NEW_PASSWORD)
    await page.getByRole("textbox", { name: "Confirm New Password" }).fill(FORCED_NEW_PASSWORD)
    await page.getByRole("button", { name: "Set New Password" }).click()
    await expect(page).toHaveURL(/\/login/, { timeout: 150_000 })
    expect(await mustChangePassword(flagged.id)).toBe(false)

    // The old password is spent; the new one opens the ordinary workspace.
    await signInWith(page, flagged.username, E2E_PASSWORD)
    await expect(page.getByText(/invalid|incorrect/i).first()).toBeVisible({ timeout: 150_000 })
    await expect(page).toHaveURL(/\/login/)

    await signInWith(page, flagged.username, FORCED_NEW_PASSWORD)
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 150_000 })
  })

  test("an Order Portal user resets a forgotten password from the profile menu", async ({ page }) => {
    test.slow()
    const op = tenant.users.op
    await signIn(page, op.username, /\/shop/)
    await page.getByRole("button", { name: "Open user profile menu" }).click()
    await page.getByRole("menuitem", { name: "Reset password" }).click()
    await expect(page).toHaveURL(/\/forgot-password/, { timeout: 150_000 })
    await expect(page.getByText("Reset your password")).toBeVisible()

    await page.getByLabel("Username or email").fill(op.username)
    await page.getByRole("button", { name: "Send verification code" }).click()
    await expect(page.getByText(/a 6-digit code was sent/)).toBeVisible({ timeout: 150_000 })

    await deliverKnownCode(op.id)

    await page.getByRole("group", { name: "Verification code" }).getByRole("textbox").first().click()
    await page.keyboard.type(KNOWN_CODE)
    await page.getByRole("button", { name: "Verify code" }).click()
    await expect(page.getByText("Email confirmed.", { exact: false })).toBeVisible({ timeout: 150_000 })

    await page.getByRole("textbox", { name: "New password", exact: true }).fill(RESET_NEW_PASSWORD)
    await page.getByRole("textbox", { name: "Confirm new password" }).fill(RESET_NEW_PASSWORD)
    await page.getByRole("button", { name: "Reset password" }).click()
    await expect(page.getByText("Password reset complete")).toBeVisible({ timeout: 150_000 })
    await expect(page).toHaveURL(/\/login/, { timeout: 150_000 })

    await page.context().clearCookies()
    await signInWith(page, op.username, E2E_PASSWORD)
    await expect(page).toHaveURL(/\/login/)
    await expect(page.getByText(/invalid|incorrect/i).first()).toBeVisible({ timeout: 150_000 })

    await signInWith(page, op.username, RESET_NEW_PASSWORD)
    await expect(page).toHaveURL(/\/shop/, { timeout: 150_000 })
  })
})
