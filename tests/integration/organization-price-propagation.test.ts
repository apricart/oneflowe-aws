import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as assignmentsRoute from "@/app/api/v1/admin/organization-assignments/route"
import * as priceImpactRoute from "@/app/api/v1/admin/organization-assignments/price-impact/route"
import { groupAuditLogs, groupInventoryPrices, organizationInventory } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  BASE_PRICE_CENTS,
  NO_DATABASE_REASON,
  createPricingFixtures,
  destroyPricingFixtures,
  hasTestDatabase,
  resetPriceTiers,
  setGroupPrice,
  setOrganizationPrice,
  type PricingFixtures,
} from "./helpers/pricing-fixtures"

/**
 * Changing an organization price, and choosing what it does to group prices.
 *
 * The planner has its own unit tests; these prove the choice survives the round
 * trip — that the plan is rebuilt from the rows as they were *before* the
 * update, that the organization price and the group writes land in one
 * transaction, and that an unpriced group outside the selection really is held
 * still rather than quietly following the new price.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/cache-utils", () => ({ invalidateByPrefix: vi.fn(async () => {}) }))

const { getServerSession } = mockedNextAuth
const { PUT } = assignmentsRoute
const { GET: priceImpact } = priceImpactRoute

type Actor = { id: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: actor } as any),
  )
}

function putRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/v1/admin/organization-assignments", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!hasTestDatabase)("organization price propagation", () => {
  let fixtures: PricingFixtures
  let superAdmin: Actor
  /** A second group in the same organization, so "some but not all" is testable. */
  let secondGroupId: number

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
    superAdmin = { id: fixtures.userId, role: "SUPER_ADMIN", organizationId: null }
    secondGroupId = fixtures.neighbourGroupId
  })

  beforeEach(async () => {
    signIn(superAdmin)
    await resetPriceTiers(fixtures)
    await setOrganizationPrice(fixtures, 8_000)
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await db.delete(groupAuditLogs).where(eq(groupAuditLogs.organizationId, fixtures.organizationId))
  })

  afterAll(async () => {
    if (fixtures) await destroyPricingFixtures(fixtures)
    await closePool()
  })

  async function groupPrice(groupId: number): Promise<number | null> {
    const [row] = await db
      .select({ customPriceCents: groupInventoryPrices.customPriceCents })
      .from(groupInventoryPrices)
      .where(and(
        eq(groupInventoryPrices.groupId, groupId),
        eq(groupInventoryPrices.organizationInventoryId, fixtures.organizationInventoryId),
      ))
    return row?.customPriceCents ?? null
  }

  async function organizationPrice(): Promise<number | null> {
    const [row] = await db
      .select({ customPrice: organizationInventory.customPrice })
      .from(organizationInventory)
      .where(eq(organizationInventory.id, fixtures.organizationInventoryId))
    return row?.customPrice ?? null
  }

  const repriceTo = (rupees: number, propagation?: unknown) => PUT(putRequest({
    id: fixtures.organizationInventoryId,
    customPrice: rupees,
    ...(propagation === undefined ? {} : { groupPricePropagation: propagation }),
  }))

  describe("the preview", () => {
    it("reports the tiers and every group of the organization", async () => {
      await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_000)

      const response = await priceImpact(new NextRequest(
        `http://localhost/api/v1/admin/organization-assignments/price-impact?organizationInventoryId=${fixtures.organizationInventoryId}`,
      ))
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body.item).toMatchObject({
        basePriceCents: BASE_PRICE_CENTS,
        organizationPriceCents: 8_000,
        organizationId: fixtures.organizationId,
      })

      const group = body.groups.find((row: any) => row.groupId === fixtures.groupId)
      expect(group).toMatchObject({ groupPriceCents: 6_000, branchCount: 1 })
      // The neighbouring tenant's group must never appear.
      expect(body.groups.map((row: any) => row.groupId)).not.toContain(secondGroupId)
    })

    it("is refused to anyone who may not change a price", async () => {
      signIn({ id: fixtures.userId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId })
      const response = await priceImpact(new NextRequest(
        `http://localhost/api/v1/admin/organization-assignments/price-impact?organizationInventoryId=${fixtures.organizationInventoryId}`,
      ))
      expect(response.status).toBe(403)
    })
  })

  describe("mode: none — the previous behaviour, and the default", () => {
    it("writes no group prices when no directive is sent", async () => {
      await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_000)

      const response = await repriceTo(90)

      expect(response.status).toBe(200)
      expect(await organizationPrice()).toBe(9_000)
      // The group keeps its own price, untouched.
      expect(await groupPrice(fixtures.groupId)).toBe(6_000)
      const body = await response.json()
      expect(body.groupPricePropagation).toBeUndefined()
    })
  })

  describe("mode: all — every group onto the new price", () => {
    it("removes the override that was insulating a group", async () => {
      await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_000)

      const response = await repriceTo(90, { mode: "all" })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(await organizationPrice()).toBe(9_000)
      expect(await groupPrice(fixtures.groupId)).toBeNull()
      expect(body.groupPricePropagation).toMatchObject({ cleared: 1, pinned: 0 })
    })
  })

  describe("mode: selected — only the chosen groups move", () => {
    it("pins an unselected unpriced group at the price it pays today", async () => {
      // The group has no override, so without a pin it would follow the
      // organization to 9000 — the exact drift the feature exists to prevent.
      expect(await groupPrice(fixtures.groupId)).toBeNull()

      const response = await repriceTo(90, { mode: "selected", groupIds: [] })
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(await organizationPrice()).toBe(9_000)
      // Pinned at the OLD price, which is only correct if the plan was built
      // from rows read before the update.
      expect(await groupPrice(fixtures.groupId)).toBe(8_000)
      expect(body.groupPricePropagation).toMatchObject({ cleared: 0, pinned: 1 })
    })

    it("lets a selected group take the new price with no override left behind", async () => {
      await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_000)

      const response = await repriceTo(90, {
        mode: "selected",
        groupIds: [fixtures.groupId],
      })

      expect(response.status).toBe(200)
      expect(await groupPrice(fixtures.groupId)).toBeNull()
    })

    it("leaves an unselected group that already has its own price alone", async () => {
      await setGroupPrice(fixtures, fixtures.groupId, fixtures.organizationId, 6_000)

      await repriceTo(90, { mode: "selected", groupIds: [] })

      expect(await groupPrice(fixtures.groupId)).toBe(6_000)
    })

    it("never touches another tenant's group", async () => {
      await setGroupPrice(
        fixtures,
        secondGroupId,
        fixtures.neighbourOrganizationId,
        1_111,
      )

      await repriceTo(90, { mode: "all" })

      // The neighbour's row is outside this item's organization and must be
      // untouched by a propagation that named "all groups".
      expect(await groupPrice(secondGroupId)).toBe(1_111)
    })
  })

  describe("guards", () => {
    it("writes nothing at group level when the price is not moving", async () => {
      await repriceTo(80, { mode: "selected", groupIds: [] })

      // Re-saving the same price must not scatter override rows that would
      // insulate every group from the next change.
      expect(await groupPrice(fixtures.groupId)).toBeNull()
    })

    it("ignores a propagation directive on an edit that does not touch the price", async () => {
      await PUT(putRequest({
        id: fixtures.organizationInventoryId,
        customName: "Renamed by integration test",
        groupPricePropagation: { mode: "all" },
      }))

      expect(await organizationPrice()).toBe(8_000)
      expect(await groupPrice(fixtures.groupId)).toBeNull()
    })

    it.each([
      ["an unknown mode", { mode: "everything" }],
      ["selected without a group list", { mode: "selected" }],
    ])("rejects %s and changes nothing", async (_label, propagation) => {
      const response = await repriceTo(90, propagation)

      expect(response.status).toBe(400)
      expect(await organizationPrice()).toBe(8_000)
    })

    it("refuses a caller who may not change prices", async () => {
      signIn({ id: fixtures.userId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId })

      const response = await repriceTo(90, { mode: "all" })

      expect(response.status).toBe(403)
      expect(await organizationPrice()).toBe(8_000)
    })

    it("records the propagation against the organization", async () => {
      await repriceTo(90, { mode: "selected", groupIds: [] })

      const [entry] = await db
        .select()
        .from(groupAuditLogs)
        .where(and(
          eq(groupAuditLogs.organizationId, fixtures.organizationId),
          eq(groupAuditLogs.action, "PROPAGATE_ORGANIZATION_PRICE"),
        ))

      expect(entry).toBeDefined()
      expect(entry.performedByRole).toBe("SUPER_ADMIN")
      expect(entry.metadata).toMatchObject({
        mode: "selected",
        pinnedGroups: [{ groupId: fixtures.groupId, customPriceCents: 8_000 }],
      })
    })
  })
})

describe.skipIf(hasTestDatabase)("organization price propagation integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
