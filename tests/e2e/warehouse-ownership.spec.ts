import { expect, test, type Page } from "@playwright/test"

import { expectStatus, put, signIn, testDatabaseUrl } from "./support/session"
import { destroyTenant, queryTestDb, seedTenant, type Tenant } from "./support/tenant"

/**
 * Warehouses own branches (`plans/OF-WAREHOUSE-order-ownership-and-transfer.md`, phase 2).
 *
 * The rules, the reach in every mode, the strand guard and the parity check are
 * in `tests/integration/warehouse-ownership-phase2.test.ts` and
 * `lib/warehouse-ownership.test.ts`. This is Super Admin's journey on Warehouse
 * Team — create a warehouse, add its operator, give it an organization-and-city
 * rule, narrow and widen the operator's branches, run the check — and the proof
 * that, with the mode still "branch", the warehouse account's own work is
 * untouched. Head Office is turned away by the page and by the endpoints.
 */

const KEY = "whown"
const CITY = "E2E Whown Ville"
const OTHER_CITY = "E2E Whown Town"
const WAREHOUSE_CODE = "E2E-WHOWN"
const WAREHOUSE_USERNAME = `e2e-${KEY}-warehouse`
const WAREHOUSE_NAME = "E2E Whown Operator"

let tenant: Tenant
let warehouseUserId: string

const db = <Row extends Record<string, unknown>>(text: string, params: unknown[] = []) =>
  queryTestDb<Row>(testDatabaseUrl(), text, params)

/** Warehouses belong to no tenant, so the tenant teardown cannot reach them. */
async function removeWarehouse(): Promise<void> {
  await db(`DELETE FROM warehouse_route_rules WHERE warehouse_id IN (SELECT id FROM apricart_warehouses WHERE code = $1)`, [WAREHOUSE_CODE])
  await db(`DELETE FROM branch_fulfillment_routes WHERE warehouse_id IN (SELECT id FROM apricart_warehouses WHERE code = $1)`, [WAREHOUSE_CODE])
  await db(`DELETE FROM apricart_warehouse_memberships WHERE warehouse_id IN (SELECT id FROM apricart_warehouses WHERE code = $1)`, [WAREHOUSE_CODE])
  await db(`DELETE FROM apricart_warehouses WHERE code = $1`, [WAREHOUSE_CODE])
}

async function membership(): Promise<{ branch_scope: string; selected: number[] } | undefined> {
  const [row] = await db<{ branch_scope: string; selected: number[] }>(
    `SELECT m.branch_scope,
            COALESCE(array_agg(mb.branch_id ORDER BY mb.branch_id) FILTER (WHERE mb.branch_id IS NOT NULL), '{}') AS selected
       FROM apricart_warehouse_memberships m
       JOIN apricart_warehouses w ON w.id = m.warehouse_id
       LEFT JOIN apricart_warehouse_member_branches mb ON mb.membership_id = m.id
      WHERE w.code = $1 AND m.user_id = $2
      GROUP BY m.branch_scope`,
    [WAREHOUSE_CODE, warehouseUserId],
  )
  return row
}

const warehouseRow = (page: Page) => page.getByRole("row").filter({ hasText: `${WAREHOUSE_CODE} ·` })

test.describe.serial("warehouses own branches", () => {
  test.beforeAll(async () => {
    await removeWarehouse()
    tenant = await seedTenant(testDatabaseUrl(), {
      key: KEY,
      branches: [{ key: "v1", city: CITY }, { key: "v2", city: CITY }, { key: "t1", city: OTHER_CITY }],
      users: [{ key: "ho", role: "HEAD_OFFICE" }],
    })
    // A warehouse account has no organization, so the tenant seed does not
    // make one; it carries the spec's username prefix, so the teardown does
    // remove it, and its assignments with it. Today's model: it serves CITY
    // in this organization.
    const [account] = await db<{ id: string }>(
      `INSERT INTO users (email, username, password_hash, role_id, full_name, is_active)
       SELECT $1, $2, sa.password_hash, (SELECT id FROM roles WHERE name = 'WAREHOUSE'), $3, true
         FROM users sa WHERE sa.id = $4
       RETURNING id`,
      [`${WAREHOUSE_USERNAME}@example.test`, WAREHOUSE_USERNAME, WAREHOUSE_NAME, tenant.superAdmin.id],
    )
    warehouseUserId = account.id
    await db(`INSERT INTO warehouse_city_assignments (user_id, city_key) VALUES ($1, lower($2))`, [warehouseUserId, CITY])
    await db(`INSERT INTO warehouse_city_organizations (user_id, organization_id) VALUES ($1, $2)`, [warehouseUserId, tenant.organizationId])
  })

  test.afterAll(async () => {
    await removeWarehouse()
    await destroyTenant(testDatabaseUrl(), KEY)
  })

  test("Super Admin creates a warehouse, adds its operator and an organization-and-city rule", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await page.goto("/warehouse-team")
    await expect(page.getByRole("button", { name: "New warehouse" })).toBeVisible({ timeout: 150_000 })
    // Production runs on each account's own assignments until the switch.
    await expect(page.getByText(/Today every order is still worked by the accounts assigned its branch/)).toBeVisible()

    await page.getByRole("button", { name: "New warehouse" }).click()
    const form = page.getByRole("dialog")
    await form.getByLabel("Code").fill(WAREHOUSE_CODE)
    await form.getByLabel("Name").fill("E2E Whown Warehouse")
    await form.getByRole("button", { name: "Create" }).click()
    await expect(warehouseRow(page)).toBeVisible({ timeout: 150_000 })

    await warehouseRow(page).getByRole("button", { name: "Members" }).click()
    const members = page.getByRole("dialog")
    await members.getByLabel(new RegExp(WAREHOUSE_NAME)).click()
    await expect(members.getByRole("button", { name: "All branches" })).toBeVisible({ timeout: 150_000 })
    await members.getByRole("button", { name: "Close" }).click()

    await warehouseRow(page).getByRole("button", { name: "Rules" }).click()
    const rules = page.getByRole("dialog")
    await rules.getByRole("combobox", { name: "Organization" }).click()
    await page.getByLabel("Search organizations").fill(tenant.organizationName)
    await page.getByRole("option", { name: new RegExp(tenant.organizationName) }).click()
    await rules.getByLabel("City").click()
    await page.getByRole("option", { name: `${CITY} (2)` }).click()
    await rules.getByRole("button", { name: "Add rule" }).click()
    await expect(rules.getByText(`${tenant.organizationName} · ${CITY}`)).toBeVisible({ timeout: 150_000 })
    await rules.getByRole("button", { name: "Close" }).click()

    // The rule is live: its two branches are in the warehouse, the other city's is not.
    await expect(warehouseRow(page)).toContainText("2 active")
    await expect(warehouseRow(page)).toContainText("1 rule · 0 by hand")
    const [rule] = await db<{ city_key: string }>(
      `SELECT r.city_key FROM warehouse_route_rules r JOIN apricart_warehouses w ON w.id = r.warehouse_id WHERE w.code = $1`,
      [WAREHOUSE_CODE],
    )
    expect(rule.city_key).toBe(CITY.toLowerCase())

    // Mapped like this, the operator's work would not change.
    await page.getByRole("button", { name: "Run check" }).click()
    await expect(page.getByText(/Checked /)).toBeVisible({ timeout: 150_000 })
    await expect(page.getByText(new RegExp(`${WAREHOUSE_USERNAME}: loses`))).toHaveCount(0)
  })

  test("Super Admin narrows the operator to one branch, then gives it all of them back", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.superAdmin.username, /\/dashboard/)
    await page.goto("/warehouse-team")
    await expect(warehouseRow(page)).toBeVisible({ timeout: 150_000 })

    await warehouseRow(page).getByRole("button", { name: "Members" }).click()
    await page.getByRole("dialog").getByRole("button", { name: "All branches" }).click()
    const scope = page.getByRole("dialog", { name: new RegExp(`${WAREHOUSE_NAME} at ${WAREHOUSE_CODE}`) })
    // Only the warehouse's own branches are offered.
    await expect(scope.getByLabel(tenant.branches.v1.name)).toBeVisible({ timeout: 150_000 })
    await expect(scope.getByLabel(tenant.branches.t1.name)).toHaveCount(0)
    await scope.getByLabel(tenant.branches.v1.name).click()
    await scope.getByRole("button", { name: "Work only the ticked branches" }).click()
    await expect.poll(membership, { timeout: 150_000 }).toEqual({ branch_scope: "SELECTED", selected: [tenant.branches.v1.id] })

    await scope.getByRole("button", { name: "Work all branches" }).click()
    await expect.poll(membership, { timeout: 150_000 }).toEqual({ branch_scope: "ALL", selected: [] })
  })

  test("the warehouse account still works its own branches, as before", async ({ page }) => {
    test.slow()
    await signIn(page, WAREHOUSE_USERNAME, /\/warehouse/)
    const queue = await expectStatus(await page.request.get("/api/v1/warehouse/orders?view=open"))
    expect(queue).toBeTruthy()
    // Its reach is still its own city assignment: the same two branches.
    const reach = await db<{ id: number }>(
      `SELECT b.id FROM branches b
        JOIN warehouse_city_assignments c ON lower(btrim(regexp_replace(b.city, '\\s+', ' ', 'g'))) = c.city_key
        JOIN warehouse_city_organizations o ON o.user_id = c.user_id AND o.organization_id = b.organization_id
       WHERE c.user_id = $1 ORDER BY b.id`,
      [warehouseUserId],
    )
    expect(reach.map((row) => row.id)).toEqual([tenant.branches.v1.id, tenant.branches.v2.id].sort((a, b) => a - b))
  })

  test("Head Office is not offered Warehouse Team and the endpoints refuse it", async ({ page }) => {
    test.slow()
    await signIn(page, tenant.users.ho.username, /\/dashboard/)
    const [warehouse] = await db<{ id: number }>(`SELECT id FROM apricart_warehouses WHERE code = $1`, [WAREHOUSE_CODE])
    await expectStatus(await put(page, `/api/v1/apricart-warehouses/${warehouse.id}/rules`, {
      organizationId: tenant.organizationId, city: OTHER_CITY, assigned: true,
    }), 403)
    await expectStatus(await put(page, `/api/v1/apricart-warehouses/${warehouse.id}/member-scope`, {
      userId: warehouseUserId, scope: "ALL",
    }), 403)
    await expectStatus(await page.request.get("/api/v1/apricart-warehouses/ownership-check"), 403)
    const rules = await db(`SELECT 1 FROM warehouse_route_rules r JOIN apricart_warehouses w ON w.id = r.warehouse_id WHERE w.code = $1`, [WAREHOUSE_CODE])
    expect(rules).toHaveLength(1)
  })
})
