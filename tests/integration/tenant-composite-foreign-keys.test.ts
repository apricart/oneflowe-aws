import { randomUUID } from "node:crypto"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { eq, inArray, sql } from "drizzle-orm"
import { getTableConfig, PgTable } from "drizzle-orm/pg-core"

import * as schema from "@/db/schema"
import { budgets, branches, groups, organizations, roles, userBranchAssignments, userGroupAssignments, users } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import { hasTestDatabase } from "./helpers/pricing-fixtures"

/**
 * The database refuses a row whose branch or group belongs to another
 * organization than the row says (plans/OF-DB-tenant-composite-foreign-keys.md).
 *
 * Every write here goes straight to the table, the way a script, an import or
 * a future endpoint might — the application's own checks are not in the way.
 */

type Fixtures = Awaited<ReturnType<typeof createFixtures>>

async function roleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db.insert(roles).values({ name, description: "tenant keys it" }).returning({ id: roles.id })
  return created.id
}

async function createFixtures() {
  const suffix = randomUUID().slice(0, 8)
  const [home, foreign] = await db.insert(organizations).values([
    { name: `IT Tenant Keys Home ${suffix}`, code: `ITKH${suffix}` },
    { name: `IT Tenant Keys Foreign ${suffix}`, code: `ITKF${suffix}` },
  ]).returning({ id: organizations.id })

  const [homeBranch, spareBranch, foreignBranch] = await db.insert(branches).values([
    { organizationId: home.id, name: `ITK Home ${suffix}`, status: "active" },
    { organizationId: home.id, name: `ITK Spare ${suffix}`, status: "active" },
    { organizationId: foreign.id, name: `ITK Foreign ${suffix}`, status: "active" },
  ]).returning({ id: branches.id })

  const [person] = await db.insert(users).values({
    email: `it-tenant-keys-${suffix}@example.test`,
    username: `it-tenant-keys-${suffix}`,
    passwordHash: "x",
    roleId: await roleId("BRANCH_ADMIN"),
    organizationId: home.id,
    branchId: homeBranch.id,
  }).returning({ id: users.id })

  const [homeGroup, foreignGroup] = await db.insert(groups).values([
    { organizationId: home.id, name: `ITK Home Group ${suffix}`, createdByUserId: person.id },
    { organizationId: foreign.id, name: `ITK Foreign Group ${suffix}`, createdByUserId: person.id },
  ]).returning({ id: groups.id })

  return {
    home: home.id,
    foreign: foreign.id,
    homeBranch: homeBranch.id,
    spareBranch: spareBranch.id,
    foreignBranch: foreignBranch.id,
    homeGroup: homeGroup.id,
    foreignGroup: foreignGroup.id,
    personId: person.id,
  }
}

async function destroyFixtures(f: Fixtures): Promise<void> {
  const orgs = [f.home, f.foreign]
  await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.organizationId, orgs))
  await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.organizationId, orgs))
  await db.delete(budgets).where(inArray(budgets.organizationId, orgs))
  await db.update(users).set({ branchId: null }).where(eq(users.id, f.personId))
  await db.update(branches).set({ groupId: null }).where(inArray(branches.organizationId, orgs))
  await db.delete(groups).where(inArray(groups.organizationId, orgs))
  await db.delete(users).where(eq(users.id, f.personId))
  await db.delete(branches).where(inArray(branches.organizationId, orgs))
  await db.delete(organizations).where(inArray(organizations.id, orgs))
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

/** 23503 is foreign_key_violation. */
const refusedBy = (constraint: string) => ({ code: "23503", constraint })

describe.skipIf(!hasTestDatabase)("tenant composite foreign keys", () => {
  let f: Fixtures

  beforeAll(async () => {
    f = await createFixtures()
  })

  afterAll(async () => {
    if (f) await destroyFixtures(f)
    await closePool()
  })

  it("exist in the database exactly as db/schema.ts declares them", async () => {
    const declared = new Set<string>()
    for (const value of Object.values(schema)) {
      if (!(value instanceof PgTable)) continue
      const config = getTableConfig(value)
      for (const key of config.foreignKeys) {
        if (key.getName().endsWith("_org_fk")) declared.add(key.getName())
      }
      for (const unique of config.uniqueConstraints) {
        const name = unique.getName()
        if (name?.endsWith("_id_organization_uq")) declared.add(name)
      }
    }
    const result = await db.execute(sql`
      SELECT conname FROM pg_constraint
      WHERE conname LIKE '%\_org\_fk' OR conname LIKE '%\_id\_organization\_uq'
    `)
    const present = new Set((result.rows as Array<{ conname: string }>).map((row) => row.conname))
    expect([...present].sort()).toEqual([...declared].sort())
    // 28 before the invoice ledger, which added orders_id_organization_uq,
    // invoices_id_organization_uq, credit_notes_id_organization_uq and five
    // composite keys (plans/OF-INVOICE-invoice-ledger.md).
    expect(declared.size).toBe(36)
  })

  describe("refuse another organization's branch", () => {
    it("on a budget", async () => {
      expect(await failureOf(db.insert(budgets).values({
        organizationId: f.home, branchId: f.foreignBranch, period: "2026-10",
      }))).toEqual(refusedBy("budgets_branch_org_fk"))
    })

    it("on a branch assignment", async () => {
      expect(await failureOf(db.insert(userBranchAssignments).values({
        userId: f.personId, organizationId: f.home, branchId: f.foreignBranch,
      }))).toEqual(refusedBy("user_branch_assignments_branch_org_fk"))
    })

    it("on a user, which had no branch key at all before", async () => {
      expect(await failureOf(
        db.update(users).set({ branchId: f.foreignBranch }).where(eq(users.id, f.personId)),
      )).toEqual(refusedBy("users_branch_org_fk"))
      expect(await failureOf(
        db.update(users).set({ branchId: 2_000_000_000 }).where(eq(users.id, f.personId)),
      )).toEqual(refusedBy("users_branch_org_fk"))
    })

    it("when a referenced branch is moved to another organization", async () => {
      expect(await failureOf(
        db.update(branches).set({ organizationId: f.foreign }).where(eq(branches.id, f.homeBranch)),
      )).toEqual(refusedBy("users_branch_org_fk"))
    })
  })

  describe("refuse another organization's group", () => {
    it("on a branch", async () => {
      expect(await failureOf(
        db.update(branches).set({ groupId: f.foreignGroup }).where(eq(branches.id, f.homeBranch)),
      )).toEqual(refusedBy("branches_group_org_fk"))
    })

    it("on a group assignment", async () => {
      expect(await failureOf(db.insert(userGroupAssignments).values({
        userId: f.personId, organizationId: f.home, groupId: f.foreignGroup,
      }))).toEqual(refusedBy("user_group_assignments_group_org_fk"))
    })
  })

  it("accepts the same rows within one organization", async () => {
    await db.insert(budgets).values({ organizationId: f.home, branchId: f.homeBranch, period: "2026-10" })
    await db.insert(userBranchAssignments).values({ userId: f.personId, organizationId: f.home, branchId: f.spareBranch })
    await db.insert(userGroupAssignments).values({ userId: f.personId, organizationId: f.home, groupId: f.homeGroup })
    await db.update(branches).set({ groupId: f.homeGroup }).where(eq(branches.id, f.homeBranch))
    await db.update(users).set({ branchId: f.spareBranch }).where(eq(users.id, f.personId))
    await db.update(users).set({ branchId: f.homeBranch }).where(eq(users.id, f.personId))
  })

  describe("keep deletes that worked before working", () => {
    it("clears a user's branch, not its organization, when the branch is deleted", async () => {
      const [doomed] = await db.insert(branches)
        .values({ organizationId: f.home, name: `ITK Doomed ${randomUUID().slice(0, 8)}`, status: "active" })
        .returning({ id: branches.id })
      await db.update(users).set({ branchId: doomed.id }).where(eq(users.id, f.personId))

      await db.delete(branches).where(eq(branches.id, doomed.id))

      const [after] = await db.select({ branchId: users.branchId, organizationId: users.organizationId })
        .from(users).where(eq(users.id, f.personId))
      expect(after).toEqual({ branchId: null, organizationId: f.home })
    })

    it("clears a branch's group, not its organization, when the group is deleted", async () => {
      const [doomed] = await db.insert(groups)
        .values({ organizationId: f.home, name: `ITK Doomed Group ${randomUUID().slice(0, 8)}`, createdByUserId: f.personId })
        .returning({ id: groups.id })
      await db.update(branches).set({ groupId: doomed.id }).where(eq(branches.id, f.spareBranch))

      await db.delete(groups).where(eq(groups.id, doomed.id))

      const [after] = await db.select({ groupId: branches.groupId, organizationId: branches.organizationId })
        .from(branches).where(eq(branches.id, f.spareBranch))
      expect(after).toEqual({ groupId: null, organizationId: f.home })
    })
  })
})
