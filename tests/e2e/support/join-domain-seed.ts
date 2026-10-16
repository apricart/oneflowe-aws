import bcrypt from "bcryptjs"
import { and, eq, inArray } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import {
  auditLogs,
  branches,
  notifications,
  organizationAllowedIps,
  organizationJoinCodes,
  organizationJoinRequests,
  organizationSettings,
  organizations,
  roles,
  systemLogs,
  users,
} from "../../../db/schema"
import { organizationUsername } from "../../../lib/username-prefix"

import { E2E_PASSWORD } from "./environment"

/**
 * The rows the organization-email-domain journeys drive the real screens with.
 *
 * Three tenants, each with a join code, so no journey depends on another having
 * run first:
 *
 * ```text
 *   CLOSED  no email domain           -> the applicant is stopped at a prompt
 *   OPEN    domain e2e-open.example.test -> the form fixes the domain
 *   CONFIG  no email domain, until Super Admin sets one in Edit Company
 * ```
 *
 * plus a Super Admin of the suite's own, and the name Create Company is driven
 * with. Everything has a fixed name so a spec can refer to it without reading
 * anything back, and `destroy` runs first so a crashed run leaves nothing a
 * later one trips over.
 *
 * Built on its own pool, never `@/lib/db`, for the reasons given in `seed.ts`.
 */

type SeedDb = ReturnType<typeof drizzle>

async function withDb<T>(databaseUrl: string, work: (db: SeedDb) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    return await work(drizzle(pool))
  } finally {
    await pool.end()
  }
}

export const JOIN_DOMAIN_SUPER_ADMIN_USERNAME = "e2e-join-domain-superadmin"

export const CLOSED_ORGANIZATION = {
  name: "E2E Join Closed Org",
  code: "E2EJ_CLOSED",
  joinCode: "E2E-JOIN-CLOSED",
} as const

export const OPEN_ORGANIZATION = {
  name: "E2E Join Open Org",
  code: "E2EJ_OPEN",
  joinCode: "E2E-JOIN-OPEN",
  emailDomain: "e2e-open.example.test",
  branchName: "E2E Join Open Branch",
} as const

export const CONFIG_ORGANIZATION = {
  name: "E2E Join Config Org",
  code: "E2EJ_CONFIG",
  joinCode: "E2E-JOIN-CONFIG",
  branchName: "E2E Join Config Branch",
} as const

/** Created through the Create Company dialog by a spec, never by the seed. */
export const CREATED_ORGANIZATION = {
  name: "E2E Join Created Org",
  code: "E2EJ_CREATED",
} as const

const ORGANIZATION_NAMES = [
  CLOSED_ORGANIZATION.name,
  OPEN_ORGANIZATION.name,
  CONFIG_ORGANIZATION.name,
  CREATED_ORGANIZATION.name,
]

async function roleId(db: SeedDb, name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by the Playwright suite" })
    .returning({ id: roles.id })
  return created.id
}

export async function seedJoinDomainE2E(databaseUrl: string): Promise<void> {
  await withDb(databaseUrl, async (db) => {
    await destroy(db)

    await db.insert(users).values({
      email: `${JOIN_DOMAIN_SUPER_ADMIN_USERNAME}@example.test`,
      username: JOIN_DOMAIN_SUPER_ADMIN_USERNAME,
      passwordHash: await bcrypt.hash(E2E_PASSWORD, 10),
      roleId: await roleId(db, "SUPER_ADMIN"),
      organizationId: null,
      fullName: "E2E Join Domain Super Admin",
      isActive: true,
      mfaEnabled: false,
      mustChangePassword: false,
    })

    const [closed, open, config] = await db
      .insert(organizations)
      .values([
        { name: CLOSED_ORGANIZATION.name, code: CLOSED_ORGANIZATION.code, status: "active" },
        {
          name: OPEN_ORGANIZATION.name,
          code: OPEN_ORGANIZATION.code,
          status: "active",
          emailDomain: OPEN_ORGANIZATION.emailDomain,
        },
        { name: CONFIG_ORGANIZATION.name, code: CONFIG_ORGANIZATION.code, status: "active" },
      ])
      .returning({ id: organizations.id })

    await db.insert(branches).values([
      { organizationId: open.id, name: OPEN_ORGANIZATION.branchName, status: "active" },
      { organizationId: config.id, name: CONFIG_ORGANIZATION.branchName, status: "active" },
    ])

    await db.insert(organizationJoinCodes).values([
      { organizationId: closed.id, code: CLOSED_ORGANIZATION.joinCode },
      { organizationId: open.id, code: OPEN_ORGANIZATION.joinCode },
      { organizationId: config.id, code: CONFIG_ORGANIZATION.joinCode },
    ])
  })
}

export async function destroyJoinDomainE2E(databaseUrl: string): Promise<void> {
  await withDb(databaseUrl, destroy)
}

/** Put a seeded tenant's domain back to a known value, so a journey starts from it. */
export async function setOrganizationEmailDomain(
  databaseUrl: string,
  organizationName: string,
  emailDomain: string | null,
): Promise<void> {
  await withDb(databaseUrl, async (db) => {
    await db.update(organizations).set({ emailDomain }).where(eq(organizations.name, organizationName))
  })
}

export async function readOrganizationEmailDomain(
  databaseUrl: string,
  organizationName: string,
): Promise<string | null | undefined> {
  return withDb(databaseUrl, async (db) => {
    const [row] = await db
      .select({ emailDomain: organizations.emailDomain })
      .from(organizations)
      .where(eq(organizations.name, organizationName))
      .limit(1)
    return row?.emailDomain
  })
}

/** Remove the organization Create Company made, so that journey can run again. */
export async function removeCreatedOrganization(databaseUrl: string): Promise<void> {
  await withDb(databaseUrl, async (db) => {
    const rows = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.name, CREATED_ORGANIZATION.name))
    await removeOrganizations(db, rows.map((row) => row.id))
  })
}

/** The address a join request was stored with, read the way the API never returns it. */
export async function readJoinRequestEmail(
  databaseUrl: string,
  organizationName: string,
  username: string,
): Promise<string | undefined> {
  return withDb(databaseUrl, async (db) => {
    const [row] = await db
      .select({ email: organizationJoinRequests.email })
      .from(organizationJoinRequests)
      .innerJoin(organizations, eq(organizations.id, organizationJoinRequests.organizationId))
      .where(and(
        eq(organizations.name, organizationName),
        // Stored under the organization's prefix (plans/OF-USERS-organization-username-prefix.md).
        eq(organizationJoinRequests.username, organizationUsername(organizationName, username)),
      ))
      .limit(1)
    return row?.email
  })
}

async function removeOrganizations(db: SeedDb, organizationIds: number[]): Promise<void> {
  if (organizationIds.length === 0) return
  // Children first: every one of these references the organization.
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
  await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
  await db.delete(organizationJoinRequests)
    .where(inArray(organizationJoinRequests.organizationId, organizationIds))
  await db.delete(organizationJoinCodes)
    .where(inArray(organizationJoinCodes.organizationId, organizationIds))
  await db.delete(organizationSettings)
    .where(inArray(organizationSettings.organizationId, organizationIds))
  await db.delete(organizationAllowedIps)
    .where(inArray(organizationAllowedIps.organizationId, organizationIds))
  await db.delete(users).where(inArray(users.organizationId, organizationIds))
  await db.delete(branches).where(inArray(branches.organizationId, organizationIds))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}

async function destroy(db: SeedDb): Promise<void> {
  const seededOrganizations = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(inArray(organizations.name, ORGANIZATION_NAMES))
  await removeOrganizations(db, seededOrganizations.map((row) => row.id))

  const [superAdmin] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, JOIN_DOMAIN_SUPER_ADMIN_USERNAME))
    .limit(1)
  if (superAdmin) {
    // Written by ordinary product behaviour while the journeys run.
    await db.delete(auditLogs).where(eq(auditLogs.userId, superAdmin.id))
    await db.delete(notifications).where(eq(notifications.userId, superAdmin.id))
    await db.delete(users).where(eq(users.id, superAdmin.id))
  }
}
