import { expect, test, type Page } from "@playwright/test"

import { openFromSidebar } from "./support/admin-ui"
import { signIn, testDatabaseUrl } from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, tenantNames, type Tenant } from "./support/tenant"

/**
 * Joining an organization from the login page, all the way to a working account
 * (`plans/OF-JOIN-organization-self-service-join.md`).
 *
 * `organization-join-domain.spec.ts` covers the applicant's form and the domain
 * lock up to the moment the request is sent. This covers the rest of the
 * round trip: Head Office sets the code people join with, an applicant uses it,
 * Head Office approves the request — which creates the account there and then —
 * and the applicant signs in with the password they chose, landing in the
 * workspace of the role they asked for.
 */

const KEY = "join"
const JOIN_CODE = "E2E-JOIN-FLOW"
const EMAIL_DOMAIN = "e2e-join.example.test"
const APPLICANT_PASSWORD = "Join-Flow-2026!x"

let tenant: Tenant
const applicantUsername = tenantNames(KEY).username("applicant")

async function readRequests(): Promise<Array<{ status: string; created_user_id: string | null; email: string }>> {
  return queryTestDb(
    testDatabaseUrl(),
    "SELECT status, created_user_id, email FROM organization_join_requests WHERE organization_id = $1",
    [tenant.organizationId],
  )
}

/** Let the join page hydrate before typing, or the code form submits natively. */
async function openJoinPage(page: Page): Promise<void> {
  await page.goto("/join")
  await page.waitForLoadState("networkidle")
}

test.describe.serial("joining an organization", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      organization: { emailDomain: EMAIL_DOMAIN },
      branches: [{ key: "front", budgetCents: 1_000_000 }],
      users: [{ key: "ho", role: "HEAD_OFFICE" }],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("Head Office sets the organization's join code", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await openFromSidebar(page, "Join Requests")
    await expect(page.getByRole("heading", { name: "Join Requests" })).toBeVisible({ timeout: 150_000 })

    await page.getByLabel("Set your organization join code").fill(JOIN_CODE)
    await page.getByRole("button", { name: "Save code" }).click()
    await expect.poll(async () => (await queryTestDb<{ code: string }>(
      testDatabaseUrl(),
      "SELECT code FROM organization_join_codes WHERE organization_id = $1",
      [tenant.organizationId],
    ))[0]?.code, { timeout: 150_000 }).toBe(JOIN_CODE)
  })

  test("an applicant joins with the code from the login page", async ({ browser }) => {
    test.slow()
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await page.goto("/login")
      await page.getByRole("link", { name: "Join an organization" }).click()
      await expect(page).toHaveURL(/\/join/, { timeout: 150_000 })
      await openJoinPage(page)

      await page.getByLabel("Organization join code").fill(JOIN_CODE)
      await page.getByRole("button", { name: "Continue" }).click()
      await expect(page.getByText(`@${EMAIL_DOMAIN}`, { exact: true })).toBeVisible({ timeout: 150_000 })

      await page.getByLabel(/^First name/).fill("Joining")
      await page.getByLabel(/^Last name/).fill("Applicant")
      await page.getByLabel(/^Work email/).fill("joining.applicant")
      await page.getByLabel(/^Username/).fill(applicantUsername)
      await page.getByLabel(/^Password/).fill(APPLICANT_PASSWORD)
      await page.getByLabel(/^Confirm password/).fill(APPLICANT_PASSWORD)
      await page.getByRole("button", { name: "Order Portal User", exact: true }).click()
      await page.getByLabel(/^Branch/).selectOption({ label: tenant.branches.front.name })
      await page.getByRole("button", { name: "Send request" }).click()
      await expect(page.getByRole("heading", { name: "Request sent" })).toBeVisible({ timeout: 150_000 })
    } finally {
      await context.close()
    }

    expect(await readRequests()).toEqual([
      expect.objectContaining({ status: "pending", created_user_id: null, email: `joining.applicant@${EMAIL_DOMAIN}` }),
    ])
  })

  test("Head Office approves the request, which creates the account", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/join-requests")
    const row = page.locator("li").filter({ hasText: "Joining Applicant" })
    await row.getByRole("button", { name: "Review" }).click({ timeout: 150_000 })
    const dialog = page.getByRole("dialog", { name: "Joining Applicant" })
    await expect(dialog.getByText(applicantUsername)).toBeVisible()
    await dialog.getByRole("button", { name: "Approve and create account" }).click()
    await expect(dialog).toBeHidden({ timeout: 150_000 })

    const [request] = await readRequests()
    expect(request.status).toBe("approved")
    const [account] = await queryTestDb<{ role: string; branch_id: number }>(
      testDatabaseUrl(),
      `SELECT r.name AS role, u.branch_id FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`,
      [request.created_user_id],
    )
    expect(account).toEqual({ role: "ORDER_PORTAL", branch_id: tenant.branches.front.id })
  })

  test("the new account signs in with the password the applicant chose", async ({ page }) => {
    test.slow()
    await page.goto("/login")
    await page.getByLabel("Username or Email").fill(applicantUsername)
    await page.getByLabel("Password", { exact: true }).fill(APPLICANT_PASSWORD)
    await page.getByRole("button", { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/shop/, { timeout: 150_000 })
  })
})
