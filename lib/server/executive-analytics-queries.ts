import "server-only"

import { and, asc, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { branches, budgets, categories, globalProducts, groups, orderItems, orders, organizations, users } from "@/db/schema"
import { db } from "@/lib/db"
import { buildAppMonthPeriods } from "@/lib/date-range-params"
import { CONSUMED_ELIGIBLE_FILTER, REVENUE_ELIGIBLE_FILTER } from "@/lib/metric-utils"
import { consumedHeldCentsSql, consumedSpentCentsSql, netOrderCentsSql } from "@/lib/server/budget-consumption-sql"
import { budgetEnabledBranchSql, budgetTrackedOrderSql } from "@/lib/server/organization-budget-policy"
import type { ExecutiveScope } from "@/lib/server/executive-analytics-scope"
import {
  MAX_TIME_AXIS_POINTS,
  isBudgetRollupDimension,
  isTimeAxisDimension,
  metricDefinitionForStatusSet,
  orderComparisonRows,
  resolveDrillDownSort,
  resolveGrain,
  resolveMatrixGrain,
  safeDivide,
  type BudgetBesideDimension,
  type DrillDownSortKey,
  type DrillDownStatusSet,
  type ExecutiveDimensionId,
  type ExecutiveMetricId,
  type MatrixDimensionId,
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
  /**
   * Which orders count. Absent or `revenue` is the Center's default rule;
   * `consumed` adds PENDING so Product Performance and budget details reconcile
   * with a budget's "spent + held".
   */
  statusSet?: DrillDownStatusSet
}

/** The status predicate a filter set asks for; the revenue rule unless told otherwise. */
function statusFilterFor(filters: Pick<ExecutiveFilters, "statusSet">) {
  return filters.statusSet === "consumed" ? CONSUMED_ELIGIBLE_FILTER : REVENUE_ELIGIBLE_FILTER
}

/**
 * Whole-order value and count after `orderConditions` has selected the status
 * population. Keeping status out of these expressions is what lets the same
 * builders answer revenue and consumed requests without pending rows being
 * selected by WHERE and then silently zeroed by a second revenue-only CASE.
 */
const filteredOrderNetValue = netOrderCentsSql()
const filteredOrderCount = sql<number>`COUNT(${orders.id})`.mapWith(Number)

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

/** Ordered item count, net of approved refunds, regardless of each line's unit label. */
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

  if (options?.revenueEligible !== false) conditions.push(statusFilterFor(filters))

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
    statusFilterFor(filters),
    ...lineFilterConditions(filters),
  ]
}

// ── Budget ─────────────────────────────────────────────────────────────────

export type BranchBudgetRow = {
  branchId: number
  branchName: string
  /**
   * False when the branch's organization has budget allocation switched off.
   * Every figure on such a row is zero: the tenant has no budget to report,
   * and its kept ledger rows are not a live one.
   */
  budgetTracked: boolean
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
 * honestly. The statuses and the refund netting come from
 * `lib/server/budget-consumption-sql.ts`, which is also what
 * `app/api/v1/analytics/budgets/summary/route.ts` uses when a range is
 * supplied — one rule, so the two reports cannot disagree.
 */
/**
 * The caller's fence, as predicates on `branches` — for the readers that start
 * from the branch table rather than from an order. One definition, so the
 * ledger, the branch picker and the month budget can never disagree about
 * which branches exist for this caller.
 */
function scopedBranchFence(scope: ExecutiveScope) {
  return [
    scope.branchIds ? inArray(branches.id, scope.branchIds) : undefined,
    scope.organizationIds.length > 0 ? inArray(branches.organizationId, scope.organizationIds) : undefined,
  ].filter(Boolean)
}

export async function loadBranchBudgets(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
): Promise<BranchBudgetRow[]> {
  const periods = buildAppMonthPeriods(filters.startDate, filters.endDate)
  if (periods.length === 0) return []

  const branchFence = scopedBranchFence(scope)

  const branchRows = await db
    .select({
      id: branches.id,
      name: branches.name,
      budgetTracked: sql<boolean>`${budgetEnabledBranchSql()}`,
    })
    .from(branches)
    .where(branchFence.length > 0 ? and(...branchFence) : undefined)

  if (branchRows.length === 0) return []
  const trackedBranchIds = branchRows.filter((row) => row.budgetTracked === true).map((row) => row.id)

  // Neither the ledger nor the orders are read for a branch whose tenant has
  // budgets off, and only orders that took a hold count toward consumption —
  // a budget figure is compared with money that was actually charged to it.
  const [ledgerRows, orderRows] = trackedBranchIds.length === 0 ? [[], []] : await Promise.all([
    db
      .select({
        branchId: budgets.branchId,
        allocatedCents: sql<number>`COALESCE(SUM(${budgets.amountAllocatedCents}), 0)`.mapWith(Number),
        creditedCents: sql<number>`COALESCE(SUM(${budgets.amountCreditedCents}), 0)`.mapWith(Number),
      })
      .from(budgets)
      .where(and(inArray(budgets.branchId, trackedBranchIds), inArray(budgets.period, periods)))
      .groupBy(budgets.branchId),
    db
      .select({
        branchId: orders.branchId,
        spentCents: consumedSpentCentsSql(),
        heldCents: consumedHeldCentsSql(),
      })
      .from(orders)
      .where(and(
        ...orderConditions(scope, filters, { revenueEligible: false }),
        inArray(orders.branchId, trackedBranchIds),
        budgetTrackedOrderSql(),
      ))
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
      budgetTracked: branch.budgetTracked === true,
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
 *
 * `created_at` is `timestamptz`, so one `AT TIME ZONE 'Asia/Karachi'` yields
 * the Karachi wall-clock time whatever the session zone is. The double form
 * other analytics routes use — `(x AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Karachi'`
 * — is the conversion for a column *without* a zone: applied to this one it
 * reads the UTC wall time as Karachi's and converts back, landing ten hours
 * behind Karachi on a UTC session. That filed an order placed at 08:00 on the
 * 1st under the previous month, outside the range the reader had chosen.
 */
const APP_LOCAL_CREATED_AT = sql`(${orders.createdAt} AT TIME ZONE 'Asia/Karachi')`

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
      spendCents: filteredOrderNetValue,
      orderCount: filteredOrderCount,
    })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .leftJoin(groups, eq(branches.groupId, groups.id))
    .leftJoin(organizations, eq(orders.organizationId, organizations.id))
    .leftJoin(users, eq(orders.createdByUserId, users.id))
    .where(and(...orderConditions(scope, filters)))
    .groupBy(...column.group)
    .orderBy(isTimeAxisDimension(dimension) ? asc(column.key) : desc(filteredOrderNetValue))
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

/** The map key `loadLineQuantities` files a quantity under: the entity, and its month when asked. */
export function lineQuantityKey(key: string, period?: string): string {
  return period === undefined ? key : `${key}|${period}`
}

/**
 * Line-grain quantity for entities an order-grain read has already ranked.
 *
 * An order-grain row is a whole order's money and knows nothing of the lines
 * inside it, so it carries no quantity of its own. Product Performance prints
 * both figures over every column, so the quantity is read here — at line grain,
 * under the same fence and status population (`lineConditions`), and pinned to
 * the keys the ranking returned, so the read is bounded by them and can never
 * add an entity the ranking did not name. Quantity is the count entered on each
 * line, net of approved refunds, whatever its unit label: the same figure a
 * line-grain row of the same dimension reports.
 */
export async function loadLineQuantities(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  dimension: OrderGrainDimension,
  keys: string[],
  options?: { byMonth?: boolean },
): Promise<Map<string, number>> {
  if (keys.length === 0) return new Map()
  const column = lineDimensionColumns[dimension]
  const monthKey = sql<string>`TO_CHAR(${APP_LOCAL_CREATED_AT}, 'YYYY-MM')`
  const byMonth = options?.byMonth === true
  const rows = await db
    .select({
      key: column.key,
      period: byMonth ? monthKey : sql<string>`NULL`,
      quantity: lineNetQuantity,
    })
    .from(orderItems)
    .innerJoin(orders, eq(orderItems.orderId, orders.id))
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .leftJoin(groups, eq(branches.groupId, groups.id))
    .leftJoin(organizations, eq(orders.organizationId, organizations.id))
    .leftJoin(users, eq(orders.createdByUserId, users.id))
    .where(and(...lineConditions(scope, filters), inArray(column.key, keys)))
    .groupBy(...column.group, ...(byMonth ? [monthKey] : []))

  return new Map(rows.map((row) => [
    lineQuantityKey(String(row.key), byMonth ? String(row.period) : undefined),
    Number(row.quantity) || 0,
  ]))
}

/** Which units are in scope for metrics, such as average unit price, that require one denominator. */
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
      budgetTracked: false,
      allocatedCents: 0,
      creditedCents: 0,
      totalBudgetCents: 0,
      spentCents: 0,
      heldCents: 0,
      consumedCents: 0,
      remainingCents: 0,
    }
    bucket.budgetTracked = bucket.budgetTracked || row.budgetTracked
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

// ── Budget beside the bars ─────────────────────────────────────────────────

/**
 * Total Budget per month across the fenced branches: allocated + add-ons for
 * every `YYYY-MM` the window touches, keyed by the ledger's own `period` —
 * the same string the month comparison keys its rows with, so the two join
 * on it directly.
 *
 * Fenced through `branches`, exactly as `loadBranchBudgets` is, so a month's
 * figure is the sum of the same rows the Overview's per-branch chart draws.
 */
async function loadMonthBudgets(scope: ExecutiveScope, filters: ExecutiveFilters): Promise<Map<string, number>> {
  const periods = buildAppMonthPeriods(filters.startDate, filters.endDate)
  if (periods.length === 0) return new Map()

  const rows = await db
    .select({
      period: budgets.period,
      totalBudgetCents: sql<number>`COALESCE(SUM(${budgets.amountAllocatedCents} + ${budgets.amountCreditedCents}), 0)`.mapWith(Number),
    })
    .from(budgets)
    .innerJoin(branches, eq(budgets.branchId, branches.id))
    .where(and(inArray(budgets.period, periods), ...scopedBranchFence(scope), budgetEnabledBranchSql()))
    .groupBy(budgets.period)

  return new Map(rows.map((row) => [row.period, row.totalBudgetCents]))
}

/**
 * Total Budget per requester: the budget of each branch their counted orders
 * in the window were placed at, summed over those branches.
 *
 * "Their branch" is read from the orders, never from `users.branch_id`, so a
 * group requester ordering for three branches stands beside those three, and
 * a person moved since stands beside the branch the money came from. The
 * pairs come from the same conditions as the comparison itself, so a branch
 * appears only where the bar beside it has orders there. Each branch's figure
 * is the "By branch" panel's own (`loadBudgetRollup`), so the two agree.
 */
async function loadRequesterBudgets(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  userIds: string[],
): Promise<Map<string, number>> {
  if (userIds.length === 0) return new Map()

  const [pairs, branchBudgets] = await Promise.all([
    db
      .selectDistinct({ userId: orders.createdByUserId, branchId: orders.branchId })
      .from(orders)
      .where(and(...orderConditions(scope, filters), inArray(orders.createdByUserId, userIds))),
    loadBudgetRollup(scope, filters, "branch"),
  ])

  const budgetOfBranch = new Map(branchBudgets.map((row) => [row.branchId, row.totalBudgetCents]))
  const budgetOfUser = new Map<string, number>()
  for (const pair of pairs) {
    if (!pair.userId || pair.branchId === null) continue
    budgetOfUser.set(pair.userId, (budgetOfUser.get(pair.userId) ?? 0) + (budgetOfBranch.get(pair.branchId) ?? 0))
  }
  return budgetOfUser
}

/**
 * Sets each entity's Total Budget beside its ranked figure.
 *
 * A branch, group or tenant takes the rollup the Overview is built from, so
 * the budget beside a bar is the same number as the budget on the Overview's
 * chart for the same window. A requester takes the budget of the branches
 * they ordered at (`loadRequesterBudgets`). A month takes the ledger summed by
 * period over the fenced branches.
 *
 * The month axis is also **filled**: a month inside the window that nobody
 * ordered in has no row from the order read, but a budget it was given is
 * exactly what the chart should show against an empty column, so a zero row
 * is added for it. Ranked dimensions are not filled — a branch with a budget
 * and no orders is the Overview's business; here the question is still which
 * branches consumed the most.
 *
 * Whether a budget *may* stand beside this comparison at all is decided by
 * `canShowBudgetBeside` before this is called; this only fetches and joins.
 */
export async function attachBudgetBeside(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  dimension: BudgetBesideDimension,
  rows: ComparisonRow[],
): Promise<ComparisonRow[]> {
  if (isBudgetRollupDimension(dimension)) {
    const rollup = await loadBudgetRollup(scope, filters, dimension)
    const budgetOf = new Map(rollup.map((row) => [row.key, row.totalBudgetCents]))
    return rows.map((row) => ({ ...row, totalBudgetCents: budgetOf.get(row.key) ?? 0 }))
  }

  if (dimension === "user") {
    const budgetOf = await loadRequesterBudgets(scope, filters, rows.map((row) => row.key))
    return rows.map((row) => ({ ...row, totalBudgetCents: budgetOf.get(row.key) ?? 0 }))
  }

  const budgetOf = await loadMonthBudgets(scope, filters)
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const filled = buildAppMonthPeriods(filters.startDate, filters.endDate).map((period) => {
    const existing = byKey.get(period)
    return existing
      ? { ...existing, totalBudgetCents: budgetOf.get(period) ?? 0 }
      : {
        key: period,
        label: period,
        value: 0,
        spendCents: 0,
        quantity: 0,
        orderCount: 0,
        avgUnitPriceCents: 0,
        totalBudgetCents: budgetOf.get(period) ?? 0,
      }
  })
  // The same cap and the same order the month read itself applies.
  return orderComparisonRows(filled, dimension).slice(0, MAX_TIME_AXIS_POINTS.month)
}

// ── Entity options ─────────────────────────────────────────────────────────

export type EntityOption = { key: string; label: string; hint?: string }

/** Branch rows inside the fence, shared by the picker and the label lookups. */
async function loadScopedBranchRows(scope: ExecutiveScope) {
  const conditions = scopedBranchFence(scope)
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
    ...ownSelection[dimension],
    // Listing what exists must not depend on which unit is being measured.
    unit: null,
  }
  // The legacy pickers list every requester/group that raised an order. A
  // consumed picker is tighter: cancelled, rejected, and refunded-only activity
  // cannot produce a figure and therefore must not be offered as one.
  const optionOrderConditions = () => filters.statusSet === "consumed"
    ? orderConditions(scope, unfiltered)
    : orderConditions(scope, unfiltered, { revenueEligible: false })

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
      .where(and(...optionOrderConditions()))
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
      .where(and(...optionOrderConditions()))
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

/**
 * One bucket of one line. `quantity` and `spendCents` ride along with the drawn
 * `value` whichever measure is selected, so a point can be read as both.
 */
export type SeriesPoint = { period: string; value: number; quantity: number; spendCents: number }
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

  // A time-axis series is drawn straight from the ranked rows, so only that
  // form needs them to carry their quantity.
  const ranked = await loadComparison(scope, filters, dimension, metric, limit, {
    withQuantity: isTimeAxisDimension(dimension),
  })
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
        label: metricDefinitionForStatusSet(metric, filters.statusSet).label,
        points: chronological.map((row) => ({
          period: row.key,
          value: row.value,
          quantity: row.quantity,
          spendCents: row.spendCents,
        })),
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
        valueCents: filteredOrderNetValue,
        quantity: sql<number>`0`.mapWith(Number),
        orderCount: filteredOrderCount,
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

  // Order-grain rows carry no quantity; read it from the lines, per entity and
  // month, for exactly the entities being drawn.
  const orderQuantities = grain === "line"
    ? null
    : await loadLineQuantities(scope, filters, dimension as OrderGrainDimension, Array.from(wanted.keys()), { byMonth: true })

  const byEntity = new Map<string, Map<string, SeriesPoint>>()
  for (const row of rows) {
    const key = String(row.key)
    if (!wanted.has(key)) continue
    const period = String(row.period)
    const points = byEntity.get(key) ?? new Map<string, SeriesPoint>()
    points.set(period, {
      period,
      value: valueOf(row),
      quantity: orderQuantities
        ? orderQuantities.get(lineQuantityKey(key, period)) ?? 0
        : Number(row.quantity) || 0,
      spendCents: Number(row.valueCents) || 0,
    })
    byEntity.set(key, points)
  }

  return {
    periods,
    series: ranked.map((entity) => ({
      key: entity.key,
      label: entity.label,
      points: periods.map((period) => (
        byEntity.get(entity.key)?.get(period) ?? { period, value: 0, quantity: 0, spendCents: 0 }
      )),
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
  /**
   * `withQuantity` fills `quantity` on order-grain rows, which otherwise report
   * none, at the cost of one more bounded read. Asked for only where the rows
   * are drawn — not for a prior window or a grid's axis ranking, which read
   * `value` alone.
   */
  options?: { withQuantity?: boolean },
): Promise<ComparisonRow[]> {
  const grain = resolveGrain(dimension, metric, { lineScoped: isLineScoped(filters) })

  if (grain === "budget") {
    // The registry only pairs budget metrics with budget-bearing dimensions, so
    // this cast is checked by `isSupportedCombination` before we get here.
    const rows = await loadBudgetRollup(scope, filters, dimension as "branch" | "group" | "organization")
    // A budget metric ranks only entities that have a budget to measure: an
    // organization with budget allocation off would otherwise rank as a real
    // zero remaining, or zero utilization, beside ones that hold budgets.
    return rows
      .filter((row) => row.budgetTracked)
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
    const quantities = options?.withQuantity
      ? await loadLineQuantities(scope, filters, dimension as OrderGrainDimension, rows.map((row) => row.key))
      : null
    return rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: metric === "orders"
        ? row.orderCount
        : metric === "avgOrderValue" ? row.avgOrderValueCents : row.spendCents,
      spendCents: row.spendCents,
      quantity: quantities?.get(lineQuantityKey(row.key)) ?? 0,
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

  return orderComparisonRows(
    rows.map((row) => ({
      key: row.key,
      label: row.label,
      value: valueOf(row),
      spendCents: row.valueCents,
      quantity: row.quantity,
      orderCount: row.orderCount,
      avgUnitPriceCents: row.avgUnitPriceCents,
    })),
    dimension,
  )
}

// ── The grid: one figure per (row, column) pair ────────────────────────────

export type MatrixAxisEntity = { key: string; label: string; total: number }
export type MatrixPairCell = {
  row: string
  column: string
  value: number
  spendCents: number
  quantity: number
  orderCount: number
}
export type MatrixResult = {
  rows: MatrixAxisEntity[]
  columns: MatrixAxisEntity[]
  cells: MatrixPairCell[]
}

/** A UUID as `users.id` holds it; the user dimension's keys are these. */
const UUID_KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The ranked keys of one axis, as the ids the cell query can bind.
 *
 * A key that is not an id — the `uncategorized` a category row gets when a
 * product has none, or the text of a null product id — is dropped from the
 * grid rather than matched loosely. Both are bound as parameters; the
 * shape check here is only so Postgres does not raise on a malformed UUID.
 */
function matrixAxisIds(dimension: MatrixDimensionId, keys: string[]): { uuids: string[]; ids: number[] } {
  if (dimension === "user") return { uuids: keys.filter((key) => UUID_KEY.test(key)), ids: [] }
  // Only a key that is the canonical text of a positive integer, so the id
  // pinned in SQL is exactly the key the margin will be labelled with.
  const ids = keys
    .map(Number)
    .filter((id, index) => Number.isInteger(id) && id > 0 && String(id) === keys[index])
  return { uuids: [], ids }
}

/**
 * The predicate that pins one axis to its ranked members. Every one of these
 * names a column the cell query has joined at either grain: `orders.*` is the
 * root or the first join, and `order_items.*` only appears for the two
 * dimensions that force line grain.
 */
function matrixAxisCondition(dimension: MatrixDimensionId, axis: { uuids: string[]; ids: number[] }) {
  switch (dimension) {
    case "user": return inArray(orders.createdByUserId, axis.uuids)
    case "branch": return inArray(orders.branchId, axis.ids)
    case "product": return inArray(orderItems.globalProductId, axis.ids)
    case "category": return categoryProductFilter(axis.ids)
  }
}

/**
 * Requester against product, uncombined — or any two grid dimensions.
 *
 * Three fenced reads. The two axes are ranked first with the same
 * `loadComparison` the single-dimension panels use, so the grid's margins are
 * *exactly* the bars of "By requester" and "By product" under the same
 * filters, and every panel on the screen reconciles with every other by
 * construction. Only then is one grouped read made for the cells, pinned to
 * the ranked members on both sides — so it can return at most
 * `limit × limit` rows whatever the tenant's size, and never a pair the
 * margins do not name.
 *
 * The cells run at the grain the pair forces (`resolveMatrixGrain`), rooted at
 * `order_items` the moment a product or category is on either axis, so a cell
 * of money is that product's own lines and not the whole of every order that
 * happened to contain it. For the `orders` metric the cells are distinct order
 * counts per pair and do not sum to their margin: one order holding two
 * products is one order in each cell and one order in the row.
 */
export async function loadMatrix(
  scope: ExecutiveScope,
  filters: ExecutiveFilters,
  rows: MatrixDimensionId,
  columns: MatrixDimensionId,
  metric: ExecutiveMetricId,
  limit: number,
): Promise<MatrixResult> {
  const [rankedRows, rankedColumns] = await Promise.all([
    loadComparison(scope, filters, rows, metric, limit),
    loadComparison(scope, filters, columns, metric, limit),
  ])

  const rowAxis = matrixAxisIds(rows, rankedRows.map((entity) => entity.key))
  const columnAxis = matrixAxisIds(columns, rankedColumns.map((entity) => entity.key))
  const pinnable = (axis: { uuids: string[]; ids: number[] }) => new Set([...axis.uuids, ...axis.ids.map(String)])
  const rowKeys = pinnable(rowAxis)
  const columnKeys = pinnable(columnAxis)

  const toEntity = (entity: ComparisonRow): MatrixAxisEntity => ({ key: entity.key, label: entity.label, total: entity.value })
  const axisRows = rankedRows.filter((entity) => rowKeys.has(entity.key)).map(toEntity)
  const axisColumns = rankedColumns.filter((entity) => columnKeys.has(entity.key)).map(toEntity)
  if (axisRows.length === 0 || axisColumns.length === 0) return { rows: axisRows, columns: axisColumns, cells: [] }

  const grain = resolveMatrixGrain(rows, columns, metric, { lineScoped: isLineScoped(filters) })
  const pinned = [matrixAxisCondition(rows, rowAxis), matrixAxisCondition(columns, columnAxis)]

  const cellRows = grain === "line"
    ? await db
      .select({
        row: lineDimensionColumns[rows].key,
        column: lineDimensionColumns[columns].key,
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
      .where(and(...lineConditions(scope, filters), ...pinned))
      .groupBy(...lineDimensionColumns[rows].group, ...lineDimensionColumns[columns].group)
    : await db
      .select({
        // Order grain is only reached when neither axis is a product or a
        // category (`resolveMatrixGrain`), so both are order-grain dimensions.
        row: orderDimensionColumns[rows as OrderGrainDimension].key,
        column: orderDimensionColumns[columns as OrderGrainDimension].key,
        valueCents: filteredOrderNetValue,
        quantity: sql<number>`0`.mapWith(Number),
        orderCount: filteredOrderCount,
      })
      .from(orders)
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .leftJoin(groups, eq(branches.groupId, groups.id))
      .leftJoin(organizations, eq(orders.organizationId, organizations.id))
      .leftJoin(users, eq(orders.createdByUserId, users.id))
      .where(and(...orderConditions(scope, filters), ...pinned))
      .groupBy(
        ...orderDimensionColumns[rows as OrderGrainDimension].group,
        ...orderDimensionColumns[columns as OrderGrainDimension].group,
      )

  const valueOf = (cell: { valueCents: unknown; quantity: unknown; orderCount: unknown }) => {
    const value = Number(cell.valueCents) || 0
    const quantity = Number(cell.quantity) || 0
    const orderCount = Number(cell.orderCount) || 0
    switch (metric) {
      case "quantity": return quantity
      case "orders": return orderCount
      case "avgUnitPrice": return Math.round(safeDivide(value, quantity))
      default: return value
    }
  }

  const cells = cellRows
    .map((cell) => ({
      row: String(cell.row),
      column: String(cell.column),
      value: valueOf(cell),
      spendCents: Number(cell.valueCents) || 0,
      quantity: Number(cell.quantity) || 0,
      orderCount: Number(cell.orderCount) || 0,
    }))
    // The predicates already pin both sides; this only drops a row whose key
    // rendered differently from its id (it cannot, but the grid must never
    // show a cell its margins do not name).
    .filter((cell) => rowKeys.has(cell.row) && columnKeys.has(cell.column))

  return { rows: axisRows, columns: axisColumns, cells }
}

// ── Drill-down: the lines behind a bar ─────────────────────────────────────

export type DrillDownLine = {
  /** The order line itself — the only identity that is unique per row. */
  lineId: number
  orderId: number
  tid: string
  createdAt: string
  status: string
  /** UNPAID / PAID — the order's, so every line of one order carries the same. */
  paymentStatus: string
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
  totals: { lineCount: number; orderCount: number; valueCents: number; quantity: number; quantityByUnit: Array<{ unit: string; quantity: number }> }
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
        paymentStatus: orders.paymentStatus,
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
        quantity: lineNetQuantity,
      })
      .from(orderItems)
      .innerJoin(orders, eq(orderItems.orderId, orders.id))
      .where(and(...conditions)),

    // Keep the per-unit breakdown in the API for line-level auditing. The
    // primary `totals.quantity` above is the raw ordered count used by charts.
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
      quantity: Number(totals?.quantity) || 0,
      quantityByUnit: units.map((row) => ({ unit: String(row.unit), quantity: Number(row.quantity) || 0 })),
    },
    rows: page.map((row) => ({
      lineId: Number(row.lineId),
      orderId: Number(row.orderId),
      tid: String(row.tid),
      createdAt: row.createdAt ? new Date(row.createdAt).toISOString() : "",
      status: String(row.status),
      paymentStatus: String(row.paymentStatus),
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
