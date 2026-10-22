import { randomUUID } from "node:crypto"

import bcrypt from "bcryptjs"
import { eq } from "drizzle-orm"
import { expect, test, type Locator, type Page } from "@playwright/test"

import { apricartExecutiveAssignments, globalProducts, orderDeskAssignments, roles, users } from "../../db/schema"
import { splitInclusiveCents } from "../../lib/tax"

import { E2E_PASSWORD } from "./support/environment"
import { sessionRole, signIn, testDatabaseUrl } from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, tenantNames, withTenantDb, type Tenant } from "./support/tenant"

/**
 * The Order Desk prices an order and an Apricart Executive approves it — the
 * whole conversation between the two, in the browser
 * (plans/OF-ORDER-DESK-line-price-entry.md,
 * plans/OF-ORDER-DESK-assigned-reach-global-catalogue-budget-exemption.md,
 * plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md).
 *
 *   1. The desk keys in an order for its assigned customer: a product the
 *      branch carries, at a price below the branch's own, and an Apricart
 *      product the branch does not carry. Every price box starts empty and the
 *      order cannot be sent until each is filled with a price above zero. The
 *      branch's budget is far smaller than the order, which goes through
 *      anyway, because a desk order takes no budget.
 *   2. The executive sees each typed price beside the branch's catalogue price,
 *      sees which product the branch does not carry, and sends the order back:
 *      one price was wrong.
 *   3. The desk reads why, corrects the price and resubmits.
 *   4. The executive approves the corrected total, and the desk sees the order
 *      Active at the agreed prices.
 *
 * Every refusal behind these screens — other roles, other tenants, malformed
 * prices, races — is proved against the real routes in
 * `tests/integration/order-desk-api.test.ts` and
 * `tests/integration/executive-desk-approval-api.test.ts`. The customer's
 * screenshot upload needs object storage this environment does not have: its
 * audit row is staged and the browser's upload call answered with its key, as
 * `order-desk.spec.ts` does.
 */

const KEY = "dprice"
const names = tenantNames(KEY)
const AGENT = names.username("agent")
const EXECUTIVE = names.username("exec")
const REFERENCE = "E2E priced order, WhatsApp 11:05"

/** Carried by the branch at Rs 15.00 a piece. */
const RICE = "E2E Priced Rice"
/** An Apricart product the customer has never been given; base price Rs 99.99, taxed at 18%. */
const GLOVES = "E2E Priced Gloves"
const GLOVES_BASE_PRICE_CENTS = 9_999

/** The branch can spend only Rs 10.00 — far less than any order below. */
const BRANCH_BUDGET_CENTS = 1_000
/** The desk's tab for approved orders not yet delivered. */
const DESK_AWAITING_DELIVERY = "Awaiting delivery"

const priceLabel = (product: string, unit: string) => `Price per ${unit} of ${product}, in rupees including tax`

let tenant: Tenant
let agentId: string
let executiveId: string
let glovesId: number

type OrderRow = {
  id: number
  tid: string
  status: string
  approved_by_user_id: string | null
  returned_for_correction_at: Date | null
  correction_request_note: string | null
  budget_tracked: boolean
  subtotal_cents: string
  tax_cents: string
  total_cents: string
}

type LineRow = {
  product_name: string
  global_product_id: number
  organization_inventory_id: number | null
  quantity: string
  price_cents: string
  price_entered_manually: boolean
  catalogue_price_cents: string | null
  tax_rate_bp: number | null
  tax_cents: string
}

async function theOrder(): Promise<OrderRow> {
  const rows = await queryTestDb<OrderRow>(
    testDatabaseUrl(),
    `SELECT id, tid, status, approved_by_user_id, returned_for_correction_at, correction_request_note,
            budget_tracked, subtotal_cents::text, tax_cents::text, total_cents::text
       FROM orders WHERE organization_id = $1 AND created_by_role = 'ORDER_DESK' ORDER BY id`,
    [tenant.organizationId],
  )
  expect(rows, "exactly one desk order").toHaveLength(1)
  return rows[0]
}

async function linesOf(orderId: number): Promise<Map<string, LineRow>> {
  const rows = await queryTestDb<LineRow>(
    testDatabaseUrl(),
    `SELECT product_name, global_product_id, organization_inventory_id, quantity::text, price_cents::text,
            price_entered_manually, catalogue_price_cents::text, tax_rate_bp, tax_cents::text
       FROM order_items WHERE order_id = $1`,
    [orderId],
  )
  return new Map(rows.map((row) => [row.product_name, row]))
}

async function budgetAtMain(): Promise<{ held: number; spent: number; rows: number }> {
  const rows = await queryTestDb<{ held: string; spent: string }>(
    testDatabaseUrl(),
    "SELECT amount_held_cents::text AS held, amount_spent_cents::text AS spent FROM budgets WHERE branch_id = $1",
    [tenant.branches.main.id],
  )
  return {
    held: rows.reduce((sum, row) => sum + Number(row.held), 0),
    spent: rows.reduce((sum, row) => sum + Number(row.spent), 0),
    rows: rows.length,
  }
}

/** The screenshot as the upload route leaves it: the audit row binding a fresh key to the agent. */
async function stageScreenshot(): Promise<string> {
  const key = `order-intake/${randomUUID()}.png`
  await queryTestDb(
    testDatabaseUrl(),
    "INSERT INTO audit_logs (user_id, action, entity, entity_id) VALUES ($1, 'UPLOAD_ORDER_INTAKE_ATTACHMENT', 'image', $2)",
    [agentId, key],
  )
  return key
}

/** A 1×1 PNG, for the screenshot picker. */
const SCREENSHOT_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
)

async function createStaffAccount(role: "ORDER_DESK" | "APRICART_EXECUTIVE", username: string, fullName: string): Promise<string> {
  return withTenantDb(testDatabaseUrl(), async (db) => {
    const [roleRow] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, role)).limit(1)
    const [first, ...rest] = fullName.split(" ")
    const [user] = await db.insert(users).values({
      email: `${username}@example.test`,
      username,
      passwordHash: await bcrypt.hash(E2E_PASSWORD, 10),
      roleId: roleRow.id,
      organizationId: null,
      branchId: null,
      fullName,
      firstName: first,
      lastName: rest.join(" "),
      isActive: true,
      mfaEnabled: false,
      mustChangePassword: false,
    }).returning({ id: users.id })
    return user.id
  })
}

/**
 * Open a workspace tab. On a cold development server the first click can land
 * before the page has hydrated and is lost, so the click is repeated until the
 * tab's own content shows.
 */
async function openWorkspaceTab(page: Page, tab: RegExp, content: Locator): Promise<void> {
  await expect(async () => {
    await page.getByRole("tab", { name: tab }).click()
    await expect(content).toBeVisible({ timeout: 10_000 })
  }).toPass({ timeout: 150_000 })
}

async function openExecutiveApprovals(page: Page): Promise<void> {
  await signIn(page, EXECUTIVE, /\/executive/)
  expect(await sessionRole(page)).toBe("APRICART_EXECUTIVE")
  await openWorkspaceTab(page, /Approvals/, page.getByRole("tablist", { name: "Approval status" }))
}

async function openDeskOrders(page: Page): Promise<void> {
  await signIn(page, AGENT, /\/order-desk/)
  expect(await sessionRole(page)).toBe("ORDER_DESK")
  await openWorkspaceTab(page, /Orders/, page.getByRole("tablist", { name: "Order status" }))
}

function orderCard(page: Page): Locator {
  return page.getByRole("article").filter({ hasText: REFERENCE })
}

function lineRow(card: Locator, product: string): Locator {
  return card.getByRole("row").filter({ hasText: product })
}

test.describe.serial("the Order Desk prices an order and an Apricart Executive approves it", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      // Budgets on, and the tenant's own approval switch on: neither applies to a desk order.
      organization: { managedOrdering: true, orderApprovalRequired: true, budgetsEnabled: true },
      branches: [{ key: "main", budgetCents: BRANCH_BUDGET_CENTS }],
      users: [{ key: "ho", role: "HEAD_OFFICE" }],
      products: [{ code: "RICE", name: RICE, priceCents: 1_500, stock: 1_000 }],
    })

    // An Apricart product this customer has never been given. The product
    // code carries the tenant's prefix, so the teardown removes it with them.
    glovesId = await withTenantDb(testDatabaseUrl(), async (db) => {
      const [product] = await db.insert(globalProducts).values({
        productCode: `${names.productPrefix}GLOVES`,
        name: GLOVES,
        basePrice: GLOVES_BASE_PRICE_CENTS,
        stockQuantity: 500,
        unit: "pair",
        taxRateBp: 1_800,
        status: "active",
        createdByUserId: tenant.superAdmin.id,
      }).returning({ id: globalProducts.id })
      return product.id
    })

    agentId = await createStaffAccount("ORDER_DESK", AGENT, "E2E Pricing Desk")
    executiveId = await createStaffAccount("APRICART_EXECUTIVE", EXECUTIVE, "E2E Pricing Executive")
    await withTenantDb(testDatabaseUrl(), async (db) => {
      await db.insert(orderDeskAssignments).values({
        userId: agentId,
        organizationId: tenant.organizationId,
        branchId: tenant.branches.main.id,
        createdByUserId: tenant.superAdmin.id,
      })
      await db.insert(apricartExecutiveAssignments).values({
        userId: executiveId,
        organizationId: tenant.organizationId,
        createdByUserId: tenant.superAdmin.id,
      })
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("1. the desk keys in the order at the prices the customer agreed", async ({ page }) => {
    test.slow()
    const budgetBefore = await budgetAtMain()
    await signIn(page, AGENT, /\/order-desk/)

    await page.getByLabel("Organization").click()
    await page.getByRole("option", { name: new RegExp(tenant.organizationName) }).click()
    await page.getByLabel("Branch").click()
    await page.getByRole("option", { name: new RegExp(tenant.branches.main.name) }).click()

    // The picker searches Apricart's whole catalogue, not only the branch's.
    await page.getByLabel("Search products").fill("E2E Priced")
    const products = page.getByRole("list", { name: "Apricart products" })
    const riceRow = products.getByRole("listitem").filter({ hasText: RICE })
    const glovesRow = products.getByRole("listitem").filter({ hasText: GLOVES })
    await expect(riceRow.getByText("Branch price Rs 15.00")).toBeVisible({ timeout: 150_000 })
    await expect(glovesRow.getByText("Not in branch catalogue")).toBeVisible()
    // The uncarried product never shows Apricart's base price as the customer's.
    await expect(glovesRow).not.toContainText("99.99")

    // Every price box starts empty, the branch's own product included.
    const ricePrice = page.getByLabel(priceLabel(RICE, "piece"))
    const glovesPrice = page.getByLabel(priceLabel(GLOVES, "pair"))
    await expect(ricePrice).toHaveValue("")
    await expect(glovesPrice).toHaveValue("")

    // Two bags of rice: the price becomes required.
    await page.getByRole("button", { name: `Increase Quantity of ${RICE}` }).click()
    await page.getByRole("button", { name: `Increase Quantity of ${RICE}` }).click()
    await expect(riceRow.getByText("Price required")).toBeVisible()
    await expect(ricePrice).toHaveAttribute("aria-invalid", "true")
    const checklist = page.getByRole("list", { name: "What this order still needs" })
    await expect(checklist.getByText("A price for every product").locator("..")).toContainText("still needed")

    // Agreed below the branch's price.
    await ricePrice.fill("14.50")
    await expect(riceRow.getByText("Differs from branch price")).toBeVisible()
    await expect(checklist.getByText("A price for every product").locator("..")).toContainText("done")

    // Three pairs of gloves; zero is refused, the agreed price accepted.
    for (let pair = 0; pair < 3; pair += 1) {
      await page.getByRole("button", { name: `Increase Quantity of ${GLOVES}` }).click()
    }
    await glovesPrice.fill("0")
    await expect(glovesRow.getByText(`The price for ${GLOVES} must be more than zero`)).toBeVisible()
    await expect(checklist.getByText("A price for every product").locator("..")).toContainText("still needed")
    await glovesPrice.fill("45.67")
    await expect(glovesPrice).toHaveAttribute("aria-invalid", "false")

    // Both are kept in the selection, whatever the search shows.
    await page.getByRole("button", { name: "Selected (2)" }).click()
    const selected = page.getByRole("list", { name: "Selected products" })
    await expect(selected.getByText(RICE)).toBeVisible()
    await expect(selected.getByText(GLOVES)).toBeVisible()

    // 2 × 14.50 + 3 × 45.67 = 166.01, tax already inside.
    await expect(page.getByText("Estimated total")).toBeVisible()
    await expect(page.getByText("Rs 166.01", { exact: true })).toBeVisible()

    await page.getByRole("button", { name: "WhatsApp", exact: true }).click()
    await page.getByLabel("Reference").fill(REFERENCE)
    const create = page.getByRole("button", { name: "Create order" })
    await expect(create).toBeDisabled()
    const screenshotKey = await stageScreenshot()
    await page.route("**/api/v1/upload/image", (route) => route.fulfill({
      json: { attachmentKey: screenshotKey, size: SCREENSHOT_PNG.length, type: "image/png" },
    }))
    await page.locator("#desk-screenshot").setInputFiles({ name: "whatsapp.png", mimeType: "image/png", buffer: SCREENSHOT_PNG })
    await expect(page.getByRole("img", { name: "Screenshot of the customer's message" })).toBeVisible()
    await expect(create).toBeEnabled()
    await create.click()

    await expect(page.getByRole("heading", { name: /Order .* created/ })).toBeVisible({ timeout: 150_000 })

    // What was stored is exactly what was typed.
    const order = await theOrder()
    expect(order).toMatchObject({ status: "PENDING", approved_by_user_id: null, budget_tracked: false, total_cents: "16601" })
    expect(Number(order.subtotal_cents) + Number(order.tax_cents)).toBe(16_601)

    const lines = await linesOf(order.id)
    expect(lines.get(RICE)).toMatchObject({
      organization_inventory_id: tenant.products.RICE.organizationInventoryId,
      quantity: "2.000",
      price_cents: "1450",
      price_entered_manually: true,
      catalogue_price_cents: "1500",
    })
    const glovesSplit = splitInclusiveCents(3 * 4_567, 1_800)
    expect(lines.get(GLOVES)).toMatchObject({
      global_product_id: glovesId,
      organization_inventory_id: null,
      quantity: "3.000",
      price_cents: "4567",
      price_entered_manually: true,
      catalogue_price_cents: null,
      tax_rate_bp: 1_800,
      tax_cents: String(glovesSplit.taxCents),
    })

    // Ordering the gloves did not add them to the customer's catalogue.
    const glovesCatalogue = await queryTestDb(
      testDatabaseUrl(),
      "SELECT id FROM organization_inventory WHERE global_product_id = $1",
      [glovesId],
    )
    expect(glovesCatalogue).toEqual([])

    // A Rs 166.01 order against a Rs 10.00 budget, and the budget never moved.
    expect(await budgetAtMain()).toEqual(budgetBefore)
  })

  test("2. the executive sees the agreed prices beside the branch's own, and sends one back", async ({ page }) => {
    test.slow()
    await openExecutiveApprovals(page)

    const card = orderCard(page)
    await expect(card).toBeVisible({ timeout: 150_000 })
    await expect(card.getByText("Custom prices")).toBeVisible()
    await expect(card.getByText("Rs 166.01").first()).toBeVisible()

    const rice = lineRow(card, RICE)
    await expect(rice.getByText("Rs 14.50").first()).toBeVisible()
    await expect(rice.getByText(/Price set by Order Desk/)).toBeVisible()
    await expect(rice.getByText("Rs 15.00", { exact: true })).toHaveClass(/line-through/)
    await expect(rice).not.toContainText("Not in branch catalogue")

    const gloves = lineRow(card, GLOVES)
    await expect(gloves.getByText("Not in branch catalogue")).toBeVisible()
    await expect(gloves.getByText(/no catalogue price/)).toBeVisible()
    await expect(gloves.getByText("Rs 45.67").first()).toBeVisible()

    await card.getByRole("button", { name: /Send back/ }).click()
    const dialog = page.getByRole("dialog", { name: /back for correction/ })
    await dialog.getByLabel("What should the desk correct?").fill("Gloves were agreed at Rs 44.00 a pair")
    await dialog.getByRole("button", { name: "Send back" }).click()
    await expect(dialog).toBeHidden({ timeout: 150_000 })

    await expect.poll(async () => (await theOrder()).correction_request_note, { timeout: 60_000 })
      .toBe("Gloves were agreed at Rs 44.00 a pair")
    const order = await theOrder()
    expect(order.status).toBe("PENDING")
    expect(order.returned_for_correction_at).not.toBeNull()

    // It now waits with the desk, and cannot be approved until it comes back.
    await page.getByRole("tab", { name: /With the desk/ }).click()
    await expect(orderCard(page)).toBeVisible({ timeout: 60_000 })
    await expect(orderCard(page).getByRole("button", { name: /Approve/ })).toHaveCount(0)
  })

  test("3. the desk corrects the price and sends it back for approval", async ({ page }) => {
    test.slow()
    await openDeskOrders(page)

    const card = orderCard(page)
    await expect(card.getByText("Gloves were agreed at Rs 44.00 a pair")).toBeVisible({ timeout: 150_000 })

    await card.getByRole("button", { name: "Edit" }).click()
    const edit = page.getByRole("dialog", { name: /^Edit / })
    // The order's own lines, each with the price it is charged now.
    await expect(edit.getByLabel(priceLabel(RICE, "piece"))).toHaveValue("14.50")
    await expect(edit.getByLabel(priceLabel(GLOVES, "pair"))).toHaveValue("45.67")
    await expect(edit.getByRole("listitem").filter({ hasText: GLOVES }).getByText("Not in branch catalogue")).toBeVisible()

    // A cleared price is refused before anything is sent.
    await edit.getByLabel(priceLabel(GLOVES, "pair")).fill("")
    await edit.getByRole("button", { name: "Save changes" }).click()
    await expect(edit.getByText(`Enter the price for ${GLOVES}, including tax`)).toBeVisible()
    expect((await theOrder()).total_cents).toBe("16601")

    await edit.getByLabel(priceLabel(GLOVES, "pair")).fill("44")
    // 2 × 14.50 + 3 × 44.00 = 161.00
    await expect(edit.getByText("Rs 161.00", { exact: true })).toBeVisible()
    await edit.getByRole("button", { name: "Save changes" }).click()
    await expect(edit).toBeHidden({ timeout: 150_000 })
    await expect.poll(async () => (await theOrder()).total_cents, { timeout: 60_000 }).toBe("16100")

    await orderCard(page).getByRole("button", { name: "Resubmit for approval" }).click()
    const resubmit = page.getByRole("dialog", { name: /Resubmit .* for approval/ })
    await resubmit.getByLabel(/Note for the executive/).fill("Gloves corrected to Rs 44.00 a pair")
    await resubmit.getByRole("button", { name: "Resubmit" }).click()
    await expect(resubmit).toBeHidden({ timeout: 150_000 })

    await expect.poll(async () => (await theOrder()).returned_for_correction_at, { timeout: 60_000 }).toBeNull()
    const order = await theOrder()
    expect(order).toMatchObject({ status: "PENDING", total_cents: "16100", budget_tracked: false })
    const lines = await linesOf(order.id)
    expect(lines.get(GLOVES)).toMatchObject({ price_cents: "4400", organization_inventory_id: null })
    expect(lines.get(RICE)).toMatchObject({ price_cents: "1450", catalogue_price_cents: "1500" })
  })

  test("4. the executive approves the corrected total, and the desk sees it Active", async ({ page, browser }) => {
    test.slow()
    const budgetBefore = await budgetAtMain()
    await openExecutiveApprovals(page)

    const card = orderCard(page)
    await expect(card).toBeVisible({ timeout: 150_000 })
    await expect(card.getByText("Rs 161.00").first()).toBeVisible()
    await expect(lineRow(card, GLOVES).getByText("Rs 44.00").first()).toBeVisible()

    await card.getByRole("button", { name: /Approve/ }).click()
    const confirm = page.getByRole("alertdialog")
    // The confirmation names the total being approved.
    await expect(confirm).toContainText("Rs 161.00")
    await confirm.getByRole("button", { name: "Approve" }).click()

    await expect.poll(async () => (await theOrder()).status, { timeout: 60_000 }).toBe("APPROVED")
    const order = await theOrder()
    expect(order).toMatchObject({ approved_by_user_id: executiveId, total_cents: "16100", budget_tracked: false })
    expect(await budgetAtMain()).toEqual(budgetBefore)

    // The trail says who priced what, and who approved it in which capacity.
    const [created] = await queryTestDb<{ details: Record<string, unknown> }>(
      testDatabaseUrl(),
      "SELECT details FROM system_logs WHERE action = 'ORDER_CREATE' AND resource_id = $1",
      [String(order.id)],
    )
    expect(created.details).toMatchObject({ budgetExemptionBasis: "ORDER_DESK" })
    expect((created.details.enteredPrices as unknown[])).toHaveLength(2)
    const [approval] = await queryTestDb<{ user_id: string; metadata: Record<string, unknown> }>(
      testDatabaseUrl(),
      "SELECT user_id, metadata FROM audit_logs WHERE action = 'ORDER_APPROVED' AND entity_id = $1",
      [String(order.id)],
    )
    expect(approval).toMatchObject({ user_id: executiveId, metadata: { decisionRole: "APRICART_EXECUTIVE" } })

    await page.getByRole("tab", { name: /^Approved/ }).click()
    await expect(orderCard(page)).toBeVisible({ timeout: 60_000 })

    // The desk, in its own session, sees it Active and waiting for delivery at the agreed prices.
    const deskContext = await browser.newContext()
    try {
      const deskPage = await deskContext.newPage()
      await openDeskOrders(deskPage)
      await deskPage.getByRole("tab", { name: new RegExp(DESK_AWAITING_DELIVERY) }).click()
      const deskCard = orderCard(deskPage)
      await expect(deskCard).toBeVisible({ timeout: 60_000 })
      await expect(deskCard.getByText("Rs 161.00", { exact: true }).first()).toBeVisible()
      // The lines are folded away until asked for.
      await deskCard.getByRole("button", { name: "Show 2 items" }).click()
      await expect(deskCard.getByRole("listitem").filter({ hasText: GLOVES })).toContainText("3 pair × Rs 44.00")
      await expect(deskCard.getByRole("listitem").filter({ hasText: RICE })).toContainText("2 piece × Rs 14.50")
      await expect(deskCard.getByRole("button", { name: "Edit" })).toHaveCount(0)
    } finally {
      await deskContext.close()
    }
  })
})
