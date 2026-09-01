import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, asc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm"

import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import {
  globalProducts,
  groupAuditLogs,
  groupInventoryPrices,
  groups,
  organizationInventory,
} from "@/db/schema"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { escapeLikePattern } from "@/lib/utils"
import { groupPricesUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { resolveEffectivePriceCents } from "@/lib/server/effective-price"

/**
 * Group prices: the tier between the organization price and the global base
 * price.
 *
 * Reading and writing both go through `authorizeGroupPricing`, which is the
 * only place the tenant rule lives: Super Admin may price any group, Head
 * Office only groups inside its own organization, and every other role — the
 * two group roles included — is refused. Group membership grants the right to
 * *order* at a group's prices, never to set them.
 *
 * A price is stored as one row per (group, product). Clearing a price deletes
 * the row rather than writing a NULL, so "no group price" always means exactly
 * one thing: the product falls back to the organization price, which this
 * endpoint never modifies.
 */

const PRICING_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE"] as const
const PAGE_SIZE_DEFAULT = 50
const PAGE_SIZE_MAX = 200

type Authorized = {
  group: { id: number; organizationId: number; name: string }
  role: string
  userId: string
}

async function authorizeGroupPricing(
  idParam: string,
): Promise<{ authorized: Authorized; failure?: undefined } | { authorized?: undefined; failure: NextResponse }> {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    return { failure: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) }
  }

  const role = (session.user as any).role
  if (!PRICING_ROLES.includes(role)) {
    return { failure: NextResponse.json({ error: "Forbidden: Insufficient permissions" }, { status: 403 }) }
  }

  const groupId = Number.parseInt(idParam)
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return { failure: NextResponse.json({ error: "Invalid Group ID" }, { status: 400 }) }
  }

  const [group] = await db
    .select({ id: groups.id, organizationId: groups.organizationId, name: groups.name })
    .from(groups)
    .where(and(eq(groups.id, groupId), sql`${groups.status} != 'deleted'`))
    .limit(1)

  if (!group) {
    return { failure: NextResponse.json({ error: "Group not found" }, { status: 404 }) }
  }

  // Head Office is pinned to its own tenant; Super Admin is the only role that
  // crosses organizations, which is the same rule the rest of /groups applies.
  if (role === "HEAD_OFFICE" && group.organizationId !== (session.user as any).organizationId) {
    return {
      failure: NextResponse.json(
        { error: "Forbidden: You can only price groups within your own organization" },
        { status: 403 },
      ),
    }
  }

  return { authorized: { group, role, userId: (session.user as any).id } }
}

/**
 * The organization's catalogue as this group pays for it.
 *
 * Every active product the organization stocks is listed, whether or not the
 * group prices it, so an administrator can see what a product costs now before
 * deciding to override it. `effectivePriceCents` is the number the group's
 * branches are actually charged.
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params
    const { authorized, failure } = await authorizeGroupPricing(id)
    if (failure) return failure

    const { searchParams } = new URL(req.url)
    const searchRaw = (searchParams.get("search") || "").trim().slice(0, 100)
    const search = searchRaw ? escapeLikePattern(searchRaw) : ""
    const page = Math.max(1, Number.parseInt(searchParams.get("page") || "1") || 1)
    const requestedLimit = Number.parseInt(searchParams.get("limit") || String(PAGE_SIZE_DEFAULT))
    const limit = Math.min(Math.max(1, requestedLimit || PAGE_SIZE_DEFAULT), PAGE_SIZE_MAX)

    const conditions: SQL[] = [
      eq(organizationInventory.organizationId, authorized.group.organizationId),
      eq(organizationInventory.isActive, true),
      isNull(organizationInventory.deletedAt),
      eq(globalProducts.status, "active"),
      isNull(globalProducts.deletedAt),
    ]
    if (search) {
      const pattern = `%${search}%`
      conditions.push(or(
        sql`${globalProducts.name} ILIKE ${pattern}`,
        sql`${globalProducts.productCode} ILIKE ${pattern}`,
        sql`${organizationInventory.customName} ILIKE ${pattern}`,
      ) as SQL)
    }
    const where = and(...conditions)

    const [items, [totals]] = await Promise.all([
      db
        .select({
          organizationInventoryId: organizationInventory.id,
          globalProductId: globalProducts.id,
          productCode: globalProducts.productCode,
          name: sql<string>`COALESCE(${organizationInventory.customName}, ${globalProducts.name})`,
          unit: globalProducts.unit,
          basePriceCents: globalProducts.basePrice,
          organizationPriceCents: organizationInventory.customPrice,
          groupPriceCents: groupInventoryPrices.customPriceCents,
        })
        .from(organizationInventory)
        .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
        .leftJoin(groupInventoryPrices, and(
          eq(groupInventoryPrices.organizationInventoryId, organizationInventory.id),
          eq(groupInventoryPrices.groupId, authorized.group.id),
          eq(groupInventoryPrices.organizationId, authorized.group.organizationId),
        ))
        .where(where)
        .orderBy(asc(sql`COALESCE(${organizationInventory.customName}, ${globalProducts.name})`))
        .limit(limit)
        .offset((page - 1) * limit),
      db
        .select({ count: sql<number>`cast(count(*) as integer)` })
        .from(organizationInventory)
        .innerJoin(globalProducts, eq(organizationInventory.globalProductId, globalProducts.id))
        .where(where),
    ])

    return NextResponse.json({
      group: authorized.group,
      items: items.map((item) => ({
        ...item,
        effectivePriceCents: resolveEffectivePriceCents({
          groupPriceCents: item.groupPriceCents,
          organizationPriceCents: item.organizationPriceCents,
          basePriceCents: item.basePriceCents,
        }),
      })),
      total: Number(totals?.count ?? 0),
      page,
      limit,
    })
  } catch (e) {
    console.error("Failed to load group prices:", e)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

/**
 * Set or clear group prices.
 *
 * The whole request is one transaction: either every line is applied or none
 * is, so a partially repriced catalogue is never observable. Products are
 * verified to belong to this group's organization first, which is what stops a
 * crafted id from pricing another tenant's catalogue item under this group.
 */
export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await props.params
    const { authorized, failure } = await authorizeGroupPricing(id)
    if (failure) return failure

    const parsedBody = groupPricesUpdateSchema.safeParse(await req.json().catch(() => null))
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const { prices } = parsedBody.data
    const requestedIds = prices.map((price) => price.organizationInventoryId)

    // Tenant guard on the write itself: only catalogue items this group's own
    // organization stocks may be priced here.
    const ownedItems = await db
      .select({ id: organizationInventory.id })
      .from(organizationInventory)
      .where(and(
        inArray(organizationInventory.id, requestedIds),
        eq(organizationInventory.organizationId, authorized.group.organizationId),
        isNull(organizationInventory.deletedAt),
      ))
    if (ownedItems.length !== requestedIds.length) {
      return NextResponse.json(
        { error: "One or more products do not belong to this group's organization" },
        { status: 400 },
      )
    }

    type PriceUpdate = { organizationInventoryId: number; customPriceCents: number }
    const updates = prices.filter(
      (price): price is PriceUpdate => price.customPriceCents !== null,
    )
    const clears = prices
      .filter((price) => price.customPriceCents === null)
      .map((price) => price.organizationInventoryId)

    await db.transaction(async (tx) => {
      if (clears.length > 0) {
        await tx.delete(groupInventoryPrices).where(and(
          eq(groupInventoryPrices.groupId, authorized.group.id),
          eq(groupInventoryPrices.organizationId, authorized.group.organizationId),
          inArray(groupInventoryPrices.organizationInventoryId, clears),
        ))
      }

      if (updates.length > 0) {
        await tx
          .insert(groupInventoryPrices)
          .values(updates.map((price) => ({
            groupId: authorized.group.id,
            organizationId: authorized.group.organizationId,
            organizationInventoryId: price.organizationInventoryId,
            customPriceCents: price.customPriceCents,
            updatedByUserId: authorized.userId,
          })))
          .onConflictDoUpdate({
            target: [groupInventoryPrices.groupId, groupInventoryPrices.organizationInventoryId],
            set: {
              customPriceCents: sql`excluded.custom_price_cents`,
              updatedByUserId: authorized.userId,
              updatedAt: new Date(),
            },
          })
      }

      await tx.insert(groupAuditLogs).values({
        organizationId: authorized.group.organizationId,
        groupId: authorized.group.id,
        action: "SET_GROUP_PRICES",
        performedByUserId: authorized.userId,
        performedByRole: authorized.role,
        metadata: {
          updated: updates.map((price) => ({
            organizationInventoryId: price.organizationInventoryId,
            customPriceCents: price.customPriceCents,
          })),
          cleared: clears,
        },
      })
    })

    // Prices reach the shop, the branch inventory listings, and the group
    // catalogue through these caches; a repricing that is not visible until a
    // TTL expires would show one price and charge another.
    await invalidateGroupPriceCaches()

    return NextResponse.json({
      message: `Updated ${updates.length} price(s) and cleared ${clears.length}.`,
      updated: updates.length,
      cleared: clears.length,
    })
  } catch (e) {
    console.error("Failed to update group prices:", e)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

async function invalidateGroupPriceCaches() {
  await invalidateByPrefix("group")
  await invalidateByPrefix("branch-inv")
  await invalidateByPrefix("inventory")
  await invalidateByPrefix("analytics")
}
