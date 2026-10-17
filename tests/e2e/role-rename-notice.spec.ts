import { expect, test, type Page } from "@playwright/test"

import { E2E_PASSWORD } from "./support/environment"
import { testDatabaseUrl } from "./support/session"
import { destroyTenant, seedTenant, type Tenant } from "./support/tenant"

/**
 * The "role names have changed" notice, through a real sign-in
 * (plans/OF-ROLES-rename-role-display-names.md).
 *
 * The behaviour suite proves what the notice says for each role. This proves
 * what only the browser can: that a sign-in through the login form marks it,
 * that it opens on the landing page of each portal, and that once closed it
 * does not come back on a reload of the same session.
 *
 * This spec signs in with its own form steps rather than `signIn`, which closes
 * the notice automatically for every other journey.
 */

const KEY = "rename-notice"
const NOTICE = "Some role names have changed"
let tenant: Tenant

async function signInThroughForm(page: Page, username: string, landing: RegExp): Promise<void> {
  await page.goto("/login")
  await page.getByLabel("Username or Email").fill(username)
  await page.getByLabel("Password", { exact: true }).fill(E2E_PASSWORD)
  await page.getByRole("button", { name: /sign in/i }).click()
  await expect(page).toHaveURL(landing, { timeout: 150_000 })
}

function renameRows(page: Page) {
  return page.getByRole("dialog", { name: NOTICE }).getByRole("listitem")
}

test.describe.serial("role-rename notice after sign-in", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      organization: { budgetsEnabled: true, orderApprovalRequired: true, orderApproverRole: "BRANCH_ADMIN" },
      groups: ["ring"],
      branches: [{ key: "one", group: "ring", budgetCents: 5_000_000 }],
      users: [
        { key: "ho", role: "HEAD_OFFICE" },
        { key: "ba", role: "BRANCH_ADMIN", branch: "one" },
        { key: "op", role: "ORDER_PORTAL", branch: "one" },
        { key: "gu", role: "GROUP_USER", groups: ["ring"] },
        { key: "gop", role: "GROUP_ORDER_PORTAL", groups: ["ring"] },
      ],
      products: [{ code: "TEA", name: "Rename Notice Tea 1kg", priceCents: 125_000 }],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  const cases = [
    {
      key: "ho",
      landing: /\/dashboard/,
      rows: [
        /Branch Admin\s*is now called\s*Financial Approver/,
        /Order Portal\s*is now called\s*Order Initiator/,
        /Group User\s*is now called\s*Group Financial Approver/,
        /Group Order Portal\s*is now called\s*Group Order Initiator/,
      ],
    },
    {
      key: "ba",
      landing: /\/dashboard/,
      rows: [/Branch Admin\s*is now called\s*Financial Approver/, /Order Portal\s*is now called\s*Order Initiator/],
    },
    {
      key: "op",
      landing: /\/shop/,
      rows: [/Branch Admin\s*is now called\s*Financial Approver/, /Order Portal\s*is now called\s*Order Initiator/],
    },
    {
      key: "gu",
      landing: /\/dashboard/,
      rows: [/Group User\s*is now called\s*Group Financial Approver/, /Group Order Portal\s*is now called\s*Group Order Initiator/],
    },
    {
      key: "gop",
      landing: /\/group-portal/,
      rows: [/Group User\s*is now called\s*Group Financial Approver/, /Group Order Portal\s*is now called\s*Group Order Initiator/],
    },
  ] as const

  for (const { key, landing, rows } of cases) {
    test(`${key}: shown once on the landing page after signing in`, async ({ page }, testInfo) => {
      test.slow()
      await signInThroughForm(page, tenant.users[key].username, landing)

      const notice = page.getByRole("dialog", { name: NOTICE })
      await expect(notice).toBeVisible({ timeout: 60_000 })
      await expect(notice.getByText("This is only a name change.")).toBeVisible()
      await expect(renameRows(page)).toHaveCount(rows.length)
      for (const [index, row] of rows.entries()) {
        await expect(renameRows(page).nth(index)).toHaveText(row)
      }
      await page.screenshot({ path: testInfo.outputPath(`${key}-notice.png`) })

      await notice.getByRole("button", { name: "Got it" }).click()
      await expect(notice).toBeHidden()

      await page.reload()
      await expect(page).toHaveURL(landing, { timeout: 150_000 })
      await page.waitForLoadState("networkidle").catch(() => {})
      await expect(page.getByRole("dialog", { name: NOTICE })).toHaveCount(0)
    })
  }
})
