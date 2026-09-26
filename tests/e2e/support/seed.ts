import { randomUUID } from "node:crypto"

import bcrypt from "bcryptjs"
import { eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import {
  auditLogs,
  branches,
  groupAuditLogs,
  groups,
  organizations,
  roles,
  systemLogs,
  users,
} from "../../../db/schema"

import { E2E_PASSWORD } from "./environment"

/**
 * The rows the Playwright suite drives the real screen against.
 *
 * Two accounts and a handful of events in all three audit tables — enough for
 * the browser to prove what the integration suite cannot: that a Super Admin
 * reaches `/activity` and sees rows, that the filters and the detail panel work
 * in a real browser, and that another role is turned away.
 *
 * Everything is suffixed, and `destroy` removes it children-first, so a crashed
 * run leaves nothing a later one can trip over.
 *
 * The connection is built here rather than imported from `@/lib/db`, for two
 * reasons. `lib/db` pulls in `server-only`, which throws outside a React Server
 * Component and which only the Vitest projects alias away — and, more to the
 * point, a pool built from an argument physically cannot reach whatever
 * `DATABASE_URL` happened to resolve to. The caller passes the connection it
 * already refused to proceed without.
 */

type SeedDb = ReturnType<typeof drizzle>

/** One pool for the seed, closed before the browser starts. */
async function withDb<T>(databaseUrl: string, work: (db: SeedDb) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    return await work(drizzle(pool))
  } finally {
    await pool.end()
  }
}

export const E2E_SUFFIX = "e2e-activity"

/** Fixed, so a spec can sign in without reading anything back. */
export const SUPER_ADMIN_USERNAME = `${E2E_SUFFIX}-superadmin`
export const HEAD_OFFICE_USERNAME = `${E2E_SUFFIX}-headoffice`

/** A distinctive action the spec can search for and filter down to. */
export const SEEDED_DELETE_ACTION = "DELETE_CATEGORY"
export const SEEDED_ENTITY_ID = "909909"

async function roleId(db: SeedDb, name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by the Playwright suite" })
    .returning({ id: roles.id })
  return created.id
}

export async function seedActivityLogE2E(databaseUrl: string): Promise<void> {
  await withDb(databaseUrl, async (db) => {
    // A crashed previous run leaves rows behind; clear them before seeding so
    // the usernames and the counts a spec asserts on stay exact.
    await destroy(db)

  const passwordHash = await bcrypt.hash(E2E_PASSWORD, 10)

  const [organization] = await db
    .insert(organizations)
    .values({ name: `E2E Activity Org ${randomUUID().slice(0, 6)}`, code: `E2EA-${randomUUID().slice(0, 6)}` })
    .returning({ id: organizations.id })

  const [superAdmin] = await db
    .insert(users)
    .values({
      email: `${SUPER_ADMIN_USERNAME}@example.test`,
      username: SUPER_ADMIN_USERNAME,
      passwordHash,
      roleId: await roleId(db, "SUPER_ADMIN"),
      organizationId: null,
      fullName: "E2E Super Admin",
      isActive: true,
      // Neither may stand between the spec and the screen.
      mfaEnabled: false,
      mustChangePassword: false,
    })
    .returning({ id: users.id })

  await db.insert(users).values({
    email: `${HEAD_OFFICE_USERNAME}@example.test`,
    username: HEAD_OFFICE_USERNAME,
    passwordHash,
    roleId: await roleId(db, "HEAD_OFFICE"),
    organizationId: organization.id,
    fullName: "E2E Head Office",
    isActive: true,
    mfaEnabled: false,
    mustChangePassword: false,
  })

  const [branch] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: `E2E Branch ${randomUUID().slice(0, 6)}`, status: "active" })
    .returning({ id: branches.id })

  const [group] = await db
    .insert(groups)
    .values({
      organizationId: organization.id,
      name: `E2E Group ${randomUUID().slice(0, 6)}`,
      status: "connected",
      createdByUserId: superAdmin.id,
    })
    .returning({ id: groups.id })

  // Recent, so the screen's default seven-day window contains them.
  const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

  await db.insert(auditLogs).values([
    {
      action: SEEDED_DELETE_ACTION,
      entity: "category",
      entityId: SEEDED_ENTITY_ID,
      organizationId: organization.id,
      branchId: null,
      userId: superAdmin.id,
      metadata: { ip: "198.51.100.11", before: { name: "E2E Retired Category" } },
      createdAt: minutesAgo(5),
    },
    {
      action: "UPDATE_SUPPLIER",
      entity: "supplier",
      entityId: "808808",
      organizationId: organization.id,
      branchId: branch.id,
      userId: superAdmin.id,
      metadata: { ip: "198.51.100.12", before: { name: "Before" }, after: { name: "After" } },
      createdAt: minutesAgo(10),
    },
  ])

  await db.insert(systemLogs).values([
    {
      action: "AUTH_LOGIN_FAILURE",
      resourceType: "auth",
      resourceId: SUPER_ADMIN_USERNAME,
      organizationId: organization.id,
      branchId: branch.id,
      userId: superAdmin.id,
      userRole: "SUPER_ADMIN",
      userEmail: `${SUPER_ADMIN_USERNAME}@example.test`,
      success: false,
      errorMessage: "invalid_password",
      ipAddress: "198.51.100.13",
      details: { reason: "invalid_password" },
      timestamp: minutesAgo(15),
      createdAt: minutesAgo(15),
    },
  ])

  await db.insert(groupAuditLogs).values([
    {
      action: "CREATE_GROUP",
      organizationId: organization.id,
      groupId: group.id,
      performedByUserId: superAdmin.id,
      performedByRole: "SUPER_ADMIN",
      metadata: { ip: "198.51.100.14" },
      createdAt: minutesAgo(20),
    },
  ])
  })
}

export async function destroyActivityLogE2E(databaseUrl: string): Promise<void> {
  await withDb(databaseUrl, destroy)
}

async function destroy(db: SeedDb): Promise<void> {
  const seeded = await db
    .select({ id: users.id, organizationId: users.organizationId })
    .from(users)
    .where(inArray(users.username, [SUPER_ADMIN_USERNAME, HEAD_OFFICE_USERNAME]))

  if (seeded.length === 0) return

  const organizationIds = [
    ...new Set(seeded.map((row) => row.organizationId).filter((id): id is number => id !== null)),
  ]

  // Children first: the audit rows reference the users, groups and branches.
  if (organizationIds.length > 0) {
    await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
    await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
    await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
  }
  await db.delete(auditLogs).where(inArray(auditLogs.userId, seeded.map((row) => row.id)))
  await db.delete(groupAuditLogs).where(
    inArray(groupAuditLogs.performedByUserId, seeded.map((row) => row.id)),
  )

  if (organizationIds.length > 0) {
    await db.delete(groups).where(inArray(groups.organizationId, organizationIds))
    await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
  }
  await db.delete(users).where(inArray(users.id, seeded.map((row) => row.id)))
  if (organizationIds.length > 0) {
    await db.delete(organizations).where(inArray(organizations.id, organizationIds))
  }
}
