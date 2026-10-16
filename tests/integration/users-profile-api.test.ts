import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { desc, eq, inArray } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as userRoute from "@/app/api/v1/users/[id]/route"
import { branches, orders, organizations, roles, sessions, systemLogs, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { verifyPassword } from "@/lib/password"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * PATCH / DELETE /api/v1/users/[id] — the profile editor and the delete button.
 *
 * Who may touch whom is the whole point of this route, so every case is an
 * authorization case: role level (an actor manages only users strictly below
 * it, never a Super Admin), tenant (Head Office stays inside its organization —
 * including against a user that has no organization at all), and the effects a
 * password reset must have on the target's sessions and lockout.
 */

vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/cache-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cache-utils")>()
  return { ...actual, invalidateByPrefix: vi.fn(async () => {}) }
})
vi.mock("@/lib/session-validation-cache", () => ({ invalidateSessionValidationCache: vi.fn(async () => {}) }))
// The audit writers read the caller's address from `headers()`, which only
// exists inside a real request.
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1", "user-agent": "vitest" })),
}))

const { getServerSession } = mockedNextAuth
const NEW_PASSWORD = "Reset-Passw0rd!2026"

type Fixtures = Awaited<ReturnType<typeof createFixtures>>

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "users profile it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [home, foreign] = await db.insert(organizations).values([
    { name: `IT Users Home ${suffix}`, code: `ITUH-${suffix}` },
    { name: `IT Users Foreign ${suffix}`, code: `ITUF-${suffix}` },
  ]).returning({ id: organizations.id })

  const person = async (label: string, role: string, organizationId: number | null, extra: Record<string, unknown> = {}) => {
    const [row] = await db.insert(users).values({
      email: `it-users-${label}-${suffix}@example.test`,
      username: `it-users-${label}-${suffix}`,
      passwordHash: "$2b$12$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyzABCDE",
      roleId: await roleId(role),
      organizationId,
      firstName: label,
      lastName: suffix,
      fullName: `${label} ${suffix}`,
      ...extra,
    }).returning({ id: users.id })
    return row.id
  }

  return {
    suffix,
    homeOrganizationId: home.id,
    foreignOrganizationId: foreign.id,
    superAdminId: await person("super", "SUPER_ADMIN", null),
    headOfficeId: await person("head", "HEAD_OFFICE", home.id),
    peerHeadOfficeId: await person("peer-head", "HEAD_OFFICE", home.id),
    orderPortalId: await person("op", "ORDER_PORTAL", home.id, {
      failedLoginAttempts: 4,
      lockoutUntil: new Date(Date.now() + 60 * 60_000),
      sessionVersion: 7,
    }),
    branchAdminId: await person("ba", "BRANCH_ADMIN", home.id),
    foreignOrderPortalId: await person("foreign-op", "ORDER_PORTAL", foreign.id),
    orphanBranchAdminId: await person("orphan", "BRANCH_ADMIN", null),
    deskId: await person("desk", "ORDER_DESK", null),
  }
}

function allUserIds(f: Fixtures): string[] {
  return [
    f.superAdminId, f.headOfficeId, f.peerHeadOfficeId, f.orderPortalId, f.branchAdminId,
    f.foreignOrderPortalId, f.orphanBranchAdminId, f.deskId,
  ]
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const ids = allUserIds(f)
  await db.delete(systemLogs).where(inArray(systemLogs.userId, ids))
  await db.delete(systemLogs).where(inArray(systemLogs.resourceId, ids))
  await db.delete(sessions).where(inArray(sessions.userId, ids))
  await db.delete(orders).where(inArray(orders.organizationId, [f.homeOrganizationId, f.foreignOrganizationId]))
  await db.delete(branches).where(inArray(branches.organizationId, [f.homeOrganizationId, f.foreignOrganizationId]))
  await db.delete(users).where(inArray(users.id, ids))
  await db.delete(users).where(inArray(users.organizationId, [f.homeOrganizationId, f.foreignOrganizationId]))
  await db.delete(organizations).where(inArray(organizations.id, [f.homeOrganizationId, f.foreignOrganizationId]))
}

function signIn(user: { id: string; role: string } | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    user === null ? null : ({ user: { ...user, email: "actor@example.test", mustChangePassword: false } } as any),
  )
}

async function patch(id: string, body: unknown) {
  const response = await userRoute.PATCH(
    new NextRequest(`http://localhost/api/v1/users/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  )
  return { status: response.status, body: await response.json() }
}

async function remove(id: string) {
  const response = await userRoute.DELETE(
    new NextRequest(`http://localhost/api/v1/users/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  )
  return { status: response.status, body: await response.json() }
}

async function readUser(id: string) {
  const [row] = await db.select().from(users).where(eq(users.id, id))
  return row
}

describe.skipIf(!hasTestDatabase)("PATCH/DELETE /api/v1/users/[id]", () => {
  let f: Fixtures
  const headOffice = () => ({ id: f.headOfficeId, role: "HEAD_OFFICE" })
  const superAdmin = () => ({ id: f.superAdminId, role: "SUPER_ADMIN" })

  beforeAll(async () => {
    f = await createFixtures()
  })

  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })

  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    vi.spyOn(console, "warn").mockImplementation(() => {})
  })

  describe("who may edit whom", () => {
    it("refuses anonymous callers and roles that do not manage users", async () => {
      signIn(null)
      expect((await patch(f.orderPortalId, { firstName: "X" })).status).toBe(401)
      signIn({ id: f.branchAdminId, role: "BRANCH_ADMIN" })
      expect((await patch(f.orderPortalId, { firstName: "X" })).status).toBe(403)
    })

    it("lets Head Office edit a lower role in its own organization", async () => {
      signIn(headOffice())
      const result = await patch(f.branchAdminId, { firstName: "Renamed", lastName: "Admin" })
      expect(result).toEqual({ status: 200, body: { success: true } })
      const row = await readUser(f.branchAdminId)
      expect(row.firstName).toBe("Renamed")
      expect(row.fullName).toBe("Renamed Admin")
    })

    it("refuses Head Office against a peer, a Super Admin and the Order Desk", async () => {
      signIn(headOffice())
      expect((await patch(f.peerHeadOfficeId, { firstName: "X" })).status).toBe(403)
      expect((await patch(f.superAdminId, { firstName: "X" })).status).toBe(403)
      expect((await patch(f.deskId, { firstName: "X" })).status).toBe(403)
    })

    it("refuses Head Office against another organization's user", async () => {
      signIn(headOffice())
      const result = await patch(f.foreignOrderPortalId, { firstName: "X" })
      expect(result.status).toBe(403)
      expect((await readUser(f.foreignOrderPortalId)).firstName).toBe("foreign-op")
    })

    it("refuses Head Office against a user that belongs to no organization", async () => {
      signIn(headOffice())
      const result = await patch(f.orphanBranchAdminId, { password: NEW_PASSWORD })
      expect(result.status).toBe(403)
      expect(await verifyPassword(NEW_PASSWORD, (await readUser(f.orphanBranchAdminId)).passwordHash)).toBe(false)
    })

    it("lets Super Admin edit across tenants but never another Super Admin", async () => {
      signIn(superAdmin())
      expect((await patch(f.foreignOrderPortalId, { lastName: "Edited" })).status).toBe(200)
      expect((await patch(f.orphanBranchAdminId, { lastName: "Edited" })).status).toBe(200)
      expect((await patch(f.superAdminId, { lastName: "Edited" })).status).toBe(403)
    })

    it("answers 404 for an unknown user", async () => {
      signIn(superAdmin())
      expect((await patch(randomUUID(), { firstName: "X" })).status).toBe(404)
    })
  })

  describe("what may be edited", () => {
    it("refuses access fields and unknown fields — role, tenant and status go through the access route", async () => {
      signIn(headOffice())
      for (const body of [
        { role: "SUPER_ADMIN" },
        { organizationId: f.foreignOrganizationId },
        { isActive: false },
        { firstName: "X", passwordHash: "x" },
      ]) {
        expect((await patch(f.orderPortalId, body)).status, JSON.stringify(body)).toBe(400)
      }
      expect((await patch(f.orderPortalId, {})).status).toBe(400)
      const row = await readUser(f.orderPortalId)
      expect(row.organizationId).toBe(f.homeOrganizationId)
    })

    it("refuses a weak password", async () => {
      signIn(headOffice())
      expect((await patch(f.orderPortalId, { password: "weak" })).status).toBe(400)
    })

    it("refuses a username or email another account already holds", async () => {
      signIn(headOffice())
      const taken = await patch(f.orderPortalId, { username: `IT-USERS-BA-${f.suffix}` })
      expect(taken).toEqual({ status: 400, body: { error: "Username already in use by another user" } })

      const email = await patch(f.orderPortalId, { email: `it-users-ba-${f.suffix}@example.test` })
      expect(email.status).toBe(400)
    })

    it("keeps the user's own username without calling it taken", async () => {
      signIn(headOffice())
      expect((await patch(f.orderPortalId, { username: `it-users-op-${f.suffix}` })).status).toBe(200)
    })

    it("resets a password: new hash, lockout cleared, sessions dropped, session version bumped, audit written", async () => {
      await db.insert(sessions).values({
        userId: f.orderPortalId,
        refreshTokenHash: `it-users-${f.suffix}-${randomUUID()}`,
        expiresAt: new Date(Date.now() + 60_000),
      })

      signIn(headOffice())
      expect((await patch(f.orderPortalId, { password: NEW_PASSWORD })).status).toBe(200)

      const row = await readUser(f.orderPortalId)
      expect(await verifyPassword(NEW_PASSWORD, row.passwordHash)).toBe(true)
      expect(row.failedLoginAttempts).toBe(0)
      expect(row.lockoutUntil).toBeNull()
      expect(row.sessionVersion).toBe(8)
      expect(await db.select().from(sessions).where(eq(sessions.userId, f.orderPortalId))).toHaveLength(0)

      const [audit] = await db.select().from(systemLogs)
        .where(eq(systemLogs.resourceId, f.orderPortalId))
        .orderBy(desc(systemLogs.id))
        .limit(1)
      expect(audit).toMatchObject({ action: "USER_UPDATE", userId: f.headOfficeId, ipAddress: "203.0.113.7" })
      expect(audit.details).toMatchObject({ sessionsInvalidated: true })
      expect(JSON.stringify(audit.details)).not.toContain(NEW_PASSWORD)
    })

    it("sets and clears a designation, and refuses one too long for the column", async () => {
      signIn(headOffice())
      expect((await patch(f.branchAdminId, { designation: "  Store Lead " })).status).toBe(200)
      expect((await readUser(f.branchAdminId)).designation).toBe("Store Lead")

      expect((await patch(f.branchAdminId, { designation: "x".repeat(81) })).status).toBe(400)
      expect((await readUser(f.branchAdminId)).designation).toBe("Store Lead")

      // An edit that does not name the field leaves it alone.
      expect((await patch(f.branchAdminId, { phone: "0300-1111111" })).status).toBe(200)
      expect((await readUser(f.branchAdminId)).designation).toBe("Store Lead")

      expect((await patch(f.branchAdminId, { designation: "" })).status).toBe(200)
      expect((await readUser(f.branchAdminId)).designation).toBeNull()
    })

    it("refuses a designation edit on another organization's user", async () => {
      signIn(headOffice())
      expect((await patch(f.foreignOrderPortalId, { designation: "Planted" })).status).toBe(403)
      expect((await readUser(f.foreignOrderPortalId)).designation).toBeNull()
    })

    it("does not touch sessions for an ordinary profile edit", async () => {
      const before = await readUser(f.branchAdminId)
      signIn(headOffice())
      await patch(f.branchAdminId, { phone: "0300-0000000" })
      expect((await readUser(f.branchAdminId)).sessionVersion).toBe(before.sessionVersion)
    })
  })

  describe("deleting", () => {
    it("refuses to delete yourself", async () => {
      signIn(headOffice())
      const result = await remove(f.headOfficeId)
      expect(result.status).toBe(400)
      expect(result.body.error).toMatch(/your own account/)
    })

    it("refuses cross-tenant, null-tenant and higher-level targets", async () => {
      signIn(headOffice())
      expect((await remove(f.foreignOrderPortalId)).status).toBe(403)
      expect((await remove(f.orphanBranchAdminId)).status).toBe(403)
      expect((await remove(f.peerHeadOfficeId)).status).toBe(403)
      expect(await readUser(f.foreignOrderPortalId)).toBeDefined()
      expect(await readUser(f.orphanBranchAdminId)).toBeDefined()
    })

    it("refuses while the user administers a branch", async () => {
      const [branch] = await db.insert(branches).values({
        organizationId: f.homeOrganizationId,
        name: `Admin Branch ${f.suffix}`,
        status: "active",
        adminUserId: f.branchAdminId,
      }).returning({ id: branches.id })

      signIn(headOffice())
      const result = await remove(f.branchAdminId)
      expect(result.status).toBe(400)
      expect(result.body.error).toMatch(/administrator for 1 branch/)

      await db.delete(branches).where(eq(branches.id, branch.id))
    })

    it("soft-deletes a user with order history, freeing the email for reuse", async () => {
      const [branch] = await db.insert(branches).values({
        organizationId: f.homeOrganizationId,
        name: `History Branch ${f.suffix}`,
        status: "active",
      }).returning({ id: branches.id })
      const historyUser = await db.insert(users).values({
        email: `it-users-history-${f.suffix}@example.test`,
        username: `it-users-history-${f.suffix}`,
        passwordHash: "x",
        roleId: await roleId("ORDER_PORTAL"),
        organizationId: f.homeOrganizationId,
      }).returning({ id: users.id })
      await db.insert(orders).values({
        tid: `ITU-${f.suffix}`,
        organizationId: f.homeOrganizationId,
        branchId: branch.id,
        createdByUserId: historyUser[0].id,
        status: "PENDING",
        subtotalCents: 100,
        taxCents: 0,
        totalCents: 100,
      })

      signIn(headOffice())
      expect((await remove(historyUser[0].id)).status).toBe(200)

      const row = await readUser(historyUser[0].id)
      expect(row.deletedAt).toBeInstanceOf(Date)
      expect(row.isActive).toBe(false)
      expect(row.email).toMatch(new RegExp(`^deleted_\\d+_it-users-history-${f.suffix}@example\\.test$`))

      const [audit] = await db.select().from(systemLogs).where(eq(systemLogs.resourceId, historyUser[0].id))
      expect(audit).toMatchObject({ action: "USER_DELETE", userId: f.headOfficeId })
    })

    it("hard-deletes a user with no history", async () => {
      const [fresh] = await db.insert(users).values({
        email: `it-users-fresh-${f.suffix}@example.test`,
        username: `it-users-fresh-${f.suffix}`,
        passwordHash: "x",
        roleId: await roleId("ORDER_PORTAL"),
        organizationId: f.homeOrganizationId,
      }).returning({ id: users.id })

      signIn(headOffice())
      expect((await remove(fresh.id)).status).toBe(200)
      expect(await readUser(fresh.id)).toBeUndefined()
    })
  })
})
