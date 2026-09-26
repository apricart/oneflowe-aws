import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"

import {
  auditLogs,
  branches,
  groupAuditLogs,
  groups,
  organizations,
  roles,
  systemLogs,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"

export { NO_DATABASE_REASON, hasTestDatabase } from "./pricing-fixtures"

/**
 * Fixtures for the admin activity log.
 *
 * Twelve events across the three tables that hold the trail, with every
 * timestamp written explicitly so the expected order is a fact a reviewer can
 * check from this comment rather than something the test discovers.
 *
 * ```
 * organization A                          organization B (the neighbour)
 *   branches: North, South                  branch: Foreign
 *   group:    Reviewed
 *   people:   Super Admin (no tenant), Head Office, Branch Admin,
 *             Group User, Group Order Portal, Order Portal
 *
 *   #    source  time (UTC)   action                        org  branch  ok
 *   E1   system  12:00:00     AUTH_LOGIN_FAILURE            A    North   no
 *   E2   audit   11:00:00     DELETE_CATEGORY               A    —       yes
 *   E3   group   11:00:00     CREATE_GROUP                  A    —       yes
 *   E4   system  11:00:00     AUTH_LOGIN_SUCCESS            A    North   yes
 *   E5   audit   10:00:00     CREATE_CATEGORY               A    —       yes
 *   E6   audit   09:00:00     UPDATE_SUPPLIER               A    South   yes
 *   E7   system  08:00:00     AUTH_MFA_CHALLENGE            A    North   yes
 *   E8   audit   07:00:00     PROPAGATE_ORGANIZATION_PRICE  A    —       yes
 *   E9   group   06:00:00     VIEW_GROUP_REPORT             A    —       yes
 *   E10  audit   05:00:00     DELETE_SUPPLIER               B    Foreign yes
 *   E11  system  04:00:00     AUTH_LOGIN_SUCCESS            B    Foreign yes
 *   E12  audit   03:00:00     IMPORT_PRODUCTS               —    —       yes
 * ```
 *
 * **E2, E3 and E4 share one timestamp on purpose.** That three-way tie is the
 * only thing that exercises all three branches of the keyset cursor at once —
 * the source that is the cursor's own, one that sorts after it at an equal
 * timestamp, and one that sorts before it. Paging through a tie is where a
 * merge-of-sorted-streams either repeats a row or loses one, and neither shows
 * up in a fixture whose timestamps are all distinct.
 *
 * The page is ordered `occurredAt DESC, sourceRank DESC, id DESC`, and
 * `ACTIVITY_SOURCE_RANK` is audit 1, system 2, group 3, so the expected whole
 * sequence is:
 *
 *     E1, E3, E4, E2, E5, E6, E7, E8, E9, E10, E11, E12
 *
 * `EXPECTED_ORDER` below is that list, and the suite asserts against it.
 *
 * **Isolation.** Every row sits inside `WINDOW`, a day in 2031 that no other
 * fixture writes to, so a suite running against a shared database cannot see
 * another's rows through this one's date filter — and every row also carries a
 * unique suffix, so a re-run after a crashed suite cannot collide with
 * leftovers. `destroyActivityLogFixtures` removes everything children-first.
 */

const DAY = "2031-05-10"

/** The window every query in the suite uses. Wide enough for the day, narrow enough to isolate it. */
export const WINDOW = {
  from: new Date("2031-05-09T00:00:00.000Z"),
  to: new Date("2031-05-11T00:00:00.000Z"),
}

function at(time: string): Date {
  return new Date(`${DAY}T${time}.000Z`)
}

/** The key each seeded event is known by, so an assertion can name a row. */
export type EventKey =
  | "E1" | "E2" | "E3" | "E4" | "E5" | "E6"
  | "E7" | "E8" | "E9" | "E10" | "E11" | "E12"

/**
 * Newest first, as the endpoint must return them. Derived by hand from the
 * table above and the documented sort, not from the implementation.
 */
export const EXPECTED_ORDER: readonly EventKey[] = [
  "E1", "E3", "E4", "E2", "E5", "E6", "E7", "E8", "E9", "E10", "E11", "E12",
]

export type SeededEvent = {
  key: EventKey
  source: "audit" | "system" | "group"
  /** Primary key of the row, filled in once inserted. */
  id: number
  action: string
  occurredAt: Date
}

export type ActivityLogFixtures = {
  suffix: string
  organizationId: number
  neighbourOrganizationId: number
  northBranchId: number
  southBranchId: number
  foreignBranchId: number
  groupId: number
  superAdminId: string
  headOfficeId: string
  branchAdminId: string
  groupUserId: string
  groupOrderPortalId: string
  orderPortalId: string
  events: Record<EventKey, SeededEvent>
  /** Event ids as the API reports them (`audit:12`), keyed the same way. */
  eventId: (key: EventKey) => string
}

/**
 * A migrated database that has been seeded already has its roles; one that has
 * not gets the row created, because `users.role_id` is NOT NULL.
 */
async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by integration tests" })
    .returning({ id: roles.id })
  return created.id
}

export async function createActivityLogFixtures(): Promise<ActivityLogFixtures> {
  const suffix = randomUUID().slice(0, 8)

  const [superAdminRole, headOfficeRole, branchAdminRole, groupUserRole, groupPortalRole, orderPortalRole] =
    await Promise.all([
      resolveRoleId("SUPER_ADMIN"),
      resolveRoleId("HEAD_OFFICE"),
      resolveRoleId("BRANCH_ADMIN"),
      resolveRoleId("GROUP_USER"),
      resolveRoleId("GROUP_ORDER_PORTAL"),
      resolveRoleId("ORDER_PORTAL"),
    ])

  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Activity Org ${suffix}`, code: `ITA-${suffix}` })
    .returning({ id: organizations.id })

  const [neighbour] = await db
    .insert(organizations)
    .values({ name: `IT Activity Neighbour ${suffix}`, code: `ITB-${suffix}` })
    .returning({ id: organizations.id })

  async function makeUser(label: string, roleId: number, organizationId: number | null) {
    const [row] = await db
      .insert(users)
      .values({
        email: `integration-activity-${label}-${suffix}@example.test`,
        passwordHash: "not-a-real-hash",
        roleId,
        organizationId,
        fullName: `Activity ${label} ${suffix}`,
      })
      .returning({ id: users.id })
    return row.id
  }

  const superAdminId = await makeUser("superadmin", superAdminRole, null)
  const headOfficeId = await makeUser("headoffice", headOfficeRole, organization.id)
  const branchAdminId = await makeUser("branchadmin", branchAdminRole, organization.id)
  const groupUserId = await makeUser("groupuser", groupUserRole, organization.id)
  const groupOrderPortalId = await makeUser("groupportal", groupPortalRole, organization.id)
  const orderPortalId = await makeUser("orderportal", orderPortalRole, organization.id)

  const [group] = await db
    .insert(groups)
    .values({
      organizationId: organization.id,
      name: `Reviewed Group ${suffix}`,
      status: "connected",
      createdByUserId: superAdminId,
    })
    .returning({ id: groups.id })

  const [north] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: `North ${suffix}`, status: "active" })
    .returning({ id: branches.id })

  const [south] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: `South ${suffix}`, status: "active" })
    .returning({ id: branches.id })

  const [foreign] = await db
    .insert(branches)
    .values({ organizationId: neighbour.id, name: `Foreign ${suffix}`, status: "active" })
    .returning({ id: branches.id })

  const events = {} as Record<EventKey, SeededEvent>

  async function seedAudit(
    key: EventKey,
    time: string,
    action: string,
    row: {
      entity: string
      entityId: string | null
      organizationId: number | null
      branchId: number | null
      userId: string | null
      metadata?: Record<string, unknown>
    },
  ) {
    const occurredAt = at(time)
    const [created] = await db
      .insert(auditLogs)
      .values({
        action,
        entity: row.entity,
        entityId: row.entityId,
        organizationId: row.organizationId,
        branchId: row.branchId,
        userId: row.userId,
        metadata: row.metadata ?? {},
        createdAt: occurredAt,
      })
      .returning({ id: auditLogs.id })
    events[key] = { key, source: "audit", id: created.id, action, occurredAt }
  }

  async function seedSystem(
    key: EventKey,
    time: string,
    action: string,
    row: {
      resourceType: string
      resourceId: string | null
      organizationId: number | null
      branchId: number | null
      userId: string | null
      userRole: string | null
      userEmail: string | null
      success: boolean
      errorMessage?: string | null
      ipAddress?: string | null
      userAgent?: string | null
      details?: Record<string, unknown>
    },
  ) {
    const occurredAt = at(time)
    const [created] = await db
      .insert(systemLogs)
      .values({
        action,
        resourceType: row.resourceType,
        resourceId: row.resourceId,
        organizationId: row.organizationId,
        branchId: row.branchId,
        userId: row.userId,
        userRole: row.userRole,
        userEmail: row.userEmail,
        success: row.success,
        errorMessage: row.errorMessage ?? null,
        ipAddress: row.ipAddress ?? null,
        userAgent: row.userAgent ?? null,
        details: row.details ?? {},
        timestamp: occurredAt,
        createdAt: occurredAt,
      })
      .returning({ id: systemLogs.id })
    events[key] = { key, source: "system", id: created.id, action, occurredAt }
  }

  async function seedGroup(
    key: EventKey,
    time: string,
    action: string,
    row: { organizationId: number; groupId: number; userId: string; role: string },
  ) {
    const occurredAt = at(time)
    const [created] = await db
      .insert(groupAuditLogs)
      .values({
        action,
        organizationId: row.organizationId,
        groupId: row.groupId,
        performedByUserId: row.userId,
        performedByRole: row.role,
        metadata: { ip: "203.0.113.9" },
        createdAt: occurredAt,
      })
      .returning({ id: groupAuditLogs.id })
    events[key] = { key, source: "group", id: created.id, action, occurredAt }
  }

  // E1 — a failed sign-in. The one row in the set with success = false.
  await seedSystem("E1", "12:00:00", "AUTH_LOGIN_FAILURE", {
    resourceType: "auth",
    resourceId: `northuser-${suffix}`,
    organizationId: organization.id,
    branchId: north.id,
    userId: branchAdminId,
    userRole: "BRANCH_ADMIN",
    userEmail: `integration-activity-branchadmin-${suffix}@example.test`,
    success: false,
    errorMessage: "invalid_password",
    ipAddress: "198.51.100.7",
    userAgent: "Mozilla/5.0 (integration)",
    details: { reason: "invalid_password" },
  })

  // E2, E3, E4 — one timestamp, three sources. See the note above.
  await seedAudit("E2", "11:00:00", "DELETE_CATEGORY", {
    entity: "category",
    entityId: "4242",
    organizationId: organization.id,
    branchId: null,
    userId: superAdminId,
    // Proves the reader coalesces an IP out of metadata for a table with no
    // column for one, and that a secret in an old row is masked on the way out.
    metadata: { ip: "198.51.100.10", before: { name: "Retired" }, password: "must-not-appear" },
  })

  await seedGroup("E3", "11:00:00", "CREATE_GROUP", {
    organizationId: organization.id,
    groupId: group.id,
    userId: headOfficeId,
    role: "HEAD_OFFICE",
  })

  await seedSystem("E4", "11:00:00", "AUTH_LOGIN_SUCCESS", {
    resourceType: "auth",
    resourceId: `northuser-${suffix}`,
    organizationId: organization.id,
    branchId: north.id,
    userId: branchAdminId,
    userRole: "BRANCH_ADMIN",
    userEmail: `integration-activity-branchadmin-${suffix}@example.test`,
    success: true,
    ipAddress: "198.51.100.7",
  })

  await seedAudit("E5", "10:00:00", "CREATE_CATEGORY", {
    entity: "category",
    entityId: "4243",
    organizationId: organization.id,
    branchId: null,
    userId: superAdminId,
    metadata: { after: { name: "Stationery" } },
  })

  await seedAudit("E6", "09:00:00", "UPDATE_SUPPLIER", {
    entity: "supplier",
    entityId: "77",
    organizationId: organization.id,
    branchId: south.id,
    userId: headOfficeId,
    metadata: { before: { name: "Old" }, after: { name: "New" } },
  })

  await seedSystem("E7", "08:00:00", "AUTH_MFA_CHALLENGE", {
    resourceType: "auth",
    resourceId: `northuser-${suffix}`,
    organizationId: organization.id,
    branchId: north.id,
    // A principal that is not a user UUID: the enrichment must not pass it to a
    // uuid column, and the row's own denormalized email must still show.
    userId: `emp_${suffix}`,
    userRole: "ORDER_PORTAL",
    userEmail: `integration-activity-employee-${suffix}@example.test`,
    success: true,
  })

  await seedAudit("E8", "07:00:00", "PROPAGATE_ORGANIZATION_PRICE", {
    entity: "organization_inventory",
    entityId: "91",
    organizationId: organization.id,
    branchId: null,
    userId: superAdminId,
    metadata: { mode: "all" },
  })

  await seedGroup("E9", "06:00:00", "VIEW_GROUP_REPORT", {
    organizationId: organization.id,
    groupId: group.id,
    userId: groupUserId,
    role: "GROUP_USER",
  })

  // E10 and E11 belong to the neighbour: the organization filter must exclude
  // them, and an unfiltered read must include them, because Super Admin reads
  // across tenants by design.
  await seedAudit("E10", "05:00:00", "DELETE_SUPPLIER", {
    entity: "supplier",
    entityId: "78",
    organizationId: neighbour.id,
    branchId: foreign.id,
    userId: superAdminId,
    metadata: {},
  })

  await seedSystem("E11", "04:00:00", "AUTH_LOGIN_SUCCESS", {
    resourceType: "auth",
    resourceId: `foreignuser-${suffix}`,
    organizationId: neighbour.id,
    branchId: foreign.id,
    userId: null,
    userRole: "ORDER_PORTAL",
    userEmail: `integration-activity-foreign-${suffix}@example.test`,
    success: true,
  })

  // E12 has no tenant at all — a platform-level write, which must still appear.
  await seedAudit("E12", "03:00:00", "IMPORT_PRODUCTS", {
    entity: "global_products",
    entityId: "bulk_import",
    organizationId: null,
    branchId: null,
    userId: superAdminId,
    metadata: { totalRows: 12 },
  })

  return {
    suffix,
    organizationId: organization.id,
    neighbourOrganizationId: neighbour.id,
    northBranchId: north.id,
    southBranchId: south.id,
    foreignBranchId: foreign.id,
    groupId: group.id,
    superAdminId,
    headOfficeId,
    branchAdminId,
    groupUserId,
    groupOrderPortalId,
    orderPortalId,
    events,
    eventId: (key) => `${events[key].source}:${events[key].id}`,
  }
}

export async function destroyActivityLogFixtures(fixtures: ActivityLogFixtures): Promise<void> {
  const auditIds = Object.values(fixtures.events)
    .filter((event) => event.source === "audit")
    .map((event) => event.id)
  const systemIds = Object.values(fixtures.events)
    .filter((event) => event.source === "system")
    .map((event) => event.id)
  const groupIds = Object.values(fixtures.events)
    .filter((event) => event.source === "group")
    .map((event) => event.id)

  // Rows a test wrote through a route handler carry no fixture id, so the trail
  // is also cleared by organization; the two overlap harmlessly.
  const organizationIds = [fixtures.organizationId, fixtures.neighbourOrganizationId]

  if (auditIds.length > 0) await db.delete(auditLogs).where(inArray(auditLogs.id, auditIds))
  if (systemIds.length > 0) await db.delete(systemLogs).where(inArray(systemLogs.id, systemIds))
  if (groupIds.length > 0) await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.id, groupIds))

  await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
  await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))

  await db.delete(groups).where(eq(groups.id, fixtures.groupId))
  await db.delete(branches).where(
    inArray(branches.id, [fixtures.northBranchId, fixtures.southBranchId, fixtures.foreignBranchId]),
  )
  await db.delete(users).where(
    inArray(users.id, [
      fixtures.superAdminId,
      fixtures.headOfficeId,
      fixtures.branchAdminId,
      fixtures.groupUserId,
      fixtures.groupOrderPortalId,
      fixtures.orderPortalId,
    ]),
  )
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}
