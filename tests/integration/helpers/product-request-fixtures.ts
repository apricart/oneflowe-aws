import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"

import { auditLogs, branches, categories, organizations, productRequests, roles, users } from "@/db/schema"
import { db } from "@/lib/db"

export { NO_DATABASE_REASON, hasTestDatabase } from "./pricing-fixtures"

/**
 * Fixtures for the new-product request routes.
 *
 * Two tenants so every read can be checked for leakage, two Head Office users
 * in the first so the organization-wide read can be told apart from an
 * own-requests read, and one person in every role that must be refused. No
 * requests are seeded: the suite raises them through the route.
 *
 * ```
 * organization A                           organization B (neighbour)
 *   branch: Main                             Head Office B
 *   people: Head Office A1, Head Office A2
 *           Branch Admin   (Main)
 *           Order Portal   (Main)
 *           Group User, Group Order Portal, Viewer
 * Apricart (SUPER_ADMIN, no tenant)
 * Stray Head Office (HEAD_OFFICE, no organization)
 *
 * taxonomy (global): Cleaning → Hand care
 *                    Stationery → Paper
 * ```
 */
export type ProductRequestFixtures = {
  suffix: string
  organizationId: number
  organizationName: string
  neighbourOrganizationId: number
  branchId: number
  superAdminId: string
  headOfficeId: string
  secondHeadOfficeId: string
  neighbourHeadOfficeId: string
  strayHeadOfficeId: string
  branchAdminId: string
  orderPortalId: string
  groupUserId: string
  groupOrderPortalId: string
  viewerId: string
  cleaningCategoryId: number
  handCareSubcategoryId: number
  stationeryCategoryId: number
  paperSubcategoryId: number
}

async function resolveRoleId(name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by integration tests" })
    .returning({ id: roles.id })
  return created.id
}

export async function createProductRequestFixtures(): Promise<ProductRequestFixtures> {
  const suffix = randomUUID().slice(0, 8)

  const organizationName = `IT Product Request Org ${suffix}`
  const [organization] = await db
    .insert(organizations)
    .values({ name: organizationName, code: `ITPR-${suffix}` })
    .returning({ id: organizations.id })
  const [neighbour] = await db
    .insert(organizations)
    .values({ name: `IT Product Request Neighbour ${suffix}`, code: `ITPRN-${suffix}` })
    .returning({ id: organizations.id })

  const [branch] = await db
    .insert(branches)
    .values({ organizationId: organization.id, name: `Main ${suffix}`, status: "active" })
    .returning({ id: branches.id })

  async function person(
    slug: string,
    label: string,
    roleName: string,
    organizationId: number | null,
    branchId: number | null,
  ): Promise<string> {
    const [row] = await db
      .insert(users)
      .values({
        email: `it-product-request-${slug}-${suffix}@example.test`,
        passwordHash: "not-a-real-hash",
        roleId: await resolveRoleId(roleName),
        organizationId,
        branchId,
        fullName: `${label} ${suffix}`,
      })
      .returning({ id: users.id })
    return row.id
  }

  async function category(name: string, parentId: number | null): Promise<number> {
    const [row] = await db
      .insert(categories)
      .values({ name: `${name} ${suffix}`, parentId })
      .returning({ id: categories.id })
    return row.id
  }

  const cleaningCategoryId = await category("ITPR Cleaning", null)
  const stationeryCategoryId = await category("ITPR Stationery", null)

  return {
    suffix,
    organizationId: organization.id,
    organizationName,
    neighbourOrganizationId: neighbour.id,
    branchId: branch.id,
    superAdminId: await person("apricart", "Apricart", "SUPER_ADMIN", null, null),
    headOfficeId: await person("ho-a1", "Head Office A1", "HEAD_OFFICE", organization.id, null),
    secondHeadOfficeId: await person("ho-a2", "Head Office A2", "HEAD_OFFICE", organization.id, null),
    neighbourHeadOfficeId: await person("ho-b", "Head Office B", "HEAD_OFFICE", neighbour.id, null),
    strayHeadOfficeId: await person("ho-stray", "Stray Head Office", "HEAD_OFFICE", null, null),
    branchAdminId: await person("branch-admin", "Branch Admin", "BRANCH_ADMIN", organization.id, branch.id),
    orderPortalId: await person("order-portal", "Order Portal", "ORDER_PORTAL", organization.id, branch.id),
    groupUserId: await person("group-user", "Group User", "GROUP_USER", organization.id, null),
    groupOrderPortalId: await person("group-order-portal", "Group Order Portal", "GROUP_ORDER_PORTAL", organization.id, null),
    viewerId: await person("viewer", "Viewer", "VIEWER", organization.id, null),
    cleaningCategoryId,
    handCareSubcategoryId: await category("ITPR Hand care", cleaningCategoryId),
    stationeryCategoryId,
    paperSubcategoryId: await category("ITPR Paper", stationeryCategoryId),
  }
}

/**
 * Children first: requests, then the audit rows that name these people and
 * tenants, then the people, the branch, the taxonomy (subcategories before
 * their parents) and the tenants.
 */
export async function destroyProductRequestFixtures(f: ProductRequestFixtures): Promise<void> {
  const organizationIds = [f.organizationId, f.neighbourOrganizationId]
  const userIds = [
    f.superAdminId,
    f.headOfficeId,
    f.secondHeadOfficeId,
    f.neighbourHeadOfficeId,
    f.strayHeadOfficeId,
    f.branchAdminId,
    f.orderPortalId,
    f.groupUserId,
    f.groupOrderPortalId,
    f.viewerId,
  ]

  await db.delete(productRequests).where(inArray(productRequests.organizationId, organizationIds))
  await db.delete(auditLogs).where(inArray(auditLogs.organizationId, organizationIds))
  await db.delete(auditLogs).where(inArray(auditLogs.userId, userIds))
  await db.delete(users).where(inArray(users.id, userIds))
  await db.delete(branches).where(eq(branches.id, f.branchId))
  await db.delete(categories).where(inArray(categories.id, [f.handCareSubcategoryId, f.paperSubcategoryId]))
  await db.delete(categories).where(inArray(categories.id, [f.cleaningCategoryId, f.stationeryCategoryId]))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}
