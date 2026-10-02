import { expect, test, type Page, type Response } from "@playwright/test"

import {
  apiSession,
  approveOrder,
  expectStatus,
  fulfilOrder,
  markDelivered,
  placeOrder,
  signIn,
  testDatabaseUrl,
} from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * The reporting screens built over the last month, read by the roles they were
 * built for.
 *
 * - Executive Overview and Product Performance (`plans/OF-EXEC-ANALYTICS-*`,
 *   `plans/OF-REPORTS-product-performance-tab.md`), with the group filter
 *   (`plans/OF-REPORTS-executive-group-filter.md`) and the Excel download
 *   (`plans/OF-EXEC-ANALYTICS-side-by-side-excel-export.md`).
 * - Group User access to the Center (`plans/OF-GROUP-USER-graphical-reports.md`),
 *   narrowed to its own branches.
 * - "Users to review" (`plans/OF-BUDGET-BURN-three-month-pattern-mom-flag.md`):
 *   a requester whose consumption rose month over month is highlighted, and
 *   the panel is Super Admin and Head Office only.
 * - Monthly Product Consumption (`plans/OF-PRODUCT-monthly-consumption-trend.md`).
 *
 * Every figure's arithmetic is pinned by `tests/integration/executive-analytics-api.test.ts`,
 * `budget-burn-api.test.ts` and `product-consumption-trend.test.ts`. What this
 * proves is that the screens load for the right people with the right scope,
 * and that the controls on them — the group filter, the measure, the download —
 * reach the server.
 */

const KEY = "exec"

let tenant: Tenant

function isOverview(response: Response): boolean {
  return response.url().includes("/api/v1/analytics/executive/overview") && response.status() === 200
}

async function overviewBranchNames(response: Response): Promise<string[]> {
  const body = await response.json()
  return (body.branches as Array<{ branchName?: string; name?: string }>).map((row) => String(row.branchName ?? row.name))
}

async function openOverview(page: Page): Promise<string[]> {
  const loaded = page.waitForResponse(isOverview, { timeout: 120_000 })
  await page.goto("/reports/graphical")
  await expect(page.getByRole("heading", { name: "Executive Overview" })).toBeVisible({ timeout: 150_000 })
  return overviewBranchNames(await loaded)
}

test.describe.serial("executive analytics", () => {
  test.beforeAll(async ({ browser }) => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      groups: ["north"],
      branches: [
        { key: "inner", group: "north", budgetCents: 500_000_000 },
        { key: "outer", budgetCents: 500_000_000 },
      ],
      users: [
        { key: "ho", role: "HEAD_OFFICE" },
        { key: "gu", role: "GROUP_USER", groups: ["north"] },
        { key: "ba", role: "BRANCH_ADMIN", branch: "inner" },
        { key: "bao", role: "BRANCH_ADMIN", branch: "outer" },
        { key: "spender", role: "ORDER_PORTAL", branch: "inner", fullName: "E2E Rising Spender" },
        { key: "steady", role: "ORDER_PORTAL", branch: "outer", fullName: "E2E Steady Spender" },
      ],
      products: [
        { code: "DESK", name: "E2E Exec Desk", priceCents: 1_000_000 },
        { code: "LAMP", name: "E2E Exec Lamp", priceCents: 200_000 },
      ],
    })

    const spender = await apiSession(browser, tenant.users.spender.username)
    const steady = await apiSession(browser, tenant.users.steady.username)
    const approver = await apiSession(browser, tenant.users.ba.username)
    const outerApprover = await apiSession(browser, tenant.users.bao.username)
    const superAdmin = await apiSession(browser, tenant.superAdmin.username)
    try {
      const desk = tenant.products.DESK.organizationInventoryId
      const lamp = tenant.products.LAMP.organizationInventoryId

      // Last month: one desk (PKR 10,000). This month: two desks and a lamp —
      // well past the 15% rise from a baseline above PKR 5,000 that highlights.
      const lastMonth = await placeOrder(spender.page, [{ organizationInventoryId: desk, quantity: 1 }])
      await placeOrder(spender.page, [{ organizationInventoryId: desk, quantity: 2 }])
      const fulfilled = await placeOrder(spender.page, [{ organizationInventoryId: lamp, quantity: 1 }])
      const token = await approveOrder(approver.page, Number(fulfilled.id))
      await markDelivered(superAdmin.page, Number(fulfilled.id))
      await fulfilOrder(superAdmin.page, Number(fulfilled.id), token)

      const outer = await placeOrder(steady.page, [{ organizationInventoryId: lamp, quantity: 3 }])
      const outerToken = await approveOrder(outerApprover.page, Number(outer.id))
      await markDelivered(superAdmin.page, Number(outer.id))
      await fulfilOrder(superAdmin.page, Number(outer.id), outerToken)

      // Move the first order to 00:30 on day 1 of the previous Karachi month.
      // Earlier months are cut to the same elapsed day as the current one, so
      // only day 1 is inside last month's column whatever today's date is.
      await queryTestDb(
        testDatabaseUrl(),
        `UPDATE orders
            SET created_at = (date_trunc('month', now() AT TIME ZONE 'Asia/Karachi')
                              - interval '1 month' + interval '30 minutes')
                             AT TIME ZONE 'Asia/Karachi'
          WHERE id = $1`,
        [Number(lastMonth.id)],
      )
    } finally {
      await Promise.all([spender.close(), steady.close(), approver.close(), outerApprover.close(), superAdmin.close()])
    }
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("Head Office reads the Executive Overview across its branches, and the group filter narrows it", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    const names = await openOverview(page)
    expect(names).toEqual(expect.arrayContaining([tenant.branches.inner.name, tenant.branches.outer.name]))

    const narrowed = page.waitForResponse(
      (response) => isOverview(response) && response.url().includes("groupIds"),
      { timeout: 150_000 },
    )
    await page.getByRole("button", { name: /All Groups/ }).click()
    await page.getByRole("checkbox", { name: new RegExp(tenant.groups.north.name, "i") }).check()
    await page.getByRole("button", { name: /Apply Selection/ }).click()
    expect(await overviewBranchNames(await narrowed)).toEqual([tenant.branches.inner.name])
  })

  test("Product Performance compares side by side, switches measure, and downloads the workbook", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/reports/graphical?tab=product-performance")
    await expect(page.getByRole("heading", { name: "Product Performance" })).toBeVisible({ timeout: 150_000 })
    for (const panel of ["By product", "By requester", "By branch", "By month"]) {
      await expect(page.getByText(panel, { exact: true }).first()).toBeVisible({ timeout: 150_000 })
    }

    const measure = page.getByRole("group", { name: "Measure" })
    await measure.getByRole("button", { name: /Quantity/ }).click()
    await expect(measure.getByRole("button", { name: /Quantity/ })).toHaveAttribute("aria-pressed", "true")

    const download = page.waitForEvent("download", { timeout: 150_000 })
    await page.getByRole("button", { name: "Download Excel" }).click()
    expect((await download).suggestedFilename()).toMatch(/^product-performance-quantity-.+\.xlsx$/)
  })

  test("a Group User reads the Center for its own branches only", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.gu.username, /\/dashboard/)
    const names = await openOverview(page)
    expect(names).toEqual([tenant.branches.inner.name])
  })

  test("a Branch Admin is refused by the page and by the endpoint", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ba.username, /\/dashboard/)
    await page.goto("/reports/graphical")
    await expect(page.getByText("Graphical Reports is not available for your role")).toBeVisible({ timeout: 150_000 })
    await expectStatus(await page.request.get("/api/v1/analytics/executive/overview"), 403)
  })

  test("Users to review highlights the requester whose consumption rose month over month", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/reports/user-report")
    await page.getByRole("tab", { name: "Users to review" }).click()

    const row = page.getByRole("row").filter({ hasText: "E2E Rising Spender" })
    await expect(row).toBeVisible({ timeout: 150_000 })
    // Never colour alone: the highlighted cell carries the marker and says so.
    await expect(row.getByLabel(/highlighted/i).first()).toBeVisible()
    await expect(row).toContainText("▲")

    const steadyRow = page.getByRole("row").filter({ hasText: "E2E Steady Spender" })
    await expect(steadyRow).toBeVisible()
    await expect(steadyRow.getByLabel(/highlighted/i)).toHaveCount(0)
  })

  test("a Group User is not offered Users to review, and the endpoint refuses it", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.gu.username, /\/dashboard/)
    await page.goto("/reports/user-report")
    await expect(page.getByRole("tab", { name: "Analytics" })).toBeVisible({ timeout: 150_000 })
    await expect(page.getByRole("tab", { name: "Users to review" })).toHaveCount(0)
    await expectStatus(await page.request.get("/api/v1/analytics/executive/budget-burn"), 403)
  })

  test("the Product Report charts monthly consumption of the products that moved", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/reports/product-performance")
    const card = page.locator("[data-slot=card]").filter({ has: page.getByText("Monthly Product Consumption", { exact: true }) })
    await expect(page.getByText("Monthly Product Consumption", { exact: true })).toBeVisible({ timeout: 150_000 })
    // Only fulfilled units count, so the lamp is charted and the waiting desks are not.
    await expect(card.getByText(tenant.products.LAMP.name).first()).toBeVisible({ timeout: 150_000 })
  })
})
