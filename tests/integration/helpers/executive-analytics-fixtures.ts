import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"

import {
  branches,
  categories,
  globalProducts,
  orderItems,
  orders,
  organizations,
  refundItems,
  refunds,
  roles,
  userBranchAssignments,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"

export { NO_DATABASE_REASON, hasTestDatabase } from "./pricing-fixtures"

/**
 * Fixtures for the Executive Analytics Center — the Product Performance tab
 * in particular.
 *
 * Two tenants, so every read can be checked for leakage, and a small order
 * history shaped so that every figure the tab shows has an answer a reviewer
 * can work out by hand from this comment alone.
 *
 * ```
 * organization A                                   organization B (neighbour)
 *   branches: North, South                            branch: Foreign
 *   people:   Ahmed (ORDER_PORTAL, North)             Foreign user (ORDER_PORTAL)
 *             Sana  (ORDER_PORTAL, South)             Head Office B
 *             Group requester (GROUP_ORDER_PORTAL,
 *                              orders at both branches)
 *             Head Office A, Branch Admin A
 *             South approver (GROUP_USER, assigned
 *                             to South only — plus a
 *                             stale row naming Foreign)
 *             Idle approver (GROUP_USER, no assignments)
 *   Super Admin (no tenant)
 *   categories: Stationery ─ Paper (subcategory), Fuel
 *   products:   Paper  (Stationery/Paper)   sold per Ream and per Box
 *               Toner  (Stationery)         per Piece
 *               Diesel (Fuel)               per Litre
 *
 *   #   date        branch  requester  status     lines (product qty unit @ price)    total
 *   O1  2026-06-10  North   Ahmed      FULFILLED  Paper 10 Ream @500; Toner 2 Piece @3000   11000
 *   O2  2026-06-20  South   Sana       APPROVED   Paper 4 Ream @500; Diesel 50 Litre @100    7000
 *   O3  2026-07-05  North   Ahmed      PARTIAL    Paper 6 Ream @500                          3000
 *                                                 ↳ APPROVED refund: 2 Ream, 1000
 *   O4  2026-07-15  South   Group      FULFILLED  Toner 1 Piece @3000; Paper 2 Box @2500     8000
 *   O5  2026-08-03  North   Group      APPROVED   Diesel 20 Litre @100                       2000
 *   O6  2026-08-12  North   Ahmed      PENDING    Paper 100 Ream @500                       50000  (Consumed only)
 *   O7  2026-08-14  South   Sana       CANCELLED  Toner 5 Piece @3000                       15000  (never counted)
 *   O9  2026-08-16  South   Sana       REFUNDED   Paper 80 Ream @500                        40000  (never counted)
 *   O8  2026-08-20  South   Sana       FULFILLED  Paper 3 Ream @500                          1500
 *   OB  2026-07-10  Foreign Foreign    FULFILLED  Foreign Product 7 Piece @1000              7000  (tenant B)
 * ```
 *
 * Hand-computed answers for tenant A over 1 Jun – 31 Aug 2026 (all in cents):
 *
 *   Procurement Value, whole-order, net of the refund
 *     total 31500 · North 15000 · South 16500
 *     Ahmed 13000 · Group 10000 · Sana 8500
 *     2026-06 18000 · 2026-07 10000 · 2026-08 3500
 *   Procurement Value by product (line-by-line)
 *     Paper 15500 · Toner 9000 · Diesel 7000
 *   Consumed (spent + held), with pending included and refunded orders excluded
 *     total 81500 · North 65000 · South 16500
 *     Ahmed 63000 · Group 10000 · Sana 8500
 *     2026-06 18000 · 2026-07 10000 · 2026-08 53500
 *     by product: Paper 65500 · Toner 9000 · Diesel 7000
 *   Paper in focus (line-by-line): North 7000 · South 8500 · Ahmed 7000 · Group 5000 · Sana 3500
 *   Quantity counts ordered items regardless of their unit label
 *     Paper: 23 (North 14, South 9) · Diesel: 70 (North 20, South 50) · Toner: 3
 *
 *   The South approver (GROUP_USER assigned to South) sees O2, O4 and O8 only:
 *     total 16500 · Sana 8500 · Group 8000
 *     2026-06 7000 · 2026-07 8000 · 2026-08 1500
 *     by product (line-by-line): Paper 8500 · Diesel 5000 · Toner 3000
 *     North, Ahmed, and everything of tenant B's are outside its reach.
 *
 * Every row carries a unique suffix; `destroyExecutiveAnalyticsFixtures`
 * removes them children-first.
 */

export const WINDOW = { startDate: "2026-06-01", endDate: "2026-08-31" } as const

export type ExecutiveAnalyticsFixtures = {
  suffix: string
  organizationId: number
  neighbourOrganizationId: number
  northBranchId: number
  southBranchId: number
  foreignBranchId: number
  superAdminId: string
  headOfficeId: string
  neighbourHeadOfficeId: string
  branchAdminId: string
  ahmedId: string
  sanaId: string
  groupRequesterId: string
  southApproverId: string
  idleApproverId: string
  foreignUserId: string
  stationeryCategoryId: number
  paperCategoryId: number
  fuelCategoryId: number
  paperProductId: number
  tonerProductId: number
  dieselProductId: number
  foreignProductId: number
  orderIds: Record<"O1" | "O2" | "O3" | "O4" | "O5" | "O6" | "O7" | "O8" | "O9" | "OB", number>
  /** Every order line, keyed by order then position, for drill-down assertions. */
  lineIds: number[]
  refundId: number
  names: {
    north: string
    south: string
    foreign: string
    ahmed: string
    sana: string
    group: string
    paper: string
    toner: string
    diesel: string
  }
}

/** Midday UTC is late afternoon in Karachi, so every row sits inside its calendar day in both zones. */
function at(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`)
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

type LineSpec = { productId: number; name: string; unit: string; quantity: number; priceCents: number }

export async function createExecutiveAnalyticsFixtures(): Promise<ExecutiveAnalyticsFixtures> {
  const suffix = randomUUID().slice(0, 8)
  const role = {
    superAdmin: await resolveRoleId("SUPER_ADMIN"),
    headOffice: await resolveRoleId("HEAD_OFFICE"),
    branchAdmin: await resolveRoleId("BRANCH_ADMIN"),
    orderPortal: await resolveRoleId("ORDER_PORTAL"),
    groupOrderPortal: await resolveRoleId("GROUP_ORDER_PORTAL"),
    groupUser: await resolveRoleId("GROUP_USER"),
  }

  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Exec Org ${suffix}`, code: `ITE-${suffix}` })
    .returning({ id: organizations.id })
  const [neighbour] = await db
    .insert(organizations)
    .values({ name: `IT Exec Neighbour ${suffix}`, code: `ITX-${suffix}` })
    .returning({ id: organizations.id })

  const names = {
    north: `North ${suffix}`,
    south: `South ${suffix}`,
    foreign: `Foreign ${suffix}`,
    ahmed: `Ahmed ${suffix}`,
    sana: `Sana ${suffix}`,
    group: `Group Requester ${suffix}`,
    paper: `Paper ${suffix}`,
    toner: `Toner ${suffix}`,
    diesel: `Diesel ${suffix}`,
  }

  const [north] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: names.north, status: "active" })
    .returning({ id: branches.id })
  const [south] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: names.south, status: "active" })
    .returning({ id: branches.id })
  const [foreign] = await db
    .insert(branches)
    .values({ organizationId: neighbour.id, name: names.foreign, status: "active" })
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
        email: `it-exec-${label}-${suffix}@example.test`,
        passwordHash: "not-a-real-hash",
        roleId,
        organizationId,
        branchId,
        fullName,
      })
      .returning({ id: users.id })
    return row.id
  }

  const superAdminId = await person("super", role.superAdmin, null, null, `Super Admin ${suffix}`)
  const headOfficeId = await person("ho-a", role.headOffice, organization.id, null, `Head Office A ${suffix}`)
  const neighbourHeadOfficeId = await person("ho-b", role.headOffice, neighbour.id, null, `Head Office B ${suffix}`)
  const branchAdminId = await person("ba", role.branchAdmin, organization.id, north.id, `Branch Admin ${suffix}`)
  const ahmedId = await person("ahmed", role.orderPortal, organization.id, north.id, names.ahmed)
  const sanaId = await person("sana", role.orderPortal, organization.id, south.id, names.sana)
  const groupRequesterId = await person("group", role.groupOrderPortal, organization.id, null, names.group)
  const southApproverId = await person("approver", role.groupUser, organization.id, null, `South Approver ${suffix}`)
  const idleApproverId = await person("idle", role.groupUser, organization.id, null, `Idle Approver ${suffix}`)
  const foreignUserId = await person("foreign", role.orderPortal, neighbour.id, foreign.id, `Foreign User ${suffix}`)

  // The approver reaches South and nothing else. The second row is a stale or
  // inconsistent assignment giving tenant A's approver the neighbour's branch;
  // every read must re-assert the tenant and drop it rather than reach Foreign.
  // It carries the neighbour's id because the database refuses a branch filed
  // under another organization's id (user_branch_assignments_branch_org_fk,
  // plans/OF-DB-tenant-composite-foreign-keys.md); nothing ties the row's
  // organization to its user's, so this shape can still exist.
  await db.insert(userBranchAssignments).values([
    { userId: southApproverId, branchId: south.id, organizationId: organization.id, createdByUserId: headOfficeId },
    { userId: southApproverId, branchId: foreign.id, organizationId: neighbour.id, createdByUserId: headOfficeId },
  ])

  const [stationery] = await db
    .insert(categories)
    .values({ name: `Stationery ${suffix}` })
    .returning({ id: categories.id })
  const [paperCategory] = await db
    .insert(categories)
    .values({ name: `Paper ${suffix}`, parentId: stationery.id })
    .returning({ id: categories.id })
  const [fuel] = await db
    .insert(categories)
    .values({ name: `Fuel ${suffix}` })
    .returning({ id: categories.id })

  async function product(code: string, name: string, categoryId: number | null, unit: string): Promise<number> {
    const [row] = await db
      .insert(globalProducts)
      .values({ productCode: `${code}-${suffix}`, name, categoryId, basePrice: 0, status: "active", unit })
      .returning({ id: globalProducts.id })
    return row.id
  }

  const paperProductId = await product("ITE-PAPER", names.paper, paperCategory.id, "Ream")
  const tonerProductId = await product("ITE-TONER", names.toner, stationery.id, "Piece")
  const dieselProductId = await product("ITE-DIESEL", names.diesel, fuel.id, "Litre")
  const foreignProductId = await product("ITE-FOREIGN", `Foreign Product ${suffix}`, null, "Piece")

  const lineIds: number[] = []
  let sequence = 0

  async function order(
    key: string,
    spec: {
      organizationId: number
      branchId: number
      createdByUserId: string
      status: string
      createdAt: Date
      lines: LineSpec[]
      refundAmountCents?: number
    },
  ): Promise<{ id: number; lineIds: number[] }> {
    sequence += 1
    const totalCents = spec.lines.reduce((sum, line) => sum + Math.round(line.priceCents * line.quantity), 0)
    const [row] = await db
      .insert(orders)
      .values({
        tid: `ITE-${suffix}-${key}-${sequence}`,
        organizationId: spec.organizationId,
        branchId: spec.branchId,
        createdByUserId: spec.createdByUserId,
        status: spec.status,
        subtotalCents: totalCents,
        taxCents: 0,
        totalCents,
        refundAmountCents: spec.refundAmountCents ?? null,
        createdAt: spec.createdAt,
      })
      .returning({ id: orders.id })

    const inserted = await db
      .insert(orderItems)
      .values(spec.lines.map((line) => ({
        organizationId: spec.organizationId,
        orderId: row.id,
        globalProductId: line.productId,
        productName: line.name,
        unit: line.unit,
        quantity: line.quantity,
        priceCents: line.priceCents,
        taxCents: 0,
        createdAt: spec.createdAt,
      })))
      .returning({ id: orderItems.id })

    const ids = inserted.map((line) => line.id)
    lineIds.push(...ids)
    return { id: row.id, lineIds: ids }
  }

  const paper = (quantity: number, unit = "Ream", priceCents = 500): LineSpec =>
    ({ productId: paperProductId, name: names.paper, unit, quantity, priceCents })
  const toner = (quantity: number): LineSpec =>
    ({ productId: tonerProductId, name: names.toner, unit: "Piece", quantity, priceCents: 3000 })
  const diesel = (quantity: number): LineSpec =>
    ({ productId: dieselProductId, name: names.diesel, unit: "Litre", quantity, priceCents: 100 })

  const A = organization.id
  const O1 = await order("O1", { organizationId: A, branchId: north.id, createdByUserId: ahmedId, status: "FULFILLED", createdAt: at("2026-06-10"), lines: [paper(10), toner(2)] })
  const O2 = await order("O2", { organizationId: A, branchId: south.id, createdByUserId: sanaId, status: "APPROVED", createdAt: at("2026-06-20"), lines: [paper(4), diesel(50)] })
  const O3 = await order("O3", { organizationId: A, branchId: north.id, createdByUserId: ahmedId, status: "PARTIAL", createdAt: at("2026-07-05"), lines: [paper(6)], refundAmountCents: 1000 })
  const O4 = await order("O4", { organizationId: A, branchId: south.id, createdByUserId: groupRequesterId, status: "FULFILLED", createdAt: at("2026-07-15"), lines: [toner(1), paper(2, "Box", 2500)] })
  const O5 = await order("O5", { organizationId: A, branchId: north.id, createdByUserId: groupRequesterId, status: "APPROVED", createdAt: at("2026-08-03"), lines: [diesel(20)] })
  const O6 = await order("O6", { organizationId: A, branchId: north.id, createdByUserId: ahmedId, status: "PENDING", createdAt: at("2026-08-12"), lines: [paper(100)] })
  const O7 = await order("O7", { organizationId: A, branchId: south.id, createdByUserId: sanaId, status: "CANCELLED", createdAt: at("2026-08-14"), lines: [toner(5)] })
  const O8 = await order("O8", { organizationId: A, branchId: south.id, createdByUserId: sanaId, status: "FULFILLED", createdAt: at("2026-08-20"), lines: [paper(3)] })
  const O9 = await order("O9", { organizationId: A, branchId: south.id, createdByUserId: sanaId, status: "REFUNDED", createdAt: at("2026-08-16"), lines: [paper(80)] })
  const OB = await order("OB", {
    organizationId: neighbour.id, branchId: foreign.id, createdByUserId: foreignUserId, status: "FULFILLED", createdAt: at("2026-07-10"),
    lines: [{ productId: foreignProductId, name: `Foreign Product ${suffix}`, unit: "Piece", quantity: 7, priceCents: 1000 }],
  })

  // The one refund: 2 of O3's 6 reams, approved, worth 1000.
  const [refund] = await db
    .insert(refunds)
    .values({
      organizationId: A,
      orderId: O3.id,
      amountCents: 1000,
      taxRefundCents: 0,
      status: "APPROVED",
      refundNumber: `RF-${suffix}`,
      requestedByUserId: ahmedId,
      processedByUserId: headOfficeId,
    })
    .returning({ id: refunds.id })
  await db.insert(refundItems).values({ refundId: refund.id, orderItemId: O3.lineIds[0], quantity: 2, amountCents: 1000 })

  return {
    suffix,
    organizationId: A,
    neighbourOrganizationId: neighbour.id,
    northBranchId: north.id,
    southBranchId: south.id,
    foreignBranchId: foreign.id,
    superAdminId,
    headOfficeId,
    neighbourHeadOfficeId,
    branchAdminId,
    ahmedId,
    sanaId,
    groupRequesterId,
    southApproverId,
    idleApproverId,
    foreignUserId,
    stationeryCategoryId: stationery.id,
    paperCategoryId: paperCategory.id,
    fuelCategoryId: fuel.id,
    paperProductId,
    tonerProductId,
    dieselProductId,
    foreignProductId,
    orderIds: { O1: O1.id, O2: O2.id, O3: O3.id, O4: O4.id, O5: O5.id, O6: O6.id, O7: O7.id, O8: O8.id, O9: O9.id, OB: OB.id },
    lineIds,
    refundId: refund.id,
    names,
  }
}

/** Remove every row the fixtures created, children before parents. */
export async function destroyExecutiveAnalyticsFixtures(fixtures: ExecutiveAnalyticsFixtures): Promise<void> {
  const orderIds = Object.values(fixtures.orderIds)
  const organizationIds = [fixtures.organizationId, fixtures.neighbourOrganizationId]

  await db.delete(refundItems).where(eq(refundItems.refundId, fixtures.refundId))
  await db.delete(refunds).where(eq(refunds.id, fixtures.refundId))
  await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
  await db.delete(orders).where(inArray(orders.id, orderIds))
  await db.delete(userBranchAssignments).where(eq(userBranchAssignments.userId, fixtures.southApproverId))
  await db.delete(users).where(inArray(users.id, [
    fixtures.superAdminId,
    fixtures.headOfficeId,
    fixtures.neighbourHeadOfficeId,
    fixtures.branchAdminId,
    fixtures.ahmedId,
    fixtures.sanaId,
    fixtures.groupRequesterId,
    fixtures.southApproverId,
    fixtures.idleApproverId,
    fixtures.foreignUserId,
  ]))
  await db.delete(branches).where(inArray(branches.id, [
    fixtures.northBranchId,
    fixtures.southBranchId,
    fixtures.foreignBranchId,
  ]))
  await db.delete(globalProducts).where(inArray(globalProducts.id, [
    fixtures.paperProductId,
    fixtures.tonerProductId,
    fixtures.dieselProductId,
    fixtures.foreignProductId,
  ]))
  // The subcategory references its parent, so it goes first.
  await db.delete(categories).where(eq(categories.id, fixtures.paperCategoryId))
  await db.delete(categories).where(inArray(categories.id, [fixtures.stationeryCategoryId, fixtures.fuelCategoryId]))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}
