import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as approvalsRoute from "@/app/api/v1/group-portal/approvals/route"
import * as moneyBudgetsRoute from "@/app/api/v1/budgets/route"
import * as budgetsRoute from "@/app/api/v1/group-portal/budgets/route"
import * as groupsRoute from "@/app/api/v1/group-portal/groups/route"
import * as reportRoute from "@/app/api/v1/group-portal/reports/group-orders/route"
import * as scopeRoute from "@/app/api/v1/group-portal/scope/route"
import * as usersRoute from "@/app/api/v1/users/route"
import * as userAccessRoute from "@/app/api/v1/users/[id]/access/route"
import {
  auditLogs,
  branches,
  budgets,
  roles,
  userBranchAssignments,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { currentBudgetPeriod } from "@/lib/server/group-branch-budgets"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"

import {
  NO_DATABASE_REASON,
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

const mocks = vi.hoisted(() => ({
  hashPassword: vi.fn(async () => "integration-test-password-hash"),
  invalidateByPrefix: vi.fn(async () => {}),
  sendWelcomeEmail: vi.fn(async () => {}),
  withRateLimit: vi.fn(async () => null),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/password", () => ({ hashPassword: mocks.hashPassword }))
vi.mock("@/lib/email", () => ({ sendWelcomeEmail: mocks.sendWelcomeEmail }))
vi.mock("@/lib/rate-limiter", () => ({ withRateLimit: mocks.withRateLimit }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: mocks.invalidateByPrefix,
    // No Redis here: every cached read runs its real fetcher against the test
    // database instead of waiting on a connection that will never open.
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth
const { GET: getApprovals } = approvalsRoute
const { GET: getBudgets } = budgetsRoute
const { GET: listMoneyBudgets, PUT: allocateMoneyBudget } = moneyBudgetsRoute
const { GET: getGroups } = groupsRoute
const { GET: getReport } = reportRoute
const { GET: getScope } = scopeRoute
const { POST: createUser } = usersRoute
const { PATCH: changeUserAccess } = userAccessRoute

type Actor = {
  id: string
  email: string
  role: string
  organizationId: number | null
}

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null
      ? null
      : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

function request(path: string): NextRequest {
  return new NextRequest(`http://localhost${path}`)
}

function allocationRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/budgets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function userRequest(body: unknown): Request {
  return new Request("http://localhost/api/v1/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

function accessRequest(userId: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/users/${userId}/access`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!hasTestDatabase)("group-based roles through their real API and database", () => {
  let fixtures: GroupRoleFixtures
  const createdUserIds: string[] = []

  const actor = (kind: "super" | "head" | "foreignHead" | "requester" | "approver" | "emptyApprover"): Actor => {
    const values = {
      super: {
        id: fixtures.superAdminId,
        email: `super-${fixtures.suffix}@example.test`,
        role: "SUPER_ADMIN",
        organizationId: null,
      },
      head: {
        id: fixtures.headOfficeId,
        email: `head-${fixtures.suffix}@example.test`,
        role: "HEAD_OFFICE",
        organizationId: fixtures.organizationId,
      },
      foreignHead: {
        id: fixtures.foreignHeadOfficeId,
        email: `foreign-head-${fixtures.suffix}@example.test`,
        role: "HEAD_OFFICE",
        organizationId: fixtures.foreignOrganizationId,
      },
      requester: {
        id: fixtures.requesterId,
        email: `requester-${fixtures.suffix}@example.test`,
        role: "GROUP_ORDER_PORTAL",
        organizationId: fixtures.organizationId,
      },
      approver: {
        id: fixtures.approverId,
        email: `approver-${fixtures.suffix}@example.test`,
        role: "GROUP_USER",
        organizationId: fixtures.organizationId,
      },
      emptyApprover: {
        id: fixtures.emptyApproverId,
        email: `empty-${fixtures.suffix}@example.test`,
        role: "GROUP_USER",
        organizationId: fixtures.organizationId,
      },
    } satisfies Record<string, Actor>
    return values[kind]
  }

  beforeAll(async () => {
    fixtures = await createGroupRoleFixtures()
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  afterAll(async () => {
    if (fixtures) await destroyGroupRoleFixtures(fixtures, createdUserIds)
    await closePool()
  })

  describe("role boundaries", () => {
    it("requires authentication on every group-only read surface", async () => {
      signIn(null)

      const responses = await Promise.all([
        getScope(),
        getGroups(),
        getBudgets(),
        getApprovals(request("/api/v1/group-portal/approvals")),
        getReport(request("/api/v1/group-portal/reports/group-orders")),
      ])

      expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401])
    })

    it("keeps ordering endpoints with the requester and decision/report endpoints with the approver", async () => {
      signIn(actor("requester"))
      expect((await getGroups()).status).toBe(200)
      expect((await getBudgets()).status).toBe(200)
      expect((await getApprovals(request("/api/v1/group-portal/approvals"))).status).toBe(403)
      expect((await getReport(request("/api/v1/group-portal/reports/group-orders"))).status).toBe(403)

      signIn(actor("approver"))
      expect((await getGroups()).status).toBe(403)
      expect((await getBudgets()).status).toBe(403)
      expect((await getApprovals(request("/api/v1/group-portal/approvals"))).status).toBe(200)
      expect((await getReport(request("/api/v1/group-portal/reports/group-orders"))).status).toBe(200)
    })
  })

  describe("Group Order Portal scope and displayed budgets", () => {
    it("unions group and direct assignments without leaking an inconsistent foreign assignment", async () => {
      signIn(actor("requester"))

      const response = await getScope()
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.item).toMatchObject({
        organization: { id: fixtures.organizationId, name: fixtures.names.organization },
        role: "GROUP_ORDER_PORTAL",
        canApproveOrders: false,
      })
      expect(body.item.groups).toEqual([
        { id: fixtures.alphaGroupId, name: fixtures.names.alphaGroup },
      ])
      expect(body.item.assignedBranches).toEqual([
        { id: fixtures.betaBranchId, name: fixtures.names.betaBranch, groupId: fixtures.betaGroupId },
      ])
      expect(body.item.branches.map((branch: { id: number }) => branch.id).sort((a: number, b: number) => a - b))
        .toEqual([fixtures.alphaNorthId, fixtures.alphaSouthId, fixtures.betaBranchId].sort((a, b) => a - b))
    })

    it("builds the storefront group tree only from currently authorized branches", async () => {
      signIn(actor("requester"))

      const response = await getGroups()
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.items.map((group: { id: number }) => group.id)).toEqual([
        fixtures.alphaGroupId,
        fixtures.betaGroupId,
      ])
      expect(body.items[0]).toMatchObject({
        id: fixtures.alphaGroupId,
        name: fixtures.names.alphaGroup,
      })
      expect(body.items[0].branches.map((branch: { id: number }) => branch.id).sort((a: number, b: number) => a - b))
        .toEqual([fixtures.alphaNorthId, fixtures.alphaSouthId].sort((a, b) => a - b))
      expect(body.items[1].branches).toEqual([
        expect.objectContaining({ id: fixtures.betaBranchId, name: fixtures.names.betaBranch }),
      ])
    })

    it("reports the same remaining money the ordering ledger will enforce", async () => {
      signIn(actor("requester"))

      const response = await getBudgets()
      const body = await response.json()
      const byBranch = new Map<number, any>(body.items.map((item: any) => [item.branchId, item]))

      expect(response.status).toBe(200)
      expect(body.period).toBe(currentBudgetPeriod())
      expect(byBranch.get(fixtures.alphaNorthId)).toMatchObject({
        configured: true,
        totalCents: 105_000,
        spentCents: 20_000,
        heldCents: 30_000,
        remainingCents: 55_000,
      })
      // No period row exists for Alpha South, so the production fallback is
      // its baseline—not zero and not a made-up allocation row.
      expect(byBranch.get(fixtures.alphaSouthId)).toMatchObject({
        configured: true,
        totalCents: 75_000,
        remainingCents: 75_000,
      })
      expect(byBranch.has(fixtures.foreignBranchId)).toBe(false)
    })
  })

  describe("Group User approval and reporting values", () => {
    it("returns only group-order children inside the assigned tenant and branches", async () => {
      signIn(actor("approver"))

      const response = await getApprovals(request("/api/v1/group-portal/approvals?filter=all"))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.pagination).toMatchObject({ total: 1, totalPages: 1, hasMore: false })
      expect(body.summary).toEqual({
        pendingOrders: 1,
        approvedOrders: 1,
        rejectedOrders: 0,
        pendingGroupOrders: 1,
        branchesInScope: 2,
      })
      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({
        id: fixtures.alphaEnvelopeId,
        groupId: fixtures.alphaGroupId,
        groupName: fixtures.names.alphaGroup,
        scopedOrderCount: 2,
        pendingOrderCount: 1,
        totalCents: 12_500,
        statusCounts: { PENDING: 1, APPROVED: 1 },
      })
      expect(body.items[0].orders.map((order: { id: number }) => order.id).sort((a: number, b: number) => a - b))
        .toEqual([fixtures.alphaNorthOrderId, fixtures.alphaSouthOrderId].sort((a, b) => a - b))
      const pending = body.items[0].orders.find((order: { id: number }) => order.id === fixtures.alphaNorthOrderId)
      const approved = body.items[0].orders.find((order: { id: number }) => order.id === fixtures.alphaSouthOrderId)
      expect(pending).toMatchObject({ itemCount: 2.5, approvalToken: null })
      expect(approved).toMatchObject({ itemCount: 0.5, approvalToken: `TOK-${fixtures.suffix}` })
    })

    it("keeps quantity, gross, refund, and net totals reconciled with the visible rows", async () => {
      signIn(actor("approver"))

      const response = await getReport(request("/api/v1/group-portal/reports/group-orders?status=ALL"))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.summary).toEqual({
        groupOrderCount: 1,
        branchOrderCount: 2,
        branchCount: 2,
        quantityOrdered: 3,
        totalCents: 12_500,
        refundCents: 500,
        netCents: 12_000,
        statusCounts: {
          PENDING: 1,
          APPROVED: 1,
          FULFILLED: 0,
          REJECTED: 0,
          REFUNDED: 0,
        },
      })
      expect(body.items).toHaveLength(1)
      expect(body.items[0]).toMatchObject({
        id: fixtures.alphaEnvelopeId,
        scopedOrderCount: 2,
        branchCount: 2,
        quantityOrdered: 3,
        totalCents: 12_500,
        refundCents: 500,
        netCents: 12_000,
      })
      expect(body.items[0].orders.reduce((sum: number, order: { totalCents: number }) => sum + order.totalCents, 0))
        .toBe(body.items[0].totalCents)
      expect(body.items[0].orders.reduce((sum: number, order: { quantityOrdered: number }) => sum + order.quantityOrdered, 0))
        .toBe(body.items[0].quantityOrdered)
    })

    it("fails closed to zero rows and zero values when the approver has no assignments", async () => {
      signIn(actor("emptyApprover"))

      const [queueResponse, reportResponse] = await Promise.all([
        getApprovals(request("/api/v1/group-portal/approvals?filter=all")),
        getReport(request("/api/v1/group-portal/reports/group-orders")),
      ])
      const queue = await queueResponse.json()
      const report = await reportResponse.json()

      expect(queueResponse.status).toBe(200)
      expect(queue.items).toEqual([])
      expect(queue.summary).toEqual({
        pendingOrders: 0,
        approvedOrders: 0,
        rejectedOrders: 0,
        pendingGroupOrders: 0,
        branchesInScope: 0,
      })
      expect(reportResponse.status).toBe(200)
      expect(report.items).toEqual([])
      expect(report.summary).toMatchObject({
        groupOrderCount: 0,
        branchOrderCount: 0,
        quantityOrdered: 0,
        totalCents: 0,
        refundCents: 0,
        netCents: 0,
      })
    })
  })

  describe("administrator provisioning", () => {
    function payload(role: "GROUP_ORDER_PORTAL" | "GROUP_USER", label: string) {
      return {
        firstName: "Role",
        lastName: "Tester",
        email: `it-created-${label}-${fixtures.suffix}@example.test`,
        username: `it-created-${label}-${fixtures.suffix}`,
        password: "Strong-Test-Password-9!",
        role,
        organizationId: fixtures.organizationId,
        branchId: null,
        groupIds: [fixtures.alphaGroupId],
        branchIds: [fixtures.betaBranchId],
      }
    }

    it("lets Super Admin create a requester atomically with group and direct-branch scope", async () => {
      signIn(actor("super"))

      const response = await createUser(userRequest(payload("GROUP_ORDER_PORTAL", "requester")))
      const body = await response.json()
      createdUserIds.push(body.item.id)

      expect(response.status).toBe(201)
      expect(body.item.passwordHash).toBeUndefined()
      expect(body.item).toMatchObject({
        organizationId: fixtures.organizationId,
        branchId: null,
        mustChangePassword: true,
      })

      const [stored] = await db
        .select({ role: roles.name, branchId: users.branchId, mustChangePassword: users.mustChangePassword })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.id, body.item.id))
      expect(stored).toEqual({ role: "GROUP_ORDER_PORTAL", branchId: null, mustChangePassword: true })
      expect(await resolveScopedBranchIds(db, body.item.id)).toEqual(expect.arrayContaining([
        fixtures.alphaNorthId,
        fixtures.alphaSouthId,
        fixtures.betaBranchId,
      ]))
    })

    it("lets Head Office create a Group User only inside its own tenant", async () => {
      signIn(actor("head"))
      const good = { ...payload("GROUP_USER", "approver"), budgetAllocationEnabled: true }

      const response = await createUser(userRequest(good))
      const body = await response.json()
      createdUserIds.push(body.item.id)

      expect(response.status).toBe(201)
      const [stored] = await db
        .select({
          role: roles.name,
          organizationId: users.organizationId,
          branchId: users.branchId,
          budgetAllocationEnabled: users.budgetAllocationEnabled,
        })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.id, body.item.id))
      expect(stored).toEqual({
        role: "GROUP_USER",
        organizationId: fixtures.organizationId,
        branchId: null,
        budgetAllocationEnabled: true,
      })

      signIn(actor("foreignHead"))
      const denied = payload("GROUP_USER", "cross-tenant")
      const deniedResponse = await createUser(userRequest(denied))
      expect(deniedResponse.status).toBe(403)
      expect(await db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.email, denied.email), inArray(users.organizationId, [fixtures.organizationId]))))
        .toEqual([])

      signIn(actor("head"))
      expect((await changeUserAccess(accessRequest(fixtures.requesterId, { budgetAllocationEnabled: true }), {
        params: Promise.resolve({ id: fixtures.requesterId }),
      })).status).toBe(400)
    })

    it.each(["BRANCH_ADMIN", "GROUP_ORDER_PORTAL", "GROUP_USER"])(
      "does not let %s enter the user-provisioning endpoint",
      async (role) => {
        signIn({ ...actor("head"), role })
        const response = await createUser(userRequest(payload("GROUP_USER", `denied-${role.toLowerCase()}`)))
        expect(response.status).toBe(403)
      },
    )
  })

  // ── Money budgets: the approver allocates to its own branches ──────────
  //
  // Runs last: it writes to Alpha South's ledger, and the reads above expect
  // the fixture's untouched figures.

  describe("Group User money budget allocation", () => {
    const period = currentBudgetPeriod()

    async function listFor(query = "") {
      const response = await listMoneyBudgets(request(`/api/v1/budgets?all=true&period=${period}${query}`))
      const body = await response.json()
      return { status: response.status, body }
    }

    const branchIdsOf = (body: any): number[] =>
      (body.budgets as Array<{ branchId: number }>).map((row) => row.branchId).sort((a, b) => a - b)

    it("lists exactly the approver's assigned branches, with the ledger figures behind them", async () => {
      signIn(actor("approver"))

      const { status, body } = await listFor()

      expect(status).toBe(200)
      expect(branchIdsOf(body)).toEqual([fixtures.alphaNorthId, fixtures.alphaSouthId].sort((a, b) => a - b))
      expect(branchIdsOf(body)).not.toContain(fixtures.betaBranchId)
      expect(branchIdsOf(body)).not.toContain(fixtures.foreignBranchId)

      const north = body.budgets.find((row: any) => row.branchId === fixtures.alphaNorthId)
      expect(north).toMatchObject({
        branchName: fixtures.names.alphaNorth,
        organizationId: fixtures.organizationId,
        amountAllocatedCents: 100_000,
        amountSpentCents: 20_000,
        amountHeldCents: 30_000,
        amountCreditedCents: 5_000,
        remainingCents: 55_000,
        budgetAllocationMode: "money",
      })
    })

    it("narrows within its assignments and refuses a request that reaches outside them", async () => {
      signIn(actor("approver"))

      const south = await listFor(`&branchIds=${fixtures.alphaSouthId}`)
      expect(branchIdsOf(south.body)).toEqual([fixtures.alphaSouthId])

      // A tenant branch it is not assigned to drops out rather than joining.
      const mixed = await listFor(`&branchIds=${fixtures.alphaNorthId},${fixtures.betaBranchId}`)
      expect(branchIdsOf(mixed.body)).toEqual([fixtures.alphaNorthId])

      // Only unassigned branches — in its own tenant or another — is a refusal,
      // never a fall-through to the tenant list.
      for (const outside of [fixtures.betaBranchId, fixtures.foreignBranchId]) {
        const { status, body } = await listFor(`&branchIds=${outside}`)
        expect(status).toBe(403)
        expect(body.error).toBe("Requested branches are outside your assigned scope")
        expect(body.budgets).toBeUndefined()
      }
    })

    it("refuses an approver with no assignments rather than listing the tenant", async () => {
      signIn(actor("emptyApprover"))

      const { status, body } = await listFor()

      expect(status).toBe(403)
      expect(body.error).toBe("No branches are assigned to your account")
      expect(body.budgets).toBeUndefined()
    })

    it("leaves Head Office on the whole tenant, and out of the neighbour's", async () => {
      signIn(actor("head"))
      const own = await listFor()
      expect(own.status).toBe(200)
      expect(branchIdsOf(own.body)).toEqual(
        [fixtures.alphaNorthId, fixtures.alphaSouthId, fixtures.betaBranchId].sort((a, b) => a - b),
      )
      // Naming the neighbour's branch matches nothing inside the tenant fence.
      const foreign = await listFor(`&branchIds=${fixtures.foreignBranchId}`)
      expect(foreign.status).toBe(200)
      expect(foreign.body.budgets).toEqual([])

      signIn(actor("foreignHead"))
      const neighbour = await listFor()
      expect(branchIdsOf(neighbour.body)).toEqual([fixtures.foreignBranchId])
    })

    it("keeps the ordering role out of the listing entirely", async () => {
      signIn(actor("requester"))
      // Not a manager: the `all` listing is skipped and the single-branch path
      // has no branch for this role, so nothing is returned either way.
      const { status, body } = await listFor()
      expect(status).toBe(400)
      expect(body.budgets).toBeUndefined()
    })

    it("credits an add-on and sets a baseline on an assigned branch, with the ledger and audit trail to match", async () => {
      signIn(actor("approver"))

      const addon = await allocateMoneyBudget(allocationRequest({
        branchId: fixtures.alphaSouthId,
        amountAllocatedCents: 12_500,
        type: "addon",
        reason: "Integration add-on",
      }))
      const addonBody = await addon.json()
      expect(addon.status).toBe(200)
      expect(addonBody.budget).toMatchObject({
        branchId: fixtures.alphaSouthId,
        branchName: fixtures.names.alphaSouth,
        period,
        newCredited: 125,
      })

      const monthly = await allocateMoneyBudget(allocationRequest({
        branchId: fixtures.alphaSouthId,
        amountAllocatedCents: 40_000,
        type: "monthly",
      }))
      expect(monthly.status).toBe(200)
      expect((await monthly.json()).baseline).toBe(400)

      const [ledger] = await db
        .select({
          allocated: budgets.amountAllocatedCents,
          credited: budgets.amountCreditedCents,
          organizationId: budgets.organizationId,
        })
        .from(budgets)
        .where(and(eq(budgets.branchId, fixtures.alphaSouthId), eq(budgets.period, period)))
      expect(ledger).toEqual({ allocated: 40_000, credited: 12_500, organizationId: fixtures.organizationId })

      const [branch] = await db
        .select({ baseline: branches.baselineBudgetCents })
        .from(branches)
        .where(eq(branches.id, fixtures.alphaSouthId))
      expect(branch.baseline).toBe(40_000)

      // The trail names the approver, so a reviewer can see who moved the money.
      const trail = await db
        .select({ action: auditLogs.action, entityId: auditLogs.entityId })
        .from(auditLogs)
        .where(and(
          eq(auditLogs.userId, fixtures.approverId),
          eq(auditLogs.organizationId, fixtures.organizationId),
        ))
      expect(trail).toEqual(expect.arrayContaining([
        { action: "ADD_CREDIT", entityId: String(fixtures.alphaSouthId) },
        { action: "UPDATE_BRANCH_BASELINE", entityId: String(fixtures.alphaSouthId) },
      ]))

      // The approver's own listing now shows the new figures.
      const { body } = await listFor(`&branchIds=${fixtures.alphaSouthId}`)
      expect(body.budgets[0]).toMatchObject({ amountAllocatedCents: 40_000, amountCreditedCents: 12_500 })
    })

    it("refuses a write to a tenant branch outside its assignments, and to another tenant's, before touching the ledger", async () => {
      // The Head Office listings above already opened this period's rows for
      // Beta and Foreign at their baselines; what must hold is that the
      // refused writes below leave them exactly as they are.
      const ledgerOf = () => db
        .select({
          branchId: budgets.branchId,
          allocated: budgets.amountAllocatedCents,
          credited: budgets.amountCreditedCents,
          updatedAt: budgets.updatedAt,
        })
        .from(budgets)
        .where(and(
          inArray(budgets.branchId, [fixtures.betaBranchId, fixtures.foreignBranchId]),
          eq(budgets.period, period),
        ))
        .orderBy(budgets.branchId)
      const before = await ledgerOf()

      signIn(actor("approver"))

      const beta = await allocateMoneyBudget(allocationRequest({
        branchId: fixtures.betaBranchId,
        amountAllocatedCents: 1_000,
        type: "addon",
      }))
      expect(beta.status).toBe(403)
      expect((await beta.json()).error).toBe("Unauthorized: Branch is outside your assigned scope")

      const foreign = await allocateMoneyBudget(allocationRequest({
        branchId: fixtures.foreignBranchId,
        amountAllocatedCents: 1_000,
        type: "addon",
      }))
      expect(foreign.status).toBe(403)
      expect((await foreign.json()).error).toBe("Unauthorized: Branch belongs to different organization")

      // Neither refusal moved a rupee or touched a row.
      expect(await ledgerOf()).toEqual(before)
      for (const row of before) expect(row.credited).toBe(0)

      // And no audit row claims the approver did anything to either branch.
      const trail = await db
        .select({ entityId: auditLogs.entityId })
        .from(auditLogs)
        .where(and(
          eq(auditLogs.userId, fixtures.approverId),
          inArray(auditLogs.entityId, [String(fixtures.betaBranchId), String(fixtures.foreignBranchId)]),
        ))
      expect(trail).toEqual([])
    })

    it("refuses the assignment-less approver and the ordering role on write", async () => {
      const body = { branchId: fixtures.alphaNorthId, amountAllocatedCents: 1_000, type: "addon" }

      signIn(actor("emptyApprover"))
      const empty = await allocateMoneyBudget(allocationRequest(body))
      expect(empty.status).toBe(403)
      expect((await empty.json()).error).toBe("Unauthorized: Branch is outside your assigned scope")

      signIn(actor("requester"))
      expect((await allocateMoneyBudget(allocationRequest(body))).status).toBe(403)

      signIn(null)
      expect((await allocateMoneyBudget(allocationRequest(body))).status).toBe(401)

      // Alpha North's ledger is exactly as the fixture left it.
      const [north] = await db
        .select({ allocated: budgets.amountAllocatedCents, credited: budgets.amountCreditedCents })
        .from(budgets)
        .where(and(eq(budgets.branchId, fixtures.alphaNorthId), eq(budgets.period, period)))
      expect(north).toEqual({ allocated: 100_000, credited: 5_000 })
    })

    it("keeps Head Office inside its own tenant on write", async () => {
      signIn(actor("foreignHead"))
      const response = await allocateMoneyBudget(allocationRequest({
        branchId: fixtures.alphaNorthId,
        amountAllocatedCents: 1_000,
        type: "addon",
      }))
      expect(response.status).toBe(403)
      expect((await response.json()).error).toBe("Unauthorized: Branch belongs to different organization")
    })

    it("defaults a new Group User to denied, then grants and revokes only within its tenant and assigned branches", async () => {
      signIn(actor("head"))
      const created = await createUser(userRequest({
        firstName: "Budget",
        lastName: "Opt In",
        email: `it-budget-opt-in-${fixtures.suffix}@example.test`,
        username: `it-budget-opt-in-${fixtures.suffix}`,
        password: "Strong-Test-Password-9!",
        role: "GROUP_USER",
        organizationId: fixtures.organizationId,
        branchId: null,
        groupIds: [fixtures.alphaGroupId],
        branchIds: [],
      }))
      expect(created.status).toBe(201)
      const userId = (await created.json()).item.id as string
      createdUserIds.push(userId)
      const [stored] = await db.select({ enabled: users.budgetAllocationEnabled })
        .from(users).where(eq(users.id, userId))
      expect(stored.enabled).toBe(false)

      const newGroupUser = { ...actor("approver"), id: userId }
      const write = (branchId: number) => allocationRequest({
        branchId,
        amountAllocatedCents: 1,
        type: "addon",
      })
      signIn(newGroupUser)
      expect((await listFor()).status).toBe(403)
      expect((await allocateMoneyBudget(write(fixtures.alphaNorthId))).status).toBe(403)

      signIn(actor("foreignHead"))
      expect((await changeUserAccess(accessRequest(userId, { budgetAllocationEnabled: true }), {
        params: Promise.resolve({ id: userId }),
      })).status).toBe(403)
      signIn(actor("approver"))
      expect((await changeUserAccess(accessRequest(userId, { budgetAllocationEnabled: true }), {
        params: Promise.resolve({ id: userId }),
      })).status).toBe(403)

      signIn(actor("head"))
      expect((await changeUserAccess(accessRequest(userId, { budgetAllocationEnabled: true }), {
        params: Promise.resolve({ id: userId }),
      })).status).toBe(200)
      signIn(newGroupUser)
      const allowed = await listFor()
      expect(allowed.status).toBe(200)
      expect(branchIdsOf(allowed.body)).toEqual([fixtures.alphaNorthId, fixtures.alphaSouthId].sort((a, b) => a - b))
      expect((await allocateMoneyBudget(write(fixtures.betaBranchId))).status).toBe(403)
      expect((await allocateMoneyBudget(write(fixtures.foreignBranchId))).status).toBe(403)
      expect((await allocateMoneyBudget(write(fixtures.alphaNorthId))).status).toBe(200)

      signIn(actor("head"))
      expect((await changeUserAccess(accessRequest(userId, { budgetAllocationEnabled: false }), {
        params: Promise.resolve({ id: userId }),
      })).status).toBe(200)
      signIn(newGroupUser)
      expect((await listFor()).status).toBe(403)
      expect((await allocateMoneyBudget(write(fixtures.alphaNorthId))).status).toBe(403)
    })
  })
})

describe.skipIf(hasTestDatabase)("group-based role integration suite", () => {
  it(NO_DATABASE_REASON, () => {})
})
