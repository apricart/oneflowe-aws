import bcrypt from "bcryptjs"
import { expect, test, type Page } from "@playwright/test"

import { E2E_PASSWORD } from "./support/environment"
import { apiSession, closeRoleRenameNoticeWhenShown, placeOrder, post, signIn, testDatabaseUrl } from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, tenantNames, type Tenant } from "./support/tenant"

/**
 * An organization with order approval levels, from the join page to an order
 * decided at its level (plans/OF-JOIN-department-signup-multi-user.md,
 * plans/OF-APPROVAL-LEVELS-route-orders-by-level.md).
 *
 * The journey: an applicant signs up through the department form, naming one
 * approver per level (one an existing Group User, one nobody yet); Head Office
 * reviews it, corrects two details, and approves, which creates the initiator
 * and the new approver — a Branch Admin, because the request has one branch —
 * and gives the existing Group User its level, leaving it a Group User; the initiator
 * signs in to the shop; their orders land at the level their amount falls in,
 * and only that level's holder decides each. Switching levels off brings the
 * standard join form back.
 *
 * Every edge — failed approvals rolling back, races, CRC matching, the edit's
 * limits, holders who no longer count — is in
 * tests/integration/organization-join-department*.test.ts and
 * tests/integration/order-approval-routing*.test.ts.
 */

const KEY = "lvlj"
const JOIN_CODE = "E2E-LVLJ-FLOW"
const EMAIL_DOMAIN = "example.test"
const APPLICANT_PASSWORD = "Levels-Flow-2026!x"
// Level 1 = PKR 500.00 and above; Level 2 = everything below. The product is PKR 100.00.
const LEVEL_ONE_FROM_CENTS = 50_000
const LEVEL_TWO_FROM_CENTS = 20_000

const names = tenantNames(KEY)
const initiatorLocal = names.username("initiator")
const newApproverLocal = names.username("approver2")
const applicantPhone = `030${String(Date.now()).slice(-8)}`
const correctedPhone = `031${String(Date.now()).slice(-8)}`

let tenant: Tenant

async function sql<Row extends Record<string, unknown>>(text: string, values: unknown[] = []) {
  return queryTestDb<Row>(testDatabaseUrl(), text, values)
}

/** Let the join page hydrate before typing, or the code form submits natively. */
async function openJoinWithCode(page: Page): Promise<void> {
  await page.goto("/join")
  await page.waitForLoadState("networkidle")
  await page.getByLabel("Organization join code").fill(JOIN_CODE)
  await page.getByRole("button", { name: "Continue" }).click()
}

async function accountByEmail(email: string) {
  const [row] = await sql<{ id: string; role: string; branch_id: number | null; level: number | null; must_change: boolean; phone: string | null; designation: string | null }>(
    `SELECT u.id, r.name AS role, u.branch_id, u.order_approval_level AS level, u.must_change_password AS must_change, u.phone, u.designation
       FROM users u JOIN roles r ON r.id = u.role_id WHERE lower(u.email) = lower($1)`,
    [email],
  )
  return row
}

test.describe.serial("joining an organization with approval levels, and ordering by level", () => {
  test.beforeAll(async () => {
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      organization: { emailDomain: EMAIL_DOMAIN, budgetsEnabled: false, orderApprovalRequired: true, orderApproverRole: "BRANCH_ADMIN" },
      branches: [{ key: "north" }],
      users: [
        { key: "ho", role: "HEAD_OFFICE" },
        { key: "approver1", role: "GROUP_USER", branches: ["north"], fullName: "Level One Approver" },
      ],
      products: [{ code: "PAPER", name: "E2E LVLJ Paper", priceCents: 10_000 }],
    })
    await sql("UPDATE organizations SET order_approval_levels_enabled = true WHERE id = $1", [tenant.organizationId])
    await sql(
      "INSERT INTO organization_approval_levels (organization_id, level, max_amount_cents) VALUES ($1, 1, $2), ($1, 2, $3)",
      [tenant.organizationId, LEVEL_ONE_FROM_CENTS, LEVEL_TWO_FROM_CENTS],
    )
    await sql("INSERT INTO organization_join_codes (organization_id, code) VALUES ($1, $2)", [tenant.organizationId, JOIN_CODE])
  })

  test.afterAll(async () => {
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("an applicant signs up through the department form, naming an approver per level", async ({ browser }) => {
    test.slow()
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await openJoinWithCode(page)

      // The department form, with one approver card per level and its band.
      await expect(page.getByRole("heading", { name: "Financial Approver Levels" })).toBeVisible({ timeout: 150_000 })
      await expect(page.getByText("orders PKR 500.00 and above")).toBeVisible()
      await expect(page.getByText("orders under PKR 500.00")).toBeVisible()
      await expect(page.getByRole("button", { name: "Send request" })).toHaveCount(0)

      await page.locator("#signup-full-name").fill("Level Applicant")
      await page.locator("#signup-email").fill(initiatorLocal)
      // The organization's prefix, then the part of the email before the "@".
      await expect(page.locator("#signup-username")).toHaveValue(new RegExp(`^[a-z0-9]{1,3}-${initiatorLocal}$`))
      await page.locator("#signup-phone").fill(applicantPhone)
      await page.locator("#signup-ip-extension").fill("4321")
      await page.locator("#signup-employee-id").fill(`E2E-LVLJ-${applicantPhone.slice(-4)}`)
      await page.locator("#signup-department").selectOption("Finance")

      // The branch is picked by name; no CRC number of an existing branch is ever shown.
      await page.locator("#signup-branch").fill("lvlj north")
      await page.getByRole("option", { name: tenant.branches.north.name }).click()
      await page.locator("#signup-address").fill("Plot 7, Clifton, Karachi")
      await page.locator("#signup-address").press("Enter")

      await page.locator("#signup-approver-1-email").fill(names.username("approver1"))
      await page.locator("#signup-approver-1-designation").fill("Head of Finance")
      await page.locator("#signup-approver-2-email").fill(newApproverLocal)
      await page.locator("#signup-approver-2-designation").fill("Manager")

      await page.locator("#signup-password").fill(APPLICANT_PASSWORD)
      await page.locator("#signup-confirm-password").fill(APPLICANT_PASSWORD)
      await page.locator("#signup-terms").check()
      await page.getByRole("button", { name: "Sign Up" }).click()
      await expect(page.getByRole("heading", { name: "Request sent" })).toBeVisible({ timeout: 150_000 })
    } finally {
      await context.close()
    }

    const requests = await sql<{ form_version: number; status: string; requested_role: string; phone: string }>(
      "SELECT form_version, status, requested_role, phone FROM organization_join_requests WHERE organization_id = $1",
      [tenant.organizationId],
    )
    expect(requests).toEqual([{ form_version: 2, status: "pending", requested_role: "ORDER_PORTAL", phone: applicantPhone }])
  })

  test("Head Office corrects the request, then approves it, which creates the whole package", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/join-requests")
    const row = page.locator("li").filter({ hasText: "Level Applicant" })
    await row.getByRole("button", { name: "Review" }).click({ timeout: 150_000 })
    const dialog = page.getByRole("dialog", { name: "Level Applicant" })

    // What approving would do, per level: assign the existing Group User; create
    // the other as the Branch Admin of the one branch.
    await expect(dialog.getByText(/Level One Approver: is given Level 1/)).toBeVisible({ timeout: 150_000 })
    await expect(dialog.getByText(`No account yet: a Financial Approver of ${tenant.branches.north.name} is created with Level 2`, { exact: false })).toBeVisible()

    await dialog.getByRole("button", { name: /Edit details/ }).click()
    await dialog.getByLabel(/^Phone/).fill(correctedPhone)
    await dialog.getByLabel(/^Level 2 designation/).fill("Finance Manager")
    await dialog.getByRole("button", { name: "Save changes" }).click()
    await expect(dialog.getByText(`${correctedPhone} / 4321`)).toBeVisible({ timeout: 150_000 })
    await expect(dialog.getByText("Finance Manager", { exact: false })).toBeVisible()

    await dialog.getByRole("button", { name: "Approve and create accounts" }).click()
    await expect(dialog).toBeHidden({ timeout: 150_000 })

    const [request] = await sql<{ status: string }>(
      "SELECT status FROM organization_join_requests WHERE organization_id = $1",
      [tenant.organizationId],
    )
    expect(request.status).toBe("approved")
    expect(await accountByEmail(`${initiatorLocal}@${EMAIL_DOMAIN}`)).toMatchObject({
      role: "ORDER_PORTAL",
      branch_id: tenant.branches.north.id,
      must_change: false,
      phone: correctedPhone,
    })
    expect(await accountByEmail(tenant.users.approver1.email)).toMatchObject({ role: "GROUP_USER", level: 1 })
    expect(await accountByEmail(`${newApproverLocal}@${EMAIL_DOMAIN}`)).toMatchObject({
      role: "BRANCH_ADMIN",
      branch_id: tenant.branches.north.id,
      level: 2,
      must_change: true,
      designation: "Finance Manager",
    })
    const audit = await sql<{ action: string }>(
      "SELECT action FROM audit_logs WHERE organization_id = $1 AND action LIKE '%ORGANIZATION_JOIN_REQUEST' ORDER BY id",
      [tenant.organizationId],
    )
    expect(audit.map((entry) => entry.action)).toEqual(["UPDATE_ORGANIZATION_JOIN_REQUEST", "APPROVE_ORGANIZATION_JOIN_REQUEST"])
  })

  test("the initiator signs in to the shop with the password they chose", async ({ page }) => {
    test.slow()
    await page.goto("/login")
    await page.getByLabel("Username or Email").fill(initiatorLocal)
    await page.getByLabel("Password", { exact: true }).fill(APPLICANT_PASSWORD)
    await closeRoleRenameNoticeWhenShown(page)
    await page.getByRole("button", { name: /sign in/i }).click()
    await expect(page).toHaveURL(/\/shop/, { timeout: 150_000 })
  })

  test("each order waits at its level, and only that level's holder decides it", async ({ browser, page }) => {
    test.slow()
    const product = tenant.products.PAPER

    const initiator = await apiSession(browser, initiatorLocal, APPLICANT_PASSWORD)
    let large: number
    let small: number
    try {
      large = (await placeOrder(initiator.page, [{ organizationInventoryId: product.organizationInventoryId, quantity: 5 }])).id
      small = (await placeOrder(initiator.page, [{ organizationInventoryId: product.organizationInventoryId, quantity: 1 }])).id
    } finally {
      await initiator.close()
    }
    const levels = await sql<{ id: number; approval_level: number }>(
      "SELECT id, approval_level FROM orders WHERE id = ANY($1::int[]) ORDER BY id",
      [[large, small]],
    )
    expect(levels).toEqual([{ id: large, approval_level: 1 }, { id: small, approval_level: 2 }])

    // Head Office sees the level on the order list, but does not decide a levelled order.
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    await page.goto("/orders")
    await expect(page.getByText("Level 1 approval").first()).toBeVisible({ timeout: 150_000 })
    expect((await post(page, `/api/v1/orders/${large}/approve`, {})).status()).toBe(403)

    const levelOne = await apiSession(browser, tenant.users.approver1.username)
    try {
      expect((await post(levelOne.page, `/api/v1/orders/${small}/approve`, {})).status()).toBe(403)
      expect((await post(levelOne.page, `/api/v1/orders/${large}/approve`, {})).status()).toBe(200)
    } finally {
      await levelOne.close()
    }

    // The Branch Admin the sign-up created decides Level 2 at its branch. Its emailed password is
    // unknown here, so the suite gives it the fixture password and skips the
    // first-sign-in change, which `password-recovery.spec.ts` covers.
    await sql(
      "UPDATE users SET password_hash = $2, must_change_password = false WHERE lower(email) = lower($1)",
      [`${newApproverLocal}@${EMAIL_DOMAIN}`, await bcrypt.hash(E2E_PASSWORD, 10)],
    )
    const levelTwo = await apiSession(browser, newApproverLocal)
    try {
      expect((await post(levelTwo.page, `/api/v1/orders/${small}/approve`, {})).status()).toBe(200)
    } finally {
      await levelTwo.close()
    }

    const statuses = await sql<{ id: number; status: string }>(
      "SELECT id, status FROM orders WHERE id = ANY($1::int[]) ORDER BY id",
      [[large, small]],
    )
    expect(statuses.map((order) => order.status)).toEqual(["APPROVED", "APPROVED"])
  })

  test("the department form is refused to the review of anyone but Head Office", async ({ browser }) => {
    const [request] = await sql<{ id: number }>(
      "SELECT id FROM organization_join_requests WHERE organization_id = $1",
      [tenant.organizationId],
    )
    const outsider = await apiSession(browser, tenant.users.approver1.username)
    try {
      expect((await outsider.page.request.get(`/api/v1/join-requests/${request.id}`)).status()).toBe(403)
    } finally {
      await outsider.close()
    }
  })

  test("switching levels off brings the standard join form back", async ({ browser }) => {
    test.slow()
    await sql("UPDATE organizations SET order_approval_levels_enabled = false WHERE id = $1", [tenant.organizationId])
    const context = await browser.newContext()
    try {
      const page = await context.newPage()
      await openJoinWithCode(page)
      await expect(page.getByRole("button", { name: "Send request" })).toBeVisible({ timeout: 150_000 })
      await expect(page.getByRole("heading", { name: "Financial Approver Levels" })).toHaveCount(0)
    } finally {
      await context.close()
      await sql("UPDATE organizations SET order_approval_levels_enabled = true WHERE id = $1", [tenant.organizationId])
    }
  })
})
