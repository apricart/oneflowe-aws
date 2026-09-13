import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"

import {
  branches,
  globalProducts,
  orders,
  organizationInventory,
  organizations,
  roles,
  supportAttachments,
  supportThreads,
  userBranchAssignments,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"

export { NO_DATABASE_REASON, hasTestDatabase } from "./pricing-fixtures"

/**
 * Fixtures for the support-thread routes.
 *
 * Two tenants so every read can be checked for leakage, three branches so the
 * branch rule can be told apart from the organization rule, and one person in
 * every role the visibility table names. No threads are seeded here: the suite
 * raises them through the route so the create path is exercised too.
 *
 * ```
 * organization A                                    organization B (neighbour)
 *   branches: North, South                             branch: Foreign
 *   people:   Head Office A                            Head Office B
 *             Branch Admin North (BRANCH_ADMIN, North) Foreign requester
 *             Branch Admin South (BRANCH_ADMIN, South)   (ORDER_PORTAL, Foreign)
 *             Ahmed  (ORDER_PORTAL, North)
 *             Bilal  (ORDER_PORTAL, North)  ← Ahmed's colleague, same branch
 *             Sana   (ORDER_PORTAL, South)
 *             Group requester (GROUP_ORDER_PORTAL, no branch, assigned to North)
 *   Apricart (SUPER_ADMIN, no tenant)
 *
 *   catalogue: Carried   — assigned to A, active
 *              Withdrawn — assigned to A, is_active = false
 *              Foreign   — assigned to B
 *              Orphan    — in global_products, assigned to nobody
 *
 *   orders:    Ahmed's   (North, by Ahmed)
 *              Sana's    (South, by Sana)
 *              Foreign   (Foreign, by the foreign requester)
 * ```
 */
export type SupportFixtures = {
  suffix: string
  organizationId: number
  neighbourOrganizationId: number
  northBranchId: number
  southBranchId: number
  foreignBranchId: number
  superAdminId: string
  headOfficeId: string
  neighbourHeadOfficeId: string
  branchAdminNorthId: string
  branchAdminSouthId: string
  ahmedId: string
  bilalId: string
  sanaId: string
  groupRequesterId: string
  foreignUserId: string
  carriedProductId: number
  withdrawnProductId: number
  foreignProductId: number
  orphanProductId: number
  inventoryIds: number[]
  ahmedOrderId: number
  ahmedOrderTid: string
  sanaOrderId: number
  foreignOrderId: number
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by integration tests" })
    .returning({ id: roles.id })
  return created.id
}

export async function createSupportFixtures(): Promise<SupportFixtures> {
  const suffix = randomUUID().slice(0, 8)
  const role = {
    superAdmin: await resolveRoleId("SUPER_ADMIN"),
    headOffice: await resolveRoleId("HEAD_OFFICE"),
    branchAdmin: await resolveRoleId("BRANCH_ADMIN"),
    orderPortal: await resolveRoleId("ORDER_PORTAL"),
    groupOrderPortal: await resolveRoleId("GROUP_ORDER_PORTAL"),
  }

  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Support Org ${suffix}`, code: `ITS-${suffix}` })
    .returning({ id: organizations.id })
  const [neighbour] = await db
    .insert(organizations)
    .values({ name: `IT Support Neighbour ${suffix}`, code: `ITSN-${suffix}` })
    .returning({ id: organizations.id })

  const [north] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: `North ${suffix}`, status: "active" })
    .returning({ id: branches.id })
  const [south] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: `South ${suffix}`, status: "active" })
    .returning({ id: branches.id })
  const [foreign] = await db
    .insert(branches)
    .values({ organizationId: neighbour.id, name: `Foreign ${suffix}`, status: "active" })
    .returning({ id: branches.id })

  async function person(
    label: string,
    roleId: number,
    organizationId: number | null,
    branchId: number | null,
    fullName: string,
  ): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `it-support-${label}-${suffix}@example.test`,
        passwordHash: "not-a-real-hash",
        roleId,
        organizationId,
        branchId,
        fullName,
      })
      .returning({ id: users.id })
    return row.id
  }

  const superAdminId = await person("apricart", role.superAdmin, null, null, `Apricart ${suffix}`)
  const headOfficeId = await person("ho-a", role.headOffice, organization.id, null, `Head Office A ${suffix}`)
  const neighbourHeadOfficeId = await person("ho-b", role.headOffice, neighbour.id, null, `Head Office B ${suffix}`)
  const branchAdminNorthId = await person("ba-north", role.branchAdmin, organization.id, north.id, `Branch Admin North ${suffix}`)
  const branchAdminSouthId = await person("ba-south", role.branchAdmin, organization.id, south.id, `Branch Admin South ${suffix}`)
  const ahmedId = await person("ahmed", role.orderPortal, organization.id, north.id, `Ahmed ${suffix}`)
  const bilalId = await person("bilal", role.orderPortal, organization.id, north.id, `Bilal ${suffix}`)
  const sanaId = await person("sana", role.orderPortal, organization.id, south.id, `Sana ${suffix}`)
  const groupRequesterId = await person("group", role.groupOrderPortal, organization.id, null, `Group Requester ${suffix}`)
  const foreignUserId = await person("foreign", role.orderPortal, neighbour.id, foreign.id, `Foreign Requester ${suffix}`)

  // The group requester covers North through a branch assignment, which is
  // what `resolveScopedBranchIds` reads.
  await db.insert(userBranchAssignments).values({
    userId: groupRequesterId,
    branchId: north.id,
    organizationId: organization.id,
    createdByUserId: headOfficeId,
  })

  async function product(code: string, name: string): Promise<number> {
    const [row] = await db
      .insert(globalProducts)
      .values({ productCode: `${code}-${suffix}`, name, basePrice: 100, status: "active", unit: "Piece" })
      .returning({ id: globalProducts.id })
    return row.id
  }

  const carriedProductId = await product("ITS-CARRIED", `Carried ${suffix}`)
  const withdrawnProductId = await product("ITS-WITHDRAWN", `Withdrawn ${suffix}`)
  const foreignProductId = await product("ITS-FOREIGN", `Foreign Product ${suffix}`)
  const orphanProductId = await product("ITS-ORPHAN", `Orphan ${suffix}`)

  const inventoryRows = await db
    .insert(organizationInventory)
    .values([
      { organizationId: organization.id, globalProductId: carriedProductId, assignedByUserId: superAdminId, isActive: true, customName: `Our Carried ${suffix}` },
      { organizationId: organization.id, globalProductId: withdrawnProductId, assignedByUserId: superAdminId, isActive: false },
      { organizationId: neighbour.id, globalProductId: foreignProductId, assignedByUserId: superAdminId, isActive: true },
    ])
    .returning({ id: organizationInventory.id })

  async function order(key: string, organizationId: number, branchId: number, createdByUserId: string): Promise<{ id: number; tid: string }> {
    const tid = `ITS-${suffix}-${key}`
    const [row] = await db
      .insert(orders)
      .values({
        tid,
        organizationId,
        branchId,
        createdByUserId,
        status: "APPROVED",
        subtotalCents: 1000,
        taxCents: 0,
        totalCents: 1000,
      })
      .returning({ id: orders.id })
    return { id: row.id, tid }
  }

  const ahmedOrder = await order("AHMED", organization.id, north.id, ahmedId)
  const sanaOrder = await order("SANA", organization.id, south.id, sanaId)
  const foreignOrder = await order("FOREIGN", neighbour.id, foreign.id, foreignUserId)

  return {
    suffix,
    organizationId: organization.id,
    neighbourOrganizationId: neighbour.id,
    northBranchId: north.id,
    southBranchId: south.id,
    foreignBranchId: foreign.id,
    superAdminId,
    headOfficeId,
    neighbourHeadOfficeId,
    branchAdminNorthId,
    branchAdminSouthId,
    ahmedId,
    bilalId,
    sanaId,
    groupRequesterId,
    foreignUserId,
    carriedProductId,
    withdrawnProductId,
    foreignProductId,
    orphanProductId,
    inventoryIds: inventoryRows.map((row) => row.id),
    ahmedOrderId: ahmedOrder.id,
    ahmedOrderTid: ahmedOrder.tid,
    sanaOrderId: sanaOrder.id,
    foreignOrderId: foreignOrder.id,
  }
}

/**
 * Children first. Deleting a thread cascades to its messages, attachments,
 * read markers, notifications and outbox rows, so only the threads and any
 * never-claimed uploads need naming.
 */
export async function destroySupportFixtures(f: SupportFixtures): Promise<void> {
  const organizationIds = [f.organizationId, f.neighbourOrganizationId]
  const userIds = [
    f.superAdminId,
    f.headOfficeId,
    f.neighbourHeadOfficeId,
    f.branchAdminNorthId,
    f.branchAdminSouthId,
    f.ahmedId,
    f.bilalId,
    f.sanaId,
    f.groupRequesterId,
    f.foreignUserId,
  ]

  await db.delete(supportThreads).where(inArray(supportThreads.organizationId, organizationIds))
  await db.delete(supportAttachments).where(inArray(supportAttachments.organizationId, organizationIds))
  await db.delete(orders).where(inArray(orders.id, [f.ahmedOrderId, f.sanaOrderId, f.foreignOrderId]))
  await db.delete(organizationInventory).where(inArray(organizationInventory.id, f.inventoryIds))
  await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.userId, userIds))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(branches).where(inArray(branches.id, [f.northBranchId, f.southBranchId, f.foreignBranchId]))
  await db.delete(globalProducts).where(inArray(globalProducts.id, [
    f.carriedProductId,
    f.withdrawnProductId,
    f.foreignProductId,
    f.orphanProductId,
  ]))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}
