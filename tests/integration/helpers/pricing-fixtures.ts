import { randomUUID } from "node:crypto"

import { eq, inArray } from "drizzle-orm"

import {
  branches,
  globalProducts,
  groupAuditLogs,
  groupInventoryPrices,
  groups,
  organizationInventory,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"

/**
 * Fixtures for the group-pricing integration tests.
 *
 * Shape, chosen so one set of rows can answer every question the price ladder
 * raises:
 *
 *   organization A                      organization B (the neighbour)
 *     group "priced"                      group "foreign"
 *       branch groupedBranch                branch foreignBranch
 *     branch looseBranch (no group)
 *     product P  (global base price)
 *       organizationInventory item  (organization override, set per test)
 *
 * `looseBranch` proves a branch outside every group keeps the organization
 * price, and organization B proves one tenant's group prices are invisible to
 * another's — the two cases a COALESCE alone would get wrong.
 *
 * Every row is created with a unique suffix so a re-run after a crashed suite
 * cannot collide with leftovers, and `destroyPricingFixtures` removes
 * everything it made in foreign-key order.
 */

export const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim() ?? ""
export const hasTestDatabase = testDatabaseUrl.length > 0

/** Message shown once when the integration suites skip themselves. */
export const NO_DATABASE_REASON =
  "TEST_DATABASE_URL is not set — skipping integration tests. " +
  "Point it at a migrated, disposable database (name must contain \"test\") to run them."

export const BASE_PRICE_CENTS = 10_000

export type PricingFixtures = {
  suffix: string
  roleId: number
  userId: string
  organizationId: number
  neighbourOrganizationId: number
  groupId: number
  neighbourGroupId: number
  /** Branch inside `groupId`. */
  groupedBranchId: number
  /** Branch in the same organization but in no group. */
  looseBranchId: number
  /** Branch in the neighbouring organization's group. */
  foreignBranchId: number
  globalProductId: number
  organizationInventoryId: number
  /** The same product stocked by the neighbouring tenant, for cross-tenant writes. */
  neighbourOrganizationInventoryId: number
}

async function resolveRoleId(): Promise<number> {
  // A migrated database that has been seeded already has the roles; one that
  // has not gets a single throwaway row, since users.role_id is NOT NULL.
  const [existing] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(eq(roles.name, "SUPER_ADMIN"))
    .limit(1)
  if (existing) return existing.id

  const [created] = await db
    .insert(roles)
    .values({ name: "SUPER_ADMIN", description: "Created by integration tests" })
    .returning({ id: roles.id })
  return created.id
}

export async function createPricingFixtures(): Promise<PricingFixtures> {
  const suffix = randomUUID().slice(0, 8)
  const roleId = await resolveRoleId()

  const [organization] = await db
    .insert(organizations)
    .values({ name: `IT Pricing Org ${suffix}`, code: `ITP-${suffix}` })
    .returning({ id: organizations.id })

  const [neighbour] = await db
    .insert(organizations)
    .values({ name: `IT Pricing Neighbour ${suffix}`, code: `ITN-${suffix}` })
    .returning({ id: organizations.id })

  const [user] = await db
    .insert(users)
    .values({
      email: `integration-pricing-${suffix}@example.test`,
      passwordHash: "not-a-real-hash",
      roleId,
      organizationId: organization.id,
      fullName: "Integration Pricing Fixture",
    })
    .returning({ id: users.id })

  const [group] = await db
    .insert(groups)
    .values({
      organizationId: organization.id,
      name: `Priced Group ${suffix}`,
      status: "connected",
      createdByUserId: user.id,
    })
    .returning({ id: groups.id })

  const [neighbourGroup] = await db
    .insert(groups)
    .values({
      organizationId: neighbour.id,
      name: `Foreign Group ${suffix}`,
      status: "connected",
      createdByUserId: user.id,
    })
    .returning({ id: groups.id })

  const [groupedBranch] = await db
    .insert(branches)
    .values({
      organizationId: organization.id,
      name: `Grouped Branch ${suffix}`,
      groupId: group.id,
      status: "active",
    })
    .returning({ id: branches.id })

  const [looseBranch] = await db
    .insert(branches)
    .values({
      organizationId: organization.id,
      name: `Loose Branch ${suffix}`,
      groupId: null,
      status: "active",
    })
    .returning({ id: branches.id })

  const [foreignBranch] = await db
    .insert(branches)
    .values({
      organizationId: neighbour.id,
      name: `Foreign Branch ${suffix}`,
      groupId: neighbourGroup.id,
      status: "active",
    })
    .returning({ id: branches.id })

  const [product] = await db
    .insert(globalProducts)
    .values({
      productCode: `ITP-${suffix}`,
      name: `Integration Pricing Product ${suffix}`,
      basePrice: BASE_PRICE_CENTS,
      status: "active",
      unit: "unit",
    })
    .returning({ id: globalProducts.id })

  const [inventoryItem] = await db
    .insert(organizationInventory)
    .values({
      organizationId: organization.id,
      globalProductId: product.id,
      assignedByUserId: user.id,
      isActive: true,
      customPrice: null,
    })
    .returning({ id: organizationInventory.id })

  const [neighbourInventoryItem] = await db
    .insert(organizationInventory)
    .values({
      organizationId: neighbour.id,
      globalProductId: product.id,
      assignedByUserId: user.id,
      isActive: true,
      customPrice: null,
    })
    .returning({ id: organizationInventory.id })

  return {
    suffix,
    roleId,
    userId: user.id,
    organizationId: organization.id,
    neighbourOrganizationId: neighbour.id,
    groupId: group.id,
    neighbourGroupId: neighbourGroup.id,
    groupedBranchId: groupedBranch.id,
    looseBranchId: looseBranch.id,
    foreignBranchId: foreignBranch.id,
    globalProductId: product.id,
    organizationInventoryId: inventoryItem.id,
    neighbourOrganizationInventoryId: neighbourInventoryItem.id,
  }
}

/** Remove every row the fixtures created, children before parents. */
export async function destroyPricingFixtures(fixtures: PricingFixtures): Promise<void> {
  const groupIds = [fixtures.groupId, fixtures.neighbourGroupId]
  const organizationIds = [fixtures.organizationId, fixtures.neighbourOrganizationId]
  const branchIds = [fixtures.groupedBranchId, fixtures.looseBranchId, fixtures.foreignBranchId]

  await db.delete(groupInventoryPrices).where(inArray(groupInventoryPrices.groupId, groupIds))
  await db.delete(groupAuditLogs).where(inArray(groupAuditLogs.organizationId, organizationIds))
  await db.delete(organizationInventory).where(inArray(organizationInventory.id, [
    fixtures.organizationInventoryId,
    fixtures.neighbourOrganizationInventoryId,
  ]))
  await db.delete(branches).where(inArray(branches.id, branchIds))
  await db.delete(groups).where(inArray(groups.id, groupIds))
  await db.delete(globalProducts).where(eq(globalProducts.id, fixtures.globalProductId))
  await db.delete(users).where(eq(users.id, fixtures.userId))
  await db.delete(organizations).where(inArray(organizations.id, organizationIds))
}

/** Reset the pricing tiers between tests without rebuilding the whole fixture set. */
export async function resetPriceTiers(fixtures: PricingFixtures): Promise<void> {
  await db
    .delete(groupInventoryPrices)
    .where(inArray(groupInventoryPrices.groupId, [fixtures.groupId, fixtures.neighbourGroupId]))
  await db
    .update(organizationInventory)
    .set({ customPrice: null })
    .where(eq(organizationInventory.id, fixtures.organizationInventoryId))
}

export async function setOrganizationPrice(
  fixtures: PricingFixtures,
  customPrice: number | null,
): Promise<void> {
  await db
    .update(organizationInventory)
    .set({ customPrice })
    .where(eq(organizationInventory.id, fixtures.organizationInventoryId))
}

export async function setGroupPrice(
  fixtures: PricingFixtures,
  groupId: number,
  organizationId: number,
  customPriceCents: number,
): Promise<void> {
  await db
    .insert(groupInventoryPrices)
    .values({
      groupId,
      organizationId,
      organizationInventoryId: fixtures.organizationInventoryId,
      customPriceCents,
      updatedByUserId: fixtures.userId,
    })
    .onConflictDoUpdate({
      target: [groupInventoryPrices.groupId, groupInventoryPrices.organizationInventoryId],
      set: { customPriceCents },
    })
}
