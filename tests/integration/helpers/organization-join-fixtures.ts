import { randomUUID } from "node:crypto"

import { eq, inArray, sql } from "drizzle-orm"

import {
  auditLogs,
  branches,
  groups,
  organizationJoinCodes,
  organizationJoinRequests,
  organizations,
  roles,
  systemLogs,
  userBranchAssignments,
  userGroupAssignments,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"

export { NO_DATABASE_REASON, hasTestDatabase } from "./pricing-fixtures"

/**
 * Two tenants, so every cross-tenant question has a real second answer.
 *
 * ```text
 * tenant A (joinable)                     tenant B (the neighbour)
 *   Head Office            <- decides       Head Office (foreign)
 *   Branch Admin           <- may not
 *   Order Portal           <- may not
 *   North branch (active)                   Foreign branch (active)
 *   Retired branch (inactive)
 *   North group (active)                    Foreign group (active)
 *   Retired group (deleted)
 *
 * tenant C (suspended)  — has a code, and must still be unreachable
 * ```
 *
 * `Retired branch`, `Retired group` and the suspended tenant exist because the
 * interesting failures are not "wrong id" but "id that used to be right":
 * a de-activated branch, a deleted group, and a tenant whose status changed
 * after its code went out.
 */
export type JoinFixtures = {
  suffix: string
  organizationId: number
  foreignOrganizationId: number
  suspendedOrganizationId: number
  organizationName: string
  headOfficeId: string
  foreignHeadOfficeId: string
  suspendedHeadOfficeId: string
  branchAdminId: string
  orderPortalId: string
  northBranchId: number
  retiredBranchId: number
  foreignBranchId: number
  northGroupId: number
  retiredGroupId: number
  foreignGroupId: number
  names: {
    northBranch: string
    retiredBranch: string
    northGroup: string
  }
}

/** The domain every fixture tenant sets, and every fixture address is at. */
export const JOIN_FIXTURE_EMAIL_DOMAIN = "example.test"

export async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1)
  if (existing) return existing.id

  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by the organization-join integration tests" })
    .returning({ id: roles.id })
  return created.id
}

export async function createJoinFixtures(): Promise<JoinFixtures> {
  const suffix = randomUUID().slice(0, 8)

  const roleId = {
    headOffice: await resolveRoleId("HEAD_OFFICE"),
    branchAdmin: await resolveRoleId("BRANCH_ADMIN"),
    orderPortal: await resolveRoleId("ORDER_PORTAL"),
    groupUser: await resolveRoleId("GROUP_USER"),
    groupOrderPortal: await resolveRoleId("GROUP_ORDER_PORTAL"),
  }

  // Every tenant here has an email domain, and it is the one the suites' own
  // addresses use: an organization without one cannot take a request at all,
  // which `organization-email-domain.test.ts` covers on a tenant of its own.
  const organizationName = `IT Join ${suffix}`
  const [organization] = await db
    .insert(organizations)
    .values({
      name: organizationName,
      code: `ITJ_${suffix}`,
      status: "active",
      emailDomain: JOIN_FIXTURE_EMAIL_DOMAIN,
    })
    .returning({ id: organizations.id })
  const [foreignOrganization] = await db
    .insert(organizations)
    .values({
      name: `IT Join Foreign ${suffix}`,
      code: `ITJF_${suffix}`,
      status: "active",
      emailDomain: JOIN_FIXTURE_EMAIL_DOMAIN,
    })
    .returning({ id: organizations.id })
  const [suspendedOrganization] = await db
    .insert(organizations)
    .values({
      name: `IT Join Suspended ${suffix}`,
      code: `ITJS_${suffix}`,
      status: "suspended",
      emailDomain: JOIN_FIXTURE_EMAIL_DOMAIN,
    })
    .returning({ id: organizations.id })

  async function person(label: string, role: number, organizationId: number): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `it-join-${label}-${suffix}@example.test`,
        username: `it-join-${label}-${suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: role,
        organizationId,
        branchId: null,
        firstName: label,
        lastName: suffix,
        fullName: `${label} ${suffix}`,
      })
      .returning({ id: users.id })
    return row.id
  }

  const headOfficeId = await person("head-office", roleId.headOffice, organization.id)
  const foreignHeadOfficeId = await person("foreign-head", roleId.headOffice, foreignOrganization.id)
  // A real member of the suspended tenant. `getRequestScope` reads the acting
  // user's organization from the database rather than from the session, so a
  // test that wants to act *as* another tenant needs a user who is in it — a
  // session claiming a different organizationId is correctly ignored.
  const suspendedHeadOfficeId = await person(
    "suspended-head",
    roleId.headOffice,
    suspendedOrganization.id,
  )
  const branchAdminId = await person("branch-admin", roleId.branchAdmin, organization.id)
  const orderPortalId = await person("order-portal", roleId.orderPortal, organization.id)

  const names = {
    northBranch: `North ${suffix}`,
    retiredBranch: `Retired ${suffix}`,
    northGroup: `North Group ${suffix}`,
  }

  const [northBranch, retiredBranch, foreignBranch] = await db
    .insert(branches)
    .values([
      { organizationId: organization.id, name: names.northBranch, status: "active" },
      { organizationId: organization.id, name: names.retiredBranch, status: "inactive" },
      { organizationId: foreignOrganization.id, name: `Foreign Branch ${suffix}`, status: "active" },
    ])
    .returning({ id: branches.id })

  const [northGroup, retiredGroup, foreignGroup] = await db
    .insert(groups)
    .values([
      {
        organizationId: organization.id,
        name: names.northGroup,
        status: "active",
        createdByUserId: headOfficeId,
      },
      {
        organizationId: organization.id,
        name: `Retired Group ${suffix}`,
        status: "deleted",
        createdByUserId: headOfficeId,
      },
      {
        organizationId: foreignOrganization.id,
        name: `Foreign Group ${suffix}`,
        status: "active",
        createdByUserId: foreignHeadOfficeId,
      },
    ])
    .returning({ id: groups.id })

  // Referenced so the fixture fails loudly if a role is ever removed from the
  // seed rather than silently testing four roles that no longer exist.
  if (!roleId.groupUser || !roleId.groupOrderPortal) {
    throw new Error("The group roles must exist for the join fixtures to be meaningful")
  }

  return {
    suffix,
    organizationId: organization.id,
    foreignOrganizationId: foreignOrganization.id,
    suspendedOrganizationId: suspendedOrganization.id,
    organizationName,
    headOfficeId,
    foreignHeadOfficeId,
    suspendedHeadOfficeId,
    branchAdminId,
    orderPortalId,
    northBranchId: northBranch.id,
    retiredBranchId: retiredBranch.id,
    foreignBranchId: foreignBranch.id,
    northGroupId: northGroup.id,
    retiredGroupId: retiredGroup.id,
    foreignGroupId: foreignGroup.id,
    names,
  }
}

export async function destroyJoinFixtures(
  fixtures: JoinFixtures,
  createdUserIds: string[] = [],
): Promise<void> {
  const organizationIds = [
    fixtures.organizationId,
    fixtures.foreignOrganizationId,
    fixtures.suspendedOrganizationId,
  ]
  const fixtureUserIds = [
    fixtures.headOfficeId,
    fixtures.foreignHeadOfficeId,
    fixtures.suspendedHeadOfficeId,
    fixtures.branchAdminId,
    fixtures.orderPortalId,
    ...createdUserIds,
  ]

  await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
  await db
    .delete(organizationJoinRequests)
    .where(inArray(organizationJoinRequests.organizationId, organizationIds))
  await db
    .delete(organizationJoinCodes)
    .where(inArray(organizationJoinCodes.organizationId, organizationIds))
  await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.userId, fixtureUserIds))
  await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.userId, fixtureUserIds))
  // Groups before users: `groups.created_by_user_id` references the head office
  // that made them. Users before branches, because `users.branch_id` references
  // the branch an approved applicant was assigned to.
  await db.delete(groups).where(inArray(groups.id, [
    fixtures.northGroupId,
    fixtures.retiredGroupId,
    fixtures.foreignGroupId,
  ]))
  // Every user in these tenants, not only the ids the suite remembered: an
  // approval creates an account through the API, and a test that fails partway
  // must not leave one behind to block the organization delete.
  await db.delete(users).where(inArray(users.organizationId, organizationIds))
  await db.delete(users).where(inArray(users.id, fixtureUserIds))
  await db.delete(branches).where(inArray(branches.id, [
    fixtures.northBranchId,
    fixtures.retiredBranchId,
    fixtures.foreignBranchId,
  ]))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}

/** The stored row, for assertions the API deliberately will not show. */
export async function readStoredRequest(requestId: number) {
  const [row] = await db
    .select()
    .from(organizationJoinRequests)
    .where(eq(organizationJoinRequests.id, requestId))
    .limit(1)
  return row ?? null
}

/** The newest request for an email, whatever its status. */
export async function findRequestByEmail(email: string) {
  const [row] = await db
    .select()
    .from(organizationJoinRequests)
    .where(sql`${organizationJoinRequests.email} = ${email}`)
    .orderBy(sql`${organizationJoinRequests.id} DESC`)
    .limit(1)
  return row ?? null
}
