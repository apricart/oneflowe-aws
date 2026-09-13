import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as approvalsRoute from "@/app/api/v1/group-portal/approvals/route"
import * as budgetsRoute from "@/app/api/v1/group-portal/budgets/route"
import * as groupsRoute from "@/app/api/v1/group-portal/groups/route"
import * as reportRoute from "@/app/api/v1/group-portal/reports/group-orders/route"
import * as scopeRoute from "@/app/api/v1/group-portal/scope/route"
import * as usersRoute from "@/app/api/v1/users/route"
import {
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
  return { ...actual, invalidateByPrefix: mocks.invalidateByPrefix }
})

const { getServerSession } = mockedNextAuth
const { GET: getApprovals } = approvalsRoute
const { GET: getBudgets } = budgetsRoute
const { GET: getGroups } = groupsRoute
const { GET: getReport } = reportRoute
const { GET: getScope } = scopeRoute
const { POST: createUser } = usersRoute

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

function userRequest(body: unknown): Request {
  return new Request("http://localhost/api/v1/users", {
    method: "POST",
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
      const good = payload("GROUP_USER", "approver")

      const response = await createUser(userRequest(good))
      const body = await response.json()
      createdUserIds.push(body.item.id)

      expect(response.status).toBe(201)
      const [stored] = await db
        .select({ role: roles.name, organizationId: users.organizationId, branchId: users.branchId })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(eq(users.id, body.item.id))
      expect(stored).toEqual({
        role: "GROUP_USER",
        organizationId: fixtures.organizationId,
        branchId: null,
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
})

describe.skipIf(hasTestDatabase)("group-based role integration suite", () => {
  it(NO_DATABASE_REASON, () => {})
})
