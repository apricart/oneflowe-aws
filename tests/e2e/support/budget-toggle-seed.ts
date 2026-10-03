import bcrypt from "bcryptjs"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import {
  auditLogs,
  branchInventory,
  branches,
  budgets,
  emailOutbox,
  globalProducts,
  invoiceSequences,
  notifications,
  orderItems,
  orders,
  organizationInventory,
  organizationSettings,
  organizations,
  roles,
  systemLogs,
  users,
} from "../../../db/schema"

import { E2E_PASSWORD } from "./environment"

/**
 * The rows the budget allocation switch is driven with in a real browser.
 *
 * A tenant of the suite's own, so switching its budgets off can never leak into
 * the role smoke tenant, whose seed upserts without resetting the switch:
 *
 * ```text
 *   E2E Budget Toggle Org   budgets_enabled = false
 *     E2E Budget Toggle Branch   no budget row, baseline 0
 *       — so any order it places could only succeed with budgets truly off
 * ```
 *
 * `destroy` runs first so a crashed run leaves nothing a later one trips over.
 * Built on its own pool, never `@/lib/db`, for the reasons given in `seed.ts`.
 */

type SeedDb = ReturnType<typeof drizzle>

async function withDb<T>(databaseUrl: string, work: (db: SeedDb) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    return await work(drizzle(pool))
  } finally {
    await pool.end()
  }
}

export const BUDGET_TOGGLE_ORGANIZATION = {
  name: "E2E Budget Toggle Org",
  code: "E2EB_TOGGLE",
  branchName: "E2E Budget Toggle Branch",
} as const

export const BUDGET_TOGGLE_PRODUCT_CODE = "E2E-BUDGET-TOGGLE-PRODUCT"

export const BUDGET_TOGGLE_USERNAMES = {
  superAdmin: "e2e-budget-toggle-superadmin",
  headOffice: "e2e-budget-toggle-headoffice",
  orderPortal: "e2e-budget-toggle-orderportal",
} as const

async function roleId(db: SeedDb, name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by the Playwright suite" })
    .returning({ id: roles.id })
  return created.id
}

export async function seedBudgetToggleE2E(databaseUrl: string): Promise<void> {
  await withDb(databaseUrl, async (db) => {
    await destroy(db)
    const passwordHash = await bcrypt.hash(E2E_PASSWORD, 10)
    const person = (username: string, role: number, organizationId: number | null, branchId: number | null) => ({
      email: `${username}@example.test`,
      username,
      passwordHash,
      roleId: role,
      organizationId,
      branchId,
      fullName: `E2E ${username}`,
      firstName: "E2E",
      lastName: "Budget",
      isActive: true,
      mfaEnabled: false,
      mustChangePassword: false,
    })

    const [superAdmin] = await db.insert(users)
      .values(person(BUDGET_TOGGLE_USERNAMES.superAdmin, await roleId(db, "SUPER_ADMIN"), null, null))
      .returning({ id: users.id })

    const [organization] = await db.insert(organizations).values({
      name: BUDGET_TOGGLE_ORGANIZATION.name,
      code: BUDGET_TOGGLE_ORGANIZATION.code,
      status: "active",
      budgetsEnabled: false,
    }).returning({ id: organizations.id })

    const [branch] = await db.insert(branches).values({
      organizationId: organization.id,
      name: BUDGET_TOGGLE_ORGANIZATION.branchName,
      status: "active",
      baselineBudgetCents: 0,
    }).returning({ id: branches.id })

    await db.insert(users).values([
      person(BUDGET_TOGGLE_USERNAMES.headOffice, await roleId(db, "HEAD_OFFICE"), organization.id, null),
      person(BUDGET_TOGGLE_USERNAMES.orderPortal, await roleId(db, "ORDER_PORTAL"), organization.id, branch.id),
    ])

    const [product] = await db.insert(globalProducts).values({
      productCode: BUDGET_TOGGLE_PRODUCT_CODE,
      name: "E2E Budget Toggle Product",
      basePrice: 25_000,
      stockQuantity: 1_000,
      unit: "piece",
      status: "active",
      createdByUserId: superAdmin.id,
    }).returning({ id: globalProducts.id })

    const [inventory] = await db.insert(organizationInventory).values({
      organizationId: organization.id,
      globalProductId: product.id,
      assignedByUserId: superAdmin.id,
      isActive: true,
    }).returning({ id: organizationInventory.id })

    await db.insert(branchInventory).values({
      branchId: branch.id,
      organizationId: organization.id,
      organizationInventoryId: inventory.id,
      assignedByUserId: superAdmin.id,
      isVisible: true,
      isActive: true,
    })
  })
}

export async function destroyBudgetToggleE2E(databaseUrl: string): Promise<void> {
  await withDb(databaseUrl, destroy)
}

export async function readBudgetsEnabled(databaseUrl: string): Promise<boolean | undefined> {
  return withDb(databaseUrl, async (db) => {
    const [row] = await db
      .select({ budgetsEnabled: organizations.budgetsEnabled })
      .from(organizations)
      .where(eq(organizations.name, BUDGET_TOGGLE_ORGANIZATION.name))
      .limit(1)
    return row?.budgetsEnabled
  })
}

/** Every order the tenant holds, and every budget row it holds — which should be none. */
export async function readTenantLedger(databaseUrl: string): Promise<{
  orders: Array<{ budgetTracked: boolean; totalCents: number }>
  budgetRows: number
}> {
  return withDb(databaseUrl, async (db) => {
    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, BUDGET_TOGGLE_ORGANIZATION.name))
      .limit(1)
    if (!organization) return { orders: [], budgetRows: 0 }
    const orderRows = await db
      .select({ budgetTracked: orders.budgetTracked, totalCents: orders.totalCents })
      .from(orders)
      .where(eq(orders.organizationId, organization.id))
    const budgetRows = await db
      .select({ id: budgets.id })
      .from(budgets)
      .where(eq(budgets.organizationId, organization.id))
    return { orders: orderRows, budgetRows: budgetRows.length }
  })
}

async function destroy(db: SeedDb): Promise<void> {
  const tenants = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.name, BUDGET_TOGGLE_ORGANIZATION.name))
  const organizationIds = tenants.map((row) => row.id)

  if (organizationIds.length > 0) {
    // Children first: every one of these references the organization or its orders.
    await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
    await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, organizationIds))
    await db.delete(orderItems).where(inArray(orderItems.organizationId, organizationIds))
    await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
    await db.delete(invoiceSequences).where(inArray(invoiceSequences.organizationId, organizationIds))
    await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
    await db.delete(budgets).where(inArray(budgets.organizationId, organizationIds))
    await db.delete(branchInventory).where(inArray(branchInventory.organizationId, organizationIds))
    await db.delete(organizationInventory).where(inArray(organizationInventory.organizationId, organizationIds))
    await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, organizationIds))
    const tenantUsers = await db.select({ id: users.id }).from(users).where(inArray(users.organizationId, organizationIds))
    if (tenantUsers.length > 0) {
      const ids = tenantUsers.map((row) => row.id)
      await db.delete(auditLogs).where(inArray(auditLogs.userId, ids))
      await db.delete(notifications).where(inArray(notifications.userId, ids))
      await db.delete(users).where(inArray(users.id, ids))
    }
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
  }

  await db.delete(globalProducts).where(eq(globalProducts.productCode, BUDGET_TOGGLE_PRODUCT_CODE))

  const [superAdmin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, BUDGET_TOGGLE_USERNAMES.superAdmin))
    .limit(1)
  if (superAdmin) {
    await db.delete(auditLogs).where(eq(auditLogs.userId, superAdmin.id))
    await db.delete(notifications).where(eq(notifications.userId, superAdmin.id))
    await db.delete(users).where(eq(users.id, superAdmin.id))
  }
}
