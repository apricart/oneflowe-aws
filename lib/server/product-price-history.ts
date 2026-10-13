import "server-only"

import { and, asc, desc, eq, gt, gte, inArray, isNull, or, sql, type SQL } from "drizzle-orm"

import {
  branches,
  globalProducts,
  groups,
  organizations,
  productPriceHistory,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  isProductPriceHistoryRange,
  resolveProductPriceHistoryRange,
  toIsoTimestamp,
  type ProductPriceHistoryPoint,
  type ProductPriceHistoryResponse,
} from "@/lib/product-price-history"

/**
 * Product price history, for every reader that may see it. Lifted unchanged
 * out of `app/api/v1/admin/product-price-history/route.ts` so the warehouse's
 * read-only catalogue answers from the same timeline rules; the access each
 * reader gets is the one parameter that differs.
 */

const MAX_HISTORY_POINTS = 5_000

function parseOptionalId(value: string | null) {
  if (value === null || value === "" || value === "all") return { value: null, valid: true }
  const parsed = Number(value)
  return {
    value: Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null,
    valid: Number.isSafeInteger(parsed) && parsed > 0,
  }
}


type HistoryGroup = { id: number; organizationId: number }
type HistoryBranch = { id: number; organizationId: number; groupId: number | null }

/**
 * A specific tenant filter intentionally excludes GLOBAL rows. The trigger
 * materializes inherited global changes as ORGANIZATION rows, so Head Office
 * gets a complete effective-price history without gaining access to the
 * supplier/global tier. Group and branch filters retain their parent tiers.
 */
function historyScopeCondition(input: {
  organizationId: number | null
  group: HistoryGroup | null
  branch: HistoryBranch | null
}): SQL | undefined {
  const { organizationId, group, branch } = input

  if (branch) {
    return and(
      eq(productPriceHistory.organizationId, branch.organizationId),
      or(
        and(isNull(productPriceHistory.groupId), isNull(productPriceHistory.branchId)),
        branch.groupId === null
          ? undefined
          : and(eq(productPriceHistory.groupId, branch.groupId), isNull(productPriceHistory.branchId)),
        eq(productPriceHistory.branchId, branch.id),
      ),
    )
  }

  if (group) {
    return and(
      eq(productPriceHistory.organizationId, group.organizationId),
      or(
        and(isNull(productPriceHistory.groupId), isNull(productPriceHistory.branchId)),
        eq(productPriceHistory.groupId, group.id),
      ),
    )
  }

  return organizationId === null
    ? undefined
    : eq(productPriceHistory.organizationId, organizationId)
}

/**
 * Who is reading, decided by the caller from the session — never the request.
 *
 *   * SUPER_ADMIN — every tenant, the global tier included.
 *   * HEAD_OFFICE — its own organization only, never the global tier.
 *   * WAREHOUSE   — the global tier, plus the organizations whose branches it
 *     serves; branch options and branch rows only for the branches it serves
 *     (plans/OF-WAREHOUSE-full-read-only-catalog.md).
 */
export type ProductPriceHistoryAccess =
  | { role: "SUPER_ADMIN" }
  | { role: "HEAD_OFFICE"; organizationId: number }
  | { role: "WAREHOUSE"; organizationIds: number[]; branchIds: number[] }

export type ProductPriceHistoryResult =
  | { ok: true; body: ProductPriceHistoryResponse }
  | { ok: false; status: number; error: string }

const refuse = (status: number, error: string): ProductPriceHistoryResult => ({ ok: false, status, error })

/** The warehouse's whole-catalogue view: global rows, and rows of the organizations it serves. */
function warehouseScopeCondition(access: { organizationIds: number[]; branchIds: number[] }): SQL {
  const organizationRows = access.organizationIds.length === 0
    ? sql`FALSE`
    : and(
      inArray(productPriceHistory.organizationId, access.organizationIds),
      access.branchIds.length === 0
        ? isNull(productPriceHistory.branchId)
        : or(isNull(productPriceHistory.branchId), inArray(productPriceHistory.branchId, access.branchIds)),
    )!
  return or(isNull(productPriceHistory.organizationId), organizationRows)!
}

// Access checks and dependent filter validation stay together so every query
// below is built from one audited tenant scope.
// eslint-disable-next-line sonarjs/cognitive-complexity
export async function loadProductPriceHistory(
  searchParams: URLSearchParams,
  access: ProductPriceHistoryAccess,
): Promise<ProductPriceHistoryResult> {
  const role = access.role
  const sessionOrganizationId = access.role === "HEAD_OFFICE" ? access.organizationId : null
  const fencedOrganizationIds = access.role === "WAREHOUSE" ? access.organizationIds : null
  const fencedBranchIds = access.role === "WAREHOUSE" ? access.branchIds : null

  const requestedRange = searchParams.get("range")
  if (requestedRange && !isProductPriceHistoryRange(requestedRange)) {
    return refuse(400, "Invalid price history range")
  }
  const range = resolveProductPriceHistoryRange(isProductPriceHistoryRange(requestedRange) ? requestedRange : "1y")

  const organizationInput = parseOptionalId(searchParams.get("organizationId"))
  const groupInput = parseOptionalId(searchParams.get("groupId"))
  const branchInput = parseOptionalId(searchParams.get("branchId"))
  const productInput = parseOptionalId(searchParams.get("productId"))
  if (!organizationInput.valid || !groupInput.valid || !branchInput.valid || !productInput.valid) {
    return refuse(400, "Invalid filter value")
  }

  if (
    role === "HEAD_OFFICE"
    && organizationInput.value !== null
    && organizationInput.value !== sessionOrganizationId
  ) {
    return refuse(403, "Forbidden")
  }
  const organizationId = role === "HEAD_OFFICE" ? sessionOrganizationId : organizationInput.value

  const organizationRows = await db
    .select({ id: organizations.id, name: organizations.name })
    .from(organizations)
    .where(organizationOptionsCondition(sessionOrganizationId, fencedOrganizationIds))
    .orderBy(asc(organizations.name))

  if (organizationId !== null && !organizationRows.some((organization) => organization.id === organizationId)) {
    return refuse(404, "Organization not found")
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
      fencedOrganizationIds === null ? undefined : inArrayOrFalse(groups.organizationId, fencedOrganizationIds),
    ))
    .orderBy(asc(organizations.name), asc(groups.name))

  const groupId = groupInput.value
  if (groupId !== null && !groupRows.some((group) => group.id === groupId)) {
    return role === "HEAD_OFFICE" ? refuse(403, "Forbidden") : refuse(404, "Group not found")
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
      fencedBranchIds === null ? undefined : inArrayOrFalse(branches.id, fencedBranchIds),
    ))
    .orderBy(asc(organizations.name), asc(branches.name))

  const branchId = branchInput.value
  if (branchId !== null && !branchRows.some((branch) => branch.id === branchId)) {
    return role === "HEAD_OFFICE" ? refuse(403, "Forbidden") : refuse(404, "Branch not found")
  }

  const selectedGroup = groupId === null
    ? null
    : groupRows.find((group) => group.id === groupId) ?? null
  const selectedBranch = branchId === null
    ? null
    : branchRows.find((branch) => branch.id === branchId) ?? null
  const scopeCondition = historyScopeCondition({
    organizationId,
    group: selectedGroup,
    branch: selectedBranch,
  })
  // Rank the complete visible timeline before applying the requested date
  // range. Historical order evidence used to contain one row per branch/order;
  // the window treats organization and group pricing as consumer-price streams
  // and retains only the initial known value plus real transitions. Ranking
  // before the date filter also prevents the first duplicate inside a range
  // from being mistaken for a change.
  const ledgerConditions: SQL[] = [gt(productPriceHistory.priceCents, 0)]
  if (scopeCondition) ledgerConditions.push(scopeCondition)
  if (access.role === "WAREHOUSE") ledgerConditions.push(warehouseScopeCondition(access))

  const rankedHistory = db
    .select({
      id: productPriceHistory.id,
      globalProductId: productPriceHistory.globalProductId,
      changedAt: productPriceHistory.changedAt,
      priceCents: productPriceHistory.priceCents,
      recordedPreviousPriceCents: productPriceHistory.previousPriceCents,
      previousTimelinePriceCents: sql<number | null>`lag(${productPriceHistory.priceCents}) over (
        partition by
          ${productPriceHistory.globalProductId},
          coalesce(${productPriceHistory.organizationId}, -1),
          coalesce(${productPriceHistory.groupId}, -1)
        order by ${productPriceHistory.changedAt}, ${productPriceHistory.id}
      )`.as("previous_timeline_price_cents"),
      scope: productPriceHistory.scope,
      changeType: productPriceHistory.changeType,
      source: productPriceHistory.source,
      organizationId: productPriceHistory.organizationId,
      groupId: productPriceHistory.groupId,
      branchId: productPriceHistory.branchId,
    })
    .from(productPriceHistory)
    .where(and(...ledgerConditions))
    .as("ranked_product_price_history")

  const changeConditions: SQL[] = [
    sql`(
      (
        ${rankedHistory.source} = 'CATALOG_CHANGE'
        AND ${rankedHistory.recordedPreviousPriceCents} > 0
        AND ${rankedHistory.recordedPreviousPriceCents} <> ${rankedHistory.priceCents}
      )
      OR
      (
        ${rankedHistory.source} <> 'CATALOG_CHANGE'
        AND ${rankedHistory.previousTimelinePriceCents} > 0
        AND ${rankedHistory.previousTimelinePriceCents} <> ${rankedHistory.priceCents}
      )
    )`,
  ]
  if (range.startAt) changeConditions.push(gte(rankedHistory.changedAt, range.startAt))

  const coverage = db
    .select({
      globalProductId: rankedHistory.globalProductId,
      recordCount: sql<number>`count(*)::int`.as("record_count"),
      firstRecordedAt: sql<Date>`min(${rankedHistory.changedAt})`.as("first_recorded_at"),
      lastRecordedAt: sql<Date>`max(${rankedHistory.changedAt})`.as("last_recorded_at"),
    })
    .from(rankedHistory)
    .where(and(...changeConditions))
    .groupBy(rankedHistory.globalProductId)
    .as("price_history_coverage")

  const productRows = await db
    .select({
      id: globalProducts.id,
      productCode: globalProducts.productCode,
      name: globalProducts.name,
      unit: globalProducts.unit,
      status: globalProducts.status,
      recordCount: coverage.recordCount,
      firstRecordedAt: coverage.firstRecordedAt,
      lastRecordedAt: coverage.lastRecordedAt,
    })
    .from(globalProducts)
    .innerJoin(coverage, eq(globalProducts.id, coverage.globalProductId))
    .orderBy(desc(coverage.recordCount), asc(globalProducts.name))

  const products = productRows.map((product) => ({
    ...product,
    recordCount: Number(product.recordCount) || 0,
    firstRecordedAt: toIsoTimestamp(product.firstRecordedAt),
    lastRecordedAt: toIsoTimestamp(product.lastRecordedAt),
  }))
  const selectedProduct = productInput.value === null
    ? products[0] ?? null
    : products.find((product) => product.id === productInput.value) ?? null

  if (productInput.value !== null && !selectedProduct) {
    return refuse(404, "Product not found in the selected scope")
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
      description: role === "HEAD_OFFICE"
        ? "Consumer-facing organization and group price changes. Global catalogue rows are never included."
        : "Consumer-facing price changes recorded at the global, organization, or group tier.",
      backfillDescription: "Earlier change points were inferred from eligible order prices during migration.",
    },
  }

  if (!selectedProduct) {
    return { ok: true, body: { ...baseResponse, points: [], truncated: false } }
  }

  const pointRows = await db
    .select({
      id: rankedHistory.id,
      changedAt: rankedHistory.changedAt,
      previousPriceCents: sql<number | null>`case
        when ${rankedHistory.source} = 'CATALOG_CHANGE'
          then ${rankedHistory.recordedPreviousPriceCents}
        else ${rankedHistory.previousTimelinePriceCents}
      end`,
      priceCents: rankedHistory.priceCents,
      scope: rankedHistory.scope,
      changeType: rankedHistory.changeType,
      source: rankedHistory.source,
      organizationId: rankedHistory.organizationId,
      organizationName: organizations.name,
      groupId: rankedHistory.groupId,
      groupName: groups.name,
      branchId: rankedHistory.branchId,
      branchName: branches.name,
    })
    .from(rankedHistory)
    .leftJoin(organizations, eq(rankedHistory.organizationId, organizations.id))
    .leftJoin(groups, eq(rankedHistory.groupId, groups.id))
    .leftJoin(branches, eq(rankedHistory.branchId, branches.id))
    .where(and(eq(rankedHistory.globalProductId, selectedProduct.id), ...changeConditions))
    .orderBy(desc(rankedHistory.changedAt), desc(rankedHistory.id))
    .limit(MAX_HISTORY_POINTS + 1)

  const truncated = pointRows.length > MAX_HISTORY_POINTS
  const points: ProductPriceHistoryPoint[] = pointRows
    .slice(0, MAX_HISTORY_POINTS)
    .map((point) => {
      const changedAt = toIsoTimestamp(point.changedAt)
      if (!changedAt) throw new TypeError("Price history query returned an invalid change timestamp")
      return {
        ...point,
        changedAt,
        previousPriceCents: point.previousPriceCents === null ? null : Number(point.previousPriceCents),
        priceCents: Number(point.priceCents),
        scope: point.scope as ProductPriceHistoryPoint["scope"],
        source: point.source as ProductPriceHistoryPoint["source"],
        organizationId: point.organizationId ?? null,
        organizationName: point.organizationName ?? null,
        groupId: point.groupId ?? null,
        groupName: point.groupName ?? null,
        branchId: point.branchId ?? null,
        branchName: point.branchName ?? null,
      }
    })
    .reverse()

  return { ok: true, body: { ...baseResponse, points, truncated } }
}


function inArrayOrFalse(column: Parameters<typeof inArray>[0], ids: number[]): SQL {
  return ids.length === 0 ? sql`FALSE` : inArray(column, ids)
}

function organizationOptionsCondition(sessionOrganizationId: number | null, fencedOrganizationIds: number[] | null): SQL | undefined {
  if (sessionOrganizationId !== null) return eq(organizations.id, sessionOrganizationId)
  if (fencedOrganizationIds !== null) return inArrayOrFalse(organizations.id, fencedOrganizationIds)
  return undefined
}
