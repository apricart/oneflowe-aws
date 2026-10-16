import { VIEWER_READ_REFUSED, viewerReadRole } from "@/lib/viewer-access"
import { NextRequest,NextResponse } from "next/server"
import { createHash,randomBytes } from "node:crypto"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { budgets,orders,orderItems,organizationInventory,branchInventory,branches,globalProducts,productQuantityBudgets,refunds,systemLogs,groupAuditLogs,organizations,refundItems,groups,legacyOrderImports } from "@/db/schema"
import { headers } from "next/headers"
import { and,desc,eq,gte,ilike,lte,or,sql,inArray,isNotNull,isNull,type AnyColumn,type SQL } from "drizzle-orm"
import { logOrderActivity } from "@/lib/global-logger"
import { generateReceiptData } from "@/lib/receipt-generator"
import {
  assignInvoiceNumberAtCreation,
  isInvoiceCodeMissingError,
  hasInvoiceSequenceTable,
} from "@/lib/invoice-number"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { parseEndDateParam,parseStartDateParam } from "@/lib/date-range-params"
import { getBudgetAllocationModeForOrganization } from "@/lib/server/budget-allocation-mode"
import { isOrganizationBudgetEnabled, resolveOrderBudgetTracking } from "@/lib/server/organization-budget-policy"
import { BUDGET_POLICY_CHANGED_MESSAGE } from "@/lib/organization-budget-policy"
import { settleDueAddonsOnBudget,settleDueBudgetAddons } from "@/lib/server/budget-addon-expiry"
import { assertBranchMayOrder } from "@/lib/server/payment-control"
import { isPaymentControlBlockedError } from "@/lib/payment-control-policy"
import { assertBranchDeliveriesAcknowledged } from "@/lib/server/unacknowledged-delivery-block"
import { isDeliveryAcknowledgementBlockedError } from "@/lib/unacknowledged-delivery-block"
import { orderSelectColumns } from "@/lib/order-select"
import { calculateLineCents,formatQuantity,roundQuantity,validateProductQuantity } from "@/lib/quantity"
import { resolveTaxRateBp,splitInclusiveCents } from "@/lib/tax"
import { getOrganizationTaxRateBp } from "@/lib/server/tax-rate"
import { orderCreateSchema,validationMessage } from "@/lib/server/mutation-validation"
import { withRateLimit } from "@/lib/rate-limiter"
import {
  attemptImmediateOrderEmailDelivery,
  queueOrderCreatedNotifications as enqueueCreatedOrderEvents,
  queueSuperAdminAutoApprovalNotifications as enqueueAutoApprovedOrderEvents,
} from "@/lib/server/order-notifications"
import { queueWarehouseOrderNotifications } from "@/lib/server/warehouse-order-notifications"
import { canViewFulfillmentToken } from "@/lib/fulfillment-token-access"
import { getOrderDecisionCapabilities } from "@/lib/server/order-decision-policy"
import { resolveInitialOrderApproval } from "@/lib/server/order-creation-approval"
import {
  isApprovalLevelUnavailableError,
  levelledViewFlags,
  loadLevelledViewContext,
  resolveOrderApprovalLevel,
} from "@/lib/server/order-approval-routing"
import { resolveScopedBranchIds,usesMultiBranchScope } from "@/lib/server/multi-branch-scope"
import { loadGroupPriceOverrides,resolveBranchGroupId,resolveEffectivePriceCents } from "@/lib/server/effective-price"
import { isValidRole } from "@/lib/rbac"
import { metricExpressions } from "@/lib/metric-utils"
import { getOrderStatusesForFilter,getOrderStatusFilter } from "@/lib/order-status"
import { budgetPeriodOf } from "@/lib/budget-consumption"
import { isGroupPortalOrder,type OrderCreatorRole } from "@/lib/group-order-visibility"
import { parseOrderCreatorRoleFilter } from "@/lib/order-creator-filter"
import { orderCreatedByRoleMatches } from "@/lib/server/order-creator-role-sql"
import { viewerStatusBucketCondition,viewerStatusBucketCount } from "@/lib/server/order-delivery-status-sql"
import { parseOrderDeliveryFilter,type OrderDeliveryFilter } from "@/lib/unacknowledged-orders"
import { parseFulfillmentStatusFilter,type FulfillmentStatus } from "@/lib/fulfillment-status"
import { parseInvoiceStatusFilter,type InvoiceStatus } from "@/lib/invoice-status"
import { invoiceStatusSortSql,invoiceStatusSql } from "@/lib/server/invoice-status-sql"
import { loadApprovedDeliveryAddress } from "@/lib/server/delivery-addresses"
import { DELIVERY_ADDRESS_UNAVAILABLE } from "@/lib/delivery-address"
import { ORDER_LIST_PRICE_SORT_KEYS,ORDER_LIST_SORT_KEYS,sortKeysForCaller,type OrderListSortKey } from "@/lib/list-sort-keys"
import { parseSortParams } from "@/lib/table-sort"
import { orderBySortSql } from "@/lib/server/sort-sql"
import { mayCreateOrder } from "@/lib/order-creation-access"
import { isOrderDeskRole, orderIntakeError } from "@/lib/order-desk-access"
import { isDeskEnteredOrder } from "@/lib/order-desk-approval"
import { isOrderDeskTarget } from "@/lib/server/order-desk-scope"
import { deskAttachmentRefusal } from "@/lib/server/order-desk-attachments"

/**
 * Thrown inside the creation transaction when an Order Desk user's grant to the
 * target branch — or the organization's managed flag — was withdrawn after the
 * pre-check. Answered with the same 403 as the pre-check.
 */
const ORDER_DESK_TARGET_UNAVAILABLE = "You are not assigned to order for this branch"

/**
 * The column each allowlisted Orders-table sort key orders by. Text compares
 * case-insensitively; the refund badge sorts none → partial → full without
 * reading the amount.
 */
const ORDER_LIST_SORT_SQL: Record<OrderListSortKey, SQL | AnyColumn> = {
  id: orders.id,
  tid: orders.tid,
  branch: sql`LOWER(${branches.name})`,
  costCenter: sql`LOWER(${branches.costCenterId})`,
  orderStatus: sql`UPPER(${orders.status})`,
  progress: orderSelectColumns.fulfillmentStatus,
  paymentStatus: orderSelectColumns.paymentStatus,
  refundStatus: sql`CASE
    WHEN UPPER(${orders.status}) = 'REFUNDED' THEN 2
    WHEN COALESCE(${orders.refundAmountCents}, 0) > 0 THEN 1
    ELSE 0
  END`,
  orderDate: orders.createdAt,
  approvalDate: orders.approvedAt,
  deliveryDate: orders.deliveredAt,
  invoiceStatus: invoiceStatusSortSql,
  amount: orders.totalCents,
}

/**
 * The ORDER BY for the list. Without a requested sort it keeps its
 * newest-first order; with one, the id tie-breaker keeps pages stable when many
 * rows share the sorted value. A price key is refused when prices are hidden.
 */
function resolveOrderListOrder(
  searchParams: URLSearchParams,
  pricesHidden: boolean,
): { ok: true; orderBy: SQL[] } | { ok: false; error: string } {
  const requested = parseSortParams(
    searchParams,
    sortKeysForCaller(ORDER_LIST_SORT_KEYS, ORDER_LIST_PRICE_SORT_KEYS, pricesHidden),
  )
  if (!requested.ok) return requested
  if (!requested.sort) return { ok: true, orderBy: [desc(orders.createdAt)] }
  return {
    ok: true,
    orderBy: [orderBySortSql(ORDER_LIST_SORT_SQL[requested.sort.key], requested.sort.direction), desc(orders.id)],
  }
}

/**
 * The list query parameters that are parsed rather than passed through: the
 * creator-role, delivery and fulfilment filters, and the sort. Parsed before
 * anything is built so a malformed value is refused rather than quietly
 * dropped, which would return more rows than the caller asked for.
 */
function parseOrderListQuery(
  params: ReturnType<typeof getOrderListParams>,
  pricesHidden: boolean,
):
  | {
    ok: true
    creatorRole: OrderCreatorRole | null
    deliveryFilter: OrderDeliveryFilter | null
    fulfillmentStatusFilter: FulfillmentStatus | null
    invoiceStatusFilter: InvoiceStatus | null
    orderBy: SQL[]
  }
  | { ok: false; error: string } {
  const creatorFilter = parseOrderCreatorRoleFilter(params.createdByRole)
  if (!creatorFilter.ok) return { ok: false, error: creatorFilter.message }
  const deliveryFilter = parseOrderDeliveryFilter(params.delivery)
  if (!deliveryFilter.ok) return { ok: false, error: deliveryFilter.message }
  const fulfillmentStatusFilter = parseFulfillmentStatusFilter(params.fulfillmentStatus)
  if (!fulfillmentStatusFilter.ok) return { ok: false, error: fulfillmentStatusFilter.message }
  const invoiceStatusFilter = parseInvoiceStatusFilter(params.invoiceStatus)
  if (!invoiceStatusFilter.ok) return { ok: false, error: invoiceStatusFilter.message }
  const listOrder = resolveOrderListOrder(params.searchParams, pricesHidden)
  if (!listOrder.ok) return listOrder
  return {
    ok: true,
    creatorRole: creatorFilter.role,
    deliveryFilter: deliveryFilter.filter,
    fulfillmentStatusFilter: fulfillmentStatusFilter.filter,
    invoiceStatusFilter: invoiceStatusFilter.filter,
    orderBy: listOrder.orderBy,
  }
}

function generateTid(): string {
  // Simple ULID-like: timestamp base36 + cryptographically secure random hex
  const ts = Date.now().toString(36)
  const rand = randomBytes(8).toString("hex")
  return (ts + rand).slice(0, 26)
}

function parseNumberList(value: string | undefined, minimum = -Infinity, maximum = Infinity) {
  return value
    ? value.split(",").map(Number).filter((number) => !Number.isNaN(number) && number >= minimum && number <= maximum)
    : []
}

function getOrderListParams(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const id = searchParams.get("id") || undefined
  const page = Math.min(Math.max(Math.trunc(Number(searchParams.get("page"))) || 1, 1), 10_000)
  const requestedLimit = Math.trunc(Number(searchParams.get("limit"))) || 200
  const limit = id ? 1 : Math.min(Math.max(requestedLimit, 1), 500)
  return {
    searchParams,
    rawStatus: searchParams.get("status") || undefined,
    branchId: searchParams.get("branchId") || undefined,
    branchIds: parseNumberList(searchParams.get("branchIds") || undefined),
    query: searchParams.get("q") || undefined,
    from: searchParams.get("from") || undefined,
    to: searchParams.get("to") || undefined,
    startDate: searchParams.get("startDate") || undefined,
    endDate: searchParams.get("endDate") || undefined,
    organizationId: searchParams.get("organizationId") || undefined,
    id,
    groupId: searchParams.get("groupId") || undefined,
    createdByRole: searchParams.get("createdByRole"),
    delivery: searchParams.get("delivery"),
    fulfillmentStatus: searchParams.get("fulfillmentStatus"),
    invoiceStatus: searchParams.get("invoiceStatus"),
    groupIds: parseNumberList(searchParams.get("groupIds") || undefined),
    months: parseNumberList(searchParams.get("months") || undefined, 1, 12),
    years: parseNumberList(searchParams.get("years") || undefined, 2000, 2100),
    page,
    limit,
    offset: id ? 0 : (page - 1) * limit,
  }
}

function addOrderSearchCondition(conditions: any[], query: string | undefined) {
  if (!query) return null
  const normalized = query.trim()
  if (normalized.length > 100) return "Search query must be at most 100 characters"
  if (!normalized) return null
  const escaped = normalized.replace(/[\\%_]/g, String.raw`\$&`)
  const searchConditions: any[] = [
    ilike(orders.tid, `%${escaped}%`),
    ilike(branches.costCenterId, `%${escaped}%`),
    sql`EXISTS (
      SELECT 1 FROM ${orderItems}
      WHERE ${orderItems.orderId} = ${orders.id}
      AND ${orderItems.productName} ILIKE ${("%" + String(escaped) + "%")}
    )`,
  ]
  const numericOrderId = Number(normalized)
  if (/^\d+$/.test(normalized) && Number.isSafeInteger(numericOrderId)) searchConditions.push(eq(orders.id, numericOrderId))
  conditions.push(or(...searchConditions))
  return null
}

// Matches no rows. Used wherever a role reaches the end of the scoping ladder
// without an explicit scope, so the absence of a filter can never mean "all".
const DENY_ALL_ORDERS = sql`false`

function addSuperAdminOrderScope(conditions: any[], organizationIdParam: unknown) {
  if (typeof organizationIdParam === "string" && /^\d+$/.test(organizationIdParam)) {
    conditions.push(eq(orders.organizationId, Number(organizationIdParam)))
  }
}

/**
 * Roles whose reach is a set of branches rather than one. The scope is resolved
 * from their assignments before the query runs; an empty set means no access,
 * never organization-wide access.
 */
function addMultiBranchOrderScope(conditions: any[], scopedBranchIds: unknown) {
  const branchIds: number[] = Array.isArray(scopedBranchIds) ? scopedBranchIds : []
  conditions.push(branchIds.length === 0 ? DENY_ALL_ORDERS : inArray(orders.branchId, branchIds))
}

function addOrderRoleConditions(conditions: any[], context: any) {
  const { role, organizationId: orgIdNum, branchId: branchIdFromUser, userId: currentUserId } = context
  if (role === "SUPER_ADMIN") {
    addSuperAdminOrderScope(conditions, context.organizationIdParam)
    return
  }

  conditions.push(typeof orgIdNum === "number"
    ? eq(orders.organizationId, orgIdNum)
    : DENY_ALL_ORDERS)
  if (role === "HEAD_OFFICE") return

  if (usesMultiBranchScope(role)) {
    addMultiBranchOrderScope(conditions, context.scopedBranchIds)
    return
  }

  // The requester reads the orders it raised itself, plus the orders the Group
  // Order Portal raised for its branch — those spend this branch's budget and
  // are delivered to it, so they belong in the branch's own history. The branch
  // pin below still applies to both halves, and `groupOrderId` is null on every
  // order created by any other flow, so no existing order changes hands.
  if (role === "ORDER_PORTAL" && currentUserId) {
    conditions.push(or(
      eq(orders.createdByUserId, currentUserId),
      isNotNull(orders.groupOrderId),
    ))
  }
  // Fail closed: any remaining role must be pinned to its own branch. Without
  // this a branch-less role would otherwise fall through to the whole tenant.
  conditions.push(typeof branchIdFromUser === "number"
    ? eq(orders.branchId, branchIdFromUser)
    : DENY_ALL_ORDERS)
}

function addOrderDimensionConditions(conditions: any[], params: ReturnType<typeof getOrderListParams>) {
  if (params.id && /^\d+$/.test(params.id)) conditions.push(eq(orders.id, Number(params.id)))
  if (params.branchIds.length > 0) conditions.push(inArray(orders.branchId, params.branchIds))
  else if (params.branchId && /^\d+$/.test(params.branchId)) conditions.push(eq(orders.branchId, Number(params.branchId)))
  if (params.groupIds.length > 0) conditions.push(inArray(branches.groupId, params.groupIds))
  else if (params.groupId && /^\d+$/.test(params.groupId)) conditions.push(eq(branches.groupId, Number(params.groupId)))
}

/**
 * Narrow the list to the orders one ordering role raised.
 *
 * The role name comes from a compile-time allowlist (`parseOrderCreatorRoleFilter`)
 * and is bound as a parameter, so nothing a caller sends reaches SQL. An order
 * with no creator matches nothing, which is what an absent `created_by_user_id`
 * should mean here.
 *
 * This is deliberately not a `groupOrderId` predicate: a group order is an
 * ordinary order of the branch's, and keying a query on that column is what
 * makes one disappear from the branch's own figures.
 */
function addOrderCreatorRoleCondition(conditions: any[], creatorRole: OrderCreatorRole | null) {
  if (!creatorRole) return
  // The role recorded on the order, not the creator's role today. A requester
  // who has since been promoted must not have their past orders vanish from
  // this tab. `orderCreatedByRoleMatches` falls back to the live join only for
  // rows written before the column existed.
  conditions.push(orderCreatedByRoleMatches(creatorRole))
}

function addOrderDateConditions(conditions: any[], params: ReturnType<typeof getOrderListParams>) {
  const start = params.startDate ? parseStartDateParam(params.startDate) : null
  const end = params.endDate ? parseEndDateParam(params.endDate) : null
  if (start) conditions.push(gte(orders.createdAt, start))
  if (end) conditions.push(lte(orders.createdAt, end))
  if (params.months.length > 0) conditions.push(sql`EXTRACT(MONTH FROM ${orders.createdAt}) IN (${sql.join(params.months, sql.raw(", "))})`)
  if (params.years.length > 0) conditions.push(sql`EXTRACT(YEAR FROM ${orders.createdAt}) IN (${sql.join(params.years, sql.raw(", "))})`)
  const legacyStart = params.from && !params.startDate ? parseStartDateParam(params.from) : null
  const legacyEnd = params.to && !params.endDate ? parseEndDateParam(params.to) : null
  if (legacyStart) conditions.push(gte(orders.createdAt, legacyStart))
  if (legacyEnd) conditions.push(lte(orders.createdAt, legacyEnd))
}

function auditOrderGroupAccess(params: ReturnType<typeof getOrderListParams>, context: any) {
  if (!params.groupId || !/^\d+$/.test(params.groupId)) return
  void db.insert(groupAuditLogs).values({
    organizationId: context.organizationId || 0,
    groupId: Number(params.groupId),
    action: "VIEW_GROUP_REPORT",
    performedByUserId: context.userId,
    performedByRole: context.role,
    metadata: { filters: Object.fromEntries(params.searchParams.entries()) },
  }).catch((error) => console.error("Audit log failed", error))
}

function sanitizeOrderListItems(items: any[], context: any) {
  return items.map((item) => {
    const canSeeToken = canViewFulfillmentToken({
      role: context.role,
      userId: context.userId,
      orderStatus: item.status,
      orderCreatedByUserId: item.createdByUserId,
      orderApprovedByUserId: item.approvedByUserId,
      configuredApproverRole: context.capabilities.orderApproverRole,
    })
    // Derived, read-only, and the same for every role: which rows came from a
    // Group Order Portal submission, and which the Order Desk entered — those
    // an Apricart Executive decides, never the tenant's approvers. The envelope
    // id and the creator's role themselves stay server-side.
    const {
      createdByUserId: _createdByUserId,
      createdByRole: _createdByRole,
      groupOrderId: _groupOrderId,
      ...publicItem
    } = item
    const withOrigin = {
      ...publicItem,
      placedByGroupPortal: isGroupPortalOrder(item),
      decidedByApricart: isDeskEnteredOrder(item),
      // The level the order waits at, and whether this reader may not decide
      // it because of it. Null and false for every organization without
      // levels (plans/OF-APPROVAL-LEVELS-route-orders-by-level.md, R10).
      ...levelledViewFlags(context.levelledView ?? null, item),
    }
    const safeItem = context.pricesHidden ? {
      ...withOrigin,
      subtotalCents: null,
      taxCents: null,
      totalCents: null,
      refundAmountCents: null,
    } : withOrigin
    return { ...safeItem, approvalToken: canSeeToken ? item.approvalToken : null }
  })
}

async function getSingleOrderListResponse(id: string | undefined, filtered: any[], context: any) {
  if (!id || !/^\d+$/.test(id) || !filtered[0]) return null
  const orderId = Number(id)
  const itemsData = await db.select({
    id: orderItems.id,
    productName: orderItems.productName,
    productCode: orderItems.productCode,
    quantity: orderItems.quantity,
    priceCents: orderItems.priceCents,
    unit: orderItems.unit,
    globalProductId: orderItems.globalProductId,
    organizationInventoryId: orderItems.organizationInventoryId,
    imageUrl: globalProducts.imageUrl,
    allowDecimalQuantity: globalProducts.allowDecimalQuantity,
    quantityStep: globalProducts.quantityStep,
    quantityRefunded: sql<number>`COALESCE((
      SELECT COALESCE(SUM(${refundItems.quantity}), 0)::numeric
      FROM ${refundItems} JOIN ${refunds} ON ${refundItems.refundId} = ${refunds.id}
      WHERE ${refundItems.orderItemId} = ${orderItems.id}
      AND UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')
    ), 0)`.mapWith(Number),
  }).from(orderItems).leftJoin(globalProducts, eq(orderItems.globalProductId, globalProducts.id))
    .where(eq(orderItems.orderId, orderId))
  const approvedRefunds = await db.select({ amount: refunds.amountCents }).from(refunds)
    .where(and(eq(refunds.orderId, orderId), sql`UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')`))
  const refundTotal = approvedRefunds.reduce((sum, refund) => sum + (refund.amount || 0), 0)
  return NextResponse.json({
    items: [{
      ...filtered[0],
      orderItems: context.pricesHidden ? itemsData.map((item) => ({ ...item, priceCents: null })) : itemsData,
      refundAmountCents: context.pricesHidden ? null : refundTotal,
      pricesHidden: context.pricesHidden,
    }],
    pricesHidden: context.pricesHidden,
    capabilities: context.capabilities,
  })
}

/**
 * Which rows a status tab returns. Applied after the summary snapshot, so a
 * selected tab narrows the list without zeroing the other cards.
 */
function addOrderStatusConditions(
  conditions: any[],
  statusFilter: ReturnType<typeof getOrderStatusFilter>,
  deliveryFilter: OrderDeliveryFilter | null,
  fulfillmentStatus: FulfillmentStatus | null,
  invoiceStatus: InvoiceStatus | null = null,
) {
  const requestedStatuses = getOrderStatusesForFilter(statusFilter)
  if (requestedStatuses.length > 0) {
    // Case-insensitive, like the summary cards (`metricExpressions`): the column
    // has no check constraint, so an exact match drops a row stored as
    // "Pending" that the card above it still counts.
    conditions.push(inArray(sql`UPPER(${orders.status})`, requestedStatuses))
  }
  // Delivered but not yet acknowledged — the dashboard's own bucket, so this
  // tab, its count and the "Delivered/Unacknowledged" card cannot disagree.
  if (deliveryFilter === "unacknowledged") {
    conditions.push(viewerStatusBucketCondition("DELIVERED_UNACKNOWLEDGED"))
  }
  if (fulfillmentStatus) {
    conditions.push(sql`UPPER(COALESCE(${orders.fulfillmentStatus}, 'NOT_STARTED')) = ${fulfillmentStatus}`)
  }
  // Derived on read (lib/invoice-status.ts), so it is filtered through the
  // same expression the list selects.
  if (invoiceStatus) {
    conditions.push(sql`${invoiceStatusSql} = ${invoiceStatus}`)
  }
}

function getOrderListSummaryTotal(statusFilter: string, summaryRow: any, deliveryFilter: OrderDeliveryFilter | null = null) {
  // Delivered-but-unacknowledged orders are all APPROVED, so this count is the
  // page total whether the caller also sent `status=approved` or not.
  if (deliveryFilter === "unacknowledged") return Number(summaryRow?.deliveredUnacknowledged || 0)
  return Number(statusFilter === "all" ? summaryRow?.all || 0 : summaryRow?.[statusFilter] || 0)
}

async function getOrderListPaginationTotal(input: {
  statusFilter: string
  summaryRow: any
  deliveryFilter: OrderDeliveryFilter | null
  fulfillmentStatus: FulfillmentStatus | null
  invoiceStatus: InvoiceStatus | null
  conditions: any[]
}) {
  const summaryTotal = Number(getOrderListSummaryTotal(
    input.statusFilter,
    input.summaryRow,
    input.deliveryFilter,
  ))
  // The summary cards do not count by fulfilment or invoice status, so either
  // filter needs its own count.
  if (!input.fulfillmentStatus && !input.invoiceStatus) return summaryTotal

  const { conditions } = input
  const listCondition = conditions.length ? and(...conditions) : undefined
  const [filteredTotal] = await db
    .select({ count: metricExpressions.totalOrderCount })
    .from(orders)
    .leftJoin(branches, eq(orders.branchId, branches.id))
    .where(listCondition)
  return Number(filteredTotal?.count || 0)
}

function parseScopedNumericId(value: unknown) {
  if (!value) return undefined
  if (typeof value !== "string" && typeof value !== "number") return undefined
  return /^\d+$/.test(String(value)) ? Number(value) : undefined
}

function getBudgetError(total: number, available: number, pricesHidden: boolean) {
  if (available < 0) return "Budget is in negative state. Please contact head office."
  if (total <= available) return null
  return pricesHidden
    ? "Insufficient budget. Please contact head office."
    : `Insufficient budget. Required: ${(total / 100).toFixed(2)} PKR, Available: ${(available / 100).toFixed(2)} PKR`
}

async function lockCreationMoneyBudget(tx: any, context: any) {
  // An add-on whose validity has passed is withdrawn under this same lock,
  // before the hold is taken, so it can never be spent whatever the page
  // showed a moment ago.
  await settleDueAddonsOnBudget(tx, context.budgetId, new Date(), { actorUserId: context.userId })
  const [budget] = await tx.select().from(budgets).where(eq(budgets.id, context.budgetId)).for('update')
  if (!budget) throw new Error(`Budget not configured for current month (${context.period})`)
  const lockedMoneyRemaining = budget.amountAllocatedCents + budget.amountCreditedCents - budget.amountSpentCents - budget.amountHeldCents
  const budgetError = getBudgetError(context.total, lockedMoneyRemaining, context.pricesHidden)
  if (budgetError) throw new Error(budgetError)
  return { budget, available: lockedMoneyRemaining }
}

async function lockCreationQuantityBudgets(tx: any, context: any) {
  if (context.mode !== "quantity") return new Map()
  const rows = await tx.select().from(productQuantityBudgets).where(and(
    eq(productQuantityBudgets.organizationId, context.organizationId),
    eq(productQuantityBudgets.branchId, context.branchId),
    eq(productQuantityBudgets.period, context.period),
    sql`(${productQuantityBudgets.allocatedQuantity} + ${productQuantityBudgets.creditedQuantity}) > 0`,
    inArray(productQuantityBudgets.organizationInventoryId, context.items.map((item: any) => item.organizationInventoryId)),
  )).for('update')
  const byInventory = new Map(rows.map((row: any) => [row.organizationInventoryId, row]))
  for (const item of context.items) {
    const quantityBudget: any = byInventory.get(item.organizationInventoryId)
    if (!quantityBudget) throw new Error(`Quantity budget is not allocated for ${item.productName}. Please select an allocated product.`)
    const remaining = quantityBudget.allocatedQuantity + quantityBudget.creditedQuantity
      - quantityBudget.usedQuantity - quantityBudget.heldQuantity
    if (remaining < 0) throw new Error(`Quantity budget for ${item.productName} is in negative state. Please contact head office.`)
    if (item.quantity > remaining) {
      throw new Error(`Insufficient quantity budget for ${item.productName}. Available: ${formatQuantity(remaining)}, Requested: ${formatQuantity(item.quantity)}`)
    }
  }
  return byInventory
}

async function lockCreationInventory(tx: any, context: any) {
  const assignments = await tx.select({ organizationInventoryId: branchInventory.organizationInventoryId })
    .from(branchInventory).where(and(
      eq(branchInventory.branchId, context.branchId),
      eq(branchInventory.organizationId, context.organizationId),
      eq(branchInventory.isActive, true),
      eq(branchInventory.isVisible, true),
      isNull(branchInventory.deletedAt),
      inArray(branchInventory.organizationInventoryId, context.inventoryIds),
    )).for('update')
  if (assignments.length !== context.inventoryIds.length) throw new Error("Some items are no longer available for this branch")
  const inventory = await tx.select().from(organizationInventory).where(and(
    eq(organizationInventory.organizationId, context.organizationId),
    eq(organizationInventory.isActive, true),
    isNull(organizationInventory.deletedAt),
    inArray(organizationInventory.id, context.inventoryIds),
  )).for('update')
  if (inventory.length !== context.inventoryIds.length) throw new Error("Some items are no longer active for this organization")
  const productIds = context.items.map((item: any) => item.globalProductId)
  const lockedGps = await tx.select().from(globalProducts).where(and(
    inArray(globalProducts.id, productIds),
    eq(globalProducts.status, "active"),
    isNull(globalProducts.deletedAt),
  )).for('update')
  // The group tier of the price ladder. Resolved inside the transaction so the
  // price charged comes from the same snapshot as the rows it is charged
  // against, rather than from a group assignment that may have moved since the
  // pre-flight budget check.
  const groupId = await resolveBranchGroupId(tx, {
    branchId: context.branchId,
    organizationId: context.organizationId,
  })
  const groupPriceByInventoryId = await loadGroupPriceOverrides(tx, {
    organizationId: context.organizationId,
    groupId,
    organizationInventoryIds: context.inventoryIds,
  })
  return {
    inventoryById: new Map<number, any>(inventory.map((item: any) => [item.id, item])),
    productById: new Map<number, any>(lockedGps.map((product: any) => [product.id, product])),
    groupPriceByInventoryId,
  }
}

function calculateLockedOrderItems(normalizedItems: any[], locked: any, orgTaxRateBp: number) {
  let subtotal = 0
  let tax = 0
  let total = 0
  const items = normalizedItems.map((requestedItem) => {
    const inventoryItem: any = locked.inventoryById.get(requestedItem.organizationInventoryId)
    if (!inventoryItem) throw new Error("An inventory item is no longer available")
    const product: any = locked.productById.get(inventoryItem.globalProductId)
    if (!product) throw new Error("A product is no longer available")
    const validation = validateProductQuantity(requestedItem.quantity, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!validation.ok) throw new Error(validation.error)
    const priceCents = resolveEffectivePriceCents({
      groupPriceCents: locked.groupPriceByInventoryId?.get(inventoryItem.id),
      organizationPriceCents: inventoryItem.customPrice,
      basePriceCents: product.basePrice,
    })
    if (priceCents === null || !Number.isSafeInteger(priceCents) || priceCents < 0) throw new Error(`Pricing is unavailable for ${product.name}`)
    // Catalogue prices are tax-inclusive, so the line amount is the gross the
    // branch pays and the split below only records how much of it is tax. The
    // order total stays exactly the sum of these gross amounts.
    const taxRateBp = resolveTaxRateBp(product.taxRateBp, orgTaxRateBp)
    const line = splitInclusiveCents(calculateLineCents(priceCents, validation.quantity), taxRateBp)
    subtotal += line.netCents
    tax += line.taxCents
    total += line.grossCents
    return {
      organizationInventoryId: inventoryItem.id,
      globalProductId: product.id,
      quantity: validation.quantity,
      priceCents,
      taxRateBp,
      taxCents: line.taxCents,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
    }
  })
  if (!Number.isSafeInteger(total) || total < 0) throw new Error("Calculated order total is invalid")
  return { items, subtotal, tax, total }
}

function validateCreationStock(items: any[], productById: Map<number, any>) {
  for (const item of items) {
    const product = productById.get(item.globalProductId)
    if (!product) throw new Error(`Product not found: ${item.productName}`)
    if (product.stockQuantity < item.quantity) {
      throw new Error(`Insufficient stock for ${product.name}. Available: ${formatQuantity(product.stockQuantity)}, Requested: ${formatQuantity(item.quantity)}`)
    }
  }
}

async function saveOrderReceipt(tx: any, context: any) {
  const receiptData = await generateReceiptData({
    orderId: context.order.id,
    orderTid: context.tid,
    status: context.order.status,
    organizationId: context.organizationId,
    branchId: context.branchId,
    orderItemsData: context.items,
    subtotalCents: context.subtotal,
    taxCents: context.tax,
    totalCents: context.total,
    discountCents: 0,
    deliveryChargesCents: 0,
    // Already verified against the tenant, the branch and `approved` inside
    // this transaction. Passed in rather than re-read, so the invoice cannot
    // print an address the order guard did not allow.
    deliveryAddress: context.deliveryAddress ?? null,
  })
  // Snapshot the buyer's own reference beside the invoice number so a reissued
  // invoice prints exactly what was agreed when the order was placed.
  if (context.poNumber) receiptData.poNumber = context.poNumber
  // Numbered when processing starts now, when the tax invoice is issued (lib/invoice-policy.ts).
  await assignInvoiceNumberAtCreation(tx, receiptData, {
    organizationId: context.organizationId,
    tid: context.tid,
    invoiceSequenceReady: context.invoiceSequenceReady,
  })
  await tx.update(orders).set({ receiptData: receiptData as any }).where(eq(orders.id, context.order.id))
}

async function saveCreationLedgers(tx: any, context: any) {
  for (const item of context.items) {
    await tx.update(globalProducts).set({
      stockQuantity: sql`${globalProducts.stockQuantity} - ${item.quantity}`,
      updatedAt: new Date(),
    }).where(eq(globalProducts.id, item.globalProductId))
  }
  // An order of a tenant with budgets off takes no hold, money or quantity.
  if (!context.budgetTracked) return
  await tx.update(budgets).set({ amountHeldCents: sql`${budgets.amountHeldCents} + ${context.total}` })
    .where(eq(budgets.id, context.budgetId))
  for (const item of context.items) {
    const row: any = context.quantityBudgets.get(item.organizationInventoryId)
    if (!row) continue
    await tx.update(productQuantityBudgets).set({
      heldQuantity: sql`${productQuantityBudgets.heldQuantity} + ${item.quantity}`,
      updatedAt: new Date(),
    }).where(eq(productQuantityBudgets.id, row.id))
  }
}

async function logCreatedOrder(tx: any, context: any) {
  try {
    logOrderActivity("CREATE", { ...context.order, orderItems: context.items }, {
      id: context.userId,
      email: context.userEmail || "unknown",
      role: context.role,
    })
  } catch (logError) {
    console.error("File logging failed during order creation", logError)
  }
  const headersList = await headers()
  const forwardedFor = headersList.get("x-forwarded-for")
  await tx.insert(systemLogs).values({
    userId: context.userId,
    userRole: context.role,
    organizationId: context.organizationId,
    branchId: context.branchId,
    action: "ORDER_CREATE",
    resourceType: "order",
    resourceId: String(context.order.id),
    details: {
      tid: context.tid,
      total: context.total,
      items: context.itemCount,
      autoApproved: context.order.status === "APPROVED",
      // Why an order skipped approval when the creator, not the tenant's
      // policy, made it Active (an Order Desk entry).
      ...(context.approvalBasis ? { approvalBasis: context.approvalBasis } : {}),
    },
    ipAddress: forwardedFor ? forwardedFor.split(",")[0] : "unknown",
    userAgent: headersList.get("user-agent"),
    success: true,
  })
}

async function persistCreatedOrder(tx: any, context: any) {
  const initialApproval = await resolveInitialOrderApproval(tx, context.organizationId, new Date(), {
    role: context.role,
    userId: context.userId,
  })
  // The approval level the order waits at, for an organization that uses
  // levels; null (decided as before) for every other. Refuses the order when
  // nobody could decide it at its level, before anything is held.
  // See plans/OF-APPROVAL-LEVELS-route-orders-by-level.md.
  const approvalLevel = await resolveOrderApprovalLevel(tx, {
    organizationId: context.organizationId,
    branchId: context.branchId,
    totalCents: context.total,
    approvalRequired: initialApproval.approvalRequired,
    creator: { userId: context.userId, role: context.role },
  })
  const [order] = await tx.insert(orders).values({
    tid: context.tid,
    idempotencyKey: context.idempotencyKey,
    requestFingerprint: context.requestFingerprint,
    organizationId: context.organizationId,
    branchId: context.branchId,
    ...initialApproval.values,
    subtotalCents: context.subtotal,
    taxCents: context.tax,
    totalCents: context.total,
    notes: context.notes || null,
    poNumber: context.poNumber || null,
    // Added only when an address was chosen, so an order placed against the
    // branch's own address produces exactly the INSERT it produced before this
    // column existed — which matters while the migration is being applied by
    // hand ahead of, or behind, the deploy.
    ...(context.deliveryAddress ? { deliveryAddressId: context.deliveryAddress.id } : {}),
    createdByUserId: context.userId,
    // Pinned at creation: the creator's role can change afterwards, what they
    // were when they raised this cannot. See `lib/server/order-creator-role-sql.ts`.
    createdByRole: context.role ?? null,
    // Fixed now, for the order's whole life: every later ledger move asks the
    // order, not the tenant's current setting. Written only when false, so a
    // budgeted order produces the INSERT it produced before the column existed.
    ...(context.budgetTracked ? {} : { budgetTracked: false }),
    // Written only when levelled, so every other organization's INSERT is unchanged.
    ...(approvalLevel === null ? {} : { approvalLevel }),
    // Order Desk only (`orderIntakeError` refused them on any other order), and
    // written only when present so every other INSERT is unchanged.
    ...(context.intakeChannel ? { intakeChannel: context.intakeChannel } : {}),
    ...(context.intakeReference ? { intakeReference: context.intakeReference } : {}),
    ...(context.intakeAttachmentKey ? { intakeAttachmentKey: context.intakeAttachmentKey } : {}),
  }).returning(orderSelectColumns)
  await tx.insert(orderItems).values(context.items.map((item: any) => ({
    ...item,
    orderId: order.id,
    organizationId: context.organizationId,
  })))
  await saveCreationLedgers(tx, { ...context, order })
  await saveOrderReceipt(tx, { ...context, order })
  await logCreatedOrder(tx, { ...context, order, approvalBasis: initialApproval.approvalBasis })
  // Every new order, desk entries included: the warehouse is Apricart's, and
  // is told an order exists whether it awaits approval or was approved now.
  await queueWarehouseOrderNotifications(tx, {
    order,
    event: "CREATED",
    approvedAtCreation: !initialApproval.approvalRequired,
  })
  return {
    order,
    queuedNotifications: await queueCreationNotifications(tx, context, order, initialApproval.approvalRequired),
    approvalRequired: initialApproval.approvalRequired,
  }
}

/**
 * A pending order asks its approvers to decide it. An order approved at
 * creation has nobody to ask, so Super Admins are told it is ready for review
 * instead — whoever raised it, since it is now as fulfilment-ready as any
 * manually approved order.
 */
async function queueCreationNotifications(tx: any, context: any, order: any, approvalRequired: boolean) {
  // An Order Desk entry was keyed in by Apricart's own staff, so telling Super
  // Admins it exists would only echo it back; the customer has no account to
  // notify yet.
  if (isOrderDeskRole(context.role)) return { eventKeys: [], recipientCount: 0 }
  if (!approvalRequired) return enqueueAutoApprovedOrderEvents(tx, { order })
  return context.role === "ORDER_PORTAL"
    ? enqueueCreatedOrderEvents(tx, { order, requestedBy: context.requestedBy })
    : { eventKeys: [], recipientCount: 0 }
}

/**
 * The chosen delivery address, verified, or null when the order goes to the
 * branch's own address.
 *
 * Read **inside** the creation transaction rather than beside the selector: an
 * address that was approved when the page rendered and rejected before the
 * order committed must not slip through. Every part of the tuple is asserted by
 * `loadApprovedDeliveryAddress` — the id, the tenant, the branch this order is
 * actually for, and `status = 'approved'` — so a pending, rejected,
 * other-branch or other-tenant id is refused here and nowhere else.
 */
async function resolveCreationDeliveryAddress(tx: any, context: any) {
  if (!context.deliveryAddressId) return null
  const address = await loadApprovedDeliveryAddress(tx, {
    organizationId: context.organizationId,
    branchId: context.branchId,
    addressId: context.deliveryAddressId,
  })
  if (!address) throw new Error(DELIVERY_ADDRESS_UNAVAILABLE)
  return address
}

async function processOrderCreationTransaction(tx: any, context: any) {
  // An Order Desk user's grant is re-read under FOR SHARE on the assignment
  // and organization rows, so withdrawing it (or the managed flag) waits for
  // this order rather than racing past the pre-check.
  if (isOrderDeskRole(context.role) && !await isOrderDeskTarget(tx, {
    userId: context.userId,
    organizationId: context.organizationId,
    branchId: context.branchId,
    lock: true,
  })) {
    throw new Error(ORDER_DESK_TARGET_UNAVAILABLE)
  }
  // The payment-control gate runs first: the branch is authoritative by now
  // and nothing has been locked or written, so a blocked branch costs one
  // read and holds no row.
  await assertBranchMayOrder(tx, { organizationId: context.organizationId, branchId: context.branchId })
  // Then the delivered-but-unacknowledged gate, under the same rule: before
  // any lock or write.
  await assertBranchDeliveriesAcknowledged(tx, { organizationId: context.organizationId, branchId: context.branchId })
  const deliveryAddress = await resolveCreationDeliveryAddress(tx, context)
  // Read under a shared lock on the organization row, which the organization
  // PATCH holds FOR UPDATE: the order commits wholly under one setting.
  const budgetTracked = await resolveOrderBudgetTracking(tx, context.organizationId)
  // The pre-flight saw budgets off and opened no budget row; the tenant has
  // switched them on since. Refuse rather than hold against nothing.
  if (budgetTracked && !context.budgetId) throw new Error(BUDGET_POLICY_CHANGED_MESSAGE)
  const money = budgetTracked ? await lockCreationMoneyBudget(tx, context) : null
  const quantityBudgets = budgetTracked ? await lockCreationQuantityBudgets(tx, context) : new Map()
  const lockedInventory = await lockCreationInventory(tx, context)
  const orgTaxRateBp = await getOrganizationTaxRateBp(context.organizationId)
  const calculated = calculateLockedOrderItems(context.normalizedItems, lockedInventory, orgTaxRateBp)
  if (money) {
    const budgetError = getBudgetError(calculated.total, money.available, context.pricesHidden)
    if (budgetError) throw new Error(budgetError)
  }
  validateCreationStock(calculated.items, lockedInventory.productById)
  return persistCreatedOrder(tx, {
    ...context,
    budgetTracked,
    items: calculated.items,
    subtotal: calculated.subtotal,
    tax: calculated.tax,
    total: calculated.total,
    quantityBudgets,
    deliveryAddress,
  })
}

function getOrderReplayResponse(existingOrder: any, requestFingerprint: string, pricesHidden: boolean) {
  if (!existingOrder) return null
  if (existingOrder.requestFingerprint !== requestFingerprint) {
    return NextResponse.json({ error: "Idempotency key was already used for a different order" }, { status: 409 })
  }
  const {
    requestFingerprint: _requestFingerprint,
    approvalTokenHash: _approvalTokenHash,
    ...replayedOrder
  } = existingOrder
  return NextResponse.json({
    message: "Order already created",
    order: pricesHidden
      ? { ...replayedOrder, subtotalCents: null, taxCents: null, totalCents: null }
      : replayedOrder,
    replayed: true,
  })
}

function resolveOrderTenant(role: string, sessionOrganizationId: unknown, requestedOrganizationId: number | undefined) {
  const organizationId = typeof sessionOrganizationId === "string" || typeof sessionOrganizationId === "number"
    ? Number.parseInt(String(sessionOrganizationId))
    : Number.NaN
  if (role === "SUPER_ADMIN" && requestedOrganizationId && Number.isFinite(requestedOrganizationId)) {
    return { organizationId: requestedOrganizationId }
  }
  // An Order Desk account has no organization of its own: it always names the
  // target, and the route then checks that target against its assignments
  // (`isOrderDeskTarget`) before anything is read or written.
  if (isOrderDeskRole(role)) {
    return requestedOrganizationId && Number.isFinite(requestedOrganizationId)
      ? { organizationId: requestedOrganizationId }
      : { error: "Organization ID is required" }
  }
  if (role === "HEAD_OFFICE" && requestedOrganizationId !== undefined && requestedOrganizationId !== organizationId) {
    return { error: "Tenant reassignment is not permitted" }
  }
  return Number.isFinite(organizationId) ? { organizationId } : { error: "Organization ID not found" }
}

/**
 * The Order Desk's two creation rules, or null when neither refuses:
 *
 *   * a desk order must say where it came from, and nobody else may claim to
 *     be one (400);
 *   * a desk user reaches only the managed organizations it is assigned to,
 *     re-read from the database now and again under lock inside the
 *     transaction (403).
 */
async function orderDeskCreationRefusal(role: unknown, input: {
  userId: string
  idempotencyKey: string
  organizationId: number
  branchId: number
  intakeChannel?: string
  intakeReference?: string
  intakeAttachmentKey?: string
}) {
  const intakeError = orderIntakeError(role, input)
  if (intakeError) return NextResponse.json({ error: intakeError }, { status: 400 })
  if (!isOrderDeskRole(role)) return null
  if (!await isOrderDeskTarget(db, { userId: input.userId, organizationId: input.organizationId, branchId: input.branchId })) {
    return NextResponse.json({ error: ORDER_DESK_TARGET_UNAVAILABLE }, { status: 403 })
  }
  // The screenshot (required by `orderIntakeError`) must be one this desk user
  // uploaded, not yet on any order other than the one this same submission
  // already created (a retry).
  const attachmentError = await deskAttachmentRefusal({
    userId: input.userId,
    key: input.intakeAttachmentKey ?? "",
    idempotencyKey: input.idempotencyKey,
  })
  return attachmentError ? NextResponse.json({ error: attachmentError }, { status: 400 }) : null
}

function getCreationBranchId(role: string, requestedBranchId: number | undefined, sessionBranchId: unknown) {
  return Number.parseInt(String(["HEAD_OFFICE", "SUPER_ADMIN", "ORDER_DESK"].includes(role) ? requestedBranchId : sessionBranchId))
}

async function validateCreationBranch(organizationId: number, branchId: number) {
  const [branch] = await db.select({ id: branches.id }).from(branches).where(and(
    eq(branches.id, branchId),
    eq(branches.organizationId, organizationId),
  )).limit(1)
  return Boolean(branch)
}

function getCreatedOrderResponse(order: any, pricesHidden: boolean) {
  const { approvalTokenHash: _approvalTokenHash, ...safeOrder } = order
  return NextResponse.json({
    message: "Order created",
    order: pricesHidden
      ? { ...safeOrder, subtotalCents: null, taxCents: null, totalCents: null }
      : safeOrder,
  })
}

function getTenantErrorStatus(message: string) {
  return message.startsWith("Tenant") ? 403 : 400
}

function warnAboutMissingOrderApprover(role: string, result: any) {
  if (
    role !== "ORDER_PORTAL"
    || !result.approvalRequired
    || result.queuedNotifications.recipientCount > 0
  ) return
  console.warn("[OrderNotifications] No active configured order approver recipient was available", {
    orderId: result.order.id,
    organizationId: result.order.organizationId,
    branchId: result.order.branchId,
  })
}

async function loadCreationInventory(context: any) {
  const inventoryRows = await db.select({
    id: organizationInventory.id,
    globalProductId: organizationInventory.globalProductId,
    customPrice: organizationInventory.customPrice,
  }).from(branchInventory).innerJoin(
    organizationInventory,
    eq(branchInventory.organizationInventoryId, organizationInventory.id),
  ).where(and(
    eq(branchInventory.branchId, context.branchId),
    eq(branchInventory.organizationId, context.organizationId),
    eq(branchInventory.isActive, true),
    eq(branchInventory.isVisible, true),
    isNull(branchInventory.deletedAt),
    eq(organizationInventory.organizationId, context.organizationId),
    eq(organizationInventory.isActive, true),
    isNull(organizationInventory.deletedAt),
    inArray(organizationInventory.id, context.inventoryIds),
  ))
  if (inventoryRows.length !== context.inventoryIds.length) return null
  const productRows = await db.select().from(globalProducts).where(and(
    inArray(globalProducts.id, inventoryRows.map((row) => row.globalProductId)),
    eq(globalProducts.status, "active"),
    isNull(globalProducts.deletedAt),
  ))
  // Same ladder the transaction re-resolves below, so this pre-flight total is
  // checked against the budget at the price the order will actually be created
  // at.
  const groupId = await resolveBranchGroupId(db, {
    branchId: context.branchId,
    organizationId: context.organizationId,
  })
  const groupPriceByInventoryId = await loadGroupPriceOverrides(db, {
    organizationId: context.organizationId,
    groupId,
    organizationInventoryIds: context.inventoryIds,
  })
  return {
    inventoryById: new Map(inventoryRows.map((row) => [row.id, row])),
    productById: new Map(productRows.map((row) => [row.id, row])),
    groupPriceByInventoryId,
  }
}

function calculateCreationItems(normalizedItems: any[], inventory: any) {
  let subtotal = 0
  const items = normalizedItems.map((requestedItem) => {
    const inventoryItem = inventory.inventoryById.get(requestedItem.organizationInventoryId)
    if (!inventoryItem) throw new Error(`Inventory item ${requestedItem.organizationInventoryId} not found`)
    const product = inventory.productById.get(inventoryItem.globalProductId)
    if (!product) throw new Error(`Global product for inventory ${inventoryItem.globalProductId} not found`)
    const validation = validateProductQuantity(requestedItem.quantity, {
      allowDecimalQuantity: product.allowDecimalQuantity,
      quantityStep: product.quantityStep,
      label: `Quantity for ${product.name}`,
    })
    if (!validation.ok) throw new Error(validation.error)
    const priceCents = resolveEffectivePriceCents({
      groupPriceCents: inventory.groupPriceByInventoryId?.get(inventoryItem.id),
      organizationPriceCents: inventoryItem.customPrice,
      basePriceCents: product.basePrice,
    })
    if (priceCents === null || priceCents === undefined) throw new Error(`Price not found for item ${requestedItem.organizationInventoryId}. Custom: ${inventoryItem.customPrice}, Base: ${product.basePrice}`)
    subtotal += calculateLineCents(priceCents, validation.quantity)
    return {
      organizationInventoryId: requestedItem.organizationInventoryId,
      globalProductId: inventoryItem.globalProductId,
      quantity: validation.quantity,
      priceCents,
      productName: product.name,
      productCode: product.productCode,
      unit: product.unit,
    }
  })
  return { items, subtotal, total: subtotal }
}

async function getOrCreateCurrentBudget(branchId: number, period: string) {
  // Settle first so the pre-check below (and its error message) sees the
  // same figure the locked check inside the transaction will.
  await settleDueBudgetAddons(db, { branchIds: [branchId], periods: [period] })
  const [existing] = await db.select().from(budgets).where(and(
    eq(budgets.branchId, branchId),
    eq(budgets.period, period),
  )).limit(1)
  if (existing) return existing
  const [branch] = await db.select({
    baselineBudgetCents: branches.baselineBudgetCents,
    organizationId: branches.organizationId,
  }).from(branches).where(eq(branches.id, branchId)).limit(1)
  if (!branch?.baselineBudgetCents || branch.baselineBudgetCents <= 0) return null
  const [inserted] = await db.insert(budgets).values({
    organizationId: branch.organizationId,
    branchId,
    period,
    amountAllocatedCents: branch.baselineBudgetCents,
    amountSpentCents: 0,
    amountHeldCents: 0,
    amountCreditedCents: 0,
  }).onConflictDoNothing().returning()
  if (inserted) return inserted
  return (await db.select().from(budgets).where(and(
    eq(budgets.branchId, branchId),
    eq(budgets.period, period),
  )).limit(1))[0]
}

/**
 * The budget pre-flight before the creation transaction: the period row this
 * order will hold against, or the refusal to return. A tenant with budget
 * allocation switched off orders with no budget at all — no row is read or
 * opened here, and the transaction takes no hold (`budgetId: null`).
 */
async function preflightCreationBudget(context: {
  organizationId: number
  branchId: number
  period: string
  total: number
  pricesHidden: boolean
}): Promise<{ budgetId: number | null } | { response: NextResponse }> {
  if (!await isOrganizationBudgetEnabled(context.organizationId)) return { budgetId: null }

  const currentBudget = await getOrCreateCurrentBudget(context.branchId, context.period)
  if (!currentBudget) {
    return {
      response: NextResponse.json({
        error: `Budget not configured for current month (${context.period}). Please contact head office to allocate budget.`,
      }, { status: 400 }),
    }
  }

  const remaining = (currentBudget.amountAllocatedCents + currentBudget.amountCreditedCents) - (currentBudget.amountSpentCents + currentBudget.amountHeldCents)
  const budgetError = getBudgetError(context.total, remaining, context.pricesHidden)
  if (budgetError) return { response: NextResponse.json({ error: budgetError }, { status: 400 }) }
  return { budgetId: currentBudget.id }
}

async function getOrderCreationErrorResponse(caughtError: any, replayContext: any) {
  // Drizzle wraps the driver's error, so the Postgres code and constraint are on
  // `cause`; reading only the top level turned every lost race into a 500.
  const uniqueViolation = String(caughtError?.code ?? caughtError?.cause?.code ?? "") === "23505"
  // A duplicate submission of the same draft lost the race to its twin. Which
  // unique index Postgres reports first is not defined — the idempotency key or,
  // on a desk order, the screenshot both collide — so the twin is looked for
  // before the screenshot conflict is reported.
  if (uniqueViolation && replayContext) {
    const [existingOrder] = await db.select({ ...orderSelectColumns, requestFingerprint: orders.requestFingerprint })
      .from(orders).where(and(
        eq(orders.createdByUserId, replayContext.userId),
        eq(orders.idempotencyKey, replayContext.idempotencyKey),
      )).limit(1)
    const replayResponse = getOrderReplayResponse(existingOrder, replayContext.requestFingerprint, replayContext.pricesHidden)
    if (replayResponse) return replayResponse
  }
  // Two different desk orders raced to claim one screenshot; the loser is told plainly.
  if (uniqueViolation && String(caughtError?.constraint ?? caughtError?.cause?.constraint ?? "") === "orders_intake_attachment_key_uq") {
    return NextResponse.json({ error: "That screenshot is already attached to another order" }, { status: 409 })
  }
  if (isPaymentControlBlockedError(caughtError)) {
    return NextResponse.json(
      { error: caughtError.message, code: caughtError.code, paymentControl: caughtError.details },
      { status: 409 },
    )
  }
  if (isDeliveryAcknowledgementBlockedError(caughtError)) {
    return NextResponse.json(
      { error: caughtError.message, code: caughtError.code, deliveryAcknowledgement: caughtError.details },
      { status: 409 },
    )
  }
  if (isInvoiceCodeMissingError(caughtError)) {
    return NextResponse.json({ error: caughtError.message, code: caughtError.code }, { status: 409 })
  }
  if (isApprovalLevelUnavailableError(caughtError)) {
    return NextResponse.json(
      { error: caughtError.message, code: caughtError.code, approvalLevel: caughtError.level },
      { status: 409 },
    )
  }
  const message = String(caughtError.message || "")
  if (message === ORDER_DESK_TARGET_UNAVAILABLE) return NextResponse.json({ error: message }, { status: 403 })
  const normalized = message.toLowerCase()
  const isCustomerError = message === DELIVERY_ADDRESS_UNAVAILABLE
    || message === BUDGET_POLICY_CHANGED_MESSAGE
    || message.startsWith("Insufficient stock")
    || message.startsWith("Budget not configured")
    || message.includes("Insufficient budget")
    || normalized.includes("quantity budget")
    || normalized.includes("negative state")
    || normalized.includes("no longer")
    || normalized.includes("pricing is unavailable")
  return isCustomerError
    ? NextResponse.json({ error: message }, { status: 400 })
    : NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
}


export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }
    if ((session.user as any).mustChangePassword === true) {
      return NextResponse.json({ error: "Forbidden", message: "Password change required" }, { status: 403 })
    }

    const sessionRole = (session.user as any).role
    // The role the list is *scoped* by: an organization-wide Viewer reads the
    // tenant's orders as Head Office does, a branch-pinned one is refused.
    // What the caller may *do* — decide, see the fulfilment token — and the
    // access audit below keep the real role.
    const role = viewerReadRole(session.user as any)
    if (!role) return NextResponse.json({ error: VIEWER_READ_REFUSED }, { status: 403 })
    const organizationIdRaw = (session.user as any).organizationId
    const branchIdFromUserRaw = (session.user as any).branchId

    const orgIdNum = parseScopedNumericId(organizationIdRaw)
    const branchIdFromUser = parseScopedNumericId(branchIdFromUserRaw)
    const currentUserId = (session.user as any).id
    const decisionCapabilities = await getOrderDecisionCapabilities(
      isValidRole(sessionRole) && typeof currentUserId === "string"
        ? {
          role: sessionRole,
          userId: currentUserId,
          organizationId: orgIdNum ?? null,
          branchId: branchIdFromUser ?? null,
        }
        : null,
    )

    const params = getOrderListParams(req)
    const statusFilter = getOrderStatusFilter(params.rawStatus)
    const conditions: any[] = []
    const searchError = addOrderSearchCondition(conditions, params.query)
    if (searchError) return NextResponse.json({ error: searchError }, { status: 400 })
    const scopedBranchIds = usesMultiBranchScope(role) && typeof currentUserId === "string"
      ? await resolveScopedBranchIds(db, currentUserId)
      : null
    addOrderRoleConditions(conditions, {
      role,
      organizationId: orgIdNum,
      branchId: branchIdFromUser,
      organizationIdParam: params.organizationId,
      userId: currentUserId,
      scopedBranchIds,
    })

    const pricesHidden = await shouldHidePricesForRole(role, orgIdNum)
    const listQuery = parseOrderListQuery(params, pricesHidden)
    if (!listQuery.ok) return NextResponse.json({ error: listQuery.error }, { status: 400 })
    addOrderDimensionConditions(conditions, params)
    addOrderCreatorRoleCondition(conditions, listQuery.creatorRole)
    addOrderDateConditions(conditions, params)

    // Status changes which rows are returned, but not the KPI scope. Keeping a
    // separate snapshot prevents a selected tab from zeroing the other cards.
    const summaryConditions = [...conditions]
    addOrderStatusConditions(
      conditions,
      statusFilter,
      listQuery.deliveryFilter,
      listQuery.fulfillmentStatusFilter,
      listQuery.invoiceStatusFilter,
    )

    // --- Audit Logging for Group Access ---
    auditOrderGroupAccess(params, { organizationId: orgIdNum, userId: currentUserId, role: sessionRole })




    // --- Base query (non-sales) ---
    const selectBase = db
      .select({
        id: orders.id,
        tid: orders.tid,
        organizationId: orders.organizationId,
        organizationName: organizations.name,
        branchId: orders.branchId,
        status: orders.status,
        fulfillmentStatus: orderSelectColumns.fulfillmentStatus,
        // Legacy delivery status 505 means part of the order reached the
        // branch. Imports normalize it to FULFILLED / DELIVERED but retain the
        // source state, so expose one boolean without leaking import metadata.
        partialDelivery: sql<boolean>`(
          UPPER(${orders.status}) IN ('PARTIAL', 'PARTIALLY_FULFILLED')
          OR EXISTS (
            SELECT 1
            FROM ${legacyOrderImports}
            WHERE ${legacyOrderImports.orderId} = ${orders.id}
              AND (
                ${legacyOrderImports.sourcePayload} #>> '{legacyStatus,deliveryStatus}' = '505'
                OR ${legacyOrderImports.sourcePayload} #>> '{sourceHeader,DeliveryStatus}' = '505'
                OR ${legacyOrderImports.sourcePayload} #>> '{sourceHeader,OriginalDeliveryStatus}' = '505'
                OR UPPER(COALESCE(${legacyOrderImports.sourcePayload} #>> '{legacyStatus,text}', '')) = 'PARTIAL'
              )
          )
        )`.mapWith(Boolean),
        paymentStatus: orderSelectColumns.paymentStatus,
        paidAt: orderSelectColumns.paidAt,
        tokenHandoffAt: orderSelectColumns.tokenHandoffAt,
        approvalLevel: orderSelectColumns.approvalLevel,
        statusAtRefund: orders.statusAtRefund,
        refundedAt: orders.refundedAt,
        refundedByUserId: orders.refundedByUserId,
        refundAmountCents: orders.refundAmountCents,
        refundReason: orders.refundReason,
        rejectionReason: orders.rejectionReason,
        returnedForCorrectionAt: orders.returnedForCorrectionAt,
        correctionRequestNote: orders.correctionRequestNote,
        subtotalCents: orders.subtotalCents,
        taxCents: orders.taxCents,
        totalCents: orders.totalCents,
        createdAt: orders.createdAt,
        approvedAt: orders.approvedAt,
        deliveredAt: orders.deliveredAt,
        fulfilledAt: orders.fulfilledAt,
        invoiceStatus: invoiceStatusSql,
        branchName: branches.name,
        branchAddress: branches.address,
        branchCity: branches.city,
        branchProvince: branches.province,
        branchCostCenterId: branches.costCenterId,
        // The order's branch's group, joined the same way as the Order Report
        // so the two downloads name the same group for the same order.
        groupName: groups.name,
        hasRefundRequests: sql<number>`(
          SELECT COUNT(*)::int
          FROM ${refunds}
          WHERE ${refunds.orderId} = ${orders.id}
          AND UPPER(${refunds.status}) = 'PENDING'
        )`,
        itemCount: sql<number>`(
          SELECT COALESCE(SUM(${orderItems.quantity}), 0)::numeric
          FROM ${orderItems}
          WHERE ${orderItems.orderId} = ${orders.id}
        )`,
        itemNames: sql<string>`(
          SELECT STRING_AGG(${orderItems.productName}, ', ')
          FROM ${orderItems}
          WHERE ${orderItems.orderId} = ${orders.id}
        )`,
        createdByUserId: orders.createdByUserId,
        createdByRole: orders.createdByRole,
        groupOrderId: orders.groupOrderId,
        approvedByUserId: orders.approvedByUserId,
        approvalToken: orders.approvalToken, // Will be filtered before return
      })
      .from(orders)
      .leftJoin(branches, eq(orders.branchId, branches.id))
      .leftJoin(organizations, eq(orders.organizationId, organizations.id))
      .leftJoin(groups, eq(branches.groupId, groups.id))

    const { page, limit, offset } = params
    const items = await (conditions.length
      ? selectBase.where(and(...conditions)).orderBy(...listQuery.orderBy).limit(limit).offset(offset)
      : selectBase.orderBy(...listQuery.orderBy).limit(limit).offset(offset))

    // The list is intentionally paginated, but the summary cards must describe
    // the complete filtered scope rather than only the current page of rows.
    const summaryCondition = summaryConditions.length ? and(...summaryConditions) : undefined
    const [summaryRow] = params.id
      ? []
      : await db
        .select({
          all: metricExpressions.totalOrderCount,
          pending: sql<number>`COALESCE(COUNT(CASE WHEN UPPER(${orders.status}) = 'PENDING' THEN 1 END), 0)`.mapWith(Number),
          approved: metricExpressions.approvedCount,
          fulfilled: metricExpressions.fulfilledCount,
          rejected: metricExpressions.rejectedCount,
          refunded: metricExpressions.refundedCount,
          deliveredUnacknowledged: viewerStatusBucketCount("DELIVERED_UNACKNOWLEDGED"),
        })
        .from(orders)
        .leftJoin(branches, eq(orders.branchId, branches.id))
        .where(summaryCondition)

    // Sanitize items: Only show approvalToken to authorized roles
    const levelledView = await loadLevelledViewContext({ userId: currentUserId, organizationId: orgIdNum })
    const filtered = sanitizeOrderListItems(items, {
      role: sessionRole,
      userId: currentUserId,
      pricesHidden,
      capabilities: decisionCapabilities,
      levelledView,
    })
    const singleOrderResponse = await getSingleOrderListResponse(params.id, filtered, {
      pricesHidden,
      capabilities: decisionCapabilities,
    })
    if (singleOrderResponse) return singleOrderResponse

    const paginationTotal = await getOrderListPaginationTotal({
      statusFilter,
      summaryRow,
      deliveryFilter: listQuery.deliveryFilter,
      fulfillmentStatus: listQuery.fulfillmentStatusFilter,
      invoiceStatus: listQuery.invoiceStatusFilter,
      conditions,
    })

    return NextResponse.json({
      items: filtered,
      summary: {
        all: Number(summaryRow?.all || 0),
        pending: Number(summaryRow?.pending || 0),
        approved: Number(summaryRow?.approved || 0),
        fulfilled: Number(summaryRow?.fulfilled || 0),
        rejected: Number(summaryRow?.rejected || 0),
        refunded: Number(summaryRow?.refunded || 0),
        deliveredUnacknowledged: Number(summaryRow?.deliveredUnacknowledged || 0),
      },
      pricesHidden,
      capabilities: decisionCapabilities,
      pagination: {
        page,
        limit,
        total: paginationTotal,
        totalPages: Math.ceil(paginationTotal / limit),
        hasMore: page * limit < paginationTotal,
      },
    })
  } catch (e: any) {
    console.error("Orders GET error:", e)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  let replayContext: {
    userId: string
    idempotencyKey: string
    requestFingerprint: string
    pricesHidden: boolean
  } | null = null

  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    if ((session.user as any).mustChangePassword === true) return NextResponse.json({ error: "Forbidden", message: "Password change required" }, { status: 403 })
    const role = (session.user as any).role
    const userId = (session.user as any).id
    // Every role that places an order here today, and nobody else — see
    // `lib/order-creation-access.ts`. Refused before anything is read.
    if (!mayCreateOrder(role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    const rateLimit = await withRateLimit("order", userId)
    if (rateLimit) return rateLimit
    const idempotencyKey = req.headers.get("idempotency-key")?.trim() || ""
    if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      return NextResponse.json({
        error: "A valid Idempotency-Key header (8-128 letters, numbers, '.', '_', ':', or '-') is required",
      }, { status: 400 })
    }

    const rawBody = await req.json().catch(() => null)
    const parsedBody = orderCreateSchema.safeParse(rawBody)
    if (!parsedBody.success) {
      return NextResponse.json({ error: validationMessage(parsedBody.error) }, { status: 400 })
    }
    const {
      items,
      branchId: branchIdInput,
      organizationId: orgIdInput,
      notes,
      poNumber,
      deliveryAddressId,
      intakeChannel,
      intakeReference,
      intakeAttachmentKey,
    } = parsedBody.data

    const normalizedItems = items.map((item) => ({
      organizationInventoryId: item.organizationInventoryId,
      quantity: roundQuantity(Number(item.quantity)),
    }))

    // Validate quantities are positive
    if (normalizedItems.some(i => !Number.isFinite(i.quantity) || i.quantity <= 0)) {
      return NextResponse.json({ error: "Quantities must be greater than zero" }, { status: 400 })
    }

    const tenant = resolveOrderTenant(role, (session.user as any).organizationId, orgIdInput)
    if (tenant.error) return NextResponse.json({ error: tenant.error }, { status: getTenantErrorStatus(tenant.error) })
    const organizationId = tenant.organizationId!

    const branchId = getCreationBranchId(role, branchIdInput, (session.user as any).branchId)
    if (!Number.isFinite(branchId)) return NextResponse.json({ error: "Branch context required" }, { status: 400 })
    if (!await validateCreationBranch(organizationId, branchId)) {
      return NextResponse.json({ error: "Branch does not belong to the selected organization" }, { status: 400 })
    }
    const orderDeskRefusal = await orderDeskCreationRefusal(role, {
      userId,
      idempotencyKey,
      organizationId,
      branchId,
      intakeChannel,
      intakeReference,
      intakeAttachmentKey,
    })
    if (orderDeskRefusal) return orderDeskRefusal
    const pricesHidden = await shouldHidePricesForRole(role, organizationId)
    const budgetAllocationMode = await getBudgetAllocationModeForOrganization(Number(organizationId))
    const requestFingerprint = orderRequestFingerprint({
      organizationId: Number(organizationId),
      branchId,
      notes,
      poNumber,
      deliveryAddressId,
      intakeChannel,
      intakeReference,
      intakeAttachmentKey,
      items: normalizedItems,
    })
    replayContext = { userId, idempotencyKey, requestFingerprint, pricesHidden }

    const [existingOrder] = await db
      .select({ ...orderSelectColumns, requestFingerprint: orders.requestFingerprint })
      .from(orders)
      .where(and(
        eq(orders.createdByUserId, userId),
        eq(orders.idempotencyKey, idempotencyKey),
      ))
      .limit(1)

    const replayResponse = getOrderReplayResponse(existingOrder, requestFingerprint, pricesHidden)
    if (replayResponse) return replayResponse

    // Fetch inventory details and prices
    const orgInvIds = normalizedItems.map(i => i.organizationInventoryId)
    const creationInventory = await loadCreationInventory({ organizationId, branchId, inventoryIds: orgInvIds })
    if (!creationInventory) return NextResponse.json({ error: "Some items invalid" }, { status: 400 })
    const calculated = calculateCreationItems(normalizedItems, creationInventory)
    const calculatedItems = calculated.items
    const total = calculated.total

    // budget check and hold - must be for current month period
    const currentMonth = budgetPeriodOf(new Date())
    const preflight = await preflightCreationBudget({
      organizationId: Number(organizationId),
      branchId,
      period: currentMonth,
      total,
      pricesHidden,
    })
    if ("response" in preflight) return preflight.response
    const currentBudgetId = preflight.budgetId

    const tid = generateTid()
    const invoiceSequenceReady = await hasInvoiceSequenceTable(db)

    const creationResult = await db.transaction((tx) => processOrderCreationTransaction(tx, {
      budgetId: currentBudgetId,
      period: currentMonth,
      total,
      pricesHidden,
      mode: budgetAllocationMode,
      organizationId: Number(organizationId),
      branchId,
      inventoryIds: orgInvIds,
      normalizedItems,
      items: calculatedItems,
      tid,
      idempotencyKey,
      requestFingerprint,
      notes,
      poNumber,
      deliveryAddressId,
      intakeChannel,
      intakeReference,
      intakeAttachmentKey,
      userId,
      role,
      userEmail: session.user?.email,
      requestedBy: String((session.user as any)?.fullName || "Order Portal user").trim().slice(0, 255),
      itemCount: items.length,
      invoiceSequenceReady,
    }))
    // queueOrderCreatedNotifications(tx) runs inside processOrderCreationTransaction.


    const created = creationResult.order
    warnAboutMissingOrderApprover(role, creationResult)
    await attemptImmediateOrderEmailDelivery(creationResult.queuedNotifications.eventKeys)
    return getCreatedOrderResponse(created, pricesHidden)
  } catch (e: any) {
    console.error("Order creation error:", e)
    console.error("Error stack:", e.stack)
    return getOrderCreationErrorResponse(e, replayContext)
  }
}

export async function PUT(_: NextRequest) {
  return NextResponse.json(
    { error: "Use the dedicated approve, reject, or fulfill operation" },
    { status: 405 },
  )
}

const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,128}$/

function orderRequestFingerprint(input: {
  organizationId: number
  branchId: number
  notes?: string
  poNumber?: string
  deliveryAddressId?: number
  intakeChannel?: string
  intakeReference?: string
  intakeAttachmentKey?: string
  items: Array<{ organizationInventoryId: number; quantity: number }>
}) {
  const canonical = {
    organizationId: input.organizationId,
    branchId: input.branchId,
    notes: input.notes || null,
    poNumber: input.poNumber || null,
    // Present only when an address was chosen, which keeps the canonical object
    // byte-identical to what it was before delivery addresses existed for every
    // order that uses the branch default. Writing `?? null` instead would
    // change the hash of every such request, turning an idempotent retry that
    // spanned the deploy into a 409 "key already used for a different order".
    ...(input.deliveryAddressId ? { deliveryAddressId: input.deliveryAddressId } : {}),
    // Present only on an Order Desk order, for the same reason: every other
    // order hashes exactly as it did before these fields existed.
    ...(input.intakeChannel ? { intakeChannel: input.intakeChannel } : {}),
    ...(input.intakeReference ? { intakeReference: input.intakeReference } : {}),
    ...(input.intakeAttachmentKey ? { intakeAttachmentKey: input.intakeAttachmentKey } : {}),
    items: input.items.slice().sort((a, b) => a.organizationInventoryId - b.organizationInventoryId),
  }
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}
