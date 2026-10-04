import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"
import { and, asc, eq, inArray } from "drizzle-orm"

import * as budgetsRoute from "@/app/api/v1/budgets/route"
import {
  branches,
  budgets,
  groups,
  organizationSettings,
  organizations,
  roles,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { closePool, db } from "@/lib/db"
import { openCurrentBudgetPeriodRows } from "@/lib/server/budget-period-opening"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The Budgets list opens the engine's current month at each branch's baseline
 * (`plans/OF-BUDGET-open-current-month-on-budget-list.md`), against Postgres.
 *
 * Only identity, the rate limiter and the cache are faked; the handler is the
 * real one and every figure is read back from `budgets`.
 *
 * ```text
 * Tenant ON (budgets on)
 *   open      baseline 5,000   no row this month        → opened at 5,000
 *   funded    baseline 7,000   row 1,234 / spent 100 / held 20 / credited 50 → untouched
 *   zero      baseline 0       no row                   → stays without one
 *   inactive  baseline 3,000   no row, status inactive  → stays without one, unlisted
 *   grouped   baseline 4,000   last month's row only    → this month opened, last month untouched
 * Tenant OTHER (budgets on)
 *   other     baseline 6,000   no row                   → opened only from inside OTHER
 * Tenant OFF (budgets off)
 *   off       baseline 9,000   no row                   → never opened, by anyone
 * ```
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("next/headers", () => ({ headers: async () => new Headers() }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: vi.fn(async () => null) }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: vi.fn(async () => undefined),
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

// The real writer, wrapped so one case can make it fail.
vi.mock("@/lib/server/budget-period-opening", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/server/budget-period-opening")>()
  return { ...actual, openCurrentBudgetPeriodRows: vi.fn(actual.openCurrentBudgetPeriodRows) }
})

const { getServerSession } = mockedNextAuth

const PERIOD = budgetPeriodOf(new Date())

function shiftMonth(period: string, offset: number): string {
  const [year, month] = period.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1 + offset, 1))
  return date.toISOString().slice(0, 7)
}
const LAST_MONTH = shiftMonth(PERIOD, -1)
const TWO_MONTHS_AGO = shiftMonth(PERIOD, -2)

type Actor = {
  id: string
  email: string
  role: string
  organizationId: number | null
  branchId: number | null
}

function signIn(actor: Actor) {
  vi.mocked(getServerSession).mockResolvedValue({ user: { ...actor, mustChangePassword: false } } as any)
}

async function list(query: string) {
  const response = await budgetsRoute.GET(new NextRequest(`http://localhost/api/v1/budgets?${query}`, { method: "GET" }))
  return { status: response.status, body: await response.json() }
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "Created by budget period opening integration tests" })
    .returning({ id: roles.id })
  return created.id
}

describe.skipIf(!hasTestDatabase)("the Budgets list opens the current month at the baseline", () => {
  const suffix = randomUUID().slice(0, 8)

  let onOrgId: number
  let otherOrgId: number
  let offOrgId: number
  let groupId: number
  const branch: Record<"open" | "funded" | "zero" | "inactive" | "grouped" | "other" | "off", number> = {} as any
  const actors: Record<string, Actor> = {}

  /** Every branch this suite expects to see opened or left alone this month. */
  const unopenedBranches = () => [branch.open, branch.zero, branch.inactive, branch.grouped, branch.other, branch.off]

  const currentRow = async (branchId: number) => {
    const rows = await db
      .select({
        id: budgets.id,
        organizationId: budgets.organizationId,
        allocated: budgets.amountAllocatedCents,
        spent: budgets.amountSpentCents,
        held: budgets.amountHeldCents,
        credited: budgets.amountCreditedCents,
      })
      .from(budgets)
      .where(and(eq(budgets.branchId, branchId), eq(budgets.period, PERIOD)))
    expect(rows.length).toBeLessThanOrEqual(1)
    return rows[0] ?? null
  }

  const openedSince = async () => {
    const rows = await db.select({ branchId: budgets.branchId }).from(budgets)
      .where(and(inArray(budgets.branchId, unopenedBranches()), eq(budgets.period, PERIOD)))
      .orderBy(asc(budgets.branchId))
    return rows.map((row) => row.branchId)
  }

  const listed = (body: any, branchId: number) => body.budgets.find((row: any) => row.branchId === branchId)

  beforeAll(async () => {
    const roleIds = {
      superAdmin: await resolveRoleId("SUPER_ADMIN"),
      headOffice: await resolveRoleId("HEAD_OFFICE"),
      branchAdmin: await resolveRoleId("BRANCH_ADMIN"),
      orderPortal: await resolveRoleId("ORDER_PORTAL"),
      groupUser: await resolveRoleId("GROUP_USER"),
    }

    const [onOrg, otherOrg, offOrg] = await db.insert(organizations).values([
      { name: `IT Open On ${suffix}`, code: `ITOO_${suffix}` },
      { name: `IT Open Other ${suffix}`, code: `ITOT_${suffix}` },
      { name: `IT Open Off ${suffix}`, code: `ITOF_${suffix}`, budgetsEnabled: false },
    ]).returning({ id: organizations.id })
    onOrgId = onOrg.id
    otherOrgId = otherOrg.id
    offOrgId = offOrg.id

    const person = async (label: string, role: string, roleId: number, organizationId: number | null, branchId: number | null, extra: Record<string, unknown> = {}) => {
      const email = `it-bpo-${label}-${suffix}@example.test`
      const [row] = await db.insert(users).values({
        email, username: `it-bpo-${label}-${suffix}`, passwordHash: "x",
        roleId, organizationId, branchId, fullName: `${label} ${suffix}`, ...extra,
      }).returning({ id: users.id })
      actors[label] = { id: row.id, email, role, organizationId, branchId }
    }

    await person("headOfficeOn", "HEAD_OFFICE", roleIds.headOffice, onOrgId, null)
    const [group] = await db.insert(groups)
      .values({ organizationId: onOrgId, name: `IT BPO Group ${suffix}`, createdByUserId: actors.headOfficeOn.id })
      .returning({ id: groups.id })
    groupId = group.id

    const inserted = await db.insert(branches).values([
      { organizationId: onOrgId, name: `IT BPO open ${suffix}`, baselineBudgetCents: 5_000 },
      { organizationId: onOrgId, name: `IT BPO funded ${suffix}`, baselineBudgetCents: 7_000 },
      { organizationId: onOrgId, name: `IT BPO zero ${suffix}`, baselineBudgetCents: 0 },
      { organizationId: onOrgId, name: `IT BPO inactive ${suffix}`, baselineBudgetCents: 3_000, status: "inactive" },
      { organizationId: onOrgId, name: `IT BPO grouped ${suffix}`, baselineBudgetCents: 4_000, groupId },
      { organizationId: otherOrgId, name: `IT BPO other ${suffix}`, baselineBudgetCents: 6_000 },
      { organizationId: offOrgId, name: `IT BPO off ${suffix}`, baselineBudgetCents: 9_000 },
    ]).returning({ id: branches.id })
    ;[branch.open, branch.funded, branch.zero, branch.inactive, branch.grouped, branch.other, branch.off] = inserted.map((row) => row.id)

    await person("superAdmin", "SUPER_ADMIN", roleIds.superAdmin, null, null)
    await person("headOfficeOther", "HEAD_OFFICE", roleIds.headOffice, otherOrgId, null)
    await person("headOfficeOff", "HEAD_OFFICE", roleIds.headOffice, offOrgId, null)
    await person("branchAdmin", "BRANCH_ADMIN", roleIds.branchAdmin, onOrgId, branch.funded)
    await person("orderPortal", "ORDER_PORTAL", roleIds.orderPortal, onOrgId, branch.zero)
    await person("groupUser", "GROUP_USER", roleIds.groupUser, onOrgId, null, { budgetAllocationEnabled: true })
    await person("groupUserOff", "GROUP_USER", roleIds.groupUser, onOrgId, null, { budgetAllocationEnabled: false })
    await db.insert(userGroupAssignments).values([
      { userId: actors.groupUser.id, groupId, organizationId: onOrgId, createdByUserId: actors.headOfficeOn.id },
      { userId: actors.groupUserOff.id, groupId, organizationId: onOrgId, createdByUserId: actors.headOfficeOn.id },
    ])

    await db.insert(budgets).values([
      { organizationId: onOrgId, branchId: branch.funded, period: PERIOD, amountAllocatedCents: 1_234, amountSpentCents: 100, amountHeldCents: 20, amountCreditedCents: 50 },
      { organizationId: onOrgId, branchId: branch.grouped, period: LAST_MONTH, amountAllocatedCents: 4_000, amountSpentCents: 3_900, amountHeldCents: 0, amountCreditedCents: 0 },
    ])
  })

  afterAll(async () => {
    if (!onOrgId) return
    const organizationIds = [onOrgId, otherOrgId, offOrgId]
    await db.delete(budgets).where(inArray(budgets.organizationId, organizationIds))
    await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.organizationId, organizationIds))
    // users → branches → groups → users is a cycle; break it at the branch's group.
    await db.update(branches).set({ groupId: null }).where(inArray(branches.organizationId, organizationIds))
    await db.delete(groups).where(eq(groups.id, groupId))
    await db.delete(users).where(inArray(users.id, Object.values(actors).map((actor) => actor.id)))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
    await db.delete(organizationSettings).where(inArray(organizationSettings.organizationId, organizationIds))
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
    await closePool()
  })

  beforeEach(async () => {
    vi.mocked(getServerSession).mockReset()
    // Each case starts from "nobody has opened this month yet".
    await db.delete(budgets).where(and(inArray(budgets.branchId, unopenedBranches()), eq(budgets.period, PERIOD)))
  })

  const fundedIsUntouched = async () => {
    expect(await currentRow(branch.funded)).toMatchObject({ allocated: 1_234, spent: 100, held: 20, credited: 50 })
  }

  describe("Head Office of the tenant, on the page's default view", () => {
    it("opens each unopened branch at its baseline and lists that figure, not 0", async () => {
      signIn(actors.headOfficeOn)
      const response = await list("all=true&preset=all")
      expect(response.status).toBe(200)

      expect(await currentRow(branch.open)).toMatchObject({ organizationId: onOrgId, allocated: 5_000, spent: 0, held: 0, credited: 0 })
      expect(await currentRow(branch.grouped)).toMatchObject({ organizationId: onOrgId, allocated: 4_000, spent: 0, held: 0, credited: 0 })
      expect(listed(response.body, branch.open)).toMatchObject({ amountAllocatedCents: 5_000, remainingCents: 5_000 })
    })

    it("leaves an existing row, last month's row, a zero baseline and an inactive branch exactly as they were", async () => {
      signIn(actors.headOfficeOn)
      const response = await list("all=true&preset=all")
      expect(response.status).toBe(200)

      await fundedIsUntouched()
      const [lastMonth] = await db.select({ allocated: budgets.amountAllocatedCents, spent: budgets.amountSpentCents })
        .from(budgets).where(and(eq(budgets.branchId, branch.grouped), eq(budgets.period, LAST_MONTH)))
      expect(lastMonth).toEqual({ allocated: 4_000, spent: 3_900 })
      expect(await currentRow(branch.zero)).toBeNull()
      expect(await currentRow(branch.inactive)).toBeNull()
      expect(listed(response.body, branch.zero)).toMatchObject({ remainingCents: 0 })
      expect(listed(response.body, branch.inactive)).toBeUndefined()
    })

    it("opens nothing in another tenant", async () => {
      signIn(actors.headOfficeOn)
      await list("all=true&preset=all")
      expect(await openedSince()).toEqual([branch.open, branch.grouped])
    })

    it("opens each row once however often the page is loaded", async () => {
      signIn(actors.headOfficeOn)
      await list("all=true&preset=all")
      const first = await currentRow(branch.open)
      await list("all=true&preset=all")
      await list("all=true&preset=thisMonth")
      expect(await currentRow(branch.open)).toEqual(first)
    })

    it("opens each row once when the page is loaded concurrently", async () => {
      signIn(actors.headOfficeOn)
      const responses = await Promise.all([1, 2, 3, 4].map(() => list("all=true&preset=all")))
      responses.forEach((response) => expect(response.status).toBe(200))
      const rows = await db.select({ id: budgets.id }).from(budgets)
        .where(and(inArray(budgets.branchId, [branch.open, branch.grouped]), eq(budgets.period, PERIOD)))
      expect(rows).toHaveLength(2)
    })

    it("opens nothing for a view of past months only", async () => {
      signIn(actors.headOfficeOn)
      const [year, month] = TWO_MONTHS_AGO.split("-").map(Number)
      expect((await list(`all=true&months=${month}&years=${year}`)).status).toBe(200)
      expect((await list("all=true&startDate=2025-01-01&endDate=2025-01-31")).status).toBe(200)
      expect(await openedSince()).toEqual([])
    })

    it("still lists the budgets when opening fails, and leaves nothing half-written", async () => {
      vi.mocked(openCurrentBudgetPeriodRows).mockRejectedValueOnce(new Error("connection reset"))
      signIn(actors.headOfficeOn)
      const response = await list("all=true&preset=all")
      expect(response.status).toBe(200)
      expect(listed(response.body, branch.funded)).toMatchObject({ amountAllocatedCents: 1_234 })
      expect(await openedSince()).toEqual([])
      // The next load opens as usual.
      await list("all=true&preset=all")
      expect(await openedSince()).toEqual([branch.open, branch.grouped])
    })

    it("does not reach another tenant by naming its organization or its branch", async () => {
      signIn(actors.headOfficeOther)
      const response = await list(`all=true&preset=all&organizationId=${onOrgId}&branchIds=${branch.open},${branch.other}`)
      expect(response.status).toBe(200)
      expect(listed(response.body, branch.open)).toBeUndefined()
      expect(await openedSince()).toEqual([branch.other])
    })
  })

  describe("a tenant with budget allocation off", () => {
    it("lists nothing and opens nothing", async () => {
      signIn(actors.headOfficeOff)
      expect((await list("all=true&preset=all")).body).toEqual({ budgets: [], budgetsEnabled: false })
      expect(await openedSince()).toEqual([])
    })

    it("is never opened by a Super Admin, even when named", async () => {
      signIn(actors.superAdmin)
      const response = await list(`all=true&preset=all&branchIds=${branch.open},${branch.other},${branch.off}`)
      expect(response.status).toBe(200)
      expect(await openedSince()).toEqual([branch.open, branch.other])
      expect(await currentRow(branch.off)).toBeNull()
    })
  })

  describe("the approver", () => {
    it("opens only the branches its assignments reach", async () => {
      signIn(actors.groupUser)
      expect((await list("all=true&preset=all")).status).toBe(200)
      expect(await openedSince()).toEqual([branch.grouped])
    })

    it("opens nothing when it names a branch outside its assignments", async () => {
      signIn(actors.groupUser)
      const response = await list(`all=true&preset=all&branchIds=${branch.open}`)
      expect(response.status).toBe(403)
      expect(await openedSince()).toEqual([])
    })

    it("opens nothing when budget allocation is not enabled on the account", async () => {
      signIn(actors.groupUserOff)
      expect((await list("all=true&preset=all")).status).toBe(403)
      expect(await openedSince()).toEqual([])
    })
  })

  describe("callers who do not manage budgets", () => {
    it("refuses an unauthenticated request and opens nothing", async () => {
      vi.mocked(getServerSession).mockResolvedValue(null as any)
      expect((await list("all=true&preset=all")).status).toBe(401)
      expect(await openedSince()).toEqual([])
    })

    it("gives a Branch Admin its own branch only, and opens no other", async () => {
      signIn(actors.branchAdmin)
      const response = await list("all=true&preset=all")
      expect(response.status).toBe(200)
      expect(response.body.branchId).toBe(branch.funded)
      expect(response.body.budgets).toBeUndefined()
      await fundedIsUntouched()
      expect(await openedSince()).toEqual([])
    })

    it("gives the Order Portal its own branch only, and opens no other", async () => {
      signIn(actors.orderPortal)
      const response = await list("all=true&preset=all")
      expect(response.status).toBe(200)
      expect(response.body.branchId).toBe(branch.zero)
      // Its own read opens its own row (at its 0 baseline), as it always has.
      expect((await openedSince()).filter((id) => id !== branch.zero)).toEqual([])
    })
  })
})
