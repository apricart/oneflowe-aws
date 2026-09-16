import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { and, desc, eq, inArray } from "drizzle-orm"

import { auditLogs, branchInventory, branches } from "@/db/schema"
import { closePool, db } from "@/lib/db"
import { cascadeOrgDeletion, cascadeOrgStatusChange } from "@/lib/inventory-cascade"

import {
  NO_DATABASE_REASON,
  createPricingFixtures,
  destroyPricingFixtures,
  hasTestDatabase,
  type PricingFixtures,
} from "./helpers/pricing-fixtures"

/**
 * The organization → branch cascades, end to end against Postgres.
 *
 * The product is stocked at more branches than a comma-joined list of row ids
 * fits into `audit_logs.entity_id` (varchar 128). That is the case that used
 * to throw on the audit insert *after* the branch rows had been updated —
 * turning a product off from the Organization Inventory page failed for any
 * K-Electric product stocked at more than a couple of dozen branches.
 */

/**
 * Enough rows that their ids joined by commas exceed 128 characters even on a
 * brand-new database where the sequence starts at 1: ids 1..60 join to 170
 * characters (1..40 join to only 110, which passed locally only because the
 * long-lived test database had already advanced the sequence).
 */
const BRANCH_COUNT = 60

describe.skipIf(!hasTestDatabase)("organization inventory cascades", () => {
  let fixtures: PricingFixtures
  let branchIds: number[] = []
  let rowIds: number[] = []

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
    const created = await db
      .insert(branches)
      .values(Array.from({ length: BRANCH_COUNT }, (_, index) => ({
        organizationId: fixtures.organizationId,
        name: `Cascade Branch ${fixtures.suffix} ${index}`,
        status: "active",
      })))
      .returning({ id: branches.id })
    branchIds = created.map((row) => row.id)

    const rows = await db
      .insert(branchInventory)
      .values(branchIds.map((branchId) => ({
        branchId,
        organizationId: fixtures.organizationId,
        organizationInventoryId: fixtures.organizationInventoryId,
        assignedByUserId: fixtures.userId,
        isVisible: true,
        isActive: true,
      })))
      .returning({ id: branchInventory.id })
    rowIds = rows.map((row) => row.id)
    expect(rowIds.join(",").length).toBeGreaterThan(128)
  })

  afterAll(async () => {
    if (rowIds.length > 0) await db.delete(branchInventory).where(inArray(branchInventory.id, rowIds))
    if (branchIds.length > 0) await db.delete(branches).where(inArray(branches.id, branchIds))
    if (fixtures) await destroyPricingFixtures(fixtures)
    await closePool()
  })

  async function branchRows() {
    return db
      .select({ isVisible: branchInventory.isVisible, isActive: branchInventory.isActive, deletedAt: branchInventory.deletedAt })
      .from(branchInventory)
      .where(inArray(branchInventory.id, rowIds))
  }

  async function latestAudit(action: string) {
    const [row] = await db
      .select({ entity: auditLogs.entity, entityId: auditLogs.entityId, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(and(eq(auditLogs.userId, fixtures.userId), eq(auditLogs.action, action)))
      .orderBy(desc(auditLogs.id))
      .limit(1)
    return row
  }

  it("turns a product off at every branch and records one audit row keyed by the organization entry", async () => {
    const result = await cascadeOrgStatusChange(fixtures.organizationInventoryId, false, fixtures.userId, "SUPER_ADMIN")

    expect(result.updatedCount).toBe(BRANCH_COUNT)
    expect(new Set(result.affectedBranches)).toEqual(new Set(branchIds))
    for (const row of await branchRows()) {
      expect(row.isActive).toBe(false)
      expect(row.isVisible).toBe(false)
      expect(row.deletedAt).toBeNull()
    }

    const audit = await latestAudit("CASCADE_UPDATE")
    expect(audit.entity).toBe("BranchInventory")
    expect(audit.entityId).toBe(String(fixtures.organizationInventoryId))
    const metadata = audit.metadata as Record<string, unknown>
    expect(metadata.isActive).toBe(false)
    expect(metadata.updatedCount).toBe(BRANCH_COUNT)
    expect(new Set(metadata.branchInventoryIds as number[])).toEqual(new Set(rowIds))
  })

  it("turns it back on at every branch", async () => {
    const result = await cascadeOrgStatusChange(fixtures.organizationInventoryId, true, fixtures.userId, "SUPER_ADMIN")

    expect(result.updatedCount).toBe(BRANCH_COUNT)
    for (const row of await branchRows()) {
      expect(row.isActive).toBe(true)
      expect(row.isVisible).toBe(true)
    }
    expect((await latestAudit("CASCADE_UPDATE")).entityId).toBe(String(fixtures.organizationInventoryId))
  })

  it("soft-deletes every branch row on unassignment and records the deletion the same way", async () => {
    const result = await cascadeOrgDeletion(fixtures.organizationInventoryId, fixtures.userId, "SUPER_ADMIN")

    expect(result.deletedCount).toBe(BRANCH_COUNT)
    for (const row of await branchRows()) expect(row.deletedAt).not.toBeNull()

    const audit = await latestAudit("CASCADE_DELETE")
    expect(audit.entity).toBe("BranchInventory")
    expect(audit.entityId).toBe(String(fixtures.organizationInventoryId))
    const metadata = audit.metadata as Record<string, unknown>
    expect(metadata.deletedCount).toBe(BRANCH_COUNT)
    expect(new Set(metadata.branchInventoryIds as number[])).toEqual(new Set(rowIds))
  })

  it("reaches nothing a second time, and writes no audit row for nothing", async () => {
    const before = await latestAudit("CASCADE_DELETE")
    const result = await cascadeOrgDeletion(fixtures.organizationInventoryId, fixtures.userId, "SUPER_ADMIN")

    expect(result).toEqual({ deletedCount: 0, affectedBranches: [] })
    expect(await latestAudit("CASCADE_DELETE")).toEqual(before)
  })
})

describe.skipIf(hasTestDatabase)("organization inventory cascades integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
