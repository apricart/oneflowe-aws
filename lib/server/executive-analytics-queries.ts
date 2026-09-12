import "server-only"

import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { branches, budgets, categories, globalProducts, groups, orderItems, orders, organizations, users } from "@/db/schema"
import { db } from "@/lib/db"
import { buildAppMonthPeriods } from "@/lib/date-range-params"
import { REVENUE_ELIGIBLE_FILTER, metricExpressions } from "@/lib/metric-utils"
import type { ExecutiveScope } from "@/lib/server/executive-analytics-scope"
import type { ExecutiveDimensionId, ExecutiveMetricId } from "@/lib/executive-analytics"
import {
  EXECUTIVE_METRICS,
  MAX_TIME_AXIS_POINTS,
  isTimeAxisDimension,
  resolveDrillDownSort,
  resolveGrain,
  safeDivide,
  type DrillDownSortKey,
} from "@/lib/executive-analytics"

/**
 * The aggregation layer behind the Executive Analytics Center.
 *
 * Two rules govern everything in this file.
 *
 * 1. **Grain.** A query is either order-grain (rooted at `orders`, never joined
 *    to `order_items`) or line-grain (rooted at `order_items`, never summing
 *    `orders.total_cents`). Mixing them is how analytics silently triples a
 *    total, so the two are kept in separate builders and the caller picks one
 *    via `resolveGrain`.
 *
 * 2. **Scope.** Every builder takes the resolved `ExecutiveScope` and applies
 *    its branch fence itself. No builder trusts a caller to have filtered
 *    already, and none accepts a raw branch id from a request.
 *
 * All aggregation runs in Postgres. Nothing here returns order rows to the
 * browser; the largest result any builder produces is one row per branch,
 * category, product or month, capped by the caller's row limit.
 */

/**
 * The parent of a product's category, for rolling subcategories up.
 *
 * Products are attached to subcategories in this schema, while the category
 * filter and the executive charts both speak in top-level categories, so every
 * category-grouped figure is reported against `COALESCE(parent, self)`.
 */
const parentCategories = alias(categories, "parent_categories")

export type ExecutiveFilters = {
  startDate: Date
  endDate: Date
  categoryIds: number[]
  productIds: number[]
  /**
   * Branch groups and requesters to narrow to.
   *
   * These are conveniences, not security boundaries: the branch fence in
   * `tenantConditions` already decides which rows exist at all, so naming a
   * group or a person from another tenant matches nothing rather than reaching
   * anything. What must stay scoped is the *picker* that suggests them, which
   * is why `loadEntityOptions` derives its list from rows inside the fence.
   */
  groupIds: number[]
  userIds: string[]
  /** Unit of measure, when the caller has resolved a single one. */
  unit: string | null
}

/** Refunded value on one order line, counting approved refunds only. */
const lineRefundValue = sql`COALESCE((
  SELECT SUM(refund_items.amount_cents)
  FROM refund_items
  INNER JOIN refunds ON refunds.id = refund_items.refund_id
  WHERE refund_items.order_item_id = ${orderItems.id}
    AND UPPER(refunds.status) IN ('APPROVED', 'COMPLETED')
), 0)`

/** Refunded quantity on one order line, counting approved refunds only. */
const lineRefundQuantity = sql`COALESCE((
  SELECT SUM(refund_items.quantity)
  FROM refund_items
  INNER JOIN refunds ON refunds.id = refund_items.refund_id
  WHERE refund_items.order_item_id = ${orderItems.id}
    AND UPPER(refunds.status) IN ('APPROVED', 'COMPLETED')
), 0)`

/**
 * Line value, net of approved refunds and floored at zero.
 *
 * `price_cents` is the tax-inclusive rate snapshotted at sale time, so
 * `ROUND(price * quantity)` reconciles exactly with `orders.total_cents` — the
 * two grains agree, which is what lets a category total be compared against an
 * order total without restating either.
 */
export const lineNetValue = sql<number>`COALESCE(SUM(GREATEST(0,
  ROUND(${orderItems.priceCents} * ${orderItems.quantity}) - ${lineRefundValue}
)), 0)`.mapWith(Number)

/** Quantity, net of approved refunds. Only ever summed within one unit. */
export const lineNetQuantity = sql<number>`COALESCE(SUM(GREATEST(0,
  ${orderItems.quantity} - ${lineRefundQuantity}
)), 0)`.mapWith(Number)

function tenantConditions(scope: ExecutiveScope) {
  return [
    scope.branchIds ? inArray(orders.branchId, scope.branchIds) : undefined,
    scope.organizationIds.length > 0 ? inArray(orders.organizationId, scope.organizationIds) : undefined,
  ].filter(Boolean)
}

/**
 * Conditions common to every order-rooted query: the tenant fence, the date
 * window, and the product/category/unit narrowing expressed as an EXISTS so it
 * never multiplies the order rows it filters.
 */
export function orderConditions(scope: ExecutiveScope, filters: ExecutiveFilters, options?: { revenueEligible?: boolean }) {
  const conditions: any[] = [
    ...tenantConditions(scope),
    ...entityConditions(filters),
    gte(orders.createdAt, filters.startDate),
    lte(orders.createdAt, filters.endDate),
  ]

  if (options?.revenueEligible !== false) conditions.push(REVENUE_ELIGIBLE_FILTER)

  const lineNarrowing = lineFilterConditions(filters)
  if (lineNarrowing.length > 0) {
    conditions.push(sql`EXISTS (
      SELECT 1 FROM ${orderItems}
      WHERE ${orderItems.orderId} = ${orders.id}
        AND ${and(...lineNarrowing)}
    )`)
  }

  return conditions
}

/**
 * The products belonging to the selected categories, or to any subcategory of
 * them, as a subquery on `order_items.global_product_id`.
 *
 * A subquery rather than a predicate on a joined `global_products`, for two
 * reasons that each caused a real failure:
 *
 *  * Not every builder joins the product tables — the unit list and both price
 *    comparisons read `order_items` alone. A predicate naming an unjoined table
 *    is a SQL error ("missing FROM-clause entry"), not a narrower result.
 *  * The filter offers top-level categories, but products hang off
 *    subcategories, so matching the selected ids literally matched nothing and
 *    every chart silently emptied.
 */
function categoryProductFilter(categoryIds: number[]) {
  return inArray(
    orderItems.globalProductId,
    db
      .select({ id: globalProducts.id })
      .from(globalProducts)
      .innerJoin(categories, eq(categories.id, globalProducts.categoryId))
      .where(or(
        inArray(categories.id, categoryIds),
        inArray(categories.parentId, categoryIds),
      )),
  )
}

/**
 * Narrowing to the specific entities the reader ticked.
 *
 * Group membership is resolved as a subquery on `orders.branchId` rather than a
 * predicate on `branches.groupId`, for the same reason the category filter is a
 * subquery: not every builder joins `branches` — `loadBranchBudgets` reads
 * `orders` alone — and a predicate naming an unjoined table is a SQL error, not
 * a narrower result.
 *
 * Neither of these is a security boundary. The branch fence in
 * `tenantConditions` already decides which rows exist, so naming a group or a
 * person from another tenant matches nothing rather than reaching anything.
 */
function entityConditions(filters: ExecutiveFilters) {
  const conditions: any[] = []
  if (filters.groupIds.length > 0) {
    conditions.push(inArray(
      orders.branchId,
      db.select({ id: branches.id }).from(branches).where(inArray(branches.groupId, filters.groupIds)),
    ))
  }
  if (filters.userIds.length > 0) conditions.push(inArray(orders.createdByUserId, filters.userIds))
  return conditions
}

/** Whether the request is narrowed to particular products or categories. */
export function isLineScoped(filters: ExecutiveFilters): boolean {
  return filters.productIds.length > 0 || filters.categoryIds.length > 0
}

function lineFilterConditions(filters: ExecutiveFilters) {
  const conditions: any[] = []
  if (filters.categoryIds.length > 0) conditions.push(categoryProductFilter(filters.categoryIds))
  if (filters.productIds.length > 0) conditions.push(inArray(orderItems.globalProductId, filters.productIds))
  if (filters.unit) conditions.push(eq(orderItems.unit, filters.unit))
  return conditions
}

/** Conditions for a line-rooted query: the same fence, applied through the join. */
export function lineConditions(scope: ExecutiveScope, filters: ExecutiveFilters) {
  return [
    ...tenantConditions(scope),
    ...entityConditions(filters),
    gte(orders.createdAt, filters.startDate),
    lte(orders.createdAt, filters.endDate),
    REVENUE_ELIGIBLE_FILTER,
    ...lineFilterConditions(filters),
  ]
}

// ── Budget ─────────────────────────────────────────────────────────────────

export type BranchBudgetRow = {
  branchId: number
  branchName: string
  allocatedCents: number
  creditedCents: number
  totalBudgetCents: number
  spentCents: number
  heldCents: number
  consumedCents: number
  remainingCents: number
}

/**
 * Budget position per branch for the selected window.
 *
 * Allocation and add-ons come from the `budgets` ledger for every `YYYY-MM`
 * period the window touches — that table has no finer grain, so a part-month
 * selection still reports the whole month's allocation, exactly as the existing
 * Budget Report does.
 *
 * Spend and commitment are derived from the orders inside the window rather
 * than from the ledger's running totals, so a date filter narrows them
 * honestly. This mirrors `app/api/v1/analytics/budgets/summary/route.ts`, which
 * switches to order-scoped spending the moment a range is supplied — the two
 * reports therefore agree.
 */
export async function loadBranchBudgets(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
): Promise<BranchBudgetRow[]> {
  const periods = buildAppMonthPeriods(filters.startDate, filters.endDate)
  if (periods.length === 0) return []

  const branchFence = [
    scope.branchIds ? inArray(branches.id, scope.branchIds) : undefined,
    scope.organizationIds.length > 0 ? inArray(branches.organizationId, scope.organizationIds) : undefined,
  ].filter(Boolean)

  const branchRows = await db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(branchFence.length > 0 ? and(...branchFence) : undefined)

  if (branchRows.length === 0) return []
  const branchIds = branchRows.map((row) => row.id)

  const [ledgerRows, orderRows] = await Promise.all([
    db
      .select({
        branchId: budgets.branchId,
        allocatedCents: sql<number>`COALESCE(SUM(${budgets.amountAllocatedCents}), 0)`.mapWith(Number),
        creditedCents: sql<number>`COALESCE(SUM(${budgets.amountCreditedCents}), 0)`.mapWith(Number),
      })
      .from(budgets)
      .where(and(inArray(budgets.branchId, branchIds), inArray(budgets.period, periods)))
      .groupBy(budgets.branchId),
    db
      .select({
        branchId: orders.branchId,
        spentCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED') THEN GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0)) ELSE 0 END), 0)`.mapWith(Number),
        heldCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('PENDING', 'APPROVED') THEN GREATEST(0, ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0)) ELSE 0 END), 0)`.mapWith(Number),
      })
      .from(orders)
      .where(and(...orderConditions(scope, filters, { revenueEligible: false })))
      .groupBy(orders.branchId),
  ])

  const ledger = new Map(ledgerRows.map((row) => [row.branchId, row]))
  const spending = new Map(orderRows.map((row) => [row.branchId, row]))

  return branchRows.map((branch) => {
    const allocatedCents = ledger.get(branch.id)?.allocatedCents ?? 0
    const creditedCents = ledger.get(branch.id)?.creditedCents ?? 0
    const spentCents = spending.get(branch.id)?.spentCents ?? 0
    const heldCents = spending.get(branch.id)?.heldCents ?? 0
    const totalBudgetCents = allocatedCents + creditedCents
    const consumedCents = spentCents + heldCents
    return {
      branchId: branch.id,
      branchName: branch.name,
      allocatedCents,
      creditedCents,
      totalBudgetCents,
      spentCents,
      heldCents,
      consumedCents,
      remainingCents: totalBudgetCents - consumedCents,
    }
  })
}

// ── Order-grain aggregates ─────────────────────────────────────────────────

export type OrderGrainRow = {
  key: string
  label: string
  spendCents: number
  orderCount: number
  avgOrderValueCents: number
}

/**
 * How each dimension is keyed and labelled.
 *
 * Every one of these is a 1:1 lookup from the order row — a branch, its group,
 * its tenant, its requester — so the joins that back them cannot multiply rows
 * and the grain rules above still hold.
 */
type DimensionColumn = { key: any; label: any; group: any[] }

const ENTITY_DIMENSION_COLUMNS: Record<Exclude<ExecutiveDimensionId, "category" | "product" | "month" | "day">, DimensionColumn> = {
  branch: {
    key: sql<string>`${orders.branchId}::text`,
    label: sql<string>`COALESCE(${branches.name}, 'Unassigned')`,
    group: [orders.branchId, branches.name],
  },
  group: {
    key: sql<string>`COALESCE(${branches.groupId}::text, 'ungrouped')`,
    label: sql<string>`COALESCE(${groups.name}, 'No group')`,
    group: [branches.groupId, groups.name],
  },
  organization: {
    key: sql<string>`COALESCE(${orders.organizationId}::text, 'none')`,
    label: sql<string>`COALESCE(${organizations.name}, 'Unassigned')`,
    group: [orders.organizationId, organizations.name],
  },
  user: {
    key: sql<string>`${orders.createdByUserId}::text`,
    // Falls back through the identifiers a person may actually have, so a row
    // is never labelled with a bare UUID.
    label: sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), ${users.employeeId}, ${users.email}, 'Unknown')`,
    group: [orders.createdByUserId, users.fullName, users.employeeId, users.email],
  },
}

/**
 * `orders.created_at` read in the application timezone.
 *
 * Every other analytics route in the application buckets through this same
 * expression (`weekly-sales`, `yearly-sales`, `sales-performance`,
 * `organization-stats`), and the budget periods in this very file come from
 * `buildAppMonthPeriods`, which is Asia/Karachi. Bucketing orders in the
 * database session zone instead put every order placed between midnight and
 * 05:00 local into the previous day — and, on the first of a month, the
 * previous month — so the month comparison and the budget it was being read
 * against disagreed at every boundary. It matters far more at day grain, where
 * five hours is a fifth of the bucket.
 */
const APP_LOCAL_CREATED_AT = sql`((${orders.createdAt} AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi')`

const MONTH_DIMENSION_COLUMN: DimensionColumn = {
  key: sql<string>`TO_CHAR(${APP_LOCAL_CREATED_AT}, 'YYYY-MM')`,
  label: sql<string>`TO_CHAR(${APP_LOCAL_CREATED_AT}, 'YYYY-MM')`,
  group: [sql`TO_CHAR(${APP_LOCAL_CREATED_AT}, 'YYYY-MM')`],
}

const DAY_DIMENSION_COLUMN: DimensionColumn = {
  key: sql<string>`TO_CHAR(${APP_LOCAL_CREATED_AT}, 'YYYY-MM-DD')`,
  label: sql<string>`TO_CHAR(${APP_LOCAL_CREATED_AT}, 'YYYY-MM-DD')`,
  group: [sql`TO_CHAR(${APP_LOCAL_CREATED_AT}, 'YYYY-MM-DD')`],
}

export type OrderGrainDimension = Exclude<ExecutiveDimensionId, "category" | "product">

const orderDimensionColumns: Record<OrderGrainDimension, DimensionColumn> = {
  ...ENTITY_DIMENSION_COLUMNS,
  month: MONTH_DIMENSION_COLUMN,
  day: DAY_DIMENSION_COLUMN,
}

/**
 * The row cap for one grouped read.
 *
 * A time axis is not ranked, so it cannot be cut to the reader's row limit
 * without losing the middle of the period; it gets its own cap per grain
 * instead, which is what keeps a two-year day-grain request bounded.
 */
function groupedRowLimit(dimension: ExecutiveDimensionId, limit: number): number {
  return isTimeAxisDimension(dimension) ? MAX_TIME_AXIS_POINTS[dimension] : limit
}

/** Order-grain totals by branch or month. Never joins `order_items`. */
export async function loadOrderGrainSeries(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  dimension: OrderGrainDimension,
  limit: number,
): Promise<OrderGrainRow[]> {
  const column = orderDimensionColumns[dimension]
  const rows = await db
    .select({
      key: column.key,
      label: column.label,
      spendCents: metricExpressions.revenue,
      orderCount: metricExpressions.orderVolume,
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .leftJoin(groups, eq(branches.groupId, groups.id))
    .leftJoin(organizations, eq(orders.organizationId, organizations.id))
    .leftJoin(users, eq(orders.createdByUserId, users.id))
    .where(and(...orderConditions(scope, filters)))
    .groupBy(...column.group)
    .orderBy(isTimeAxisDimension(dimension) ? asc(column.key) : desc(metricExpressions.revenue))
    .limit(groupedRowLimit(dimension, limit))

  return rows.map((row) => ({
    key: String(row.key),
    label: String(row.label),
    spendCents: Number(row.spendCents) || 0,
    orderCount: Number(row.orderCount) || 0,
    avgOrderValueCents: Math.round(safeDivide(Number(row.spendCents) || 0, Number(row.orderCount) || 0)),
  }))
}

// ── Line-grain aggregates ──────────────────────────────────────────────────

export type LineGrainRow = {
  key: string
  label: string
  valueCents: number
  quantity: number
  orderCount: number
  avgUnitPriceCents: number
}

const lineDimensionColumns: Record<ExecutiveDimensionId, DimensionColumn> = {
  ...ENTITY_DIMENSION_COLUMNS,
  month: MONTH_DIMENSION_COLUMN,
  day: DAY_DIMENSION_COLUMN,
  category: {
    key: sql<string>`COALESCE(COALESCE(${parentCategories.id}, ${categories.id})::text, 'uncategorized')`,
    label: sql<string>`COALESCE(COALESCE(${parentCategories.name}, ${categories.name}), 'Uncategorized')`,
    group: [sql`COALESCE(${parentCategories.id}, ${categories.id})`, sql`COALESCE(${parentCategories.name}, ${categories.name})`],
  },
  product: {
    key: sql<string>`${orderItems.globalProductId}::text`,
    label: sql<string>`MIN(${orderItems.productName})`,
    group: [orderItems.globalProductId],
  },
}

/**
 * Line-grain totals by any dimension.
 *
 * `orderCount` here is a DISTINCT count of orders touching the group, not a
 * row count — a three-line order is one order in every group its lines land in.
 */
export async function loadLineGrainSeries(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  dimension: ExecutiveDimensionId,
  limit: number,
): Promise<LineGrainRow[]> {
  const column = lineDimensionColumns[dimension]
  const rows = await db
    .select({
      key: column.key,
      label: column.label,
      valueCents: lineNetValue,
      quantity: lineNetQuantity,
      orderCount: sql<number>`COUNT(DISTINCT ${orders.id})`.mapWith(Number),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .leftJoin(groups, eq(branches.groupId, groups.id))
    .leftJoin(organizations, eq(orders.organizationId, organizations.id))
    .leftJoin(users, eq(orders.createdByUserId, users.id))
    .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
    .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
    .leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))
    .where(and(...lineConditions(scope, filters)))
    .groupBy(...column.group)
    .orderBy(isTimeAxisDimension(dimension) ? asc(column.key) : desc(lineNetValue))
    .limit(groupedRowLimit(dimension, limit))

  return rows.map((row) => {
    const valueCents = Number(row.valueCents) || 0
    const quantity = Number(row.quantity) || 0
    return {
      key: String(row.key),
      label: String(row.label),
      valueCents,
      quantity,
      orderCount: Number(row.orderCount) || 0,
      avgUnitPriceCents: Math.round(safeDivide(valueCents, quantity)),
    }
  })
}

/** Which units of measure are in scope, so quantity is never added across them. */
export async function loadUnitsInScope(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
): Promise<string[]> {
  const rows = await db
    .select({ unit: orderItems.unit })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(...lineConditions(scope, { ...filters, unit: null })))
    .groupBy(orderItems.unit)
    .orderBy(orderItems.unit)
  return rows.map((row) => row.unit).filter(Boolean)
}

// ── Branch × Category matrix ───────────────────────────────────────────────

export type MatrixCell = { branchId: number; categoryKey: string; valueCents: number; quantity: number }

export async function loadBranchCategoryMatrix(scope: ExecutiveScope, filters: ExecutiveFilters) {
  const rows = await db
    .select({
      branchId: orders.branchId,
      branchName: sql<string>`COALESCE(${branches.name}, 'Unassigned')`,
      categoryKey: sql<string>`COALESCE(COALESCE(${parentCategories.id}, ${categories.id})::text, 'uncategorized')`,
      categoryName: sql<string>`COALESCE(COALESCE(${parentCategories.name}, ${categories.name}), 'Uncategorized')`,
      valueCents: lineNetValue,
      quantity: lineNetQuantity,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
    .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
    .leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))
    .where(and(...lineConditions(scope, filters)))
    .groupBy(orders.branchId, branches.name, sql`COALESCE(${parentCategories.id}, ${categories.id})`, sql`COALESCE(${parentCategories.name}, ${categories.name})`)

  return rows.map((row) => ({
    branchId: Number(row.branchId),
    branchName: String(row.branchName),
    categoryKey: String(row.categoryKey),
    categoryName: String(row.categoryName),
    valueCents: Number(row.valueCents) || 0,
    quantity: Number(row.quantity) || 0,
  }))
}

// ── Order process ──────────────────────────────────────────────────────────

/**
 * Order counts by status per branch, across every status — this one query
 * deliberately drops the revenue-eligible filter, because the question is where
 * orders stop, and a rejected order is the answer rather than noise.
 */
export async function loadStatusComposition(scope: ExecutiveScope, filters: ExecutiveFilters) {
  const rows = await db
    .select({
      branchId: orders.branchId,
      branchName: sql<string>`COALESCE(${branches.name}, 'Unassigned')`,
      status: sql<string>`UPPER(${orders.status})`,
      orderCount: sql<number>`COUNT(${orders.id})`.mapWith(Number),
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(...orderConditions(scope, filters, { revenueEligible: false })))
    .groupBy(orders.branchId, branches.name, sql`UPPER(${orders.status})`)

  return rows.map((row) => ({
    branchId: Number(row.branchId),
    branchName: String(row.branchName),
    status: String(row.status),
    orderCount: Number(row.orderCount) || 0,
  }))
}

/** Pending orders older than the aging threshold, oldest first. */
export async function loadAgingPendingOrders(scope: ExecutiveScope, filters: ExecutiveFilters, agingDays: number) {
  return db
    .select({
      branchId: orders.branchId,
      branchName: sql<string>`COALESCE(${branches.name}, 'Unassigned')`,
      orderCount: sql<number>`COUNT(${orders.id})`.mapWith(Number),
      valueCents: sql<number>`COALESCE(SUM(${orders.totalCents}), 0)`.mapWith(Number),
      oldestDays: sql<number>`COALESCE(MAX(EXTRACT(DAY FROM (NOW() - ${orders.createdAt}))), 0)::int`.mapWith(Number),
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(
      ...orderConditions(scope, filters, { revenueEligible: false }),
      sql`UPPER(${orders.status}) = 'PENDING'`,
      sql`${orders.createdAt} < NOW() - (${agingDays} * INTERVAL '1 day')`,
    ))
    .groupBy(orders.branchId, branches.name)
    .orderBy(desc(sql`MAX(EXTRACT(DAY FROM (NOW() - ${orders.createdAt})))`))
    .limit(10)
}

// ── Price variance ─────────────────────────────────────────────────────────

export type PriceVarianceRow = {
  productId: number
  productName: string
  unit: string
  branchCount: number
  minUnitPriceCents: number
  maxUnitPriceCents: number
  avgUnitPriceCents: number
  spreadPct: number
  valueCents: number
}

/**
 * Products bought by more than one branch at more than one weighted average
 * unit price, ranked by the size of the gap.
 *
 * Comparison is only ever made within the same `global_product_id` AND the same
 * unit of measure, and every price is a weighted average of that branch's own
 * lines. A product with a single buying branch cannot produce a spread and is
 * excluded by the HAVING clause rather than shown as 0% — a fabricated zero
 * would read as "no problem here" for a comparison that was never possible.
 */
export async function loadPriceVariance(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  limit: number,
): Promise<PriceVarianceRow[]> {
  const branchPrices = db
    .select({
      productId: orderItems.globalProductId,
      productName: sql<string>`MIN(${orderItems.productName})`.as("product_name"),
      unit: orderItems.unit,
      branchId: orders.branchId,
      branchValue: lineNetValue.as("branch_value"),
      branchQuantity: lineNetQuantity.as("branch_quantity"),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .where(and(...lineConditions(scope, filters)))
    .groupBy(orderItems.globalProductId, orderItems.unit, orders.branchId)
    .having(sql`SUM(${orderItems.quantity}) > 0`)
    .as("branch_prices")

  const rows = await db
    .select({
      productId: branchPrices.productId,
      productName: sql<string>`MIN(${branchPrices.productName})`,
      unit: branchPrices.unit,
      branchCount: sql<number>`COUNT(*)`.mapWith(Number),
      minUnitPriceCents: sql<number>`MIN(${branchPrices.branchValue} / NULLIF(${branchPrices.branchQuantity}, 0))`.mapWith(Number),
      maxUnitPriceCents: sql<number>`MAX(${branchPrices.branchValue} / NULLIF(${branchPrices.branchQuantity}, 0))`.mapWith(Number),
      avgUnitPriceCents: sql<number>`SUM(${branchPrices.branchValue}) / NULLIF(SUM(${branchPrices.branchQuantity}), 0)`.mapWith(Number),
      valueCents: sql<number>`SUM(${branchPrices.branchValue})`.mapWith(Number),
    })
    .from(branchPrices)
    .groupBy(branchPrices.productId, branchPrices.unit)
    .having(sql`COUNT(*) > 1`)
    .orderBy(desc(sql`
      (MAX(${branchPrices.branchValue} / NULLIF(${branchPrices.branchQuantity}, 0))
       - MIN(${branchPrices.branchValue} / NULLIF(${branchPrices.branchQuantity}, 0)))
      / NULLIF(MIN(${branchPrices.branchValue} / NULLIF(${branchPrices.branchQuantity}, 0)), 0)
    `))
    .limit(limit)

  return rows.map((row) => {
    const min = Number(row.minUnitPriceCents) || 0
    const max = Number(row.maxUnitPriceCents) || 0
    return {
      productId: Number(row.productId),
      productName: String(row.productName ?? "Unknown product"),
      unit: String(row.unit ?? ""),
      branchCount: Number(row.branchCount) || 0,
      minUnitPriceCents: Math.round(min),
      maxUnitPriceCents: Math.round(max),
      avgUnitPriceCents: Math.round(Number(row.avgUnitPriceCents) || 0),
      spreadPct: min > 0 ? ((max - min) / min) * 100 : 0,
      valueCents: Number(row.valueCents) || 0,
    }
  })
}

/** Per-branch weighted unit price for one product and unit — the drilldown. */
export async function loadProductPriceByBranch(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  productId: number,
  unit: string | null,
) {
  const rows = await db
    .select({
      branchId: orders.branchId,
      branchName: sql<string>`COALESCE(${branches.name}, 'Unassigned')`,
      unit: orderItems.unit,
      valueCents: lineNetValue,
      quantity: lineNetQuantity,
      orderCount: sql<number>`COUNT(DISTINCT ${orders.id})`.mapWith(Number),
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(and(
      ...lineConditions(scope, { ...filters, productIds: [productId], unit: unit ?? filters.unit }),
    ))
    .groupBy(orders.branchId, branches.name, orderItems.unit)
    .orderBy(desc(lineNetValue))

  return rows.map((row) => {
    const valueCents = Number(row.valueCents) || 0
    const quantity = Number(row.quantity) || 0
    return {
      branchId: Number(row.branchId),
      branchName: String(row.branchName),
      unit: String(row.unit ?? ""),
      valueCents,
      quantity,
      orderCount: Number(row.orderCount) || 0,
      avgUnitPriceCents: Math.round(safeDivide(valueCents, quantity)),
    }
  })
}

// ── Budget rollup ──────────────────────────────────────────────────────────

/**
 * Budget position rolled up to whichever entity holds it.
 *
 * A budget is recorded per branch. A group's or a tenant's budget is therefore
 * the sum of its branches', computed here from the same per-branch rows — so
 * every level reconciles with every other by construction, rather than through
 * a second query that could drift.
 */
export async function loadBudgetRollup(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  dimension: "branch" | "group" | "organization",
): Promise<Array<BranchBudgetRow & { key: string; label: string }>> {
  const branchRows = await loadBranchBudgets(scope, filters)
  if (dimension === "branch") {
    return branchRows.map((row) => ({ ...row, key: String(row.branchId), label: row.branchName }))
  }

  const branchIds = branchRows.map((row) => row.branchId)
  if (branchIds.length === 0) return []

  const parents = await db
    .select({
      branchId: branches.id,
      groupId: branches.groupId,
      groupName: groups.name,
      organizationId: branches.organizationId,
      organizationName: organizations.name,
    })
    .from(branches)
    .leftJoin(groups, eq(branches.groupId, groups.id))
    .leftJoin(organizations, eq(branches.organizationId, organizations.id))
    .where(inArray(branches.id, branchIds))

  const parentOf = new Map(parents.map((row) => [row.branchId, row]))
  const buckets = new Map<string, BranchBudgetRow & { key: string; label: string }>()

  for (const row of branchRows) {
    const parent = parentOf.get(row.branchId)
    const key = dimension === "group"
      ? (parent?.groupId ? String(parent.groupId) : "ungrouped")
      : (parent?.organizationId ? String(parent.organizationId) : "none")
    const label = dimension === "group"
      ? (parent?.groupName ?? "No group")
      : (parent?.organizationName ?? "Unassigned")

    const bucket = buckets.get(key) ?? {
      branchId: 0,
      branchName: label,
      key,
      label,
      allocatedCents: 0,
      creditedCents: 0,
      totalBudgetCents: 0,
      spentCents: 0,
      heldCents: 0,
      consumedCents: 0,
      remainingCents: 0,
    }
    bucket.allocatedCents += row.allocatedCents
    bucket.creditedCents += row.creditedCents
    bucket.totalBudgetCents += row.totalBudgetCents
    bucket.spentCents += row.spentCents
    bucket.heldCents += row.heldCents
    bucket.consumedCents += row.consumedCents
    bucket.remainingCents += row.remainingCents
    buckets.set(key, bucket)
  }

  return Array.from(buckets.values())
}

// ── Entity options ─────────────────────────────────────────────────────────

export type EntityOption = { key: string; label: string; hint?: string }

/** Branch rows inside the fence, shared by the picker and the label lookups. */
async function loadScopedBranchRows(scope: ExecutiveScope) {
  const conditions = [
    scope.branchIds ? inArray(branches.id, scope.branchIds) : undefined,
    scope.organizationIds.length > 0 ? inArray(branches.organizationId, scope.organizationIds) : undefined,
  ].filter(Boolean)
  return db
    .select({ id: branches.id, name: branches.name })
    .from(branches)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(branches.name)
}

/**
 * The pickable members of a dimension: the list behind the entity selector.
 *
 * This is the one place the Center hands out entity *names*, so it is the one
 * place a scoping mistake would leak something even when no figure does. Every
 * list is therefore derived from rows already inside the caller's fence:
 * branches from the scoped branch set, and products, people, groups and
 * categories from the orders those branches actually placed. Another tenant's
 * names cannot appear here, because no order of theirs is inside the fence to
 * name them.
 */
export async function loadEntityOptions(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  dimension: ExecutiveDimensionId,
  limit = 200,
): Promise<EntityOption[]> {
  // A picker ignores its *own* selection — a list that hid everything not
  // already picked could never be changed — but honours every other filter, so
  // focusing on two products narrows the branch list to the branches that
  // actually bought them.
  const ownSelection: Partial<Record<ExecutiveDimensionId, Partial<ExecutiveFilters>>> = {
    group: { groupIds: [] },
    user: { userIds: [] },
    category: { categoryIds: [] },
    product: { productIds: [] },
  }
  const unfiltered: ExecutiveFilters = {
    ...filters,
    ...(ownSelection[dimension] ?? {}),
    // Listing what exists must not depend on which unit is being measured.
    unit: null,
  }

  if (dimension === "branch") {
    // With no product or category focus the picker lists every branch in scope,
    // including ones that have ordered nothing — a branch with no activity is
    // still a legitimate thing to select. Once a focus is on, it narrows to the
    // branches that actually bought it, so the list answers "who buys this?"
    // rather than burying twelve real answers among two hundred.
    if (!isLineScoped(unfiltered)) {
      const rows = await loadScopedBranchRows(scope)
      return rows.slice(0, limit).map((row) => ({ key: String(row.id), label: row.name }))
    }

    const rows = await db
      .select({
        id: orders.branchId,
        name: sql<string>`COALESCE(${branches.name}, 'Unassigned')`,
        orderCount: sql<number>`COUNT(DISTINCT ${orders.id})`.mapWith(Number),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .where(and(...lineConditions(scope, unfiltered)))
      .groupBy(orders.branchId, branches.name)
      .orderBy(desc(sql`COUNT(DISTINCT ${orders.id})`))
      .limit(limit)
    return rows.map((row) => ({
      key: String(row.id),
      label: String(row.name),
      hint: `${row.orderCount} order${row.orderCount === 1 ? "" : "s"}`,
    }))
  }

  if (dimension === "organization") {
    const rows = await db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(scope.organizationIds.length > 0 ? inArray(organizations.id, scope.organizationIds) : undefined)
      .orderBy(organizations.name)
      .limit(limit)
    return rows.map((row) => ({ key: String(row.id), label: row.name }))
  }

  if (dimension === "group") {
    const rows = await db
      .selectDistinct({ id: groups.id, name: groups.name })
      .from(orders)
      .innerJoin(branches, eq(orders.branchId, branches.id))
      .innerJoin(groups, eq(branches.groupId, groups.id))
      .where(and(...orderConditions(scope, unfiltered, { revenueEligible: false })))
      .orderBy(groups.name)
      .limit(limit)
    return rows.map((row) => ({ key: String(row.id), label: row.name }))
  }

  if (dimension === "user") {
    // One row per person. A group requester orders for several branches, and a
    // person moved between branches has orders at two, so the branch is
    // aggregated into the hint rather than grouped on — grouping on it listed
    // the same person twice under one key, and ticking one ticked both.
    const rows = await db
      .select({
        id: orders.createdByUserId,
        label: sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), ${users.employeeId}, ${users.email}, 'Unknown')`,
        branchNames: sql<string>`STRING_AGG(DISTINCT ${branches.name}, ', ' ORDER BY ${branches.name})`,
        orderCount: sql<number>`COUNT(${orders.id})`.mapWith(Number),
      })
      .from(orders)
      .innerJoin(users, eq(orders.createdByUserId, users.id))
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .where(and(...orderConditions(scope, unfiltered, { revenueEligible: false })))
      .groupBy(orders.createdByUserId, users.fullName, users.employeeId, users.email)
      .orderBy(desc(sql`COUNT(${orders.id})`))
      .limit(limit)
    return rows.map((row) => ({
      key: String(row.id),
      label: String(row.label),
      hint: row.branchNames ? `${row.branchNames} · ${row.orderCount} orders` : `${row.orderCount} orders`,
    }))
  }

  if (dimension === "category") {
    const rows = await db
      .selectDistinct({
        id: sql<number>`COALESCE(${parentCategories.id}, ${categories.id})`.mapWith(Number),
        name: sql<string>`COALESCE(${parentCategories.name}, ${categories.name})`,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .innerJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
      .innerJoin(categories, eq(globalProducts.categoryId, categories.id))
      .leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))
      .where(and(...lineConditions(scope, unfiltered)))
      .limit(limit)
    return rows
      .filter((row) => Number.isFinite(row.id))
      .map((row) => ({ key: String(row.id), label: String(row.name) }))
      .sort((left, right) => left.label.localeCompare(right.label))
  }

  if (dimension === "product") {
    // One row per product, whatever units it was sold in. The focus filter is
    // `productIds`, so the key must be the product alone; grouping on the unit
    // as well listed a product sold per Piece and per Box twice under one key.
    // The units are still named in the hint, because they decide whether a
    // quantity comparison across the ticked products will need a unit chosen.
    const rows = await db
      .select({
        id: orderItems.globalProductId,
        label: sql<string>`MIN(${orderItems.productName})`,
        units: sql<string>`STRING_AGG(DISTINCT ${orderItems.unit}, ', ' ORDER BY ${orderItems.unit})`,
        orderCount: sql<number>`COUNT(DISTINCT ${orders.id})`.mapWith(Number),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(and(...lineConditions(scope, unfiltered)))
      .groupBy(orderItems.globalProductId)
      .orderBy(desc(sql`COUNT(DISTINCT ${orders.id})`))
      .limit(limit)
    return rows.map((row) => ({
      key: String(row.id),
      label: String(row.label),
      hint: `per ${row.units} · ${row.orderCount} orders`,
    }))
  }

  return []
}

// ── Time series ────────────────────────────────────────────────────────────

export type SeriesPoint = { period: string; value: number }
export type EntitySeries = { key: string; label: string; points: SeriesPoint[] }

/**
 * One line per entity, month by month: "compare these two products over the
 * last six months" rather than "rank them once".
 *
 * The entities are ranked first and the top ones drawn, so the chart shows the
 * lines that matter rather than every member of the dimension. The month axis
 * is built from the periods actually present and every series is filled against
 * it, so a month in which one entity bought nothing reads as zero rather than
 * as a gap that closes up and fakes a straight line.
 */
export async function loadEntitySeries(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  dimension: ExecutiveDimensionId,
  metric: ExecutiveMetricId,
  limit: number,
): Promise<{ periods: string[]; series: EntitySeries[] }> {
  const grain = resolveGrain(dimension, metric, { lineScoped: isLineScoped(filters) })
  const monthKey = sql<string>`TO_CHAR(${APP_LOCAL_CREATED_AT}, 'YYYY-MM')`

  const ranked = await loadComparison(scope, filters, dimension, metric, limit)
  if (ranked.length === 0) return { periods: [], series: [] }

  /**
   * When the dimension *is* the time axis, the periods are the entities.
   *
   * Falling through to the code below would key one series per month and then
   * plot it against the months, giving as many lines as there are months, each
   * a single spike — which is what "Trend over time" drew for a month
   * comparison before this branch existed, and it was the form offered first.
   */
  if (isTimeAxisDimension(dimension)) {
    const chronological = [...ranked].sort((left, right) => left.key.localeCompare(right.key))
    return {
      periods: chronological.map((row) => row.key),
      series: [{
        key: dimension,
        label: EXECUTIVE_METRICS[metric].label,
        points: chronological.map((row) => ({ period: row.key, value: row.value })),
      }],
    }
  }

  const wanted = new Map(ranked.map((row) => [row.key, row.label]))

  const lineRows = grain === "line"
    ? await db
      .select({
        key: lineDimensionColumns[dimension].key,
        period: monthKey,
        valueCents: lineNetValue,
        quantity: lineNetQuantity,
        orderCount: sql<number>`COUNT(DISTINCT ${orders.id})`.mapWith(Number),
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .leftJoin(groups, eq(branches.groupId, groups.id))
      .leftJoin(organizations, eq(orders.organizationId, organizations.id))
      .leftJoin(users, eq(orders.createdByUserId, users.id))
      .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
      .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
      .leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))
      .where(and(...lineConditions(scope, filters)))
      .groupBy(...lineDimensionColumns[dimension].group, monthKey)
    : []

  const orderRows = grain === "line"
    ? []
    : await db
      .select({
        key: orderDimensionColumns[dimension as OrderGrainDimension].key,
        period: monthKey,
        valueCents: metricExpressions.revenue,
        quantity: sql<number>`0`.mapWith(Number),
        orderCount: metricExpressions.orderVolume,
      })
      .from(orders)
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .leftJoin(groups, eq(branches.groupId, groups.id))
      .leftJoin(organizations, eq(orders.organizationId, organizations.id))
      .leftJoin(users, eq(orders.createdByUserId, users.id))
      .where(and(...orderConditions(scope, filters)))
      .groupBy(...orderDimensionColumns[dimension as OrderGrainDimension].group, monthKey)

  const rows = [...lineRows, ...orderRows]

  const valueOf = (row: { valueCents: unknown; quantity: unknown; orderCount: unknown }) => {
    const value = Number(row.valueCents) || 0
    const quantity = Number(row.quantity) || 0
    const orderCount = Number(row.orderCount) || 0
    switch (metric) {
      case "quantity": return quantity
      case "orders": return orderCount
      case "avgOrderValue": return Math.round(safeDivide(value, orderCount))
      case "avgUnitPrice": return Math.round(safeDivide(value, quantity))
      default: return value
    }
  }

  const periods = Array.from(new Set(rows.map((row) => String(row.period))))
    .sort((left, right) => left.localeCompare(right))

  const byEntity = new Map<string, Map<string, number>>()
  for (const row of rows) {
    const key = String(row.key)
    if (!wanted.has(key)) continue
    const points = byEntity.get(key) ?? new Map<string, number>()
    points.set(String(row.period), valueOf(row))
    byEntity.set(key, points)
  }

  return {
    periods,
    series: ranked.map((entity) => ({
      key: entity.key,
      label: entity.label,
      points: periods.map((period) => ({
        period,
        value: byEntity.get(entity.key)?.get(period) ?? 0,
      })),
    })),
  }
}

// ── Comparison dispatcher ──────────────────────────────────────────────────

export type ComparisonRow = {
  key: string
  label: string
  value: number
  spendCents: number
  quantity: number
  orderCount: number
  avgUnitPriceCents: number
  totalBudgetCents?: number
  consumedCents?: number
  remainingCents?: number
}

/**
 * The Level-2 comparison. One entry point, one grain decided by the registry,
 * and a value column selected from an already-computed row rather than from a
 * caller-supplied expression — there is no path from a request string into SQL.
 */
export async function loadComparison(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  dimension: ExecutiveDimensionId,
  metric: ExecutiveMetricId,
  limit: number,
): Promise<ComparisonRow[]> {
  const grain = resolveGrain(dimension, metric, { lineScoped: isLineScoped(filters) })

  if (grain === "budget") {
    // The registry only pairs budget metrics with budget-bearing dimensions, so
    // this cast is checked by `isSupportedCombination` before we get here.
    const rows = await loadBudgetRollup(scope, filters, dimension as "branch" | "group" | "organization")
    return rows
      .map((row) => ({
        key: row.key,
        label: row.label,
        value: metric === "utilization"
          ? (row.totalBudgetCents > 0 ? (row.consumedCents / row.totalBudgetCents) * 100 : 0)
          : row.remainingCents,
        spendCents: row.consumedCents,
        quantity: 0,
        orderCount: 0,
        avgUnitPriceCents: 0,
        totalBudgetCents: row.totalBudgetCents,
        consumedCents: row.consumedCents,
        remainingCents: row.remainingCents,
      }))
      .sort((left, right) => right.value - left.value)
      .slice(0, limit)
  }

  if (grain === "order") {
    const rows = await loadOrderGrainSeries(scope, filters, dimension as OrderGrainDimension, limit)
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: metric === "orders"
        ? row.orderCount
        : metric === "avgOrderValue" ? row.avgOrderValueCents : row.spendCents,
      spendCents: row.spendCents,
      quantity: 0,
      orderCount: row.orderCount,
      avgUnitPriceCents: 0,
    }))
  }

  const rows = await loadLineGrainSeries(scope, filters, dimension, limit)
  const valueOf = (row: LineGrainRow) => {
    switch (metric) {
      case "quantity": return row.quantity
      case "avgUnitPrice": return row.avgUnitPriceCents
      case "orders": return row.orderCount
      default: return row.valueCents
    }
  }

  return rows
    .map((row) => ({
      key: row.key,
      label: row.label,
      value: valueOf(row),
      spendCents: row.valueCents,
      quantity: row.quantity,
      orderCount: row.orderCount,
      avgUnitPriceCents: row.avgUnitPriceCents,
    }))
    .sort((left, right) => (
      EXECUTIVE_METRICS[metric].grain === "line" && isTimeAxisDimension(dimension)
        ? left.key.localeCompare(right.key)
        : right.value - left.value
    ))
}

// ── Drill-down: the lines behind a bar ─────────────────────────────────────

export type DrillDownLine = {
  /** The order line itself — the only identity that is unique per row. */
  lineId: number
  orderId: number
  tid: string
  createdAt: string
  status: string
  branchId: number | null
  branchName: string
  requesterId: string | null
  requesterName: string
  productId: number | null
  productName: string
  categoryName: string
  unit: string
  quantity: number
  unitPriceCents: number
  valueCents: number
}

export type DrillDownResult = {
  rows: DrillDownLine[]
  totals: { lineCount: number; orderCount: number; valueCents: number; quantityByUnit: Array<{ unit: string; quantity: number }> }
  hasMore: boolean
}

/**
 * Net line value and quantity for a *single* row, rather than the summed
 * expressions above.
 *
 * The aggregate forms cannot be reused here because a listing selects one row
 * at a time; the arithmetic is deliberately identical — same refund join, same
 * `GREATEST(0, …)` floor, same rounding — so a drill-down always reconciles
 * with the bar it was opened from. A drill-down that did not add up to its own
 * chart would be worse than no drill-down at all.
 */
const rowNetValue = sql<number>`GREATEST(0, ROUND(${orderItems.priceCents} * ${orderItems.quantity}) - ${lineRefundValue})`
const rowNetQuantity = sql<number>`GREATEST(0, ${orderItems.quantity} - ${lineRefundQuantity})`

/** Sortable expressions, selected by an allowlisted key — never built from input. */
const DRILLDOWN_SORT_EXPRESSIONS: Record<DrillDownSortKey, any> = {
  date: orders.createdAt,
  value: rowNetValue,
  quantity: rowNetQuantity,
  unitPrice: orderItems.priceCents,
  branch: branches.name,
  requester: sql`COALESCE(NULLIF(TRIM(${users.fullName}), ''), ${users.employeeId}, ${users.email})`,
  product: orderItems.productName,
}

/**
 * The order lines behind one clicked bar, point or slice.
 *
 * Always line grain, whatever the chart was drawn at. A bar of order-grain
 * money opened at order grain would list whole orders and their whole totals,
 * which is the same 5.7x overstatement `resolveGrain` already guards against
 * for the chart itself — so the detail is the lines, and the money column is
 * each line's own net value.
 *
 * The fence is `lineConditions`, the same one every other builder here uses, so
 * this listing can only ever name rows the caller could already see in
 * aggregate.
 */
export async function loadDrillDownLines(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  options: { sort?: DrillDownSortKey; direction?: "asc" | "desc"; limit: number; offset: number },
): Promise<DrillDownResult> {
  const conditions = lineConditions(scope, filters)
  const sortKey = resolveDrillDownSort(options.sort)
  const sortExpression = DRILLDOWN_SORT_EXPRESSIONS[sortKey]
  const direction = options.direction === "asc" ? asc : desc

  const [rows, [totals], units] = await Promise.all([
    db
      .select({
        lineId: orderItems.id,
        orderId: orders.id,
        tid: orders.tid,
        createdAt: orders.createdAt,
        status: orders.status,
        branchId: orders.branchId,
        branchName: sql<string>`COALESCE(${branches.name}, 'Unassigned')`,
        requesterId: orders.createdByUserId,
        requesterName: sql<string>`COALESCE(NULLIF(TRIM(${users.fullName}), ''), ${users.employeeId}, ${users.email}, 'Unknown')`,
        productId: orderItems.globalProductId,
        productName: orderItems.productName,
        categoryName: sql<string>`COALESCE(COALESCE(${parentCategories.name}, ${categories.name}), 'Uncategorized')`,
        unit: orderItems.unit,
        quantity: rowNetQuantity,
        unitPriceCents: orderItems.priceCents,
        valueCents: rowNetValue,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .leftJoin(users, eq(orders.createdByUserId, users.id))
      .leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
      .leftJoin(categories, eq(globalProducts.categoryId, categories.id))
      .leftJoin(parentCategories, eq(categories.parentId, parentCategories.id))
      .where(and(...conditions))
      // The id breaks ties, so paging cannot repeat or skip a row when many
      // lines share a timestamp — which they do, since one order writes all of
      // its lines at once.
      .orderBy(direction(sortExpression), desc(orderItems.id))
      // One row past the page, so "there is more" needs no second count query.
      .limit(options.limit + 1)
      .offset(options.offset),

    db
      .select({
        lineCount: sql<number>`COUNT(*)`.mapWith(Number),
        orderCount: sql<number>`COUNT(DISTINCT ${orders.id})`.mapWith(Number),
        valueCents: lineNetValue,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(and(...conditions)),

    // Quantity is reported per unit rather than as one total: litres and packs
    // are not addable, and a drill-down must not invent a number the charts
    // above it refuse to print.
    db
      .select({ unit: orderItems.unit, quantity: lineNetQuantity })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(and(...conditions))
      .groupBy(orderItems.unit)
      .orderBy(desc(lineNetQuantity))
      .limit(8),
  ])

  const page = rows.slice(0, options.limit)

  return {
    hasMore: rows.length > options.limit,
    totals: {
      lineCount: Number(totals?.lineCount) || 0,
      orderCount: Number(totals?.orderCount) || 0,
      valueCents: Number(totals?.valueCents) || 0,
      quantityByUnit: units.map((row) => ({ unit: String(row.unit), quantity: Number(row.quantity) || 0 })),
    },
    rows: page.map((row) => ({
      lineId: Number(row.lineId),
      orderId: Number(row.orderId),
      tid: String(row.tid),
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : "",
      status: String(row.status),
      branchId: row.branchId ?? null,
      branchName: String(row.branchName),
      requesterId: row.requesterId ?? null,
      requesterName: String(row.requesterName),
      productId: row.productId ?? null,
      productName: String(row.productName),
      categoryName: String(row.categoryName),
      unit: String(row.unit),
      quantity: Number(row.quantity) || 0,
      unitPriceCents: Number(row.unitPriceCents) || 0,
      valueCents: Number(row.valueCents) || 0,
    })),
  }
}
