import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import { and, desc, eq } from "drizzle-orm"
import { NextRequest } from "next/server"
import * as mockedNextAuth from "next-auth"

import * as pricesRoute from "@/app/api/v1/groups/[id]/prices/route"
import { groupAuditLogs, groupInventoryPrices } from "@/db/schema"
import { closePool, db } from "@/lib/db"

import {
  BASE_PRICE_CENTS,
  NO_DATABASE_REASON,
  createPricingFixtures,
  destroyPricingFixtures,
  hasTestDatabase,
  resetPriceTiers,
  setOrganizationPrice,
  type PricingFixtures,
} from "./helpers/pricing-fixtures"

/**
 * The group pricing endpoint, end to end: HTTP-shaped request in, real rows
 * out.
 *
 * Only the identity of the caller is faked. Everything downstream of the
 * session — the role and tenant checks, the ownership check on each product,
 * the upsert, the delete, and the audit row — runs for real against Postgres,
 * because those are the parts that decide whether a price is charged and to
 * whom it is visible.
 *
 * Redis is stubbed out: cache invalidation is fire-and-forget in the route and
 * a real Upstash call would only add a network dependency to a database test.
 */
vi.mock("next-auth", () => ({ getServerSession: vi.fn() }))
vi.mock("@/lib/auth-options", () => ({ authOptions: {} }))
vi.mock("@/lib/cache-utils", () => ({ invalidateByPrefix: vi.fn(async () => {}) }))

// Static imports are safe here: Vitest hoists the `vi.mock` calls above them,
// so the route below is loaded against the stubs declared just above.
const { getServerSession } = mockedNextAuth
const { GET, PUT } = pricesRoute

type Actor = { id: string; role: string; organizationId: number | null }

function signIn(actor: Actor | null) {
  vi.mocked(getServerSession).mockResolvedValue(
    actor === null ? null : ({ user: actor } as any),
  )
}

function params(groupId: number | string) {
  return { params: Promise.resolve({ id: String(groupId) }) }
}

function getRequest(groupId: number, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/v1/groups/${groupId}/prices${query}`)
}

function putRequest(groupId: number, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/v1/groups/${groupId}/prices`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe.skipIf(!hasTestDatabase)("group pricing endpoint", () => {
  let fixtures: PricingFixtures
  let superAdmin: Actor
  let headOffice: Actor
  let neighbourHeadOffice: Actor

  beforeAll(async () => {
    fixtures = await createPricingFixtures()
    superAdmin = { id: fixtures.userId, role: "SUPER_ADMIN", organizationId: null }
    headOffice = { id: fixtures.userId, role: "HEAD_OFFICE", organizationId: fixtures.organizationId }
    neighbourHeadOffice = {
      id: fixtures.userId,
      role: "HEAD_OFFICE",
      organizationId: fixtures.neighbourOrganizationId,
    }
  })

  beforeEach(() => {
    signIn(superAdmin)
  })

  afterEach(async () => {
    vi.clearAllMocks()
    await resetPriceTiers(fixtures)
    await db.delete(groupAuditLogs).where(eq(groupAuditLogs.groupId, fixtures.groupId))
  })

  afterAll(async () => {
    if (fixtures) await destroyPricingFixtures(fixtures)
    await closePool()
  })

  async function storedPrice(): Promise<number | null> {
    const [row] = await db
      .select({ customPriceCents: groupInventoryPrices.customPriceCents })
      .from(groupInventoryPrices)
      .where(and(
        eq(groupInventoryPrices.groupId, fixtures.groupId),
        eq(groupInventoryPrices.organizationInventoryId, fixtures.organizationInventoryId),
      ))
    return row?.customPriceCents ?? null
  }

  describe("access control", () => {
    it("refuses an unauthenticated caller", async () => {
      signIn(null)
      const response = await GET(getRequest(fixtures.groupId), params(fixtures.groupId))
      expect(response.status).toBe(401)
    })

    it.each(["BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER", "GROUP_ORDER_PORTAL"])(
      "refuses %s on both reads and writes",
      async (role) => {
        // Belonging to a group grants the right to order at its prices, never
        // to set them.
        signIn({ id: fixtures.userId, role, organizationId: fixtures.organizationId })

        const read = await GET(getRequest(fixtures.groupId), params(fixtures.groupId))
        expect(read.status).toBe(403)

        const write = await PUT(
          putRequest(fixtures.groupId, {
            prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: 1 }],
          }),
          params(fixtures.groupId),
        )
        expect(write.status).toBe(403)
        expect(await storedPrice()).toBeNull()
      },
    )

    it("lets Head Office read a group inside its own organization", async () => {
      // Head Office has to know what its branches pay to do its job.
      signIn(headOffice)
      const response = await GET(getRequest(fixtures.groupId), params(fixtures.groupId))
      expect(response.status).toBe(200)
    })

    it("refuses Head Office the write, even in its own organization", async () => {
      // Only a Super Admin may change a price, at any tier. Administering the
      // group does not carry the right to reprice it.
      signIn(headOffice)

      const response = await PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: 6_500 }],
        }),
        params(fixtures.groupId),
      )
      const body = await response.json()

      expect(response.status).toBe(403)
      expect(body.error).toContain("only a Super Admin may change prices")
      expect(await storedPrice()).toBeNull()
    })

    it("refuses Head Office from another organization", async () => {
      signIn(neighbourHeadOffice)

      const read = await GET(getRequest(fixtures.groupId), params(fixtures.groupId))
      expect(read.status).toBe(403)

      const write = await PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: 1 }],
        }),
        params(fixtures.groupId),
      )
      expect(write.status).toBe(403)
      expect(await storedPrice()).toBeNull()
    })

    it("reports an unknown group as not found", async () => {
      const response = await GET(getRequest(2_147_483_000), params(2_147_483_000))
      expect(response.status).toBe(404)
    })

    it("rejects a malformed group id", async () => {
      const response = await GET(getRequest(fixtures.groupId), params("not-a-number"))
      expect(response.status).toBe(400)
    })
  })

  describe("reading the catalogue as the group pays for it", () => {
    it("reports every tier and the price the branches actually pay", async () => {
      await setOrganizationPrice(fixtures, 8_000)

      const response = await GET(
        getRequest(fixtures.groupId, `?search=${fixtures.suffix}`),
        params(fixtures.groupId),
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      const item = body.items.find(
        (row: any) => row.organizationInventoryId === fixtures.organizationInventoryId,
      )
      expect(item).toMatchObject({
        basePriceCents: BASE_PRICE_CENTS,
        organizationPriceCents: 8_000,
        groupPriceCents: null,
        effectivePriceCents: 8_000,
      })
    })

    it("lists a product the group has not been assigned yet", async () => {
      // Pricing is independent of assignment: an administrator can set the
      // price before the product reaches the group's branches.
      const response = await GET(
        getRequest(fixtures.groupId, `?search=${fixtures.suffix}`),
        params(fixtures.groupId),
      )
      const body = await response.json()

      expect(body.items.map((row: any) => row.organizationInventoryId))
        .toContain(fixtures.organizationInventoryId)
    })

    it("never lists another organization's catalogue", async () => {
      const response = await GET(getRequest(fixtures.groupId), params(fixtures.groupId))
      const body = await response.json()

      expect(body.items.map((row: any) => row.organizationInventoryId))
        .not.toContain(fixtures.neighbourOrganizationInventoryId)
    })
  })

  describe("setting and clearing prices", () => {
    it("stores a group price and reports it as the effective price", async () => {
      await setOrganizationPrice(fixtures, 8_000)

      const response = await PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: 6_500 }],
        }),
        params(fixtures.groupId),
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toMatchObject({ updated: 1, cleared: 0 })
      expect(await storedPrice()).toBe(6_500)

      const read = await GET(
        getRequest(fixtures.groupId, `?search=${fixtures.suffix}`),
        params(fixtures.groupId),
      )
      const readBody = await read.json()
      const item = readBody.items.find(
        (row: any) => row.organizationInventoryId === fixtures.organizationInventoryId,
      )
      expect(item).toMatchObject({
        organizationPriceCents: 8_000,
        groupPriceCents: 6_500,
        effectivePriceCents: 6_500,
      })
    })

    it("overwrites an existing price rather than failing on the unique index", async () => {
      const write = async (customPriceCents: number) => PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents }],
        }),
        params(fixtures.groupId),
      )

      expect((await write(6_500)).status).toBe(200)
      expect((await write(5_250)).status).toBe(200)
      expect(await storedPrice()).toBe(5_250)
    })

    it("clears a price with null and falls back to the organization price", async () => {
      await setOrganizationPrice(fixtures, 8_000)
      await PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: 6_500 }],
        }),
        params(fixtures.groupId),
      )

      const response = await PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: null }],
        }),
        params(fixtures.groupId),
      )
      const body = await response.json()

      expect(response.status).toBe(200)
      expect(body).toMatchObject({ updated: 0, cleared: 1 })
      // The row is deleted, not nulled: "no group price" means exactly one thing.
      expect(await storedPrice()).toBeNull()

      const read = await GET(
        getRequest(fixtures.groupId, `?search=${fixtures.suffix}`),
        params(fixtures.groupId),
      )
      const item = (await read.json()).items.find(
        (row: any) => row.organizationInventoryId === fixtures.organizationInventoryId,
      )
      expect(item.effectivePriceCents).toBe(8_000)
    })

    it("accepts zero as a deliberate price", async () => {
      await setOrganizationPrice(fixtures, 8_000)

      const response = await PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: 0 }],
        }),
        params(fixtures.groupId),
      )

      expect(response.status).toBe(200)
      expect(await storedPrice()).toBe(0)

      const read = await GET(
        getRequest(fixtures.groupId, `?search=${fixtures.suffix}`),
        params(fixtures.groupId),
      )
      const item = (await read.json()).items.find(
        (row: any) => row.organizationInventoryId === fixtures.organizationInventoryId,
      )
      expect(item.effectivePriceCents).toBe(0)
    })

    it("records who repriced the group", async () => {
      await PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: 6_500 }],
        }),
        params(fixtures.groupId),
      )

      const [entry] = await db
        .select()
        .from(groupAuditLogs)
        .where(eq(groupAuditLogs.groupId, fixtures.groupId))
        .orderBy(desc(groupAuditLogs.id))
        .limit(1)

      expect(entry).toMatchObject({
        action: "SET_GROUP_PRICES",
        performedByUserId: fixtures.userId,
        performedByRole: "SUPER_ADMIN",
        organizationId: fixtures.organizationId,
      })
      expect(entry.metadata).toMatchObject({
        updated: [{
          organizationInventoryId: fixtures.organizationInventoryId,
          customPriceCents: 6_500,
        }],
        cleared: [],
      })
    })
  })

  describe("rejected writes leave nothing behind", () => {
    it("refuses a product belonging to another organization", async () => {
      const response = await PUT(
        putRequest(fixtures.groupId, {
          prices: [{
            organizationInventoryId: fixtures.neighbourOrganizationInventoryId,
            customPriceCents: 1,
          }],
        }),
        params(fixtures.groupId),
      )

      expect(response.status).toBe(400)
      const written = await db
        .select({ id: groupInventoryPrices.id })
        .from(groupInventoryPrices)
        .where(eq(groupInventoryPrices.groupId, fixtures.groupId))
      expect(written).toHaveLength(0)
    })

    it("refuses the whole batch when one product is foreign", async () => {
      // Atomicity matters: a partially applied repricing would leave some
      // branches on a price nobody approved.
      const response = await PUT(
        putRequest(fixtures.groupId, {
          prices: [
            { organizationInventoryId: fixtures.organizationInventoryId, customPriceCents: 6_500 },
            { organizationInventoryId: fixtures.neighbourOrganizationInventoryId, customPriceCents: 1 },
          ],
        }),
        params(fixtures.groupId),
      )

      expect(response.status).toBe(400)
      expect(await storedPrice()).toBeNull()
    })

    it.each([
      ["a negative price", { customPriceCents: -1 }],
      ["a fractional price", { customPriceCents: 12.5 }],
      ["an out-of-range price", { customPriceCents: 9_999_999_999 }],
    ])("rejects %s", async (_label, override) => {
      const response = await PUT(
        putRequest(fixtures.groupId, {
          prices: [{ organizationInventoryId: fixtures.organizationInventoryId, ...override }],
        }),
        params(fixtures.groupId),
      )

      expect(response.status).toBe(400)
      expect(await storedPrice()).toBeNull()
    })

    it("rejects a malformed body", async () => {
      const response = await PUT(
        putRequest(fixtures.groupId, { prices: [] }),
        params(fixtures.groupId),
      )
      expect(response.status).toBe(400)
    })
  })
})

describe.skipIf(hasTestDatabase)("group pricing endpoint integration suite", () => {
  it("is skipped without a test database", () => {
    console.warn(NO_DATABASE_REASON)
    expect(hasTestDatabase).toBe(false)
  })
})
