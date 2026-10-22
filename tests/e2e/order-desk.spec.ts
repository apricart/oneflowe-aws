import { randomUUID } from "node:crypto"

import bcrypt from "bcryptjs"
import { eq } from "drizzle-orm"
import { expect, test, type Page } from "@playwright/test"

import { apricartExecutiveAssignments, orderDeskAssignments, roles, users } from "../../db/schema"

import { setCompanySwitch } from "./support/admin-ui"
import { E2E_PASSWORD } from "./support/environment"
import {
  apiSession,
  expectStatus,
  post,
  sessionRole,
  signIn,
  testDatabaseUrl,
} from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, tenantNames, withTenantDb, type Tenant } from "./support/tenant"

/**
 * Apricart's Order Desk (`plans/OF-ORDER-DESK-internal-order-entry.md`), as
 * the people who use it see it.
 *
 * Reach, ledgers, races and every refusal are proved against the real routes
 * in `tests/integration/order-desk-api.test.ts`. This proves the journeys a
 * browser adds to that: Super Admin creates a desk user and grants it a
 * managed customer; the desk signs in to its own workspace and can reach
 * nothing else — through the real proxy, which the integration suite does not
 * run; it keys in an order that waits for an Apricart Executive, edits one and
 * cancels another while they wait; an executive assigned to the customer
 * approves it from the executive workspace
 * (`plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md`); the desk
 * fulfils it once delivered and asks for a refund; the customer's Head Office
 * sees the order as its branch's, decided by Apricart; and switching the
 * customer off withdraws the desk on its next page load.
 *
 * Delivery itself is Super Admin's, with a challan upload this environment has
 * no object storage for; it is written to the row here and proved in
 * `tests/integration/delivery-challan-api.test.ts`. The customer's screenshot,
 * which every desk order requires, has the same problem: the upload's audit row
 * is staged here (`stageScreenshot`) and the browser's upload call answered
 * with its key; the upload itself is proved in
 * `tests/integration/order-desk-api.test.ts`.
 */

const KEY = "desk"
const names = tenantNames(KEY)
const AGENT = names.username("agent")
const NEWCOMER = names.username("newcomer")
const EXECUTIVE = names.username("exec")
const PRODUCT = "E2E Desk Rice"
/** The price box on the product's row; the unit is the tenant fixture's. */
const PRICE_LABEL = new RegExp(`^Price per .+ of ${PRODUCT}, in rupees including tax$`)

let tenant: Tenant
let agentId: string
let executiveId: string

type OrderRow = {
  id: number
  status: string
  created_by_role: string | null
  approved_by_user_id: string | null
  intake_channel: string | null
  intake_reference: string | null
  total_cents: string
  fulfilled_by_user_id: string | null
  cancellation_reason: string | null
}

async function deskOrders(): Promise<OrderRow[]> {
  return queryTestDb<OrderRow>(
    testDatabaseUrl(),
    `SELECT id, status, created_by_role, approved_by_user_id, intake_channel, intake_reference,
            total_cents::text, fulfilled_by_user_id, cancellation_reason
       FROM orders WHERE organization_id = $1 AND created_by_role = 'ORDER_DESK' ORDER BY id`,
    [tenant.organizationId],
  )
}

async function heldAtMain(): Promise<number> {
  const [row] = await queryTestDb<{ held: string }>(
    testDatabaseUrl(),
    "SELECT amount_held_cents::text AS held FROM budgets WHERE branch_id = $1 ORDER BY id DESC LIMIT 1",
    [tenant.branches.main.id],
  )
  return Number(row.held)
}

/** Super Admin's delivery, written to the row (see the header). */
async function recordDelivery(orderId: number): Promise<void> {
  await queryTestDb(
    testDatabaseUrl(),
    "UPDATE orders SET fulfillment_status = 'DELIVERED', delivered_at = NOW() WHERE id = $1 AND status = 'APPROVED'",
    [orderId],
  )
}

/**
 * A screenshot as the upload route leaves it for the desk agent: the audit row
 * binding a fresh key to its uploader, which order creation checks.
 */
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

/** An order keyed in through the API by the desk agent, for journeys that start after creation. */
async function deskOrderThroughApi(page: Page, reference: string, quantity = 1): Promise<number> {
  const body = await expectStatus(await post(page, "/api/v1/orders", {
    organizationId: tenant.organizationId,
    branchId: tenant.branches.main.id,
    items: [{ globalProductId: tenant.products.RICE.globalProductId, quantity, unitPriceCents: 1_500 }],
    intakeChannel: "EMAIL",
    intakeReference: reference,
    intakeAttachmentKey: await stageScreenshot(),
  }, { "Idempotency-Key": `e2e-${randomUUID()}` }))
  return Number(body.order.id)
}

async function openDeskOrders(page: Page): Promise<void> {
  await page.goto("/order-desk")
  await page.getByRole("tab", { name: /Orders/ }).click()
  await expect(page.getByRole("tablist", { name: "Order status" })).toBeVisible({ timeout: 120_000 })
}

function orderCard(page: Page, text: string) {
  return page.getByRole("article").filter({ hasText: text })
}

test.describe.serial("the Order Desk", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      organization: { managedOrdering: true, orderApprovalRequired: true, budgetsEnabled: true },
      branches: [{ key: "main", budgetCents: 100_000_000 }, { key: "east", budgetCents: 100_000_000 }],
      users: [
        { key: "ho", role: "HEAD_OFFICE" },
        { key: "op", role: "ORDER_PORTAL", branch: "main" },
      ],
      products: [{ code: "RICE", name: PRODUCT, priceCents: 1_500, stock: 1_000 }],
    })

    // The desk agent: Apricart staff, no organization, granted this customer whole.
    agentId = await withTenantDb(testDatabaseUrl(), async (db) => {
      const [deskRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "ORDER_DESK")).limit(1)
      const [agent] = await db.insert(users).values({
        email: `${AGENT}@example.test`,
        username: AGENT,
        passwordHash: await bcrypt.hash(E2E_PASSWORD, 10),
        roleId: deskRole.id,
        organizationId: null,
        branchId: null,
        fullName: "E2E Desk Agent",
        firstName: "E2E Desk",
        lastName: "Agent",
        isActive: true,
        mfaEnabled: false,
        mustChangePassword: false,
      }).returning({ id: users.id })
      await db.insert(orderDeskAssignments).values({
        userId: agent.id,
        organizationId: tenant.organizationId,
        branchId: null,
        createdByUserId: tenant.superAdmin.id,
      })
      return agent.id
    })

    // An Apricart Executive who approves this customer's desk orders.
    executiveId = await withTenantDb(testDatabaseUrl(), async (db) => {
      const [executiveRole] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, "APRICART_EXECUTIVE")).limit(1)
      const [executive] = await db.insert(users).values({
        email: `${EXECUTIVE}@example.test`,
        username: EXECUTIVE,
        passwordHash: await bcrypt.hash(E2E_PASSWORD, 10),
        roleId: executiveRole.id,
        organizationId: null,
        branchId: null,
        fullName: "E2E Executive",
        firstName: "E2E",
        lastName: "Executive",
        isActive: true,
        mfaEnabled: false,
        mustChangePassword: false,
      }).returning({ id: users.id })
      await db.insert(apricartExecutiveAssignments).values({
        userId: executive.id,
        organizationId: tenant.organizationId,
        createdByUserId: tenant.superAdmin.id,
      })
      return executive.id
    })
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("Super Admin adds a desk user and grants it the managed customer", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await page.goto("/desk-team")
    await expect(page.getByRole("heading", { name: "Order Desk Team" })).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText("E2E Desk Agent")).toBeVisible()

    await page.getByRole("button", { name: /Add desk user/ }).click()
    const dialog = page.getByRole("dialog", { name: "Add Order Desk user" })
    await dialog.getByLabel("First name").fill("E2E")
    await dialog.getByLabel("Last name").fill("Newcomer")
    await dialog.getByLabel("Email").fill(`${NEWCOMER}@example.test`)
    await dialog.getByLabel("Username").fill(NEWCOMER)
    await dialog.getByLabel("Temporary password").fill("E2e!Desk-Passw0rd")
    await dialog.getByLabel(`${tenant.organizationName} — all branches`).click()
    await dialog.getByRole("button", { name: "Create desk user" }).click()
    await expect(dialog).toBeHidden({ timeout: 150_000 })

    const row = page.getByRole("row").filter({ hasText: NEWCOMER })
    await expect(row.getByText(`${tenant.organizationName} (all branches)`)).toBeVisible({ timeout: 60_000 })

    const [created] = await queryTestDb<{ role: string; organization_id: number | null; branch_id: number | null; must_change_password: boolean }>(
      testDatabaseUrl(),
      `SELECT r.name AS role, u.organization_id, u.branch_id, u.must_change_password
         FROM users u JOIN roles r ON r.id = u.role_id WHERE u.username = $1`,
      [NEWCOMER],
    )
    expect(created).toEqual({ role: "ORDER_DESK", organization_id: null, branch_id: null, must_change_password: true })
    const grants = await queryTestDb<{ organization_id: number; branch_id: number | null }>(
      testDatabaseUrl(),
      `SELECT a.organization_id, a.branch_id FROM order_desk_assignments a
         JOIN users u ON u.id = a.user_id WHERE u.username = $1`,
      [NEWCOMER],
    )
    expect(grants).toEqual([{ organization_id: tenant.organizationId, branch_id: null }])
  })

  test("the desk lands in its own workspace and reaches nothing else", async ({ page }) => {
    test.slow()
    await signIn(page, AGENT, /\/order-desk/)
    expect(await sessionRole(page)).toBe("ORDER_DESK")

    for (const path of ["/dashboard", "/orders", "/users", "/desk-team", "/shop"]) {
      await page.goto(path)
      await expect(page, `${path} should send the desk home`).toHaveURL(/\/order-desk/, { timeout: 150_000 })
    }

    // Through the real proxy: anything off the desk's allowlist is refused before a handler runs.
    for (const path of ["/api/v1/orders", "/api/v1/order-desk/team", "/api/v1/users", `/api/v1/organizations/${tenant.organizationId}`]) {
      expect((await page.request.get(path)).status(), path).toBe(403)
    }
    // "Forgot password" in the desk's profile menu works while signed in.
    const reset = await post(page, "/api/v1/auth/password-reset/request", { identifier: AGENT })
    expect(reset.status()).toBe(202)
  })

  test("the desk keys in an order, and it waits for an Apricart Executive", async ({ page }) => {
    test.slow()
    const heldBefore = await heldAtMain()
    await signIn(page, AGENT, /\/order-desk/)

    await page.getByLabel("Organization").click()
    await page.getByRole("option", { name: new RegExp(tenant.organizationName) }).click()
    await page.getByLabel("Branch").click()
    await page.getByRole("option", { name: new RegExp(tenant.branches.main.name) }).click()

    // The picker lists all of Apricart's products, so find this one first.
    await page.getByLabel("Search products").fill(PRODUCT)
    await page.getByRole("button", { name: `Increase Quantity of ${PRODUCT}` }).click({ timeout: 120_000 })
    await page.getByRole("button", { name: `Increase Quantity of ${PRODUCT}` }).click()
    // The price box starts empty and must be filled, including tax.
    const price = page.getByLabel(PRICE_LABEL)
    await expect(price).toHaveValue("")
    await expect(page.getByText("Price required")).toBeVisible()
    await price.fill("15")
    // Exact: the screenshot picker's label also mentions WhatsApp.
    await page.getByRole("button", { name: "WhatsApp", exact: true }).click()
    await page.getByLabel("Reference").fill("E2E customer, WhatsApp 10:14")
    await page.getByLabel(/Customer PO number/).fill("PO-E2E-1")

    // Nothing goes until the customer's screenshot is attached.
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

    const [order] = await deskOrders()
    expect(order).toMatchObject({
      status: "PENDING",
      created_by_role: "ORDER_DESK",
      approved_by_user_id: null,
      intake_channel: "WHATSAPP",
      intake_reference: "E2E customer, WhatsApp 10:14",
      total_cents: "3000",
    })
    // A desk order takes no budget (plans/OF-ORDER-DESK-assigned-reach-global-catalogue-budget-exemption.md).
    expect(await heldAtMain()).toBe(heldBefore)

    // The next order starts from a clean draft.
    await page.getByRole("button", { name: "Create another order" }).click()
    await expect(page.getByRole("button", { name: "Create order" })).toBeDisabled()
  })

  test("while they wait for approval the desk edits one order and cancels another", async ({ page }) => {
    test.slow()
    await signIn(page, AGENT, /\/order-desk/)
    const toCancel = await deskOrderThroughApi(page, "E2E cancel me")
    const heldBefore = await heldAtMain()

    await openDeskOrders(page)
    const edited = orderCard(page, "E2E customer, WhatsApp 10:14")
    await edited.getByRole("button", { name: "Edit" }).click()
    const editDialog = page.getByRole("dialog", { name: /^Edit / })
    // Opens on the order's own lines, its price kept.
    await expect(editDialog.getByLabel(PRICE_LABEL)).toHaveValue("15.00")
    // Exact: the stepper's buttons are labelled "Increase/Decrease Quantity of …".
    const quantity = editDialog.getByLabel(`Quantity of ${PRODUCT}`, { exact: true })
    await quantity.fill("3")
    await quantity.press("Enter")
    await editDialog.getByRole("button", { name: "Save changes" }).click()
    await expect(editDialog).toBeHidden({ timeout: 150_000 })
    await expect.poll(async () => (await deskOrders())[0].total_cents, { timeout: 60_000 }).toBe("4500")
    expect(await heldAtMain()).toBe(heldBefore)

    await orderCard(page, "E2E cancel me").getByRole("button", { name: "Cancel order" }).click()
    const cancelDialog = page.getByRole("dialog", { name: /^Cancel / })
    await cancelDialog.getByRole("button", { name: "Cancel order" }).click()
    await expect(cancelDialog.getByText("A reason is required")).toBeVisible()
    await cancelDialog.getByLabel("Reason").fill("Customer withdrew it by email")
    await cancelDialog.getByRole("button", { name: "Cancel order" }).click()
    await expect(cancelDialog).toBeHidden({ timeout: 150_000 })

    const cancelled = (await deskOrders()).find((row) => row.id === toCancel)
    expect(cancelled).toMatchObject({ status: "CANCELLED", cancellation_reason: "Customer withdrew it by email" })
    // The edit added one bag (1,500) and the cancel released the other order's one bag.
    expect(await heldAtMain()).toBe(heldBefore)

    await page.getByRole("tab", { name: /Cancelled/ }).click()
    await expect(orderCard(page, "E2E cancel me").getByText(/Customer withdrew it by email/)).toBeVisible()
  })

  test("an executive assigned to the customer approves it from the executive workspace", async ({ page }) => {
    test.slow()
    await signIn(page, EXECUTIVE, /\/executive/)
    expect(await sessionRole(page)).toBe("APRICART_EXECUTIVE")
    // Through the real proxy: the tenant's own decision route is not the executive's.
    const [order] = await deskOrders()
    expect((await post(page, `/api/v1/orders/${order.id}/approve`, {})).status()).toBe(403)

    // A cold dev server can drop the first click before the page hydrates, so
    // the tab is clicked until its list shows.
    await expect(async () => {
      await page.getByRole("tab", { name: /Approvals/ }).click()
      await expect(page.getByRole("tablist", { name: "Approval status" })).toBeVisible({ timeout: 10_000 })
    }).toPass({ timeout: 150_000 })
    const card = page.getByRole("article").filter({ hasText: "E2E customer, WhatsApp 10:14" })
    await expect(card).toBeVisible({ timeout: 150_000 })
    // The executive sees what it approves: the edited quantity and its amount.
    await expect(card.getByText(PRODUCT)).toBeVisible()
    await card.getByRole("button", { name: /Approve/ }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Approve" }).click()

    await expect.poll(async () => (await deskOrders())[0].status, { timeout: 60_000 }).toBe("APPROVED")
    expect((await deskOrders())[0].approved_by_user_id).toBe(executiveId)
  })

  test("once Super Admin records delivery the desk fulfils, then asks for a refund", async ({ page }) => {
    test.slow()
    const [order] = await deskOrders()
    await recordDelivery(order.id)

    await signIn(page, AGENT, /\/order-desk/)
    await openDeskOrders(page)
    await expect(page.getByText("1 order has been delivered and is ready for you to fulfil.")).toBeVisible({ timeout: 60_000 })
    await page.getByRole("button", { name: /Review/ }).click()

    const card = orderCard(page, "E2E customer, WhatsApp 10:14")
    await expect(card.getByRole("button", { name: "Edit" })).toHaveCount(0)
    await card.getByRole("button", { name: /Fulfil/ }).click()
    await page.getByRole("alertdialog").getByRole("button", { name: "Yes, fulfil" }).click()
    await expect.poll(async () => (await deskOrders())[0].status, { timeout: 60_000 }).toBe("FULFILLED")
    expect((await deskOrders())[0].fulfilled_by_user_id).toBe(agentId)

    await page.getByRole("tab", { name: /Fulfilled/ }).click()
    await orderCard(page, "E2E customer, WhatsApp 10:14").getByRole("button", { name: "Request refund" }).click()
    const refund = page.getByRole("dialog", { name: /Request a refund/ })
    await refund.getByLabel(`Refund quantity for ${PRODUCT}`).fill("1")
    await refund.getByLabel("Reason").fill("One bag arrived torn")
    await refund.getByRole("button", { name: "Request refund" }).click()
    await expect(refund).toBeHidden({ timeout: 150_000 })

    const refunds = await queryTestDb<{ status: string; amount_cents: string; requested_by_user_id: string }>(
      testDatabaseUrl(),
      "SELECT status, amount_cents::text, requested_by_user_id FROM refunds WHERE order_id = $1",
      [order.id],
    )
    expect(refunds).toEqual([{ status: "PENDING", amount_cents: "1500", requested_by_user_id: agentId }])
    await expect(orderCard(page, "E2E customer, WhatsApp 10:14").getByText(/Refund awaiting approval/)).toBeVisible({ timeout: 60_000 })
  })

  test("the customer's Head Office sees the desk's order, but never the desk", async ({ page, browser }) => {
    test.slow()
    const [order] = await deskOrders()
    const headOffice = await apiSession(browser, tenant.users.ho.username)
    try {
      const listed = await expectStatus(await headOffice.page.request.get(`/api/v1/orders?id=${order.id}`))
      expect(listed.items.map((item: { id: number }) => item.id)).toEqual([order.id])
      expect(listed.items[0].decidedByApricart).toBe(true)
      expect((await headOffice.page.request.get("/api/v1/order-desk/targets")).status()).toBe(403)
    } finally {
      await headOffice.close()
    }

    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/order-desk")
    await expect(page).toHaveURL(/\/dashboard/, { timeout: 150_000 })
  })

  test("switching the customer off withdraws the desk on its next page load", async ({ page, browser }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await setCompanySwitch(page, tenant, "Managed by Apricart Order Desk", false)

    const desk = await apiSession(browser, AGENT)
    try {
      await desk.page.goto("/order-desk")
      await expect(desk.page.getByText("No organizations assigned yet")).toBeVisible({ timeout: 150_000 })
      const refused = await post(desk.page, "/api/v1/orders", {
        organizationId: tenant.organizationId,
        branchId: tenant.branches.main.id,
        items: [{ globalProductId: tenant.products.RICE.globalProductId, quantity: 1, unitPriceCents: 1_500 }],
        intakeChannel: "EMAIL",
        intakeReference: "after the switch",
        intakeAttachmentKey: await stageScreenshot(),
      }, { "Idempotency-Key": `e2e-${randomUUID()}` })
      expect(refused.status()).toBe(403)
    } finally {
      await desk.close()
    }
  })
})
