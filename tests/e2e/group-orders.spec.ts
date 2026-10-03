import { expect, test } from "@playwright/test"

import {
  apiSession,
  expectStatus,
  placeOrder,
  put,
  signIn,
  testDatabaseUrl,
} from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * One group order, many branches, and the people at each of them.
 *
 * - A Group Order Portal submission is one ordinary order per branch
 *   (`CLAUDE.md`, "Group orders belong to the branch";
 *   `plans/OF-GROUP-ORDER-CROSS-ROLE-VISIBILITY.md`), so each branch's own Branch
 *   Admin and Order Portal user see theirs.
 * - The branch owns its orders (`plans/OF-GROUP-branch-owns-order-writes.md`):
 *   an Order Portal user may edit a pending group order at its branch, and the
 *   raiser is told.
 * - "Other orders" (`plans/OF-GROUP-PORTAL-other-orders-tab.md`,
 *   `plans/OF-GROUP-USER-other-orders-tab.md`): what the branches' own staff
 *   raised, for the group requester and for the group approver.
 *
 * The storefront plan arithmetic and the visibility SQL are in the unit and
 * integration suites. This drives the real multi-branch checkout and follows the
 * orders it creates into every portal that should — and should not — see them.
 */

const KEY = "grp"

let tenant: Tenant

async function readOrders(): Promise<Array<{
  id: number
  tid: string
  branch_id: number
  group_order_id: number | null
  status: string
  created_by_user_id: string
}>> {
  return queryTestDb(
    testDatabaseUrl(),
    `SELECT id, tid, branch_id, group_order_id, status, created_by_user_id
       FROM orders WHERE organization_id = $1 ORDER BY id`,
    [tenant.organizationId],
  )
}

async function groupOrders() {
  return (await readOrders()).filter((order) => order.group_order_id !== null)
}

test.describe.serial("group orders across branches", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      groups: ["ring"],
      branches: [
        { key: "one", group: "ring", budgetCents: 100_000_000 },
        { key: "two", group: "ring", budgetCents: 100_000_000 },
      ],
      users: [
        { key: "gop", role: "GROUP_ORDER_PORTAL", groups: ["ring"] },
        { key: "gu", role: "GROUP_USER", groups: ["ring"] },
        { key: "op1", role: "ORDER_PORTAL", branch: "one" },
        { key: "ba1", role: "BRANCH_ADMIN", branch: "one" },
        { key: "op2", role: "ORDER_PORTAL", branch: "two" },
      ],
      products: [{ code: "WATER", name: "E2E Group Water", priceCents: 8_000 }],
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("the Group Order Portal submits one order for two branches from the storefront", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.gop.username, /\/group-portal/)

    await page.getByRole("checkbox", { name: `Order for ${tenant.branches.one.name}` }).check({ timeout: 150_000 })
    await page.getByRole("checkbox", { name: `Order for ${tenant.branches.two.name}` }).check()

    await page.getByRole("button", { name: /Add .* to cart/ }).first().click()
    await page.getByTitle("Open cart").click()
    await page.getByRole("button", { name: "Review order" }).click()
    await page.getByRole("button", { name: "Submit group order (2)" }).click()

    // The pending-invoice check runs first; with nothing owed it goes straight through.
    await expect(page.getByText("Orders created", { exact: true })).toBeVisible({ timeout: 150_000 })

    const orders = await groupOrders()
    expect(orders).toHaveLength(2)
    expect(new Set(orders.map((order) => order.group_order_id)).size).toBe(1)
    expect(orders.map((order) => order.branch_id).sort()).toEqual(
      [tenant.branches.one.id, tenant.branches.two.id].sort(),
    )
    expect(orders.every((order) => order.status === "PENDING")).toBe(true)
  })

  test("each branch's own Branch Admin and Order Portal user see the order at their branch", async ({ page }) => {
    test.slow()
    const orders = await groupOrders()
    const atOne = orders.find((order) => order.branch_id === tenant.branches.one.id)!
    const atTwo = orders.find((order) => order.branch_id === tenant.branches.two.id)!

    await signIn(page, tenant.users.ba1.username, /\/dashboard/)
    await page.goto("/orders")
    await expect(page.getByText(atOne.tid).first()).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText(atTwo.tid)).toHaveCount(0)
    await page.context().clearCookies()

    // The Order Portal user is narrowed to its own orders — and the group
    // orders at its branch, because they spend its budget.
    await signIn(page, tenant.users.op1.username, /\/shop/)
    const listed = await expectStatus(await page.request.get("/api/v1/orders?limit=50"))
    const tids = (listed.items as Array<{ tid: string }>).map((order) => order.tid)
    expect(tids).toContain(atOne.tid)
    expect(tids).not.toContain(atTwo.tid)
  })

  test("an Order Portal user edits the pending group order at its branch, and the raiser is told", async ({ page }) => {
    test.slow()
    const atOne = (await groupOrders()).find((order) => order.branch_id === tenant.branches.one.id)!
    await signIn(page, tenant.users.op1.username, /\/shop/)
    await expectStatus(await put(page, `/api/v1/orders/${atOne.id}`, {
      items: [{ organizationInventoryId: tenant.products.WATER.organizationInventoryId, quantity: 3 }],
    }))

    const [line] = await queryTestDb<{ quantity: string }>(
      testDatabaseUrl(),
      "SELECT quantity::text AS quantity FROM order_items WHERE order_id = $1",
      [atOne.id],
    )
    expect(Number(line.quantity)).toBe(3)

    // Accountability moved to the trail: the raiser is notified of the change.
    await expect.poll(async () => (await queryTestDb(
      testDatabaseUrl(),
      "SELECT id FROM notifications WHERE user_id = $1",
      [tenant.users.gop.id],
    )).length, { timeout: 150_000 }).toBeGreaterThan(0)

    // Branch two is not op1's branch: the same write is refused there.
    const atTwo = (await groupOrders()).find((order) => order.branch_id === tenant.branches.two.id)!
    const refused = await put(page, `/api/v1/orders/${atTwo.id}`, {
      items: [{ organizationInventoryId: tenant.products.WATER.organizationInventoryId, quantity: 9 }],
    })
    expect([403, 404]).toContain(refused.status())
  })

  test("the group requester's Other orders tab shows what branch staff raised", async ({ page, browser }) => {
    test.slow()
    const staff = await apiSession(browser, tenant.users.op2.username)
    let staffTid: string
    try {
      const order = await placeOrder(staff.page, [
        { organizationInventoryId: tenant.products.WATER.organizationInventoryId, quantity: 1 },
      ])
      staffTid = String(order.tid)
    } finally {
      await staff.close()
    }

    await signIn(page, tenant.users.gop.username, /\/group-portal/)
    await page.getByRole("button", { name: "My group orders" }).click()
    await expect(page.getByText(staffTid)).toHaveCount(0)

    await page.getByRole("button", { name: "Other orders" }).click()
    await expect(page.getByText(staffTid).first()).toBeVisible({ timeout: 150_000 })
  })

  test("the Group User sees staff orders under Other orders and approves the group order", async ({ page }) => {
    test.slow()
    const staffOrder = (await readOrders()).find((order) => order.group_order_id === null)!

    await signIn(page, tenant.users.gu.username, /\/dashboard/)
    await page.goto("/approvals")
    await page.getByRole("tab", { name: "Other orders" }).click()
    await expect(page.getByText(staffOrder.tid).first()).toBeVisible({ timeout: 150_000 })

    await page.getByRole("tab", { name: "By group order" }).click()
    await page.getByRole("button", { name: "Select all pending" }).first().click({ timeout: 150_000 })
    await page.getByRole("button", { name: /^Approve/ }).first().click()
    const confirm = page.getByRole("dialog", { name: "Approve 2 orders" })
    await expect(confirm).toBeVisible()
    await confirm.getByRole("button", { name: /^Approve/ }).click()

    await expect.poll(async () => (await groupOrders()).map((order) => order.status), { timeout: 150_000 })
      .toEqual(["APPROVED", "APPROVED"])
  })
})
