import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { and, asc, desc, eq, gte, sql, type SQL } from "drizzle-orm"

import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import {
  branches,
  globalProducts,
  groups,
  orderItems,
  orders,
  organizations,
} from "@/db/schema"
import {
  isProductPriceHistoryRange,
  resolveProductPriceHistoryRange,
  toIsoTimestamp,
  type ProductPriceHistoryPoint,
  type ProductPriceHistoryResponse,
  type ProductPriceHistoryRole,
} from "@/lib/product-price-history"

const ALLOWED_ROLES = new Set<ProductPriceHistoryRole>(["SUPER_ADMIN", "HEAD_OFFICE"])
const MAX_HISTORY_POINTS = 5_000
const INCLUDED_ORDER = sql`upper(${orders.status}) not in ('CANCELLED', 'REJECTED')`

function parseOptionalId(value: string | null) {
  if (value === null || value === "" || value === "all") return { value: null, valid: true }
  const parsed = Number(value)
  return {
    value: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null,
    valid: Number.isSafeInteger(parsed) && parsed > 0,
  }
}

function noStoreJson(body: ProductPriceHistoryResponse) {
  return NextResponse.json(body, { headers: { "Cache-Control": "private, no-store" } })
}

// Access checks and dependent filter validation stay together so every query
// below is built from one audited tenant scope.
// eslint-disable-next-line sonarjs/cognitive-complexity
async function getProductPriceHistory(request: NextRequest) {
  const session = await getServerSession(authOptions)
  if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const actor = session.user as { role?: string; organizationId?: number | string | null }
  if (!ALLOWED_ROLES.has(actor.role as ProductPriceHistoryRole)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const role = actor.role as ProductPriceHistoryRole
  const sessionOrganizationId = Number(actor.organizationId)
  if (role === "HEAD_OFFICE" && (!Number.isSafeInteger(sessionOrganizationId) || sessionOrganizationId <= 0)) {
    return NextResponse.json({ error: "Organization context required" }, { status: 403 })
  }

  const requestedRange = request.nextUrl.searchParams.get("range")
  if (requestedRange && !isProductPriceHistoryRange(requestedRange)) {
    return NextResponse.json({ error: "Invalid price history range" }, { status: 400 })
  }
  const range = resolveProductPriceHistoryRange(isProductPriceHistoryRange(requestedRange) ? requestedRange : "1y")

  const organizationInput = parseOptionalId(request.nextUrl.searchParams.get("organizationId"))
  const groupInput = parseOptionalId(request.nextUrl.searchParams.get("groupId"))
  const branchInput = parseOptionalId(request.nextUrl.searchParams.get("branchId"))
  const productInput = parseOptionalId(request.nextUrl.searchParams.get("productId"))
  if (!organizationInput.valid || !groupInput.valid || !branchInput.valid || !productInput.valid) {
    return NextResponse.json({ error: "Invalid filter value" }, { status: 400 })
  }

  if (
    role === "HEAD_OFFICE"
    && organizationInput.value !== null
    && organizationInput.value !== sessionOrganizationId
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }
  const organizationId = role === "HEAD_OFFICE" ? sessionOrganizationId : organizationInput.value

  const organizationRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(role === "HEAD_OFFICE" ? eq(organizations.id, sessionOrganizationId) : undefined)
    .orderBy(asc(organizations.name))

  if (organizationId !== null && !organizationRows.some((organization) => organization.id === organizationId)) {
    return NextResponse.json({ error: "Organization not found" }, { status: 404 })
  }

  const groupRows = await db
    .select({
      id: groups.id,
      name: groups.name,
      organizationId: groups.organizationId,
      organizationName: organizations.name,
    })
    .from(groups)
    .innerJoin(organizations, eq(groups.organizationId, organizations.id))
    .where(and(
      sql`lower(coalesce(${groups.status}, 'active')) <> 'deleted'`,
      organizationId === null ? undefined : eq(groups.organizationId, organizationId),
    ))
    .orderBy(asc(organizations.name), asc(groups.name))

  const groupId = groupInput.value
  if (groupId !== null && !groupRows.some((group) => group.id === groupId)) {
    return NextResponse.json({ error: role === "HEAD_OFFICE" ? "Forbidden" : "Group not found" }, { status: role === "HEAD_OFFICE" ? 403 : 404 })
  }

  const branchRows = await db
    .select({
      id: branches.id,
      name: branches.name,
      organizationId: branches.organizationId,
      organizationName: organizations.name,
      groupId: branches.groupId,
    })
    .from(branches)
    .innerJoin(organizations, eq(branches.organizationId, organizations.id))
    .where(and(
      sql`lower(coalesce(${branches.status}, 'active')) <> 'deleted'`,
      organizationId === null ? undefined : eq(branches.organizationId, organizationId),
      groupId === null ? undefined : eq(branches.groupId, groupId),
    ))
    .orderBy(asc(organizations.name), asc(branches.name))

  const branchId = branchInput.value
  if (branchId !== null && !branchRows.some((branch) => branch.id === branchId)) {
    return NextResponse.json({ error: role === "HEAD_OFFICE" ? "Forbidden" : "Branch not found" }, { status: role === "HEAD_OFFICE" ? 403 : 404 })
  }

  const historyConditions: SQL[] = [INCLUDED_ORDER]
  if (range.startAt) historyConditions.push(gte(orders.createdAt, range.startAt))
  if (organizationId !== null) historyConditions.push(eq(orders.organizationId, organizationId))
  if (groupId !== null) historyConditions.push(eq(branches.groupId, groupId))
  if (branchId !== null) historyConditions.push(eq(orders.branchId, branchId))

  const coverage = db
    .select({
      globalProductId: orderItems.globalProductId,
      snapshotCount: sql<number>`count(*)::int`.as("snapshot_count"),
      firstRecordedAt: sql<Date>`min(${orders.createdAt})`.as("first_recorded_at"),
      lastRecordedAt: sql<Date>`max(${orders.createdAt})`.as("last_recorded_at"),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(branches, eq(orders.branchId, branches.id))
    .where(and(...historyConditions))
    .groupBy(orderItems.globalProductId)
    .as("price_history_coverage")

  const productRows = await db
    .select({
      id: globalProducts.id,
      productCode: globalProducts.productCode,
      name: globalProducts.name,
      unit: globalProducts.unit,
      status: globalProducts.status,
      snapshotCount: coverage.snapshotCount,
      firstRecordedAt: coverage.firstRecordedAt,
      lastRecordedAt: coverage.lastRecordedAt,
    })
    .from(globalProducts)
    .innerJoin(coverage, eq(globalProducts.id, coverage.globalProductId))
    .orderBy(desc(coverage.snapshotCount), asc(globalProducts.name))

  const products = productRows.map((product) => ({
    ...product,
    snapshotCount: Number(product.snapshotCount) || 0,
    firstRecordedAt: toIsoTimestamp(product.firstRecordedAt),
    lastRecordedAt: toIsoTimestamp(product.lastRecordedAt),
  }))
  const selectedProduct = productInput.value === null
    ? products[0] ?? null
    : products.find((product) => product.id === productInput.value) ?? null

  if (productInput.value !== null && !selectedProduct) {
    return NextResponse.json({ error: "Product not found in the selected scope" }, { status: 404 })
  }

  const baseResponse = {
    role,
    products,
    selectedProduct,
    options: {
      organizations: organizationRows,
      groups: groupRows,
      branches: branchRows,
    },
    selection: { organizationId, groupId, branchId },
    range: { ...range, startAt: range.startAt?.toISOString() ?? null },
    source: {
      description: "Exact unit price charged on each order line when the order was placed.",
      excludes: ["Cancelled orders", "Rejected orders"],
    },
  }

  if (!selectedProduct) {
    return noStoreJson({ ...baseResponse, points: [], truncated: false })
  }

  const pointRows = await db
    .select({
      orderItemId: orderItems.id,
      orderId: orders.id,
      orderReference: orders.tid,
      orderedAt: orders.createdAt,
      chargedPriceCents: orderItems.priceCents,
      quantity: orderItems.quantity,
      organizationId: organizations.id,
      organizationName: organizations.name,
      groupId: groups.id,
      groupName: groups.name,
      branchId: branches.id,
      branchName: branches.name,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .innerJoin(organizations, eq(orders.organizationId, organizations.id))
    .innerJoin(branches, eq(orders.branchId, branches.id))
    .leftJoin(groups, eq(branches.groupId, groups.id))
    .where(and(eq(orderItems.globalProductId, selectedProduct.id), ...historyConditions))
    .orderBy(desc(orders.createdAt), desc(orderItems.id))
    .limit(MAX_HISTORY_POINTS + 1)

  const truncated = pointRows.length > MAX_HISTORY_POINTS
  const points: ProductPriceHistoryPoint[] = pointRows
    .slice(0, MAX_HISTORY_POINTS)
    .map((point) => {
      const orderedAt = toIsoTimestamp(point.orderedAt)
      if (!orderedAt) throw new TypeError("Price history query returned an invalid order timestamp")
      return {
        ...point,
        orderedAt,
        chargedPriceCents: Number(point.chargedPriceCents) || 0,
        quantity: Number(point.quantity) || 0,
        groupId: point.groupId ?? null,
        groupName: point.groupName ?? null,
      }
    })
    .reverse()

  return noStoreJson({ ...baseResponse, points, truncated })
}

export async function GET(request: NextRequest) {
  try {
    return await getProductPriceHistory(request)
  } catch (error) {
    console.error("Failed to load product price history:", error)
    return NextResponse.json({ error: "Failed to load product price history" }, { status: 500 })
  }
}
