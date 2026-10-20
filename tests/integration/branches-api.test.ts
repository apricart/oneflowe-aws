import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, desc, eq, inArray } from "drizzle-orm"
import * as mockedNextAuth from "next-auth"

import * as branchPerformanceRoute from "@/app/api/v1/analytics/branches/performance/route"
import * as branchRoute from "@/app/api/v1/branches/[id]/route"
import * as branchesRoute from "@/app/api/v1/branches/route"
import { auditLogs, branches, groups, organizations, roles, userBranchAssignments, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * /api/v1/branches and /api/v1/branches/[id], end to end.
 *
 * Every role that may list branches is checked against the set it should see:
 * Super Admin everything it asks for, Head Office its tenant, Branch Admin its
 * own branch, a Group User its assignments — and any non-Super-Admin caller
 * without an organization nothing at all. Creation and editing are held to the
 * caller's tenant, and every write leaves an audit row.
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
  const [created] = await db.insert(roles).values({ name, description: "branches it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [home, foreign] = await db.insert(organizations).values([
    { name: `IT Branches Home ${suffix}`, code: `ITBH${suffix}` },
    { name: `IT Branches Foreign ${suffix}`, code: `ITBF${suffix}` },
  ]).returning({ id: organizations.id, code: organizations.code })

  const [north, south, abroad] = await db.insert(branches).values([
    { organizationId: home.id, name: `North ${suffix}`, status: "active", code: `${home.code}-01` },
    { organizationId: home.id, name: `South ${suffix}`, status: "active", code: `${home.code}-02` },
    { organizationId: foreign.id, name: `Abroad ${suffix}`, status: "active", code: `${foreign.code}-01` },
  ]).returning({ id: branches.id })

  const person = async (label: string, role: string, organizationId: number | null, branchId: number | null = null) => {
    const [row] = await db.insert(users).values({
      email: `it-branches-${label}-${suffix}@example.test`,
      username: `it-branches-${label}-${suffix}`,
      passwordHash: "x",
      roleId: await roleId(role),
      organizationId,
      branchId,
    }).returning({ id: users.id })
    return row.id
  }

  const superAdminId = await person("super", "SUPER_ADMIN", null)
  const headOfficeId = await person("head", "HEAD_OFFICE", home.id)
  const branchAdminId = await person("ba", "BRANCH_ADMIN", home.id, north.id)
  const groupUserId = await person("gu", "GROUP_USER", home.id)
  const orderPortalId = await person("op", "ORDER_PORTAL", home.id, north.id)
  const orphanOrderPortalId = await person("orphan-op", "ORDER_PORTAL", null, null)
  await db.insert(userBranchAssignments).values({
    userId: groupUserId,
    branchId: south.id,
    organizationId: home.id,
    createdByUserId: headOfficeId,
  })

  const [homeGroup] = await db.insert(groups)
    .values({ organizationId: home.id, name: `Home Group ${suffix}`, createdByUserId: headOfficeId })
    .returning({ id: groups.id })
  const [foreignGroup] = await db.insert(groups)
    .values({ organizationId: foreign.id, name: `Foreign Group ${suffix}`, createdByUserId: headOfficeId })
    .returning({ id: groups.id })

  return {
    suffix,
    home: home.id,
    homeCode: home.code,
    foreign: foreign.id,
    north: north.id,
    south: south.id,
    abroad: abroad.id,
    homeGroup: homeGroup.id,
    foreignGroup: foreignGroup.id,
    superAdminId,
    headOfficeId,
    branchAdminId,
    groupUserId,
    orderPortalId,
    orphanOrderPortalId,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orgs = [f.home, f.foreign]
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, orgs))
  await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.organizationId, orgs))
  await db.delete(branches).where(inArray(branches.organizationId, orgs))
  await db.delete(groups).where(inArray(groups.id, [f.homeGroup, f.foreignGroup]))
  await db.delete(users).where(inArray(users.id, [
    f.superAdminId, f.headOfficeId, f.branchAdminId, f.groupUserId, f.orderPortalId, f.orphanOrderPortalId,
  ]))
  await db.delete(organizations).where(inArray(organizations.id, orgs))
}

function signIn(user: { id: string; role: string } | null): void {
  vi.mocked(getServerSession).mockResolvedValue(
    user === null ? null : ({ user: { ...user, email: "actor@example.test", mustChangePassword: false } } as any),
  )
}

async function list(query = "") {
  const response = await branchesRoute.GET(new Request(`http://localhost/api/v1/branches?refresh=1${query}`))
  const body = await response.json()
  return { status: response.status, body, ids: (body.items ?? []).map((item: { id: number }) => item.id) as number[] }
}

async function create(body: unknown) {
  const response = await branchesRoute.POST(new Request("http://localhost/api/v1/branches", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }))
  return { status: response.status, body: await response.json() }
}

async function getOne(id: number | string) {
  const response = await branchRoute.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: String(id) }) })
  return { status: response.status, body: await response.json() }
}

async function patchOne(id: number, body: unknown) {
  const response = await branchRoute.PATCH(new Request("http://localhost/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }), { params: Promise.resolve({ id: String(id) }) })
  return { status: response.status, body: await response.json() }
}

async function performance(query: string) {
  const response = await branchPerformanceRoute.GET(
    new Request(`http://localhost/api/v1/analytics/branches/performance?${query}`) as any,
  )
  const body = await response.json()
  return { status: response.status, body, ids: (body.items ?? []).map((item: { id: number }) => item.id) as number[] }
}

/** The Postgres error behind a failed statement, whether or not Drizzle wrapped it. */
async function failureOf(write: Promise<unknown>): Promise<{ code: string; constraint: string } | null> {
  return write.then(
    () => null,
    (caught: any) => ({
      code: String(caught.code ?? caught.cause?.code),
      constraint: String(caught.constraint ?? caught.cause?.constraint),
    }),
  )
}

async function deleteOne(id: number) {
  const response = await branchRoute.DELETE(new Request("http://localhost/x", { method: "DELETE" }), {
    params: Promise.resolve({ id: String(id) }),
  })
  return { status: response.status, body: await response.json() }
}

const validBranch = (organizationId: number, name: string) => ({
  organizationId,
  name,
  province: "Sindh",
  city: "Karachi",
  address: "Plot 1, Street 2",
})

describe.skipIf(!hasTestDatabase)("branches API", () => {
  let f: Fixtures

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

  describe("listing", () => {
    it("refuses anonymous callers and roles not on the list", async () => {
      signIn(null)
      expect((await list()).status).toBe(401)
      signIn({ id: f.superAdminId, role: "GROUP_ORDER_PORTAL" })
      expect((await list()).status).toBe(403)
    })

    it("shows Super Admin the tenants it asks for", async () => {
      signIn({ id: f.superAdminId, role: "SUPER_ADMIN" })
      const both = await list(`&organizationId=${f.home},${f.foreign}`)
      expect(both.ids).toEqual(expect.arrayContaining([f.north, f.south, f.abroad]))
      const one = await list(`&organizationId=${f.foreign}`)
      expect(one.ids).toEqual([f.abroad])
    })

    it("validates the organization filter", async () => {
      signIn({ id: f.superAdminId, role: "SUPER_ADMIN" })
      expect((await list("&organizationId=abc")).status).toBe(400)
      expect((await list("&organizationId=0")).status).toBe(400)
    })

    it("keeps Head Office inside its tenant whatever the query names", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await list(`&organizationId=${f.foreign}`)
      expect(result.status).toBe(200)
      expect(result.ids.sort()).toEqual([f.north, f.south].sort())
    })

    it("shows a Branch Admin its own branch only", async () => {
      signIn({ id: f.branchAdminId, role: "BRANCH_ADMIN" })
      expect((await list()).ids).toEqual([f.north])
    })

    it("shows a Group User only its assigned branches", async () => {
      signIn({ id: f.groupUserId, role: "GROUP_USER" })
      expect((await list()).ids).toEqual([f.south])
    })

    it("lets an Order Portal user see its tenant's branches and nothing beyond", async () => {
      signIn({ id: f.orderPortalId, role: "ORDER_PORTAL" })
      const result = await list()
      expect(result.ids.sort()).toEqual([f.north, f.south].sort())
    })

    it("refuses any non-Super-Admin caller without an organization instead of listing every tenant", async () => {
      signIn({ id: f.orphanOrderPortalId, role: "ORDER_PORTAL" })
      const result = await list()
      expect(result.status).toBe(403)
      expect(result.ids).toEqual([])
    })

    it("filters by group", async () => {
      await db.update(branches).set({ groupId: f.homeGroup }).where(eq(branches.id, f.north))
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await list(`&groupIds=${f.homeGroup}`)
      expect(result.ids).toEqual([f.north])
      expect(result.body.items[0].groupName).toBe(`Home Group ${f.suffix}`)
      await db.update(branches).set({ groupId: null }).where(eq(branches.id, f.north))
    })
  })

  describe("creating", () => {
    it("creates a branch with the next code in sequence and audits it", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await create(validBranch(f.home, `East ${f.suffix}`))

      expect(result.status).toBe(201)
      expect(result.body.item).toMatchObject({ organizationId: f.home, code: `${f.homeCode}-03`, status: "active" })
      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "CREATE_BRANCH"),
        eq(auditLogs.entityId, String(result.body.item.id)),
      ))
      expect(audit).toMatchObject({ userId: f.headOfficeId, organizationId: f.home })
    })

    it("refuses a duplicate name, case- and space-insensitively", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await create(validBranch(f.home, `  NORTH ${f.suffix.toUpperCase()} `))
      expect(result.status).toBe(409)
    })

    it("keeps Head Office from creating in another tenant", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await create(validBranch(f.foreign, `Sneaky ${f.suffix}`))
      expect(result.status).toBe(403)
      expect(await db.select().from(branches).where(eq(branches.name, `Sneaky ${f.suffix}`))).toHaveLength(0)
    })

    it("lets Super Admin create anywhere, and answers 404 for an unknown tenant", async () => {
      signIn({ id: f.superAdminId, role: "SUPER_ADMIN" })
      expect((await create(validBranch(f.foreign, `Abroad Two ${f.suffix}`))).status).toBe(201)
      expect((await create(validBranch(2_147_483_000, `Nowhere ${f.suffix}`))).status).toBe(404)
    })

    it("refuses roles that may not create, and malformed bodies", async () => {
      signIn({ id: f.branchAdminId, role: "BRANCH_ADMIN" })
      expect((await create(validBranch(f.home, `X ${f.suffix}`))).status).toBe(403)

      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await create({ ...validBranch(f.home, "A"), })).status).toBe(400)
      expect((await create({ ...validBranch(f.home, `Y ${f.suffix}`), address: "x" })).status).toBe(400)
      expect((await create({ ...validBranch(f.home, `Z ${f.suffix}`), code: "MINE" })).status).toBe(400)
    })
  })

  describe("reading and editing one branch", () => {
    it("lets Head Office read its tenant's branch and refuses another tenant's", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await getOne(f.south)).status).toBe(200)
      expect((await getOne(f.abroad)).status).toBe(403)
      expect((await getOne(2_147_483_000)).status).toBe(404)
    })

    it("lets a Branch Admin read its own branch but not a sibling", async () => {
      signIn({ id: f.branchAdminId, role: "BRANCH_ADMIN" })
      expect((await getOne(f.north)).status).toBe(200)
      expect((await getOne(f.south)).status).toBe(403)
    })

    it("edits a branch, recording the before and after of only the touched fields", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const result = await patchOne(f.south, { city: "Lahore", groupId: f.homeGroup })
      expect(result.status).toBe(200)
      expect(result.body.item).toMatchObject({ city: "Lahore", groupId: f.homeGroup })

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE_BRANCH"), eq(auditLogs.entityId, String(f.south))))
        .orderBy(desc(auditLogs.id))
        .limit(1)
      expect(JSON.stringify(audit.metadata)).toContain("Lahore")
      expect(JSON.stringify(audit.metadata)).not.toContain("adminUserId")
    })

    it("refuses another tenant's group, another tenant's branch, a duplicate name, and a bad status", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await patchOne(f.south, { groupId: f.foreignGroup })).status).toBe(400)
      expect((await patchOne(f.abroad, { city: "Lahore" })).status).toBe(403)
      expect((await patchOne(f.south, { name: `north ${f.suffix}` })).status).toBe(409)
      expect((await patchOne(f.south, { status: "closed" })).status).toBe(400)
      expect((await patchOne(f.south, {})).status).toBe(400)
      expect((await patchOne(2_147_483_000, { city: "Lahore" })).status).toBe(404)
    })

    it("keeps deactivation to Super Admin, and deactivates rather than deletes", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await deleteOne(f.south)).status).toBe(403)

      signIn({ id: f.superAdminId, role: "SUPER_ADMIN" })
      const result = await deleteOne(f.south)
      expect(result.status).toBe(200)
      expect(result.body.item.status).toBe("inactive")
      expect((await deleteOne(f.south)).status).toBe(400)
      expect((await deleteOne(2_147_483_000)).status).toBe(404)

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "DEACTIVATE_BRANCH"), eq(auditLogs.entityId, String(f.south))))
      expect(audit.userId).toBe(f.superAdminId)
    })
  })

  /**
   * The parent / child label (plans/OF-BRANCH-parent-child-label.md): set on
   * create and edit by the roles that already write branches, held to the
   * branch's own organization, one level deep, and read back on the lists and
   * the Branch Report. A label only — no access rule reads it.
   */
  describe("parent / child label", () => {
    const tag = () => randomUUID().slice(0, 6)

    async function createAs(role: "HEAD_OFFICE" | "SUPER_ADMIN", body: Record<string, unknown>) {
      signIn(role === "HEAD_OFFICE" ? { id: f.headOfficeId, role } : { id: f.superAdminId, role })
      return create(body)
    }

    it("creates a parent and a child of it, audits both, and lists them with the parent's name", async () => {
      const parent = await createAs("HEAD_OFFICE", { ...validBranch(f.home, `Parent ${tag()}`), hierarchyRole: "PARENT" })
      expect(parent.status).toBe(201)
      expect(parent.body.item).toMatchObject({ hierarchyRole: "PARENT", parentBranchId: null })

      const child = await createAs("HEAD_OFFICE", {
        ...validBranch(f.home, `Child ${tag()}`), hierarchyRole: "CHILD", parentBranchId: parent.body.item.id,
      })
      expect(child.status).toBe(201)
      expect(child.body.item).toMatchObject({ hierarchyRole: "CHILD", parentBranchId: parent.body.item.id })

      const [audit] = await db.select().from(auditLogs).where(and(
        eq(auditLogs.action, "CREATE_BRANCH"),
        eq(auditLogs.entityId, String(child.body.item.id)),
      ))
      expect(audit.metadata).toMatchObject({ hierarchyRole: "CHILD", parentBranchId: parent.body.item.id })

      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const listed = (await list()).body.items.find((item: { id: number }) => item.id === child.body.item.id)
      expect(listed).toMatchObject({ hierarchyRole: "CHILD", parentBranchName: parent.body.item.name })
      expect((await getOne(child.body.item.id)).body.item).toMatchObject({ parentBranchName: parent.body.item.name })
    })

    it("treats a branch created without a type as standalone", async () => {
      const result = await createAs("HEAD_OFFICE", validBranch(f.home, `Plain ${tag()}`))
      expect(result.status).toBe(201)
      expect(result.body.item).toMatchObject({ hierarchyRole: "STANDALONE", parentBranchId: null })
    })

    it("refuses a child without a parent, a parent on a non-child, an unknown type, and a non-parent as parent", async () => {
      expect((await createAs("HEAD_OFFICE", { ...validBranch(f.home, `A ${tag()}`), hierarchyRole: "CHILD" })).status).toBe(400)
      expect((await createAs("HEAD_OFFICE", {
        ...validBranch(f.home, `B ${tag()}`), hierarchyRole: "PARENT", parentBranchId: f.north,
      })).status).toBe(400)
      expect((await createAs("HEAD_OFFICE", { ...validBranch(f.home, `C ${tag()}`), hierarchyRole: "GRANDPARENT" })).status).toBe(400)
      expect((await createAs("HEAD_OFFICE", { ...validBranch(f.home, `D ${tag()}`), parentBranchId: "7" })).status).toBe(400)

      // North is standalone.
      const notAParent = await createAs("HEAD_OFFICE", {
        ...validBranch(f.home, `E ${tag()}`), hierarchyRole: "CHILD", parentBranchId: f.north,
      })
      expect(notAParent.status).toBe(400)
      expect(notAParent.body.error).toBe("The chosen branch is not a parent branch")
    })

    it("never takes a parent from another organization, and says no more than 'not found'", async () => {
      const [foreignParent] = await db.insert(branches)
        .values({ organizationId: f.foreign, name: `Foreign Parent ${tag()}`, status: "active", hierarchyRole: "PARENT" })
        .returning({ id: branches.id })

      const byHeadOffice = await createAs("HEAD_OFFICE", {
        ...validBranch(f.home, `F ${tag()}`), hierarchyRole: "CHILD", parentBranchId: foreignParent.id,
      })
      expect(byHeadOffice.status).toBe(400)
      expect(byHeadOffice.body.error).toBe("Parent branch not found in this organization")

      // Super Admin may create anywhere, but a child still belongs with its parent.
      const bySuperAdmin = await createAs("SUPER_ADMIN", {
        ...validBranch(f.home, `G ${tag()}`), hierarchyRole: "CHILD", parentBranchId: foreignParent.id,
      })
      expect(bySuperAdmin.status).toBe(400)

      const [home] = await db.select({ id: branches.id }).from(branches)
        .where(and(eq(branches.organizationId, f.home), eq(branches.parentBranchId, foreignParent.id)))
      expect(home).toBeUndefined()
    })

    it("re-parents, re-types and clears a child, and keeps a parent with children from changing type", async () => {
      const first = await createAs("HEAD_OFFICE", { ...validBranch(f.home, `P1 ${tag()}`), hierarchyRole: "PARENT" })
      const second = await createAs("HEAD_OFFICE", { ...validBranch(f.home, `P2 ${tag()}`), hierarchyRole: "PARENT" })
      const child = await createAs("HEAD_OFFICE", {
        ...validBranch(f.home, `K ${tag()}`), hierarchyRole: "CHILD", parentBranchId: first.body.item.id,
      })
      const childId: number = child.body.item.id

      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      const moved = await patchOne(childId, { parentBranchId: second.body.item.id })
      expect(moved.status).toBe(200)
      expect(moved.body.item).toMatchObject({ hierarchyRole: "CHILD", parentBranchId: second.body.item.id })

      const [audit] = await db.select().from(auditLogs)
        .where(and(eq(auditLogs.action, "UPDATE_BRANCH"), eq(auditLogs.entityId, String(childId))))
        .orderBy(desc(auditLogs.id))
        .limit(1)
      expect(JSON.stringify(audit.metadata)).toContain(`"parentBranchId":${second.body.item.id}`)

      const refused = await patchOne(second.body.item.id, { hierarchyRole: "STANDALONE" })
      expect(refused.status).toBe(409)
      const [stillParent] = await db.select({ hierarchyRole: branches.hierarchyRole }).from(branches)
        .where(eq(branches.id, second.body.item.id))
      expect(stillParent.hierarchyRole).toBe("PARENT")

      expect((await patchOne(childId, { parentBranchId: childId })).status).toBe(400)
      expect((await patchOne(childId, { hierarchyRole: "PARENT", parentBranchId: first.body.item.id })).status).toBe(400)
      expect((await patchOne(childId, { parentBranchId: f.north })).status).toBe(400)

      const cleared = await patchOne(childId, { hierarchyRole: "STANDALONE" })
      expect(cleared.status).toBe(200)
      expect(cleared.body.item).toMatchObject({ hierarchyRole: "STANDALONE", parentBranchId: null })

      // With its only child gone, the parent may stop being one.
      expect((await patchOne(second.body.item.id, { hierarchyRole: "STANDALONE" })).status).toBe(200)
      // A standalone branch takes no parent.
      expect((await patchOne(childId, { parentBranchId: first.body.item.id })).status).toBe(400)
    })

    it("keeps Head Office off another tenant's branch whatever the hierarchy fields say", async () => {
      signIn({ id: f.headOfficeId, role: "HEAD_OFFICE" })
      expect((await patchOne(f.abroad, { hierarchyRole: "PARENT" })).status).toBe(403)
      const [abroad] = await db.select({ hierarchyRole: branches.hierarchyRole }).from(branches).where(eq(branches.id, f.abroad))
      expect(abroad.hierarchyRole).toBe("STANDALONE")
    })

    it("holds the rules in the database whatever writes the row", async () => {
      const [parent] = await db.insert(branches)
        .values({ organizationId: f.home, name: `DB Parent ${tag()}`, status: "active", hierarchyRole: "PARENT" })
        .returning({ id: branches.id })
      await db.insert(branches).values({
        organizationId: f.home, name: `DB Child ${tag()}`, status: "active", hierarchyRole: "CHILD", parentBranchId: parent.id,
      })

      // A child of a standalone branch.
      expect(await failureOf(db.insert(branches).values({
        organizationId: f.home, name: `DB Orphan ${tag()}`, status: "active", hierarchyRole: "CHILD", parentBranchId: f.north,
      }))).toEqual({ code: "23514", constraint: "branches_hierarchy_guard" })
      // A parent with children re-typed directly.
      expect(await failureOf(
        db.update(branches).set({ hierarchyRole: "STANDALONE" }).where(eq(branches.id, parent.id)),
      )).toEqual({ code: "23514", constraint: "branches_hierarchy_guard" })
      // A child with no parent, and a parent on a standalone branch.
      expect(await failureOf(db.insert(branches).values({
        organizationId: f.home, name: `DB Lost ${tag()}`, status: "active", hierarchyRole: "CHILD",
      }))).toEqual({ code: "23514", constraint: "branches_hierarchy_parent_ck" })
      expect(await failureOf(db.insert(branches).values({
        organizationId: f.home, name: `DB Odd ${tag()}`, status: "active", parentBranchId: parent.id,
      }))).toEqual({ code: "23514", constraint: "branches_hierarchy_parent_ck" })
      // Deleting a parent that still has children.
      expect(await failureOf(db.delete(branches).where(eq(branches.id, parent.id))))
        .toEqual({ code: "23503", constraint: "branches_parent_org_fk" })
    })

    describe("when a child insert races its parent's re-type", () => {
      // Either order ends with a consistent tree: the trigger takes the parent
      // FOR SHARE, which conflicts with the re-type's row lock, and whichever
      // statement waits re-reads after the other commits.
      async function parentRow() {
        const [parent] = await db.insert(branches)
          .values({ organizationId: f.home, name: `Race Parent ${tag()}`, status: "active", hierarchyRole: "PARENT" })
          .returning({ id: branches.id })
        return parent.id
      }

      it("refuses the re-type once the child commits", async () => {
        const parentId = await parentRow()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        let signalInserted!: () => void
        const inserted = new Promise<void>((resolve) => { signalInserted = resolve })

        const childInsert = db.transaction(async (tx) => {
          await tx.insert(branches).values({
            organizationId: f.home, name: `Race Child ${tag()}`, status: "active", hierarchyRole: "CHILD", parentBranchId: parentId,
          })
          signalInserted()
          await gate
        })
        await inserted
        const retype = failureOf(db.update(branches).set({ hierarchyRole: "STANDALONE" }).where(eq(branches.id, parentId)))
        release()
        await childInsert

        expect(await retype).toEqual({ code: "23514", constraint: "branches_hierarchy_guard" })
      })

      it("refuses the child once the re-type commits", async () => {
        const parentId = await parentRow()
        let release!: () => void
        const gate = new Promise<void>((resolve) => { release = resolve })
        let signalRetyped!: () => void
        const retyped = new Promise<void>((resolve) => { signalRetyped = resolve })

        const retype = db.transaction(async (tx) => {
          await tx.update(branches).set({ hierarchyRole: "STANDALONE" }).where(eq(branches.id, parentId))
          signalRetyped()
          await gate
        })
        await retyped
        const childInsert = failureOf(db.insert(branches).values({
          organizationId: f.home, name: `Race Late ${tag()}`, status: "active", hierarchyRole: "CHILD", parentBranchId: parentId,
        }))
        release()
        await retype

        expect(await childInsert).toEqual({ code: "23514", constraint: "branches_hierarchy_guard" })
      })
    })

    describe("on the Branch Report", () => {
      let family: { parent: number; child: number; foreignParent: number }

      beforeAll(async () => {
        const [parent] = await db.insert(branches)
          .values({ organizationId: f.home, name: `Report Parent ${tag()}`, status: "active", hierarchyRole: "PARENT" })
          .returning({ id: branches.id })
        const [child] = await db.insert(branches)
          .values({ organizationId: f.home, name: `Report Child ${tag()}`, status: "active", hierarchyRole: "CHILD", parentBranchId: parent.id })
          .returning({ id: branches.id })
        const [foreignParent] = await db.insert(branches)
          .values({ organizationId: f.foreign, name: `Report Foreign ${tag()}`, status: "active", hierarchyRole: "PARENT" })
          .returning({ id: branches.id })
        family = { parent: parent.id, child: child.id, foreignParent: foreignParent.id }
      })

      function signInHeadOfficeForReports() {
        vi.mocked(getServerSession).mockResolvedValue({
          user: { id: f.headOfficeId, role: "HEAD_OFFICE", organizationId: f.home, email: "actor@example.test", mustChangePassword: false },
        } as any)
      }

      it("returns each branch's type and parent", async () => {
        signInHeadOfficeForReports()
        const result = await performance("")
        expect(result.status).toBe(200)
        const child = result.body.items.find((item: { id: number }) => item.id === family.child)
        expect(child).toMatchObject({ hierarchyRole: "CHILD", parentBranchId: family.parent, parentBranchStatus: "active" })
        expect(child.parentBranchName).toMatch(/^Report Parent/)
      })

      it("filters by type, and by parent to the parent and its children", async () => {
        signInHeadOfficeForReports()
        const children = await performance("hierarchyRoles=CHILD")
        expect(children.ids).toContain(family.child)
        expect(children.ids).not.toContain(family.parent)
        expect(children.ids).not.toContain(f.north)

        const familyOnly = await performance(`parentBranchIds=${family.parent}`)
        expect(familyOnly.ids.sort((a, b) => a - b)).toEqual([family.parent, family.child].sort((a, b) => a - b))
      })

      it("never widens Head Office past its tenant, whichever parent it names", async () => {
        signInHeadOfficeForReports()
        const foreign = await performance(`parentBranchIds=${family.foreignParent}&organizationId=${f.foreign}`)
        expect(foreign.status).toBe(200)
        expect(foreign.ids).toEqual([])
      })

      it("refuses a malformed filter", async () => {
        signInHeadOfficeForReports()
        expect((await performance("hierarchyRoles=COUSIN")).status).toBe(400)
        expect((await performance("parentBranchIds=1;DROP")).status).toBe(400)
      })
    })
  })
})
