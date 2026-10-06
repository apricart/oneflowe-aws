import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as route from "@/app/api/v1/budget-quantity/route"
import {
  auditLogs,
  branchInventory,
  branches,
  budgetAddons,
  budgets,
  globalProducts,
  organizationInventory,
  organizationSettings,
  organizations,
  productQuantityBudgetAllocations,
  productQuantityBudgets,
  roles,
  users,
} from "@/db/schema"
import { currentBudgetPeriod } from "@/lib/server/group-branch-budgets"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * /api/v1/budget-quantity — budgets expressed as product quantities.
 *
 * A quantity tenant allocates "50 reams of paper" rather than money; the
 * server values the allocation at the price the branch will actually be
 * charged and books it on the ordinary money ledger as well. Checked here:
 * who may allocate, the tenant fence (a Head Office naming another tenant's
 * branch or organization), that a money-mode tenant is refused, the valuation,
 * the ledger rows written, the audit row, the listing and the reset.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    coalesceInFlight: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
    invalidateByPrefix: vi.fn(async () => {}),
  }
})

const { getServerSession } = mockedNextAuth

type Fixtures = Awaited<ReturnType<typeof createFixtures>>

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "quantity it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [quantityOrg, moneyOrg] = await db.insert(organizations).values([
    { name: `IT Qty ${suffix}`, code: `ITQ-${suffix}` },
    { name: `IT Money ${suffix}`, code: `ITM-${suffix}` },
  ]).returning({ id: organizations.id })
  await db.insert(organizationSettings).values({
    organizationId: quantityOrg.id,
    key: "budget_allocation_mode",
    value: "quantity",
  })

  const [headOffice, foreignHeadOffice, superAdmin] = await db.insert(users).values([
    { email: `it-qty-ho-${suffix}@example.test`, username: `it-qty-ho-${suffix}`, passwordHash: "x", roleId: await roleId("HEAD_OFFICE"), organizationId: quantityOrg.id },
    { email: `it-qty-fho-${suffix}@example.test`, username: `it-qty-fho-${suffix}`, passwordHash: "x", roleId: await roleId("HEAD_OFFICE"), organizationId: moneyOrg.id },
    { email: `it-qty-sa-${suffix}@example.test`, username: `it-qty-sa-${suffix}`, passwordHash: "x", roleId: await roleId("SUPER_ADMIN"), organizationId: null },
  ]).returning({ id: users.id })

  const [branch, foreignBranch] = await db.insert(branches).values([
    { organizationId: quantityOrg.id, name: `Qty North ${suffix}`, status: "active" },
    { organizationId: moneyOrg.id, name: `Money North ${suffix}`, status: "active" },
  ]).returning({ id: branches.id })

  const [paper, toner] = await db.insert(globalProducts).values([
    { productCode: `ITQ-P-${suffix}`, name: `Paper ${suffix}`, basePrice: 500, status: "active", unit: "Ream" },
    { productCode: `ITQ-T-${suffix}`, name: `Toner ${suffix}`, basePrice: 3_000, status: "active", unit: "Piece" },
  ]).returning({ id: globalProducts.id })

  const [paperInv, tonerInv, foreignInv] = await db.insert(organizationInventory).values([
    // Paper carries an organization price: the allocation must use it, not the base price.
    { organizationId: quantityOrg.id, globalProductId: paper.id, assignedByUserId: superAdmin.id, isActive: true, customPrice: 400 },
    { organizationId: quantityOrg.id, globalProductId: toner.id, assignedByUserId: superAdmin.id, isActive: true },
    { organizationId: moneyOrg.id, globalProductId: paper.id, assignedByUserId: superAdmin.id, isActive: true },
  ]).returning({ id: organizationInventory.id })

  const [paperRow, tonerRow, foreignRow] = await db.insert(branchInventory).values([
    { branchId: branch.id, organizationId: quantityOrg.id, organizationInventoryId: paperInv.id, assignedByUserId: superAdmin.id, isVisible: true, isActive: true },
    { branchId: branch.id, organizationId: quantityOrg.id, organizationInventoryId: tonerInv.id, assignedByUserId: superAdmin.id, isVisible: true, isActive: true },
    { branchId: foreignBranch.id, organizationId: moneyOrg.id, organizationInventoryId: foreignInv.id, assignedByUserId: superAdmin.id, isVisible: true, isActive: true },
  ]).returning({ id: branchInventory.id })

  return {
    suffix,
    quantityOrg: quantityOrg.id,
    moneyOrg: moneyOrg.id,
    headOfficeId: headOffice.id,
    foreignHeadOfficeId: foreignHeadOffice.id,
    superAdminId: superAdmin.id,
    branchId: branch.id,
    foreignBranchId: foreignBranch.id,
    productIds: [paper.id, toner.id],
    paperRow: paperRow.id,
    tonerRow: tonerRow.id,
    foreignRow: foreignRow.id,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orgs = [f.quantityOrg, f.moneyOrg]
  await db.delete(productQuantityBudgetAllocations).where(inArray(productQuantityBudgetAllocations.organizationId, orgs))
  await db.delete(productQuantityBudgets).where(inArray(productQuantityBudgets.organizationId, orgs))
  const budgetIds = (await db.select({ id: budgets.id }).from(budgets).where(inArray(budgets.organizationId, orgs))).map((row) => row.id)
  if (budgetIds.length) await db.delete(budgetAddons).where(inArray(budgetAddons.budgetId, budgetIds))
  await db.delete(budgets).where(inArray(budgets.organizationId, orgs))
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgs))
  await db.delete(branchInventory).where(inArray(branchInventory.organizationId, orgs))
  await db.delete(organizationInventory).where(inArray(organizationInventory.organizationId, orgs))
  await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, orgs))
  await db.delete(branches).where(inArray(branches.organizationId, orgs))
  await db.delete(users).where(inArray(users.id, [f.headOfficeId, f.foreignHeadOfficeId, f.superAdminId]))
  await db.delete(globalProducts).where(inArray(globalProducts.id, f.productIds))
  await db.delete(organizations).where(inArray(organizations.id, orgs))
}

type Actor = { id: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, email: "a@example.test", mustChangePassword: false } } as any),
  )
}

function request(method: string, body?: unknown, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/budget-quantity${query}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

async function json(response: Response) {
  return { status: response.status, body: await response.json() }
}

describe.skipIf(!hasTestDatabase)("quantity budgets", () => {
  let f: Fixtures
  const headOffice = (): Actor => ({ id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.quantityOrg })

  beforeAll(async () => {
    f = await createFixtures()
  })

  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })

  beforeEach(async () => {
    await db.delete(productQuantityBudgetAllocations).where(eq(productQuantityBudgetAllocations.organizationId, f.quantityOrg))
    await db.delete(productQuantityBudgets).where(eq(productQuantityBudgets.organizationId, f.quantityOrg))
    const budgetIds = (await db.select({ id: budgets.id }).from(budgets).where(eq(budgets.organizationId, f.quantityOrg))).map((row) => row.id)
    if (budgetIds.length) await db.delete(budgetAddons).where(inArray(budgetAddons.budgetId, budgetIds))
    await db.delete(budgets).where(eq(budgets.organizationId, f.quantityOrg))
    signIn(headOffice())
    vi.spyOn(console, "error").mockImplementation(() => {})
  })

  describe("access", () => {
    it("refuses anonymous callers and roles other than Head Office and Super Admin", async () => {
      signIn(null)
      expect((await route.GET(request("GET"))).status).toBe(401)
      expect((await route.POST(request("POST", {}))).status).toBe(401)
      for (const role of ["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER"]) {
        signIn({ id: f.headOfficeId, role, organizationId: f.quantityOrg })
        expect((await route.GET(request("GET"))).status, role).toBe(403)
        expect((await route.POST(request("POST", { branchId: f.branchId, items: [{ branchInventoryId: f.paperRow, quantity: 1 }] }))).status, role).toBe(403)
      }
    })

    it("refuses a money-mode organization", async () => {
      signIn({ id: f.foreignHeadOfficeId, role: "HEAD_OFFICE", organizationId: f.moneyOrg })
      expect((await route.GET(request("GET"))).status).toBe(403)
    })

    it("keeps Head Office out of another tenant's branch and products", async () => {
      const foreignBranch = await json(await route.POST(request("POST", {
        branchId: f.foreignBranchId,
        items: [{ branchInventoryId: f.foreignRow, quantity: 1 }],
      })))
      expect(foreignBranch.status).toBe(403)

      const foreignItem = await json(await route.POST(request("POST", {
        branchId: f.branchId,
        items: [{ branchInventoryId: f.foreignRow, quantity: 1 }],
      })))
      expect(foreignItem.status).toBe(400)
      expect(await db.select().from(productQuantityBudgets).where(eq(productQuantityBudgets.organizationId, f.quantityOrg))).toHaveLength(0)
    })

    it("pins Head Office's listing to its own organization whatever the query names", async () => {
      const listing = await json(await route.GET(request("GET", undefined, `?organizationId=${f.moneyOrg}`)))
      expect(listing.status).toBe(200)
      expect(JSON.stringify(listing.body)).not.toContain(`Money North ${f.suffix}`)
    })
  })

  describe("allocating", () => {
    it("values the allocation at the organization price and books it on both ledgers with an audit row", async () => {
      const result = await json(await route.POST(request("POST", {
        branchId: f.branchId,
        type: "monthly",
        items: [
          { branchInventoryId: f.paperRow, quantity: 50 },
          { branchInventoryId: f.tonerRow, quantity: 2 },
        ],
        reason: "October plan",
      })))
      expect(result.status, JSON.stringify(result.body)).toBeLessThan(300)

      const quantityRows = await db.select().from(productQuantityBudgets)
        .where(and(eq(productQuantityBudgets.organizationId, f.quantityOrg), eq(productQuantityBudgets.branchId, f.branchId)))
      expect(quantityRows).toHaveLength(2)
      const byProduct = new Map(quantityRows.map((row) => [row.globalProductId, row]))
      // 50 reams at the organization price of 4.00; 2 toner at the base price of 30.00.
      expect(Number(byProduct.get(f.productIds[0])!.allocatedQuantity)).toBe(50)
      expect(Number(byProduct.get(f.productIds[0])!.amountAllocatedCents)).toBe(20_000)
      expect(Number(byProduct.get(f.productIds[1])!.amountAllocatedCents)).toBe(6_000)

      const [money] = await db.select().from(budgets)
        .where(and(eq(budgets.branchId, f.branchId), eq(budgets.period, currentBudgetPeriod())))
      expect(money.amountAllocatedCents + money.amountCreditedCents).toBe(26_000)

      const audits = await db.select().from(auditLogs).where(eq(auditLogs.organizationId, f.quantityOrg))
      expect(audits.length).toBeGreaterThan(0)
    })

    it("refuses an inactive or unassigned product, a zero quantity, and an empty list", async () => {
      expect((await route.POST(request("POST", { branchId: f.branchId, items: [] }))).status).toBe(400)
      expect((await route.POST(request("POST", { branchId: f.branchId, items: [{ branchInventoryId: f.paperRow, quantity: 0 }] }))).status).toBe(400)
      expect((await route.POST(request("POST", { branchId: 2_147_483_000, items: [{ branchInventoryId: f.paperRow, quantity: 1 }] }))).status).toBe(404)
      expect((await route.POST(request("POST", { branchId: f.branchId, items: [{ branchInventoryId: f.paperRow, quantity: 1 }], priceCents: 1 }))).status).toBe(400)

      await db.update(branchInventory).set({ isActive: false }).where(eq(branchInventory.id, f.tonerRow))
      expect((await route.POST(request("POST", { branchId: f.branchId, items: [{ branchInventoryId: f.tonerRow, quantity: 1 }] }))).status).toBe(400)
      await db.update(branchInventory).set({ isActive: true }).where(eq(branchInventory.id, f.tonerRow))
    })

    it("lists what was allocated", async () => {
      await route.POST(request("POST", { branchId: f.branchId, type: "monthly", items: [{ branchInventoryId: f.paperRow, quantity: 10 }] }))
      const listing = await json(await route.GET(request("GET", undefined, `?period=${currentBudgetPeriod()}`)))
      expect(listing.status).toBe(200)
      expect(JSON.stringify(listing.body)).toContain(`Paper ${f.suffix}`)
    })
  })

  describe("resetting", () => {
    it("resets the view's branches when nothing has been spent", async () => {
      await route.POST(request("POST", { branchId: f.branchId, type: "monthly", items: [{ branchInventoryId: f.paperRow, quantity: 10 }] }))
      const reset = await json(await route.DELETE(request("DELETE", { branchIds: [f.branchId] })))
      expect(reset.status, JSON.stringify(reset.body)).toBe(200)

      const rows = await db.select().from(productQuantityBudgets).where(eq(productQuantityBudgets.branchId, f.branchId))
      expect(rows.every((row) => Number(row.allocatedQuantity) === 0)).toBe(true)
    })

    it("refuses to reset while a quantity is held or spent", async () => {
      await route.POST(request("POST", { branchId: f.branchId, type: "monthly", items: [{ branchInventoryId: f.paperRow, quantity: 10 }] }))
      await db.update(productQuantityBudgets).set({ heldQuantity: 1 }).where(eq(productQuantityBudgets.branchId, f.branchId))
      expect((await route.DELETE(request("DELETE", { branchIds: [f.branchId] }))).status).toBe(409)
    })

    it("resets nothing outside the tenant", async () => {
      const reset = await json(await route.DELETE(request("DELETE", { organizationId: f.moneyOrg, branchIds: [f.foreignBranchId] })))
      expect(reset.body.reset?.branchCount ?? 0).toBe(0)
    })

    it("validates the body", async () => {
      expect((await route.DELETE(request("DELETE", { period: "2026-13" }))).status).toBe(400)
      expect((await route.DELETE(request("DELETE", { branchIds: [0] }))).status).toBe(400)
    })
  })
})
