import "server-only"

import { and, asc, count, desc, eq, ilike, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { branches, orderItems, orders, organizations, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  executiveApprovalActions,
  executiveApprovalSelection,
  type ExecutiveApprovalActions,
  type ExecutiveApprovalCounts,
  type ExecutiveApprovalListQuery,
  type ExecutiveApprovalTab,
} from "@/lib/executive-approval-query"
import { normalizeFulfillmentStatus, type FulfillmentStatus } from "@/lib/fulfillment-status"
import { ORDER_DESK_ROLE, type IntakeChannel } from "@/lib/order-desk-access"
import { deskApprovalReachIsEmpty, type DeskApprovalReach } from "@/lib/order-desk-approval"
import { escapeLikePattern } from "@/lib/utils"
import { deskApprovalOrderCondition, loadDeskApprovalReach } from "@/lib/server/apricart-executive-scope"

/**
 * An Apricart Executive's approval list: the Order Desk orders in the
 * organizations assigned to them, read **through** that reach
 * (`deskApprovalOrderCondition`) so a filter can only narrow it. Super Admin
 * reads the same list for every desk order, from Order Desk Team
 * (plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md).
 *
 * Amounts and lines are included — the executive approves money, and no
 * price-visibility setting restricts the role (`lib/price-visibility.ts`).
 * The approval token never is: the executive does not hand off fulfilment.
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */

export type ExecutiveApprovalItem = ExecutiveApprovalActions & {
  id: number
  tid: string
  status: string
  fulfillmentStatus: FulfillmentStatus
  organizationId: number | null
  organizationName: string | null
  branchId: number
  branchName: string | null
  branchCity: string | null
  subtotalCents: number
  taxCents: number
  totalCents: number
  poNumber: string | null
  notes: string | null
  intakeChannel: IntakeChannel | null
  intakeReference: string | null
  hasAttachment: boolean
  enteredBy: string | null
  createdAt: Date | null
  /** The version the approve request must name back (`expectedUpdatedAt`). */
  updatedAt: Date | null
  approvedAt: Date | null
  approvedBy: string | null
  rejectedAt: Date | null
  rejectionReason: string | null
  returnedForCorrectionAt: Date | null
  correctionRequestNote: string | null
  items: {
    id: number
    productName: string
    productCode: string | null
    quantity: number
    unit: string | null
    priceCents: number
    /** The desk typed this line's price; `cataloguePriceCents` is what it replaced. */
    priceEnteredManually: boolean
    cataloguePriceCents: number | null
    /** False when the product was outside the branch's own catalogue when it was ordered. */
    inBranchCatalogue: boolean
  }[]
}

export type ExecutiveApprovalPage = {
  items: ExecutiveApprovalItem[]
  counts: ExecutiveApprovalCounts
  /**
   * The filter's choices: the organizations this executive approves for, or,
   * for Super Admin, every organization the desk has entered an order for.
   */
  organizations: { id: number; name: string }[]
  pagination: { page: number; limit: number; total: number; totalPages: number }
}

const PENDING_SQL = sql`UPPER(${orders.status}) = 'PENDING'`

function tabCondition(tab: ExecutiveApprovalTab): SQL | undefined {
  const selection = executiveApprovalSelection(tab)
  switch (selection.kind) {
    case "pending":
      return and(
        PENDING_SQL,
        selection.returned ? isNotNull(orders.returnedForCorrectionAt) : isNull(orders.returnedForCorrectionAt),
      )
    case "approved":
      return isNotNull(orders.approvedAt)
    case "rejected":
      return sql`UPPER(${orders.status}) = 'REJECTED'`
    default:
      return undefined
  }
}

function tabCount(tab: ExecutiveApprovalTab) {
  const condition = tabCondition(tab)
  return condition
    ? sql<number>`COUNT(*) FILTER (WHERE ${condition})`.mapWith(Number)
    : sql<number>`COUNT(*)`.mapWith(Number)
}

/** The organizations the filter offers: the executive's assigned ones, or every one the desk has ordered for. */
function reachOrganizationsCondition(reach: DeskApprovalReach): SQL {
  if (reach.kind === "organizations") return inArray(organizations.id, [...reach.organizationIds])
  return inArray(
    organizations.id,
    db
      .selectDistinct({ organizationId: orders.organizationId })
      .from(orders)
      .where(and(eq(orders.createdByRole, ORDER_DESK_ROLE), isNotNull(orders.organizationId))),
  )
}

const NO_COUNTS: ExecutiveApprovalCounts = { awaiting_approval: 0, returned: 0, approved: 0, rejected: 0, all: 0 }

export async function listExecutiveApprovals(
  userId: string,
  query: ExecutiveApprovalListQuery,
): Promise<ExecutiveApprovalPage> {
  const reach = await loadDeskApprovalReach(db, userId)
  const empty = { items: [], counts: NO_COUNTS, organizations: [], pagination: { page: query.page, limit: query.limit, total: 0, totalPages: 0 } }
  if (deskApprovalReachIsEmpty(reach)) return empty

  const conditions: SQL[] = [deskApprovalOrderCondition(reach)]
  // Filters only narrow what the reach above already allows.
  if (query.organizationId !== null) conditions.push(eq(orders.organizationId, query.organizationId))
  if (query.search) {
    // A parameter, with the LIKE wildcards in what was typed escaped.
    const pattern = `%${escapeLikePattern(query.search)}%`
    conditions.push(or(ilike(orders.tid, pattern), ilike(orders.intakeReference, pattern)) as SQL)
  }
  const scopeWhere = and(...conditions)
  const tab = tabCondition(query.tab)
  const where = tab ? and(scopeWhere, tab) : scopeWhere

  const [[{ total }], [counts], organizationRows] = await Promise.all([
    db.select({ total: count() }).from(orders).where(where),
    db
      .select({
        awaiting_approval: tabCount("awaiting_approval"),
        returned: tabCount("returned"),
        approved: tabCount("approved"),
        rejected: tabCount("rejected"),
        all: tabCount("all"),
      })
      .from(orders)
      .where(scopeWhere),
    db
      .select({ id: organizations.id, name: organizations.name })
      .from(organizations)
      .where(reachOrganizationsCondition(reach))
      .orderBy(asc(organizations.name)),
  ])

  const enteredBy = alias(users, "desk_entered_by")
  const approvedBy = alias(users, "desk_approved_by")
  const rows = await db
    .select({
      id: orders.id,
      tid: orders.tid,
      status: orders.status,
      fulfillmentStatus: orders.fulfillmentStatus,
      organizationId: orders.organizationId,
      organizationName: organizations.name,
      branchId: orders.branchId,
      branchName: branches.name,
      branchCity: branches.city,
      subtotalCents: orders.subtotalCents,
      taxCents: orders.taxCents,
      totalCents: orders.totalCents,
      poNumber: orders.poNumber,
      notes: orders.notes,
      intakeChannel: orders.intakeChannel,
      intakeReference: orders.intakeReference,
      intakeAttachmentKey: orders.intakeAttachmentKey,
      enteredBy: enteredBy.fullName,
      createdAt: orders.createdAt,
      updatedAt: orders.updatedAt,
      approvedAt: orders.approvedAt,
      approvedBy: approvedBy.fullName,
      rejectedAt: orders.rejectedAt,
      rejectionReason: orders.rejectionReason,
      returnedForCorrectionAt: orders.returnedForCorrectionAt,
      correctionRequestNote: orders.correctionRequestNote,
    })
    .from(orders)
    .leftJoin(organizations, eq(organizations.id, orders.organizationId))
    .leftJoin(branches, eq(branches.id, orders.branchId))
    .leftJoin(enteredBy, eq(enteredBy.id, orders.createdByUserId))
    .leftJoin(approvedBy, eq(approvedBy.id, orders.approvedByUserId))
    .where(where)
    // Every tab lists the latest orders first.
    .orderBy(desc(orders.createdAt), desc(orders.id))
    .limit(query.limit)
    .offset((query.page - 1) * query.limit)

  const orderIds = rows.map((row) => row.id)
  const lineRows = orderIds.length === 0
    ? []
    : await db
      .select({
        id: orderItems.id,
        orderId: orderItems.orderId,
        productName: orderItems.productName,
        productCode: orderItems.productCode,
        quantity: orderItems.quantity,
        unit: orderItems.unit,
        priceCents: orderItems.priceCents,
        organizationInventoryId: orderItems.organizationInventoryId,
        priceEnteredManually: orderItems.priceEnteredManually,
        cataloguePriceCents: orderItems.cataloguePriceCents,
      })
      .from(orderItems)
      .where(inArray(orderItems.orderId, orderIds))
      .orderBy(asc(orderItems.id))

  return {
    counts,
    organizations: organizationRows,
    items: rows.map(({ intakeAttachmentKey, ...row }) => ({
      ...row,
      ...executiveApprovalActions(row),
      fulfillmentStatus: normalizeFulfillmentStatus(row.fulfillmentStatus),
      subtotalCents: Number(row.subtotalCents),
      taxCents: Number(row.taxCents),
      totalCents: Number(row.totalCents),
      intakeChannel: row.intakeChannel as IntakeChannel | null,
      // The key itself never leaves the server; the screenshot is fetched by
      // order id through the executive's attachment route.
      hasAttachment: intakeAttachmentKey !== null,
      items: lineRows
        .filter((line) => line.orderId === row.id)
        .map(({ orderId: _orderId, quantity, priceCents, cataloguePriceCents, organizationInventoryId, ...line }) => ({
          ...line,
          // Only a desk order reaches this list; its line has no catalogue
          // entry exactly when the branch did not carry the product.
          inBranchCatalogue: organizationInventoryId !== null,
          quantity: Number(quantity),
          priceCents: Number(priceCents),
          cataloguePriceCents: cataloguePriceCents === null ? null : Number(cataloguePriceCents),
        })),
    })),
    pagination: {
      page: query.page,
      limit: query.limit,
      total: Number(total),
      totalPages: Math.ceil(Number(total) / query.limit),
    },
  }
}

/** One desk order the executive (or Super Admin) reaches, or null. Read through the reach, never around it. */
export async function loadExecutiveApprovalOrder(userId: string, orderId: number) {
  const reach = await loadDeskApprovalReach(db, userId)
  const [order] = await db
    .select({ id: orders.id, intakeAttachmentKey: orders.intakeAttachmentKey })
    .from(orders)
    .where(and(eq(orders.id, orderId), deskApprovalOrderCondition(reach)))
    .limit(1)
  return order ?? null
}
