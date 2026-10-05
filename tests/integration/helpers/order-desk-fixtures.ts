import { randomUUID } from "node:crypto"

import { eq, inArray, or } from "drizzle-orm"

import {
  auditLogs,
  branchInventory,
  branches,
  budgets,
  emailOutbox,
  globalProducts,
  invoiceSequences,
  notifications,
  orderDeskAssignments,
  orderItems,
  orders,
  refundItems,
  refunds,
  organizationInventory,
  organizations,
  roles,
  sessions,
  systemLogs,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import { currentBudgetPeriod } from "@/lib/server/group-branch-budgets"

export { NO_DATABASE_REASON, hasTestDatabase } from "./pricing-fixtures"

/**
 * Three tenants for the Order Desk, each answering one question.
 *
 * ```text
 * Managed A  (managed, approval REQUIRED, budgets off)  A1 active · A2 active · A3 inactive
 * Managed B  (managed, budgets ON, B1 funded)           B1 active
 * Tenant C   (NOT managed — a K-Electric shape)         C1 active
 *
 * desk     : A whole · B1 · C whole (a stale grant; C is not managed, so it reaches nothing)
 * desk2    : A2 only
 * deskOff  : A whole, but the account is inactive
 * viewer   : VIEWER pinned to A1      portal : ORDER_PORTAL at A1      head : HEAD_OFFICE of A
 * ```
 *
 * One product, base price 10.00, priced 15.00 by tenant A, stock 1000.
 */
export type OrderDeskFixtures = {
  suffix: string
  organizationA: number
  organizationB: number
  organizationC: number
  branchA1: number
  branchA2: number
  branchA3: number
  branchB1: number
  branchC1: number
  superAdminId: string
  headOfficeId: string
  deskId: string
  desk2Id: string
  deskOffId: string
  viewerId: string
  portalId: string
  productId: number
  inventoryA: number
  inventoryB: number
  inventoryC: number
  budgetB1: number
}

export const ORDER_DESK_FIXTURE_PRICE_CENTS = { base: 1_000, organizationA: 1_500 } as const

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by order-desk integration tests" })
    .returning({ id: roles.id })
  return created.id
}

export async function createOrderDeskFixtures(): Promise<OrderDeskFixtures> {
  const suffix = randomUUID().slice(0, 8)
  const role = {
    superAdmin: await resolveRoleId("SUPER_ADMIN"),
    headOffice: await resolveRoleId("HEAD_OFFICE"),
    desk: await resolveRoleId("ORDER_DESK"),
    viewer: await resolveRoleId("VIEWER"),
    portal: await resolveRoleId("ORDER_PORTAL"),
  }

  const [organizationA, organizationB, organizationC] = await db
    .insert(organizations)
    .values([
      { name: `ITD Managed A ${suffix}`, code: `ITDA_${suffix}`, managedOrdering: true, orderApprovalRequired: true, budgetsEnabled: false },
      { name: `ITD Managed B ${suffix}`, code: `ITDB_${suffix}`, managedOrdering: true, budgetsEnabled: true },
      { name: `ITD Tenant C ${suffix}`, code: `ITDC_${suffix}`, managedOrdering: false, budgetsEnabled: false },
    ])
    .returning({ id: organizations.id })

  const [branchA1, branchA2, branchA3, branchB1, branchC1] = await db
    .insert(branches)
    .values([
      { organizationId: organizationA.id, name: `ITD A1 ${suffix}`, status: "active" },
      { organizationId: organizationA.id, name: `ITD A2 ${suffix}`, status: "active" },
      { organizationId: organizationA.id, name: `ITD A3 ${suffix}`, status: "inactive" },
      { organizationId: organizationB.id, name: `ITD B1 ${suffix}`, status: "active", baselineBudgetCents: 1_000_000 },
      { organizationId: organizationC.id, name: `ITD C1 ${suffix}`, status: "active" },
    ])
    .returning({ id: branches.id })

  async function person(
    label: string,
    roleId: number,
    scope: { organizationId: number | null; branchId: number | null; isActive?: boolean },
  ): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `itd-${label}-${suffix}@example.test`,
        username: `itd-${label}-${suffix}`,
        passwordHash: "not-a-real-hash",
        roleId,
        organizationId: scope.organizationId,
        branchId: scope.branchId,
        isActive: scope.isActive ?? true,
        firstName: label,
        lastName: suffix,
        fullName: `${label} ${suffix}`,
      })
      .returning({ id: users.id })
    return row.id
  }

  const superAdminId = await person("super", role.superAdmin, { organizationId: null, branchId: null })
  const headOfficeId = await person("head", role.headOffice, { organizationId: organizationA.id, branchId: null })
  const deskId = await person("desk", role.desk, { organizationId: null, branchId: null })
  const desk2Id = await person("desk2", role.desk, { organizationId: null, branchId: null })
  const deskOffId = await person("desk-off", role.desk, { organizationId: null, branchId: null, isActive: false })
  const viewerId = await person("viewer", role.viewer, { organizationId: organizationA.id, branchId: branchA1.id })
  const portalId = await person("portal", role.portal, { organizationId: organizationA.id, branchId: branchA1.id })

  await db.insert(orderDeskAssignments).values([
    { userId: deskId, organizationId: organizationA.id, branchId: null, createdByUserId: superAdminId },
    { userId: deskId, organizationId: organizationB.id, branchId: branchB1.id, createdByUserId: superAdminId },
    // A grant to an organization that is not managed: it must reach nothing.
    { userId: deskId, organizationId: organizationC.id, branchId: null, createdByUserId: superAdminId },
    { userId: desk2Id, organizationId: organizationA.id, branchId: branchA2.id, createdByUserId: superAdminId },
    { userId: deskOffId, organizationId: organizationA.id, branchId: null, createdByUserId: superAdminId },
  ])

  const [product] = await db
    .insert(globalProducts)
    .values({
      productCode: `ITD-P-${suffix}`,
      name: `ITD Product ${suffix}`,
      basePrice: ORDER_DESK_FIXTURE_PRICE_CENTS.base,
      status: "active",
      unit: "box",
      stockQuantity: 1_000,
    })
    .returning({ id: globalProducts.id })

  const [inventoryA, inventoryB, inventoryC] = await db
    .insert(organizationInventory)
    .values([
      { organizationId: organizationA.id, globalProductId: product.id, isActive: true, customPrice: ORDER_DESK_FIXTURE_PRICE_CENTS.organizationA, assignedByUserId: superAdminId },
      { organizationId: organizationB.id, globalProductId: product.id, isActive: true, assignedByUserId: superAdminId },
      { organizationId: organizationC.id, globalProductId: product.id, isActive: true, assignedByUserId: superAdminId },
    ])
    .returning({ id: organizationInventory.id })

  await db.insert(branchInventory).values([
    { branchId: branchA1.id, organizationId: organizationA.id, organizationInventoryId: inventoryA.id, assignedByUserId: superAdminId },
    { branchId: branchA2.id, organizationId: organizationA.id, organizationInventoryId: inventoryA.id, assignedByUserId: superAdminId },
    { branchId: branchA3.id, organizationId: organizationA.id, organizationInventoryId: inventoryA.id, assignedByUserId: superAdminId },
    { branchId: branchB1.id, organizationId: organizationB.id, organizationInventoryId: inventoryB.id, assignedByUserId: superAdminId },
    { branchId: branchC1.id, organizationId: organizationC.id, organizationInventoryId: inventoryC.id, assignedByUserId: superAdminId },
  ])

  const [budget] = await db
    .insert(budgets)
    .values({
      organizationId: organizationB.id,
      branchId: branchB1.id,
      period: currentBudgetPeriod(),
      amountAllocatedCents: 1_000_000,
    })
    .returning({ id: budgets.id })

  return {
    suffix,
    organizationA: organizationA.id,
    organizationB: organizationB.id,
    organizationC: organizationC.id,
    branchA1: branchA1.id,
    branchA2: branchA2.id,
    branchA3: branchA3.id,
    branchB1: branchB1.id,
    branchC1: branchC1.id,
    superAdminId,
    headOfficeId,
    deskId,
    desk2Id,
    deskOffId,
    viewerId,
    portalId,
    productId: product.id,
    inventoryA: inventoryA.id,
    inventoryB: inventoryB.id,
    inventoryC: inventoryC.id,
    budgetB1: budget.id,
  }
}

export async function destroyOrderDeskFixtures(f: OrderDeskFixtures, extraUserIds: string[] = []): Promise<void> {
  const organizationIds = [f.organizationA, f.organizationB, f.organizationC]
  const userIds = [f.superAdminId, f.headOfficeId, f.deskId, f.desk2Id, f.deskOffId, f.viewerId, f.portalId, ...extraUserIds]

  await db.delete(notifications).where(inArray(notifications.organizationId, organizationIds))
  await db.delete(emailOutbox).where(inArray(emailOutbox.organizationId, organizationIds))
  await db.delete(systemLogs).where(or(inArray(systemLogs.organizationId, organizationIds), inArray(systemLogs.userId, userIds)))
  await db.delete(auditLogs).where(or(inArray(auditLogs.organizationId, organizationIds), inArray(auditLogs.userId, userIds)))
  const refundRows = await db.select({ id: refunds.id }).from(refunds).where(inArray(refunds.organizationId, organizationIds))
  if (refundRows.length > 0) {
    await db.delete(refundItems).where(inArray(refundItems.refundId, refundRows.map((row) => row.id)))
  }
  await db.delete(refunds).where(inArray(refunds.organizationId, organizationIds))
  await db.delete(orderItems).where(inArray(orderItems.organizationId, organizationIds))
  await db.delete(orders).where(inArray(orders.organizationId, organizationIds))
  await db.delete(budgets).where(inArray(budgets.organizationId, organizationIds))
  await db.delete(invoiceSequences).where(inArray(invoiceSequences.organizationId, organizationIds))
  await db.delete(orderDeskAssignments).where(inArray(orderDeskAssignments.userId, userIds))
  await db.delete(branchInventory).where(inArray(branchInventory.organizationId, organizationIds))
  await db.delete(organizationInventory).where(inArray(organizationInventory.organizationId, organizationIds))
  await db.delete(sessions).where(inArray(sessions.userId, userIds))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
  await db.delete(globalProducts).where(eq(globalProducts.id, f.productId))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}
