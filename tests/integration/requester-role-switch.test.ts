import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { eq, inArray } from "drizzle-orm"
import * as mockedNextAuth from "next-auth"

import { NextRequest } from "next/server"

import * as analyticsUsersListRoute from "@/app/api/v1/analytics/users/list/route"
import * as userAccessRoute from "@/app/api/v1/users/[id]/access/route"
import { orderItems, orders, roles, systemLogs, userGroupAssignments, users } from "@/db/schema"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"
import { closePool, db } from "@/lib/db"

import {
  NO_DATABASE_REASON,
  createGroupRoleFixtures,
  destroyGroupRoleFixtures,
  hasTestDatabase,
  type GroupRoleFixtures,
} from "./helpers/group-role-fixtures"

const mocks = vi.hoisted(() => ({
  invalidateByPrefix: vi.fn(async () => {}),
  invalidateSessionValidationCache: vi.fn(async () => {}),
}))

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/session-validation-cache", () => ({
  invalidateSessionValidationCache: mocks.invalidateSessionValidationCache,
}))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return {
    ...actual,
    invalidateByPrefix: mocks.invalidateByPrefix,
    getCached: async <T,>(_key: string, fetchFn: () => Promise<T>) => fetchFn(),
  }
})

const { getServerSession } = mockedNextAuth
const { GET: readAccess, PATCH: changeAccess } = userAccessRoute
const { GET: listAnalyticsUsers } = analyticsUsersListRoute

type Actor = {
  id: string
  email: string
  role: string
  organizationId: number | null
}

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: { ...actor, mustChangePassword: false } } as any),
  )
}

function accessRequest(body: unknown): Request {
  return new Request("http://localhost/api/v1/users/x/access", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function patchAccess(targetUserId: string, body: unknown) {
  const response = await changeAccess(accessRequest(body) as any, {
    params: Promise.resolve({ id: targetUserId }),
  })
  return { status: response.status, payload: await response.json() }
}

async function getAccess(targetUserId: string) {
  const response = await readAccess(new Request("http://localhost") as any, {
    params: Promise.resolve({ id: targetUserId }),
  })
  return { status: response.status, payload: await response.json() }
}

async function roleNameOf(userId: string): Promise<string> {
  const [row] = await db
    .select({ role: roles.name })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1)
  return row?.role ?? ""
}

/** The user ids the requester filter offers for a branch. */
async function listUsersForBranch(branchId: number): Promise<string[]> {
  const response = await listAnalyticsUsers(
    new NextRequest(`http://localhost/api/v1/analytics/users/list?branchIds=${branchId}`),
  )
  const payload = await response.json()
  return (payload.items ?? []).map((item: { id: string }) => item.id)
}

async function roleIdOf(name: string): Promise<number> {
  const [row] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  return row.id
}

describe.skipIf(!hasTestDatabase)("switching a user between the four branch and group roles", () => {
  let fixtures: GroupRoleFixtures
  let headOffice: Actor
  let foreignHeadOffice: Actor
  let superAdmin: Actor

  /** Users this file creates, torn down with the fixtures. */
  const createdUserIds: string[] = []
  const createdOrderIds: number[] = []
  let tidCounter = 0

  async function makeUser(
    key: string,
    roleName: string,
    extra: Record<string, unknown> = {},
  ): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `itrs-${key}-${fixtures.suffix}@example.test`,
        username: `itrs-${key}-${fixtures.suffix}`,
        fullName: `Role Switch ${key}`,
        passwordHash: "integration-test-hash",
        roleId: await roleIdOf(roleName),
        organizationId: fixtures.organizationId,
        branchId: fixtures.alphaNorthId,
        isActive: true,
        ...extra,
      })
      .returning({ id: users.id })
    createdUserIds.push(row.id)
    return row.id
  }

  async function makeOrder(createdByUserId: string, status: string, createdByRole = "ORDER_PORTAL") {
    const [row] = await db
      .insert(orders)
      .values({
        // `tid` is varchar(26); the suffix plus a counter keeps it inside that.
        tid: `ITRS${fixtures.suffix}${tidCounter++}`.slice(0, 26),
        organizationId: fixtures.organizationId,
        branchId: fixtures.alphaNorthId,
        createdByUserId,
        createdByRole,
        status,
        subtotalCents: 1_000,
        taxCents: 0,
        totalCents: 1_000,
      })
      .returning({ id: orders.id })
    createdOrderIds.push(row.id)
    return row.id
  }

  async function clearOrders() {
    if (createdOrderIds.length === 0) return
    await db.delete(orderItems).where(inArray(orderItems.orderId, createdOrderIds))
    await db.delete(orders).where(inArray(orders.id, createdOrderIds))
    createdOrderIds.length = 0
  }

  beforeAll(async () => {
    fixtures = await createGroupRoleFixtures()
    headOffice = {
      id: fixtures.headOfficeId,
      email: "ho@example.test",
      role: "HEAD_OFFICE",
      organizationId: fixtures.organizationId,
    }
    foreignHeadOffice = {
      id: fixtures.foreignHeadOfficeId,
      email: "foreign-ho@example.test",
      role: "HEAD_OFFICE",
      organizationId: fixtures.foreignOrganizationId,
    }
    superAdmin = {
      id: fixtures.superAdminId,
      email: "sa@example.test",
      role: "SUPER_ADMIN",
      organizationId: null,
    }
  })

  afterAll(async () => {
    await clearOrders()
    if (createdUserIds.length > 0) {
      await db.delete(systemLogs).where(inArray(systemLogs.resourceId, createdUserIds))
    }
    await destroyGroupRoleFixtures(fixtures, createdUserIds)
    await closePool()
  })

  beforeEach(async () => {
    await clearOrders()
    vi.clearAllMocks()
  })

  describe("the lifecycle precondition", () => {
    it("switches a requester with no orders at all, and records the change", async () => {
      const userId = await makeUser("clean", "ORDER_PORTAL")
      signIn(headOffice)

      const { status } = await patchAccess(userId, { role: "BRANCH_ADMIN" })

      expect(status).toBe(200)
      expect(await roleNameOf(userId)).toBe("BRANCH_ADMIN")

      const [log] = await db
        .select({ action: systemLogs.action, details: systemLogs.details })
        .from(systemLogs)
        .where(eq(systemLogs.resourceId, userId))
        .limit(1)
      expect(log.action).toBe("USER_ACCESS_UPDATE")
      expect(log.details).toMatchObject({ previousRole: "ORDER_PORTAL", nextRole: "BRANCH_ADMIN" })
    })

    it("refuses while an order is still awaiting approval", async () => {
      const userId = await makeUser("pending", "ORDER_PORTAL")
      await makeOrder(userId, "PENDING")
      signIn(headOffice)

      const { status, payload } = await patchAccess(userId, { role: "BRANCH_ADMIN" })

      expect(status).toBe(409)
      expect(payload.error).toContain("1 awaiting approval")
      // The refusal must leave the row exactly as it was.
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses while an approved order has not been fulfilled — approval is not the end", async () => {
      const userId = await makeUser("approved", "ORDER_PORTAL")
      await makeOrder(userId, "APPROVED")
      signIn(headOffice)

      const { status, payload } = await patchAccess(userId, { role: "BRANCH_ADMIN" })

      expect(status).toBe(409)
      expect(payload.error).toContain("approved but not yet fulfilled")
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("allows the switch once every order has settled, in any settled form", async () => {
      const userId = await makeUser("settled", "ORDER_PORTAL")
      for (const status of ["FULFILLED", "PARTIALLY_FULFILLED", "REJECTED", "CANCELLED", "REFUNDED"]) {
        await makeOrder(userId, status)
      }
      signIn(headOffice)

      const { status } = await patchAccess(userId, { role: "BRANCH_ADMIN" })

      expect(status).toBe(200)
      expect(await roleNameOf(userId)).toBe("BRANCH_ADMIN")
    })

    it("switches back from BRANCH_ADMIN to ORDER_PORTAL on the same rule", async () => {
      const userId = await makeUser("reverse", "BRANCH_ADMIN")
      signIn(headOffice)

      expect((await patchAccess(userId, { role: "ORDER_PORTAL" })).status).toBe(200)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("does not obstruct an unrelated access edit that leaves the role alone", async () => {
      const userId = await makeUser("mfa-only", "ORDER_PORTAL")
      await makeOrder(userId, "PENDING")
      signIn(headOffice)

      // Toggling MFA is not a move between portals. Making it wait on a pending
      // order would obstruct with no safety behind it.
      const { status } = await patchAccess(userId, { mfaEnabled: true })

      expect(status).toBe(200)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("counts only the target's own orders, not the whole branch's", async () => {
      const blocked = await makeUser("owner", "ORDER_PORTAL")
      const bystander = await makeUser("bystander", "ORDER_PORTAL")
      await makeOrder(blocked, "PENDING")
      signIn(headOffice)

      expect((await patchAccess(blocked, { role: "BRANCH_ADMIN" })).status).toBe(409)
      expect((await patchAccess(bystander, { role: "BRANCH_ADMIN" })).status).toBe(200)
    })
  })

  describe("the readiness preview agrees with what the write enforces", () => {
    it("reports ready for a user with nothing in flight", async () => {
      const userId = await makeUser("preview-clean", "ORDER_PORTAL")
      signIn(headOffice)

      const { status, payload } = await getAccess(userId)

      expect(status).toBe(200)
      expect(payload.item).toMatchObject({ roleChangeAllowed: true, reason: null })
    })

    it("reports the same refusal, with counts, that the write would give", async () => {
      const userId = await makeUser("preview-blocked", "ORDER_PORTAL")
      await makeOrder(userId, "PENDING")
      await makeOrder(userId, "APPROVED")
      signIn(headOffice)

      const preview = await getAccess(userId)
      const write = await patchAccess(userId, { role: "BRANCH_ADMIN" })

      expect(preview.payload.item.roleChangeAllowed).toBe(false)
      expect(preview.payload.item.blockers).toEqual({
        pendingOrderCount: 1,
        approvedOrderCount: 1,
      })
      // The preview must not be able to say something the write disagrees with.
      expect(write.status).toBe(409)
      expect(write.payload.error).toBe(preview.payload.item.reason)
    })

    it("refuses to preview a user outside the caller's tenant", async () => {
      const userId = await makeUser("preview-foreign", "ORDER_PORTAL")
      signIn(foreignHeadOffice)

      expect((await getAccess(userId)).status).toBe(403)
    })
  })

  /**
   * Mirrored accounts were refused while the legacy K-Electric platform was
   * still the source of truth, because `sync:ke` would have rebuilt a switched
   * pair into a third account. That migration is complete and the sync is not
   * run again, so they are switched like any other account. These pin that the
   * refusal is gone and that nothing else about a mirrored account moved with it.
   */
  describe("mirrored accounts", () => {
    it("switches an account mirrored from the legacy system like any other", async () => {
      const userId = await makeUser("mirrored", "ORDER_PORTAL", {
        externalSource: "KE_SYNC",
        externalId: "9999999",
      })
      signIn(headOffice)

      const { status } = await patchAccess(userId, { role: "BRANCH_ADMIN" })

      expect(status).toBe(200)
      expect(await roleNameOf(userId)).toBe("BRANCH_ADMIN")
    })

    it("still holds a mirrored account to the lifecycle rule", async () => {
      const userId = await makeUser("mirrored-blocked", "ORDER_PORTAL", {
        externalSource: "KE_SYNC",
        externalId: "9999996",
      })
      await makeOrder(userId, "PENDING")
      signIn(headOffice)

      const { status, payload } = await patchAccess(userId, { role: "BRANCH_ADMIN" })
      expect(status).toBe(409)
      expect(payload.error).toContain("awaiting approval")
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("offers the switch in the preview rather than refusing it", async () => {
      const userId = await makeUser("mirrored-preview", "ORDER_PORTAL", {
        externalSource: "KE_SYNC",
        externalId: "9999998",
      })
      signIn(headOffice)

      const { payload } = await getAccess(userId)
      expect(payload.item.roleChangeAllowed).toBe(true)
    })

    it("leaves external_source and the username untouched by the switch", async () => {
      const userId = await makeUser("mirrored-identity", "ORDER_PORTAL", {
        externalSource: "KE_SYNC",
        externalId: "9999995",
      })
      signIn(headOffice)
      expect((await patchAccess(userId, { role: "BRANCH_ADMIN" })).status).toBe(200)

      const [row] = await db
        .select({
          externalSource: users.externalSource,
          externalId: users.externalId,
          username: users.username,
        })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      // The email-login guard keys on external_source and must survive: a
      // mirrored person signs in by username only, whatever their role.
      expect(row.externalSource).toBe("KE_SYNC")
      expect(row.externalId).toBe("9999995")
      expect(row.username).toBe(`itrs-mirrored-identity-${fixtures.suffix}`)
    })

    it("still allows an unrelated access edit on a mirrored account", async () => {
      const userId = await makeUser("mirrored-mfa", "ORDER_PORTAL", {
        externalSource: "KE_SYNC",
        externalId: "9999997",
      })
      signIn(headOffice)

      expect((await patchAccess(userId, { mfaEnabled: true })).status).toBe(200)
    })
  })

  describe("edge cases that must fail closed", () => {
    it("refuses a role change on a soft-deleted account, as not found", async () => {
      const userId = await makeUser("softdeleted", "ORDER_PORTAL", { deletedAt: new Date() })
      signIn(headOffice)

      // A deleted account keeps its rows for the audit trail but is not
      // administrable — changing its role would resurrect it into every report
      // keyed on a current role.
      expect((await patchAccess(userId, { role: "BRANCH_ADMIN" })).status).toBe(404)
      expect((await getAccess(userId)).status).toBe(404)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses budget allocation offered to a role that cannot hold it", async () => {
      const userId = await makeUser("allocdenied", "ORDER_PORTAL")
      signIn(headOffice)

      const { status, payload } = await patchAccess(userId, {
        role: "BRANCH_ADMIN",
        branchId: fixtures.alphaNorthId,
        budgetAllocationEnabled: true,
      })

      expect(status).toBe(400)
      expect(payload.error).toContain("Group Users")
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("clears budget allocation moving between the two group roles", async () => {
      const userId = await makeUser("allocgroup", "GROUP_USER", {
        branchId: null,
        budgetAllocationEnabled: true,
      })
      await db.insert(userGroupAssignments).values({
        userId,
        groupId: fixtures.alphaGroupId,
        organizationId: fixtures.organizationId,
      })
      signIn(headOffice)

      // GROUP_ORDER_PORTAL raises orders; it never allocates money.
      expect((await patchAccess(userId, { role: "GROUP_ORDER_PORTAL" })).status).toBe(200)

      const [row] = await db
        .select({ enabled: users.budgetAllocationEnabled })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      expect(row.enabled).toBe(false)
    })

    it("refuses an unknown role rather than coercing it", async () => {
      const userId = await makeUser("badrole", "ORDER_PORTAL")
      signIn(headOffice)

      expect((await patchAccess(userId, { role: "WAREHOUSE_GOD" })).status).toBe(400)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses an unknown field rather than ignoring it", async () => {
      const userId = await makeUser("straykey", "ORDER_PORTAL")
      signIn(headOffice)

      // The schema is `.strict()`: a body carrying something it does not know is
      // a mistake to report, not a field to drop.
      const { status } = await patchAccess(userId, {
        role: "BRANCH_ADMIN",
        branchId: fixtures.alphaNorthId,
        sessionVersion: 99,
      })
      expect(status).toBe(400)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses an empty body", async () => {
      const userId = await makeUser("emptybody", "ORDER_PORTAL")
      signIn(headOffice)
      expect((await patchAccess(userId, {})).status).toBe(400)
    })

    it("answers 404 for a user id that does not exist", async () => {
      signIn(headOffice)
      const absent = "00000000-0000-0000-0000-000000000000"
      expect((await patchAccess(absent, { role: "BRANCH_ADMIN" })).status).toBe(404)
      expect((await getAccess(absent)).status).toBe(404)
    })

    it("bumps the session version and drops every session on a switch", async () => {
      const userId = await makeUser("sessionbump", "ORDER_PORTAL")
      const [before] = await db
        .select({ version: users.sessionVersion })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      signIn(headOffice)

      expect((await patchAccess(userId, { role: "BRANCH_ADMIN" })).status).toBe(200)

      const [after] = await db
        .select({ version: users.sessionVersion })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      // Every existing token must stop being accepted the moment the role moves.
      expect(after.version).toBe((before.version ?? 0) + 1)
    })

    it("leaves the row untouched when the write is refused, not half-applied", async () => {
      const userId = await makeUser("atomicity", "GROUP_USER", { branchId: null })
      await db.insert(userGroupAssignments).values({
        userId,
        groupId: fixtures.alphaGroupId,
        organizationId: fixtures.organizationId,
      })
      await makeOrder(userId, "PENDING", "GROUP_ORDER_PORTAL")
      const scopeBefore = [...await resolveScopedBranchIds(db, userId)].sort()
      expect(scopeBefore.length).toBeGreaterThan(0)
      signIn(headOffice)

      // Blocked by the lifecycle rule from inside the transaction, so neither
      // the role, nor the branch, nor the assignments may have moved.
      const { status } = await patchAccess(userId, {
        role: "ORDER_PORTAL",
        branchId: fixtures.alphaNorthId,
        groupIds: [],
        branchIds: [],
      })
      expect(status).toBe(409)
      expect(await roleNameOf(userId)).toBe("GROUP_USER")
      const [row] = await db
        .select({ branchId: users.branchId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      expect(row.branchId).toBeNull()
      expect([...await resolveScopedBranchIds(db, userId)].sort()).toEqual(scopeBefore)
    })
  })

  describe("authorization", () => {
    it("refuses an unauthenticated caller", async () => {
      const userId = await makeUser("anon-target", "ORDER_PORTAL")
      signIn(null)

      const { status } = await patchAccess(userId, { role: "BRANCH_ADMIN" })
      expect([401, 403]).toContain(status)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses a requester trying to change anyone's role, including their own", async () => {
      const userId = await makeUser("self-promoter", "ORDER_PORTAL")
      signIn({
        id: userId,
        email: "self@example.test",
        role: "ORDER_PORTAL",
        organizationId: fixtures.organizationId,
      })

      expect((await patchAccess(userId, { role: "BRANCH_ADMIN" })).status).toBe(403)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses a Head Office administrator reaching into another tenant", async () => {
      const userId = await makeUser("cross-tenant", "ORDER_PORTAL")
      signIn(foreignHeadOffice)

      const { status } = await patchAccess(userId, { role: "BRANCH_ADMIN" })
      expect(status).toBe(403)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses an escalation to SUPER_ADMIN from either administrator", async () => {
      const userId = await makeUser("escalate", "ORDER_PORTAL")

      for (const actor of [headOffice, superAdmin]) {
        signIn(actor)
        expect((await patchAccess(userId, { role: "SUPER_ADMIN" })).status).toBe(403)
      }
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses Head Office granting a peer its own authority", async () => {
      const userId = await makeUser("peer", "ORDER_PORTAL")
      signIn(headOffice)

      // canAssignRole requires strictly below the actor's own level.
      expect((await patchAccess(userId, { role: "HEAD_OFFICE" })).status).toBe(403)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses an administrator changing their own access level", async () => {
      signIn(headOffice)
      const { status } = await patchAccess(headOffice.id, { role: "BRANCH_ADMIN" })
      expect(status).toBe(403)
    })
  })

  /**
   * Four roles, two shapes. `BRANCH_ADMIN`/`ORDER_PORTAL` are pinned to one
   * branch; `GROUP_USER`/`GROUP_ORDER_PORTAL` carry no branch and reach branches
   * through assignments. Every one of the twelve transitions is exercised here,
   * because the cross-shape directions are the ones that need information from
   * the administrator and the ones that can leave a row in an invalid shape.
   */
  describe("the full four-role matrix", () => {
    const SINGLE_BRANCH: readonly string[] = ["BRANCH_ADMIN", "ORDER_PORTAL"]
    const GROUP_BASED: readonly string[] = ["GROUP_USER", "GROUP_ORDER_PORTAL"]

    /** The body an administrator's dialog sends for each target shape. */
    function bodyFor(nextRole: string) {
      return GROUP_BASED.includes(nextRole)
        ? { role: nextRole, branchId: null, groupIds: [fixtures.alphaGroupId], branchIds: [] }
        : { role: nextRole, branchId: fixtures.alphaNorthId, groupIds: [], branchIds: [] }
    }

    async function shapeOf(userId: string) {
      const [row] = await db
        .select({ branchId: users.branchId })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      return { branchId: row.branchId, scopedBranchIds: await resolveScopedBranchIds(db, userId) }
    }

    async function assignGroup(userId: string) {
      await db.insert(userGroupAssignments).values({
        userId,
        groupId: fixtures.alphaGroupId,
        organizationId: fixtures.organizationId,
      })
    }

    for (const from of [...SINGLE_BRANCH, ...GROUP_BASED]) {
      for (const to of [...SINGLE_BRANCH, ...GROUP_BASED]) {
        if (from === to) continue
        it("moves " + from + " to " + to + " and leaves a valid row behind", async () => {
          const userId = await makeUser(
            (from + "2" + to).replace(/_/g, "").toLowerCase().slice(0, 24),
            from,
            { branchId: SINGLE_BRANCH.includes(from) ? fixtures.alphaNorthId : null },
          )
          if (GROUP_BASED.includes(from)) await assignGroup(userId)
          signIn(headOffice)

          const { status, payload } = await patchAccess(userId, bodyFor(to))
          expect(status, JSON.stringify(payload)).toBe(200)
          expect(await roleNameOf(userId)).toBe(to)

          const shape = await shapeOf(userId)
          if (GROUP_BASED.includes(to)) {
            // No pinned branch, and a scope that actually reaches something —
            // an empty assignment set denies everything rather than widening.
            expect(shape.branchId).toBeNull()
            expect(shape.scopedBranchIds.length).toBeGreaterThan(0)
          } else {
            expect(shape.branchId).toBe(fixtures.alphaNorthId)
            // Assignments are cleared on the way out of a group role.
            expect(shape.scopedBranchIds).toEqual([])
          }
        })
      }
    }

    it("refuses a move into a group role with no group and no branch", async () => {
      const userId = await makeUser("nogroupscope", "ORDER_PORTAL")
      signIn(headOffice)

      const { status, payload } = await patchAccess(userId, {
        role: "GROUP_ORDER_PORTAL",
        branchId: null,
        groupIds: [],
        branchIds: [],
      })

      expect(status).toBe(400)
      expect(payload.error).toContain("at least one group or one branch")
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses a move into a group role that keeps a pinned branch", async () => {
      const userId = await makeUser("keepsbranch", "ORDER_PORTAL")
      signIn(headOffice)

      const { status, payload } = await patchAccess(userId, {
        role: "GROUP_USER",
        groupIds: [fixtures.alphaGroupId],
        branchIds: [],
      })

      expect(status).toBe(400)
      expect(payload.error).toContain("not assigned a single branch")
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses a move out of a group role with no branch to land on", async () => {
      const userId = await makeUser("nobranch", "GROUP_USER", { branchId: null })
      await assignGroup(userId)
      signIn(headOffice)

      const { status, payload } = await patchAccess(userId, { role: "BRANCH_ADMIN" })

      expect(status).toBe(400)
      expect(payload.error).toContain("branch is required")
      expect(await roleNameOf(userId)).toBe("GROUP_USER")
    })

    it("refuses group assignments offered to a single-branch role", async () => {
      const userId = await makeUser("straylists", "ORDER_PORTAL")
      signIn(headOffice)

      const { status, payload } = await patchAccess(userId, {
        role: "BRANCH_ADMIN",
        branchId: fixtures.alphaNorthId,
        groupIds: [fixtures.alphaGroupId],
      })

      expect(status).toBe(400)
      expect(payload.error).toContain("group-based roles")
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("refuses a group assignment belonging to another tenant", async () => {
      const userId = await makeUser("foreigngroup", "ORDER_PORTAL")
      signIn(headOffice)

      const { status } = await patchAccess(userId, {
        role: "GROUP_ORDER_PORTAL",
        branchId: null,
        groupIds: [fixtures.foreignGroupId],
        branchIds: [],
      })

      expect(status).toBe(400)
      expect(await roleNameOf(userId)).toBe("ORDER_PORTAL")
    })

    it("carries an untouched scope across a group-to-group switch", async () => {
      const userId = await makeUser("groupcarry", "GROUP_USER", { branchId: null })
      await assignGroup(userId)
      const before = await resolveScopedBranchIds(db, userId)
      signIn(headOffice)

      // No lists supplied: the approver keeps exactly the reach it had.
      const { status } = await patchAccess(userId, { role: "GROUP_ORDER_PORTAL" })

      expect(status).toBe(200)
      expect(await resolveScopedBranchIds(db, userId)).toEqual(before)
    })

    it("clears budget allocation when a Group User stops being one", async () => {
      const userId = await makeUser("allocator", "GROUP_USER", {
        branchId: null,
        budgetAllocationEnabled: true,
      })
      await assignGroup(userId)
      signIn(headOffice)

      expect((await patchAccess(userId, bodyFor("ORDER_PORTAL"))).status).toBe(200)

      const [row] = await db
        .select({ enabled: users.budgetAllocationEnabled })
        .from(users)
        .where(eq(users.id, userId))
        .limit(1)
      expect(row.enabled).toBe(false)
    })
  })

  /**
   * The reporting guarantee, end to end: a role change must not move an order
   * out of any report, nor take its author out of the filter that selects it.
   */
  describe("reporting survives a group role change", () => {
    it("keeps a former group requester in the branch's user filter after their assignments are cleared", async () => {
      const userId = await makeUser("reportcarry", "GROUP_ORDER_PORTAL", { branchId: null })
      await db.insert(userGroupAssignments).values({
        userId,
        groupId: fixtures.alphaGroupId,
        organizationId: fixtures.organizationId,
      })
      // An order they raised for a branch they reached only through the group.
      await makeOrder(userId, "FULFILLED", "GROUP_ORDER_PORTAL")

      signIn(headOffice)
      const listedBefore = await listUsersForBranch(fixtures.alphaNorthId)
      expect(listedBefore).toContain(userId)

      // Move them to a single-branch role at a *different* branch, so neither
      // `users.branch_id` nor any assignment connects them to alphaNorth.
      const { status } = await patchAccess(userId, {
        role: "ORDER_PORTAL",
        branchId: fixtures.alphaSouthId,
        groupIds: [],
        branchIds: [],
      })
      expect(status).toBe(200)
      expect(await resolveScopedBranchIds(db, userId)).toEqual([])

      // Their order still belongs to alphaNorth, so they must still be
      // selectable there — otherwise the branch's own figures include orders
      // nobody can filter to.
      const listedAfter = await listUsersForBranch(fixtures.alphaNorthId)
      expect(listedAfter).toContain(userId)
    })

    it("keeps the order attributed to the role it was raised under", async () => {
      const userId = await makeUser("reportrole", "GROUP_ORDER_PORTAL", { branchId: null })
      await db.insert(userGroupAssignments).values({
        userId,
        groupId: fixtures.alphaGroupId,
        organizationId: fixtures.organizationId,
      })
      const orderId = await makeOrder(userId, "FULFILLED", "GROUP_ORDER_PORTAL")
      signIn(headOffice)

      expect((await patchAccess(userId, {
        role: "BRANCH_ADMIN",
        branchId: fixtures.alphaNorthId,
        groupIds: [],
        branchIds: [],
      })).status).toBe(200)

      const [row] = await db
        .select({ createdByRole: orders.createdByRole })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1)
      // They are a Branch Admin now — a role that raises nothing — but the
      // order is still a requester's and still counts as one.
      expect(row.createdByRole).toBe("GROUP_ORDER_PORTAL")
    })
  })

  describe("the order's recorded creator role survives the switch", () => {
    it("keeps attributing an order to the role it was raised under", async () => {
      const userId = await makeUser("attribution", "ORDER_PORTAL")
      const orderId = await makeOrder(userId, "FULFILLED", "ORDER_PORTAL")
      signIn(headOffice)

      expect((await patchAccess(userId, { role: "BRANCH_ADMIN" })).status).toBe(200)

      const [row] = await db
        .select({ createdByRole: orders.createdByRole })
        .from(orders)
        .where(eq(orders.id, orderId))
        .limit(1)
      // The person is now a BRANCH_ADMIN; the order is still a requester's.
      expect(row.createdByRole).toBe("ORDER_PORTAL")
      expect(await roleNameOf(userId)).toBe("BRANCH_ADMIN")
    })
  })
})

describe.skipIf(hasTestDatabase)("requester role switch suite", () => {
  it(NO_DATABASE_REASON, () => {})
})
