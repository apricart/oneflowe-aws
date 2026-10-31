import { expect, test } from "@playwright/test"

import { openFromSidebar } from "./support/admin-ui"
import { apiSession, approveOrder, placeOrder, signIn, testDatabaseUrl } from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * The direct channel between portal users and Apricart
 * (`plans/OF-SUPPORT-portal-to-apricart-threads.md`, with the order search,
 * product reference and shell/KPI refinements).
 *
 * The access rules and the row-locked transitions are in
 * `tests/integration/support-threads-api.test.ts`. This is the conversation as
 * people have it: an Order Portal user raises a query from an invoice, citing
 * the order and a product; a colleague at the branch cannot see it but the
 * Branch Admin can; Apricart finds it in the queue by the order's reference,
 * replies and resolves it; and the requester reads the reply.
 */

const KEY = "sup"
const SUBJECT = "E2E invoice total does not match the delivery"
const REPLY = "We have corrected the invoice and re-issued it."

let tenant: Tenant
let order: { id: number; tid: string }

async function readThreads(): Promise<Array<{ id: number; status: string; order_id: number | null; product_code: string | null }>> {
  return queryTestDb(
    testDatabaseUrl(),
    `SELECT t.id, t.status, t.order_id, gp.product_code
       FROM support_threads t LEFT JOIN global_products gp ON gp.id = t.product_id
      WHERE t.organization_id = $1 ORDER BY t.id`,
    [tenant.organizationId],
  )
}

test.describe.serial("support threads", () => {
  test.beforeAll(async ({ browser }) => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [{ key: "main", budgetCents: 10_000_000 }],
      users: [
        { key: "op", role: "ORDER_PORTAL", branch: "main" },
        { key: "colleague", role: "ORDER_PORTAL", branch: "main" },
        { key: "ba", role: "BRANCH_ADMIN", branch: "main" },
      ],
      products: [{ code: "TONER", name: "E2E Support Toner", priceCents: 30_000 }],
    })
    // An approved order, so it has an invoice to raise the query from.
    const requester = await apiSession(browser, tenant.users.op.username)
    const approver = await apiSession(browser, tenant.users.ba.username)
    try {
      const placed = await placeOrder(requester.page, [
        { organizationInventoryId: tenant.products.TONER.organizationInventoryId, quantity: 2 },
      ])
      order = { id: Number(placed.id), tid: String(placed.tid) }
      await approveOrder(approver.page, order.id)
    } finally {
      await requester.close()
      await approver.close()
    }
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("an Order Portal user raises a query from an invoice, citing the order and a product", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.op.username, /\/shop/)
    await page.goto(`/invoices/${order.id}`)
    await page.getByRole("link", { name: "Raise a Query" }).click()

    const dialog = page.getByRole("dialog", { name: "Raise a query with Apricart" })
    await expect(dialog).toBeVisible({ timeout: 150_000 })
    // The deep link names the order the query is about.
    await expect(dialog.getByText(/^About order /)).toBeVisible()
    await dialog.getByLabel("Subject").fill(SUBJECT)

    // An order query must name the product it is about.
    await dialog.getByRole("combobox", { name: /^Product/ }).click()
    await dialog.getByPlaceholder("Search by code or name").fill(tenant.products.TONER.productCode)
    await page.getByRole("listbox", { name: "Matching products" })
      .getByRole("option", { name: new RegExp(tenant.products.TONER.productCode) })
      .click()
    await dialog.getByLabel("What has happened?").fill("Two toners were invoiced, one arrived.")
    await dialog.getByRole("button", { name: "Send to Apricart" }).click()

    await expect(page).toHaveURL(/\/support\/\d+$/, { timeout: 150_000 })
    await expect(page.getByText(SUBJECT).first()).toBeVisible()
    await expect(page.getByText("About order")).toBeVisible()
    await expect(page.getByText("About product")).toBeVisible()

    expect(await readThreads()).toEqual([
      expect.objectContaining({
        status: "OPEN",
        order_id: order.id,
        product_code: tenant.products.TONER.productCode,
      }),
    ])
  })

  test("a colleague does not see it, and the Branch Admin does", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.colleague.username, /\/shop/)
    await page.goto("/support")
    await expect(page.getByText("Nothing here yet")).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText(SUBJECT)).toHaveCount(0)
    await page.context().clearCookies()

    await signIn(page, tenant.users.ba.username, /\/dashboard/)
    await openFromSidebar(page, "Support")
    await expect(page.getByText(SUBJECT)).toBeVisible({ timeout: 150_000 })
  })

  test("Apricart finds it by the order reference, replies, and resolves it", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await page.goto("/support")
    await expect(page.getByRole("heading", { name: "Support queue" })).toBeVisible({ timeout: 150_000 })
    await expect(page.getByRole("region", { name: "Support summary" })).toBeVisible()

    await page.getByPlaceholder("Search by order or transaction ID").fill(order.tid)
    const row = page.getByRole("link").filter({ hasText: SUBJECT })
    await expect(row).toBeVisible({ timeout: 150_000 })
    await row.click()
    await expect(page).toHaveURL(/\/support\/\d+$/, { timeout: 150_000 })

    await page.getByPlaceholder("Reply to the customer…").fill(REPLY)
    await page.getByRole("button", { name: "Send reply" }).click()
    await expect(page.getByText(REPLY)).toBeVisible({ timeout: 150_000 })
    await expect.poll(async () => (await queryTestDb<{ side: string }>(
      testDatabaseUrl(),
      `SELECT m.author_side AS side FROM support_messages m
         JOIN support_threads t ON t.id = m.thread_id
        WHERE t.organization_id = $1 AND m.body = $2`,
      [tenant.organizationId, REPLY],
    )).map((row) => row.side), { timeout: 150_000 }).toEqual(["APRICART"])
    await page.getByRole("button", { name: "Mark resolved" }).click()
    await expect(page.getByText("Request marked resolved").first()).toBeVisible({ timeout: 150_000 })

    await expect.poll(async () => (await readThreads())[0]?.status, { timeout: 150_000 }).toBe("RESOLVED")
  })

  test("the requester reads Apricart's reply on the resolved request", async ({ page }) => {
    test.slow()
    const [thread] = await readThreads()
    await signIn(page, tenant.users.op.username, /\/shop/)
    await page.goto(`/support/${thread.id}`)
    await expect(page.getByText(REPLY)).toBeVisible({ timeout: 150_000 })
    // Signed by the Apricart person who answered.
    await expect(page.getByText(`E2E ${KEY} Super Admin`).first()).toBeVisible()
  })
})
