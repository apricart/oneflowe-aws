import { expect, test, type Page } from "@playwright/test"

import { E2E_PASSWORD } from "./support/environment"
import {
  apiSession,
  approveOrder,
  expectStatus,
  fulfilOrder,
  markDelivered,
  placeOrder,
  post,
  sessionRole,
  signIn,
  testDatabaseUrl,
} from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, tenantNames, type Tenant } from "./support/tenant"

/**
 * The read-only dashboard Viewer (`plans/OF-VIEWER-readonly-dashboard-role.md`).
 *
 * The integration suite proves each endpoint admits or refuses the role. This
 * proves what a person in that role actually gets: Head Office can create one
 * from the Users screen; it lands on its own dashboard, whose six status
 * buckets count the tenant's real orders and open a drill-down; a viewer pinned
 * to a branch sees that branch alone; and every other area of the portal sends
 * it home, while the endpoints refuse it outright.
 */

const KEY = "view"

let tenant: Tenant

function bucket(page: Page, title: string) {
  return page
    .getByRole("region", { name: "Order status" })
    .locator(".glass-card")
    .filter({ has: page.getByText(title, { exact: true }) })
}

async function bucketCount(page: Page, title: string): Promise<string> {
  return (await bucket(page, title).locator("p.font-extrabold").innerText()).trim()
}

test.describe.serial("the read-only Viewer", () => {
  test.beforeAll(async ({ browser }) => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [
        { key: "east", budgetCents: 100_000_000 },
        { key: "west", budgetCents: 100_000_000 },
      ],
      users: [
        { key: "ho", role: "HEAD_OFFICE" },
        { key: "op", role: "ORDER_PORTAL", branch: "east" },
        { key: "ba", role: "BRANCH_ADMIN", branch: "east" },
        { key: "viewer", role: "VIEWER" },
        { key: "pinned", role: "VIEWER", branch: "west" },
      ],
      products: [{ code: "PEN", name: "E2E Viewer Pen", priceCents: 2_000 }],
    })

    // East: one order waiting, one delivered but unacknowledged, one fulfilled.
    const requester = await apiSession(browser, tenant.users.op.username)
    const approver = await apiSession(browser, tenant.users.ba.username)
    const superAdmin = await apiSession(browser, tenant.superAdmin.username)
    try {
      const line = [{ organizationInventoryId: tenant.products.PEN.organizationInventoryId, quantity: 1 }]
      await placeOrder(requester.page, line)

      const delivered = await placeOrder(requester.page, line)
      await approveOrder(approver.page, Number(delivered.id))
      await markDelivered(superAdmin.page, Number(delivered.id))

      const fulfilled = await placeOrder(requester.page, line)
      const token = await approveOrder(approver.page, Number(fulfilled.id))
      await markDelivered(superAdmin.page, Number(fulfilled.id))
      await fulfilOrder(superAdmin.page, Number(fulfilled.id), token)
    } finally {
      await Promise.all([requester.close(), approver.close(), superAdmin.close()])
    }
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("Head Office creates a Viewer from the Users screen", async ({ page }) => {
    test.slow()
    const username = tenantNames(KEY).username("created")
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/users")
    await page.getByRole("button", { name: "Create User" }).first().click()
    const dialog = page.getByRole("dialog", { name: "Create New User" })
    await dialog.getByLabel(/^First Name/).fill("Created")
    await dialog.getByLabel(/^Last Name/).fill("Viewer")
    await dialog.getByLabel(/^Email Address/).fill(`${username}@example.test`)
    await dialog.getByLabel(/^Username/).fill(username)
    await dialog.getByLabel(/^Password/).fill(E2E_PASSWORD)
    await dialog.getByRole("button", { name: "Next" }).click()

    await dialog.getByRole("combobox").filter({ hasText: "Select role" }).click()
    await page.getByRole("option", { name: "Viewer (read-only)" }).click()
    // The branch is optional for a Viewer: unpinned, it watches the whole tenant.
    await expect(dialog.getByText("Branch Assignment (optional)")).toBeVisible()
    await dialog.getByRole("button", { name: "Next" }).click()
    await dialog.getByRole("button", { name: "Create User" }).click()

    await expect.poll(async () => (await queryTestDb<{ role: string; organization_id: number; branch_id: number | null }>(
      testDatabaseUrl(),
      `SELECT r.name AS role, u.organization_id, u.branch_id FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.username = $1`,
      [username],
    ))[0], { timeout: 150_000 }).toEqual({ role: "VIEWER", organization_id: tenant.organizationId, branch_id: null })
  })

  test("a Viewer lands on its dashboard, and the six buckets count the tenant's orders", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.viewer.username, /\/dashboard/)
    expect(await sessionRole(page)).toBe("VIEWER")
    await expect(page.getByText("View only")).toBeVisible({ timeout: 150_000 })

    await expect.poll(() => bucketCount(page, "Pending Approval"), { timeout: 150_000 }).toBe("1")
    expect(await bucketCount(page, "Active")).toBe("1")
    expect(await bucketCount(page, "Delivered, Pending Acknowledgment")).toBe("1")
    expect(await bucketCount(page, "Unfulfilled")).toBe("0")
    expect(await bucketCount(page, "Delivered")).toBe("2")
    expect(await bucketCount(page, "Fulfilled")).toBe("1")

    // A bucket opens its drill-down, with the order behind the number.
    await bucket(page, "Pending Approval").click()
    const sheet = page.getByRole("dialog")
    await expect(sheet).toBeVisible({ timeout: 150_000 })
    await expect(sheet.getByText(/PENDING|Pending/).first()).toBeVisible({ timeout: 150_000 })
  })

  test("a Viewer pinned to a branch sees that branch alone", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.pinned.username, /\/dashboard/)
    await expect(page.getByText("View only")).toBeVisible({ timeout: 150_000 })
    // Every seeded order is at East; the pinned viewer watches West.
    await expect.poll(() => bucketCount(page, "Pending Approval"), { timeout: 150_000 }).toBe("0")
    expect(await bucketCount(page, "Delivered")).toBe("0")
  })

  test("every other area sends a Viewer home, and the endpoints refuse it", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.viewer.username, /\/dashboard/)
    for (const path of ["/orders", "/users", "/budgets", "/inventory", "/support", "/shop"]) {
      await page.goto(path)
      await expect(page, `${path} should send a Viewer home`).toHaveURL(/\/dashboard/, { timeout: 150_000 })
    }

    await expectStatus(await page.request.get("/api/v1/users?limit=1"), 403)
  })

  test("a Viewer pinned to a branch cannot place an order there", async ({ page }) => {
    test.slow()
    // The pinned Viewer carries an organization and a branch on its session —
    // everything the order endpoint needs except the right to order.
    await signIn(page, tenant.users.pinned.username, /\/dashboard/)
    await expectStatus(
      await post(page, "/api/v1/orders", {
        items: [{ organizationInventoryId: tenant.products.PEN.organizationInventoryId, quantity: 1 }],
      }, { "Idempotency-Key": `e2e-view-${Date.now()}` }),
      403,
    )
    const placed = await queryTestDb(
      testDatabaseUrl(),
      "SELECT id FROM orders WHERE branch_id = $1",
      [tenant.branches.west.id],
    )
    expect(placed).toHaveLength(0)
  })
})
