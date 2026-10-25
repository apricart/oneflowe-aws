import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"

import {
  branches,
  categories,
  globalProducts,
  groups,
  orderItems,
  orders,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"

export { NO_DATABASE_REASON, hasTestDatabase } from "./pricing-fixtures"

/**
 * Fixtures for the Product Performance filter matrix — every filter the tab
 * offers, alone and stacked, and the date range at its Karachi edges.
 *
 * `executive-analytics-fixtures.ts` places every order at 12:00 UTC so that
 * each one sits inside its calendar day in both zones. That is what let a
 * bucket expression ten hours out of step with Karachi pass every test. These
 * fixtures do the opposite on purpose: four orders sit minutes either side of
 * a Karachi midnight, two of them on a month boundary.
 *
 * ```
 * one organization, two groups and an ungrouped branch
 *   Group One:  North, East          Group Two: South          (no group): West
 *   people:     Ahmed (North)  Bilal (East)  Sana (South)  Wali (West), all ORDER_PORTAL
 *   categories: Stationery ─ Paper (subcategory), Fuel
 *   products:   Paper (Stationery/Paper) · Toner (Stationery) · Diesel (Fuel)
 *
 *   #   created (UTC)          = Karachi            branch requester status     lines (product qty @ price)       total
 *   B0  2026-08-31 18:30       = 08-31 23:30        North  Ahmed     FULFILLED  Diesel 9 @100                       900
 *   B4  2026-09-01 03:00       = 09-01 08:00        East   Bilal     FULFILLED  Toner 1 @3000                      3000
 *   P1  2026-09-10 12:00       = 09-10 17:00        North  Ahmed     FULFILLED  Paper 10 @500; Toner 2 @3000      11000
 *   P2  2026-09-15 12:00       = 09-15 17:00        East   Bilal     APPROVED   Paper 4 @500; Diesel 30 @100       5000
 *   P3  2026-09-20 12:00       = 09-20 17:00        South  Sana      FULFILLED  Paper 6 @500; Toner 1 @3000        6000
 *   B1  2026-09-30 19:30       = 10-01 00:30        North  Ahmed     FULFILLED  Paper 1 @500                        500
 *   P4  2026-10-05 12:00       = 10-05 17:00        North  Ahmed     PENDING    Diesel 50 @100                     5000  (Consumed only)
 *   P5  2026-10-08 12:00       = 10-08 17:00        West   Wali      FULFILLED  Paper 8 @500                       4000
 *   P6  2026-10-12 12:00       = 10-12 17:00        East   Bilal     FULFILLED  Toner 3 @3000; Paper 2 @500       10000
 *   P7  2026-10-20 12:00       = 10-20 17:00        South  Sana      REJECTED   Paper 50 @500                     25000  (never counted)
 *   B2  2026-10-31 18:59:59    = 10-31 23:59:59     South  Sana      FULFILLED  Diesel 7 @100                       700
 *   B3  2026-10-31 19:00       = 11-01 00:00        South  Sana      FULFILLED  Paper 9 @500                       4500
 * ```
 *
 * Hand-computed answers over 1 Sep – 31 Oct 2026, Karachi (cents). B0 and B3
 * fall outside it by thirty minutes and by one second respectively.
 *
 *   Procurement Value (revenue: approved and fulfilled)
 *     total 40200
 *     branch    North 11500 · East 18000 · South 6700 · West 4000
 *     group     Group One 29500 · Group Two 6700 · No group 4000
 *     requester Bilal 18000 · Ahmed 11500 · Sana 6700 · Wali 4000
 *     month     2026-09 25000 (P1 P2 P3 B4) · 2026-10 15200 (B1 P5 P6 B2)
 *     product   Toner 21000 · Paper 15500 · Diesel 3700
 *     category  Stationery 36500 · Fuel 3700
 *     quantity  Paper 31 · Diesel 37 · Toner 7
 *
 *   Group One + Paper                      8500  North 5500 (P1 B1) · East 3000 (P2 P6)
 *                                                months 2026-09 7000 · 2026-10 1500
 *                                                days 09-10 5000 · 09-15 2000 · 10-01 500 · 10-12 1000
 *                                                quantity 17 (North 11 · East 6)
 *   Group One + Paper, Toner              26500  Toner 18000 · Paper 8500
 *                                                North 11500 · East 15000 · 2026-09 16000 · 2026-10 10500
 *                                                grid Ahmed×Paper 5500 Ahmed×Toner 6000 Bilal×Paper 3000 Bilal×Toner 12000
 *   Group One + Stationery + Bilal        15000  Toner 12000 · Paper 3000
 *   Group One + East + Toner              12000  2026-09 3000 (B4) · 2026-10 9000 (P6)
 *   Group One, Group Two + Diesel          3700  Group One 3000 · Group Two 700
 *   Group Two + Fuel                        700  2026-10 only
 *   Group Two + Toner, October only           0  (P3 is September)
 *   Group One + Diesel, Consumed           8000  P2 3000 + P4 5000 (revenue 3000)
 *
 *   Single-day windows (Karachi): 08-31 → B0 900 · 09-01 → B4 3000 · 10-01 → B1 500 · 10-31 → B2 700
 *   October alone vs the 31 days before it (31 Aug – 30 Sep Karachi):
 *     North 500 vs 11900 (P1 + B0) · East 10000 vs 8000 (P2 + B4)
 *
 * Every row carries a unique suffix; `destroyProductPerformanceFilterFixtures`
 * removes them children-first.
 */

export const FILTER_WINDOW = { startDate: "2026-09-01", endDate: "2026-10-31" } as const

type OrderKey = "B0" | "B1" | "B2" | "B3" | "B4" | "P1" | "P2" | "P3" | "P4" | "P5" | "P6" | "P7"

export type ProductPerformanceFilterFixtures = {
  suffix: string
  organizationId: number
  headOfficeId: string
  groupOneId: number
  groupTwoId: number
  northBranchId: number
  eastBranchId: number
  southBranchId: number
  westBranchId: number
  ahmedId: string
  bilalId: string
  sanaId: string
  waliId: string
  stationeryCategoryId: number
  paperCategoryId: number
  fuelCategoryId: number
  paperProductId: number
  tonerProductId: number
  dieselProductId: number
  orderIds: Record<OrderKey, number>
  names: Record<
    "groupOne" | "groupTwo" | "north" | "east" | "south" | "west" | "ahmed" | "bilal" | "sana" | "wali"
    | "paper" | "toner" | "diesel" | "stationery" | "fuel",
    string
  >
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

export async function createProductPerformanceFilterFixtures(): Promise<ProductPerformanceFilterFixtures> {
  const suffix = randomUUID().slice(0, 8)
  const headOfficeRole = await resolveRoleId("HEAD_OFFICE")
  const orderPortalRole = await resolveRoleId("ORDER_PORTAL")

  const names = {
    groupOne: `Group One ${suffix}`,
    groupTwo: `Group Two ${suffix}`,
    north: `North ${suffix}`,
    east: `East ${suffix}`,
    south: `South ${suffix}`,
    west: `West ${suffix}`,
    ahmed: `Ahmed ${suffix}`,
    bilal: `Bilal ${suffix}`,
    sana: `Sana ${suffix}`,
    wali: `Wali ${suffix}`,
    paper: `Paper ${suffix}`,
    toner: `Toner ${suffix}`,
    diesel: `Diesel ${suffix}`,
    stationery: `Stationery ${suffix}`,
    fuel: `Fuel ${suffix}`,
  }

  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Filter Org ${suffix}`, code: `ITPF-${suffix}` })
    .returning({ id: organizations.id })
  const A = organization.id

  async function person(label: string, roleId: number, branchId: number | null, fullName: string): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `it-pf-${label}-${suffix}@example.test`,
        passwordHash: "not-a-real-hash",
        roleId,
        organizationId: A,
        branchId,
        fullName,
      })
      .returning({ id: users.id })
    return row.id
  }

  // Groups name their creator, so Head Office comes first.
  const headOfficeId = await person("ho", headOfficeRole, null, `Head Office ${suffix}`)
  const [groupOne] = await db
    .insert(groups)
    .values({ organizationId: A, name: names.groupOne, createdByUserId: headOfficeId })
    .returning({ id: groups.id })
  const [groupTwo] = await db
    .insert(groups)
    .values({ organizationId: A, name: names.groupTwo, createdByUserId: headOfficeId })
    .returning({ id: groups.id })

  async function branch(name: string, groupId: number | null): Promise<number> {
    const [row] = await db
      .insert(branches)
      .values({ organizationId: A, name, status: "active", groupId })
      .returning({ id: branches.id })
    return row.id
  }

  const northBranchId = await branch(names.north, groupOne.id)
  const eastBranchId = await branch(names.east, groupOne.id)
  const southBranchId = await branch(names.south, groupTwo.id)
  const westBranchId = await branch(names.west, null)

  const ahmedId = await person("ahmed", orderPortalRole, northBranchId, names.ahmed)
  const bilalId = await person("bilal", orderPortalRole, eastBranchId, names.bilal)
  const sanaId = await person("sana", orderPortalRole, southBranchId, names.sana)
  const waliId = await person("wali", orderPortalRole, westBranchId, names.wali)

  const [stationery] = await db.insert(categories).values({ name: names.stationery }).returning({ id: categories.id })
  const [paperCategory] = await db
    .insert(categories)
    .values({ name: `Paper Sub ${suffix}`, parentId: stationery.id })
    .returning({ id: categories.id })
  const [fuel] = await db.insert(categories).values({ name: names.fuel }).returning({ id: categories.id })

  async function product(code: string, name: string, categoryId: number, unit: string): Promise<number> {
    const [row] = await db
      .insert(globalProducts)
      .values({ productCode: `${code}-${suffix}`, name, categoryId, basePrice: 0, status: "active", unit })
      .returning({ id: globalProducts.id })
    return row.id
  }

  const paperProductId = await product("ITPF-PAPER", names.paper, paperCategory.id, "Ream")
  const tonerProductId = await product("ITPF-TONER", names.toner, stationery.id, "Piece")
  const dieselProductId = await product("ITPF-DIESEL", names.diesel, fuel.id, "Litre")

  const paper = (quantity: number): LineSpec =>
    ({ productId: paperProductId, name: names.paper, unit: "Ream", quantity, priceCents: 500 })
  const toner = (quantity: number): LineSpec =>
    ({ productId: tonerProductId, name: names.toner, unit: "Piece", quantity, priceCents: 3000 })
  const diesel = (quantity: number): LineSpec =>
    ({ productId: dieselProductId, name: names.diesel, unit: "Litre", quantity, priceCents: 100 })

  let sequence = 0
  async function order(
    key: OrderKey,
    spec: { branchId: number; createdByUserId: string; status: string; createdAt: string; lines: LineSpec[] },
  ): Promise<number> {
    sequence += 1
    const createdAt = new Date(spec.createdAt)
    const totalCents = spec.lines.reduce((sum, line) => sum + Math.round(line.priceCents * line.quantity), 0)
    const [row] = await db
      .insert(orders)
      .values({
        tid: `ITPF-${suffix}-${key}-${sequence}`,
        organizationId: A,
        branchId: spec.branchId,
        createdByUserId: spec.createdByUserId,
        status: spec.status,
        subtotalCents: totalCents,
        taxCents: 0,
        totalCents,
        createdAt,
      })
      .returning({ id: orders.id })
    await db.insert(orderItems).values(spec.lines.map((line) => ({
      organizationId: A,
      orderId: row.id,
      globalProductId: line.productId,
      productName: line.name,
      unit: line.unit,
      quantity: line.quantity,
      priceCents: line.priceCents,
      taxCents: 0,
      createdAt,
    })))
    return row.id
  }

  const orderIds: Record<OrderKey, number> = {
    B0: await order("B0", { branchId: northBranchId, createdByUserId: ahmedId, status: "FULFILLED", createdAt: "2026-08-31T18:30:00.000Z", lines: [diesel(9)] }),
    B4: await order("B4", { branchId: eastBranchId, createdByUserId: bilalId, status: "FULFILLED", createdAt: "2026-09-01T03:00:00.000Z", lines: [toner(1)] }),
    P1: await order("P1", { branchId: northBranchId, createdByUserId: ahmedId, status: "FULFILLED", createdAt: "2026-09-10T12:00:00.000Z", lines: [paper(10), toner(2)] }),
    P2: await order("P2", { branchId: eastBranchId, createdByUserId: bilalId, status: "APPROVED", createdAt: "2026-09-15T12:00:00.000Z", lines: [paper(4), diesel(30)] }),
    P3: await order("P3", { branchId: southBranchId, createdByUserId: sanaId, status: "FULFILLED", createdAt: "2026-09-20T12:00:00.000Z", lines: [paper(6), toner(1)] }),
    B1: await order("B1", { branchId: northBranchId, createdByUserId: ahmedId, status: "FULFILLED", createdAt: "2026-09-30T19:30:00.000Z", lines: [paper(1)] }),
    P4: await order("P4", { branchId: northBranchId, createdByUserId: ahmedId, status: "PENDING", createdAt: "2026-10-05T12:00:00.000Z", lines: [diesel(50)] }),
    P5: await order("P5", { branchId: westBranchId, createdByUserId: waliId, status: "FULFILLED", createdAt: "2026-10-08T12:00:00.000Z", lines: [paper(8)] }),
    P6: await order("P6", { branchId: eastBranchId, createdByUserId: bilalId, status: "FULFILLED", createdAt: "2026-10-12T12:00:00.000Z", lines: [toner(3), paper(2)] }),
    P7: await order("P7", { branchId: southBranchId, createdByUserId: sanaId, status: "REJECTED", createdAt: "2026-10-20T12:00:00.000Z", lines: [paper(50)] }),
    B2: await order("B2", { branchId: southBranchId, createdByUserId: sanaId, status: "FULFILLED", createdAt: "2026-10-31T18:59:59.000Z", lines: [diesel(7)] }),
    B3: await order("B3", { branchId: southBranchId, createdByUserId: sanaId, status: "FULFILLED", createdAt: "2026-10-31T19:00:00.000Z", lines: [paper(9)] }),
  }

  return {
    suffix,
    organizationId: A,
    headOfficeId,
    groupOneId: groupOne.id,
    groupTwoId: groupTwo.id,
    northBranchId,
    eastBranchId,
    southBranchId,
    westBranchId,
    ahmedId,
    bilalId,
    sanaId,
    waliId,
    stationeryCategoryId: stationery.id,
    paperCategoryId: paperCategory.id,
    fuelCategoryId: fuel.id,
    paperProductId,
    tonerProductId,
    dieselProductId,
    orderIds,
    names,
  }
}

/** Remove every row the fixtures created, children before parents. */
export async function destroyProductPerformanceFilterFixtures(f: ProductPerformanceFilterFixtures): Promise<void> {
  const orderIds = Object.values(f.orderIds)
  await db.delete(orderItems).where(inArray(orderItems.orderId, orderIds))
  await db.delete(orders).where(inArray(orders.id, orderIds))
  // Branches reference their group and users their branch, so users go first
  // — except Head Office, which the groups name as their creator.
  await db.delete(users).where(inArray(users.id, [f.ahmedId, f.bilalId, f.sanaId, f.waliId]))
  await db.delete(branches).where(inArray(branches.id, [f.northBranchId, f.eastBranchId, f.southBranchId, f.westBranchId]))
  await db.delete(groups).where(inArray(groups.id, [f.groupOneId, f.groupTwoId]))
  await db.delete(users).where(eq(users.id, f.headOfficeId))
  await db.delete(globalProducts).where(inArray(globalProducts.id, [f.paperProductId, f.tonerProductId, f.dieselProductId]))
  await db.delete(categories).where(eq(categories.id, f.paperCategoryId))
  await db.delete(categories).where(inArray(categories.id, [f.stationeryCategoryId, f.fuelCategoryId]))
  await db.delete(organizations).where(eq(organizations.id, f.organizationId))
}
