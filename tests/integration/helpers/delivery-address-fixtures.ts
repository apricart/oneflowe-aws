import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"

import {
  auditLogs,
  branchDeliveryAddresses,
  branches,
  groups,
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
 * tenant A                                    tenant B (the neighbour)
 *   Head Office          <- decides             Head Office (foreign)
 *   Branch Admin         <- North only
 *   Order Portal         <- North only
 *   Group Requester      <- the North group
 *   Super Admin          <- no tenant at all
 *   North branch  (in the North group)          Foreign branch
 *   South branch  (in no group)
 * ```
 *
 * The South branch exists because the interesting authorization failure is not
 * "a branch that does not exist" but "a branch in my own tenant that is not
 * mine": the Branch Admin and the group requester must both be refused it while
 * Head Office is not.
 */
export type DeliveryAddressFixtures = {
  suffix: string
  organizationId: number
  foreignOrganizationId: number
  headOfficeId: string
  foreignHeadOfficeId: string
  branchAdminId: string
  orderPortalId: string
  groupRequesterId: string
  superAdminId: string
  northBranchId: number
  southBranchId: number
  foreignBranchId: number
  northGroupId: number
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, name))
    .limit(1)
  if (existing) return existing.id

  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by the delivery-address integration tests" })
    .returning({ id: roles.id })
  return created.id
}

export async function createDeliveryAddressFixtures(): Promise<DeliveryAddressFixtures> {
  const suffix = randomUUID().slice(0, 8)

  const roleId = {
    superAdmin: await resolveRoleId("SUPER_ADMIN"),
    headOffice: await resolveRoleId("HEAD_OFFICE"),
    branchAdmin: await resolveRoleId("BRANCH_ADMIN"),
    orderPortal: await resolveRoleId("ORDER_PORTAL"),
    groupOrderPortal: await resolveRoleId("GROUP_ORDER_PORTAL"),
  }

  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Addr ${suffix}`, code: `ITA_${suffix}`, status: "active" })
    .returning({ id: organizations.id })
  const [foreignOrganization] = await db
    .insert(organizations)
    .values({ name: `IT Addr Foreign ${suffix}`, code: `ITAF_${suffix}`, status: "active" })
    .returning({ id: organizations.id })

  async function person(
    label: string,
    role: number,
    organizationId: number | null,
    branchId: number | null = null,
  ): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `it-addr-${label}-${suffix}@example.test`,
        username: `it-addr-${label}-${suffix}`,
        passwordHash: "not-a-real-hash",
        roleId: role,
        organizationId,
        branchId,
        firstName: label,
        lastName: suffix,
        fullName: `${label} ${suffix}`,
      })
      .returning({ id: users.id })
    return row.id
  }

  const headOfficeId = await person("head-office", roleId.headOffice, organization.id)
  const foreignHeadOfficeId = await person("foreign-head", roleId.headOffice, foreignOrganization.id)
  // No tenant at all, which is exactly how `getRequestScope` reports a Super
  // Admin. It must be refused rather than treated as "every tenant".
  const superAdminId = await person("super-admin", roleId.superAdmin, null)

  const [northGroup] = await db
    .insert(groups)
    .values({
      organizationId: organization.id,
      name: `North Group ${suffix}`,
      status: "active",
      createdByUserId: headOfficeId,
    })
    .returning({ id: groups.id })

  const [northBranch, southBranch] = await db
    .insert(branches)
    .values([
      {
        organizationId: organization.id,
        name: `North ${suffix}`,
        address: "1 Branch Road",
        city: "Karachi",
        province: "Sindh",
        status: "active",
        groupId: northGroup.id,
      },
      {
        organizationId: organization.id,
        name: `South ${suffix}`,
        address: "2 Branch Road",
        status: "active",
      },
    ])
    .returning({ id: branches.id })

  const [foreignBranch] = await db
    .insert(branches)
    .values({
      organizationId: foreignOrganization.id,
      name: `Foreign Branch ${suffix}`,
      status: "active",
    })
    .returning({ id: branches.id })

  const branchAdminId = await person("branch-admin", roleId.branchAdmin, organization.id, northBranch.id)
  const orderPortalId = await person("order-portal", roleId.orderPortal, organization.id, northBranch.id)
  // A group requester has no branch of its own; its reach is the group
  // assignment resolved live, which is what makes North reachable and South not.
  const groupRequesterId = await person("group-requester", roleId.groupOrderPortal, organization.id)

  await db.insert(userGroupAssignments).values({
    userId: groupRequesterId,
    groupId: northGroup.id,
    organizationId: organization.id,
    createdByUserId: headOfficeId,
  })

  return {
    suffix,
    organizationId: organization.id,
    foreignOrganizationId: foreignOrganization.id,
    headOfficeId,
    foreignHeadOfficeId,
    branchAdminId,
    orderPortalId,
    groupRequesterId,
    superAdminId,
    northBranchId: northBranch.id,
    southBranchId: southBranch.id,
    foreignBranchId: foreignBranch.id,
    northGroupId: northGroup.id,
  }
}

export async function destroyDeliveryAddressFixtures(
  fixtures: DeliveryAddressFixtures,
): Promise<void> {
  const organizationIds = [fixtures.organizationId, fixtures.foreignOrganizationId]
  const userIds = [
    fixtures.headOfficeId,
    fixtures.foreignHeadOfficeId,
    fixtures.branchAdminId,
    fixtures.orderPortalId,
    fixtures.groupRequesterId,
    fixtures.superAdminId,
  ]

  await db.delete(systemLogs).where(inArray(systemLogs.organizationId, organizationIds))
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
  await db
    .delete(branchDeliveryAddresses)
    .where(inArray(branchDeliveryAddresses.organizationId, organizationIds))
  await db.delete(userGroupAssignments).where(inArray(userGroupAssignments.userId, userIds))
  await db.delete(userBranchAssignments).where(inArray(userBranchAssignments.userId, userIds))
  // Users before branches: `users.branch_id` references the branch they are on.
  // Groups before users: `groups.created_by_user_id` references Head Office.
  await db.delete(groups).where(eq(groups.id, fixtures.northGroupId))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(branches).where(inArray(branches.id, [
    fixtures.northBranchId,
    fixtures.southBranchId,
    fixtures.foreignBranchId,
  ]))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}
