import { viewerReadRole } from "@/lib/viewer-access"
import "server-only"

import { and, asc, count, eq, gte, inArray, isNotNull, lte, ne, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import { branches, groups, invoices, orders, organizations, users } from "@/db/schema"
import { getRequestScope, getSharedServerSession } from "@/lib/auth"
import {
  CONSOLIDATED_INVOICE_MAX_ROWS,
  buildConsolidatedInvoiceRows,
  consolidatedInvoiceFilterNote,
  consolidatedInvoicePeriodLabel,
  consolidatedInvoiceStatement,
  consolidatedInvoiceTitle,
  consolidatedInvoiceTotals,
  karachiToday,
  legacyDateFootnote,
  parseConsolidatedInvoiceQuery,
  type ConsolidatedInvoiceMode,
  type ConsolidatedInvoiceQuery,
  type ConsolidatedInvoiceRow,
  type ConsolidatedInvoiceSource,
  type ConsolidatedInvoiceTotals,
} from "@/lib/consolidated-invoice"
import { canReadConsolidatedInvoiceReport, choosesOrganization } from "@/lib/consolidated-invoice-access"
import { db } from "@/lib/db"
import { legacyCreditedTaxCents, type LegacyApprovedRefund } from "@/lib/invoice-ledger-backfill"
import { reservedInvoiceNumber } from "@/lib/invoice-ledger"
import { getReceiptUserDisplayName } from "@/lib/receipt-user"
import { invoiceStatusSql } from "@/lib/server/invoice-status-sql"
import { resolveFinanceReadScope } from "@/lib/server/finance-scope"

/**
 * The Consolidated Invoice Report's server side
 * (plans/OF-INVOICE-consolidated-invoices.md): who is asking and for which
 * organization (D1), the two bounded reads (D5), and the assembled report.
 * Both routes — the JSON preview and the PDF — call `loadConsolidatedInvoiceReport`
 * and nothing else, so they cannot authorize or select differently.
 */

export type ConsolidatedInvoiceReport = {
  mode: ConsolidatedInvoiceMode
  title: string
  statement: string
  footnote: string | null
  /** The payment-status filter, in words, when one narrowed the report. */
  filterNote: string | null
  billTo: { id: number; name: string; code: string | null; ntn: string | null; strn: string | null }
  period: { from: string; to: string; label: string }
  rows: ConsolidatedInvoiceRow[]
  totals: ConsolidatedInvoiceTotals
}

export type ReportCaller = { userId: string; role: string; session: unknown }

export type ReportOutcome =
  | { ok: true; caller: ReportCaller; query: ConsolidatedInvoiceQuery; report: ConsolidatedInvoiceReport }
  | { ok: false; status: 400 | 401 | 403 | 404 | 422; error: string; count?: number }

const STATUSES_WITHOUT_CREDITED = ["ISSUED", "PARTIALLY_CREDITED"]
const STATUSES_WITH_CREDITED = ["ISSUED", "PARTIALLY_CREDITED", "CREDITED"]

const approver = alias(users, "consolidated_invoice_approver")

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() ? value.trim() : null

/** A participant name the ledger recorded, or the live approver's for legacy rows. */
function approverName(recorded: unknown, user: { fullName: string | null; firstName: string | null; lastName: string | null; username: string | null; email: string | null } | null): string {
  const name = text(recorded)
  if (name && name !== "N/A" && name !== "Unknown") return name
  return user ? getReceiptUserDisplayName(user, "") : ""
}

const rates = (value: unknown): number[] =>
  Array.isArray(value) ? value.map(Number).filter((rate) => Number.isInteger(rate)) : []

/** Who is asking, and which organization the report is for. Never from the request for Head Office. */
async function resolveOrganization(query: ConsolidatedInvoiceQuery): Promise<
  | { ok: true; caller: ReportCaller; organization: ConsolidatedInvoiceReport["billTo"] }
  | { ok: false; status: 400 | 401 | 403 | 404; error: string }
> {
  const session = await getSharedServerSession()
  const user = (session?.user ?? null) as { id?: unknown; role?: unknown; organizationId?: unknown; branchId?: unknown } | null
  if (!user || typeof user.id !== "string") return { ok: false, status: 401, error: "Unauthorized" }
  // Both callers are GET handlers. An organization-wide Viewer reads the
  // report as Head Office does (its own organization, whatever was sent); a
  // pinned one is refused. The caller keeps its real role for the audit row.
  let readRole = viewerReadRole(user)
  // Finance reads as Super Admin, but only an organization assigned to it.
  const financeScope = await resolveFinanceReadScope({
    role: readRole,
    userId: user.id,
    requestedOrganizationIds: query.organizationId === null ? [] : [query.organizationId],
  })
  if (financeScope && !financeScope.ok) return { ok: false, status: financeScope.status, error: financeScope.error }
  if (financeScope) {
    if (query.organizationId === null) return { ok: false, status: 400, error: "organizationId is required" }
    readRole = "SUPER_ADMIN"
  }
  if (!canReadConsolidatedInvoiceReport(readRole)) return { ok: false, status: 403, error: "Forbidden" }
  const caller: ReportCaller = { userId: user.id, role: String(user.role), session }

  let organizationId: number | null
  if (choosesOrganization(readRole)) {
    if (query.organizationId === null) return { ok: false, status: 400, error: "organizationId is required" }
    organizationId = query.organizationId
  } else {
    // Head Office: the organization on its own user row, whatever was sent.
    const scope = await getRequestScope()
    organizationId = scope?.organizationId ?? null
    if (organizationId === null) return { ok: false, status: 403, error: "Forbidden" }
  }

  const [organization] = await db.select({
    id: organizations.id,
    name: organizations.name,
    code: organizations.code,
    ntn: organizations.ntnNumber,
    strn: organizations.strnNumber,
  }).from(organizations).where(eq(organizations.id, organizationId)).limit(1)
  if (!organization) return { ok: false, status: 404, error: "Organization not found" }

  return { ok: true, caller, organization }
}

/** Branch and group filters must name rows of this organization; anything else reads as not found. */
async function fenceFilters(organizationId: number, query: ConsolidatedInvoiceQuery): Promise<{ status: 404; error: string } | null> {
  if (query.branchIds.length > 0) {
    const [{ value }] = await db.select({ value: count() }).from(branches)
      .where(and(inArray(branches.id, query.branchIds), eq(branches.organizationId, organizationId)))
    if (Number(value) !== query.branchIds.length) return { status: 404, error: "Branch not found" }
  }
  if (query.groupId !== null) {
    const [group] = await db.select({ id: groups.id }).from(groups)
      .where(and(eq(groups.id, query.groupId), eq(groups.organizationId, organizationId))).limit(1)
    if (!group) return { status: 404, error: "Group not found" }
  }
  return null
}

/** Issued invoices dated in the period, less what has been credited against them. */
async function loadInvoiceSources(organizationId: number, query: ConsolidatedInvoiceQuery): Promise<{ sources: ConsolidatedInvoiceSource[]; total: number }> {
  const conditions: SQL[] = [
    eq(invoices.organizationId, organizationId),
    gte(invoices.issueDate, query.from),
    lte(invoices.issueDate, query.to),
    inArray(invoices.status, query.includeCredited ? STATUSES_WITH_CREDITED : STATUSES_WITHOUT_CREDITED),
  ]
  if (query.branchIds.length > 0) conditions.push(inArray(invoices.branchId, query.branchIds))
  if (query.groupId !== null) conditions.push(eq(branches.groupId, query.groupId))
  // Anything not marked PAID is unpaid, as `normalizePaymentStatus` reads it.
  if (query.paymentStatus === "PAID") conditions.push(eq(orders.paymentStatus, "PAID"))
  if (query.paymentStatus === "UNPAID") conditions.push(ne(orders.paymentStatus, "PAID"))
  const where = and(...conditions)

  const supplied = sql`${invoices.origin} = 'ISSUED_AT_SUPPLY'`
  const rows = await db.select({
    orderId: invoices.orderId,
    number: invoices.number,
    issueDate: invoices.issueDate,
    invoiceStatus: invoices.status,
    orderStatus: orders.status,
    paymentStatus: orders.paymentStatus,
    refundAmountCents: orders.refundAmountCents,
    approvalLevel: orders.approvalLevel,
    department: sql<string | null>`COALESCE(NULLIF(${invoices.buyer} ->> 'branchName', ''), ${branches.name})`,
    costCenterId: sql<string | null>`${invoices.buyer} ->> 'costCenterId'`,
    recordedApprover: sql<string | null>`${invoices.participants} ->> 'approvedByName'`,
    approverFullName: approver.fullName,
    approverFirstName: approver.firstName,
    approverLastName: approver.lastName,
    approverUsername: approver.username,
    approverEmail: approver.email,
    netCents: invoices.netCents,
    taxCents: invoices.taxCents,
    totalCents: invoices.totalCents,
    creditedNetCents: invoices.creditedNetCents,
    creditedTaxCents: invoices.creditedTaxCents,
    creditedTotalCents: invoices.creditedTotalCents,
    // An invoice issued at supply has its own lines and credit notes; a legacy
    // row reads its order's lines and the refunds approved against it.
    quantity: sql<string>`CASE WHEN ${supplied}
      THEN (SELECT COALESCE(SUM(l.quantity), 0) FROM invoice_lines l WHERE l.invoice_id = ${invoices.id})
      ELSE (SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = ${invoices.orderId}) END`,
    creditedQuantity: sql<string>`CASE WHEN ${supplied}
      THEN (SELECT COALESCE(SUM(cl.quantity), 0) FROM credit_note_lines cl
              JOIN credit_notes cn ON cn.id = cl.credit_note_id AND cn.organization_id = cl.organization_id
             WHERE cn.invoice_id = ${invoices.id})
      ELSE (SELECT COALESCE(SUM(ri.quantity), 0) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
             WHERE r.order_id = ${invoices.orderId} AND UPPER(r.status) IN ('APPROVED', 'COMPLETED')) END`,
    taxRates: sql<number[] | null>`CASE WHEN ${supplied}
      THEN (SELECT ARRAY_AGG(DISTINCT l.tax_rate_bp) FILTER (WHERE l.tax_rate_bp IS NOT NULL) FROM invoice_lines l WHERE l.invoice_id = ${invoices.id})
      ELSE (SELECT ARRAY_AGG(DISTINCT oi.tax_rate_bp) FILTER (WHERE oi.tax_rate_bp IS NOT NULL) FROM order_items oi WHERE oi.order_id = ${invoices.orderId}) END`,
  })
    .from(invoices)
    .innerJoin(orders, and(eq(orders.id, invoices.orderId), eq(orders.organizationId, invoices.organizationId)))
    .innerJoin(branches, and(eq(branches.id, invoices.branchId), eq(branches.organizationId, invoices.organizationId)))
    .leftJoin(approver, eq(approver.id, orders.approvedByUserId))
    .where(where)
    .orderBy(asc(invoices.issueDate), asc(invoices.number), asc(invoices.id))
    .limit(CONSOLIDATED_INVOICE_MAX_ROWS + 1)

  const total = rows.length > CONSOLIDATED_INVOICE_MAX_ROWS
    ? Number((await db.select({ value: count() }).from(invoices)
      .innerJoin(orders, and(eq(orders.id, invoices.orderId), eq(orders.organizationId, invoices.organizationId)))
      .innerJoin(branches, and(eq(branches.id, invoices.branchId), eq(branches.organizationId, invoices.organizationId)))
      .where(where))[0]?.value ?? 0)
    : rows.length

  return {
    total,
    sources: rows.map((row) => ({
      orderId: row.orderId,
      invoiceNumber: row.number,
      date: row.issueDate,
      orderStatus: row.orderStatus,
      refundAmountCents: row.refundAmountCents,
      invoiceStatus: row.invoiceStatus,
      paymentStatus: row.paymentStatus,
      department: row.department,
      approver: approverName(row.recordedApprover, row.approverFullName !== undefined ? {
        fullName: row.approverFullName, firstName: row.approverFirstName, lastName: row.approverLastName,
        username: row.approverUsername, email: row.approverEmail,
      } : null),
      approvalLevel: row.approvalLevel,
      costCenterId: row.costCenterId,
      quantity: Number(row.quantity),
      creditedQuantity: Number(row.creditedQuantity),
      taxRatesBp: rates(row.taxRates),
      netCents: Number(row.netCents),
      taxCents: Number(row.taxCents),
      totalCents: Number(row.totalCents),
      creditedNetCents: Number(row.creditedNetCents),
      creditedTaxCents: Number(row.creditedTaxCents),
      creditedTotalCents: Number(row.creditedTotalCents),
    })),
  }
}

/** Approved orders not yet delivered (no tax invoice), approved in the period. */
async function loadProformaSources(organizationId: number, query: ConsolidatedInvoiceQuery): Promise<{ sources: ConsolidatedInvoiceSource[]; total: number }> {
  const approvedOn = sql`(${orders.approvedAt} AT TIME ZONE 'Asia/Karachi')::date`
  const conditions: SQL[] = [
    eq(orders.organizationId, organizationId),
    sql`${invoiceStatusSql} = 'PROFORMA_AVAILABLE'`,
    isNotNull(orders.approvedAt),
    sql`${approvedOn} BETWEEN ${query.from}::date AND ${query.to}::date`,
  ]
  if (query.branchIds.length > 0) conditions.push(inArray(orders.branchId, query.branchIds))
  if (query.groupId !== null) conditions.push(eq(branches.groupId, query.groupId))
  const where = and(...conditions)

  const rows = await db.select({
    orderId: orders.id,
    tid: orders.tid,
    reservedNumber: sql<string | null>`${orders.receiptData} ->> 'invoiceNumber'`,
    approvedOn: sql<string>`to_char(${approvedOn}, 'YYYY-MM-DD')`,
    orderStatus: orders.status,
    paymentStatus: orders.paymentStatus,
    refundAmountCents: orders.refundAmountCents,
    approvalLevel: orders.approvalLevel,
    department: branches.name,
    costCenterId: branches.costCenterId,
    approverFullName: approver.fullName,
    approverFirstName: approver.firstName,
    approverLastName: approver.lastName,
    approverUsername: approver.username,
    approverEmail: approver.email,
    subtotalCents: orders.subtotalCents,
    taxCents: orders.taxCents,
    totalCents: orders.totalCents,
    quantity: sql<string>`(SELECT COALESCE(SUM(oi.quantity), 0) FROM order_items oi WHERE oi.order_id = ${orders.id})`,
    refundedQuantity: sql<string>`(SELECT COALESCE(SUM(ri.quantity), 0) FROM refund_items ri JOIN refunds r ON r.id = ri.refund_id
      WHERE r.order_id = ${orders.id} AND UPPER(r.status) IN ('APPROVED', 'COMPLETED'))`,
    taxRates: sql<number[] | null>`(SELECT ARRAY_AGG(DISTINCT oi.tax_rate_bp) FILTER (WHERE oi.tax_rate_bp IS NOT NULL) FROM order_items oi WHERE oi.order_id = ${orders.id})`,
    approvedRefunds: sql<LegacyApprovedRefund[] | null>`(SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
        'amountCents', r.amount_cents,
        'taxRefundCents', r.tax_refund_cents,
        'lines', COALESCE((SELECT JSONB_AGG(JSONB_BUILD_OBJECT('grossCents', ri.amount_cents, 'taxRateBp', oi.tax_rate_bp))
                             FROM refund_items ri JOIN order_items oi ON oi.id = ri.order_item_id WHERE ri.refund_id = r.id), '[]'::jsonb)
      ) ORDER BY r.id) FROM refunds r WHERE r.order_id = ${orders.id} AND UPPER(r.status) IN ('APPROVED', 'COMPLETED'))`,
  })
    .from(orders)
    .innerJoin(branches, and(eq(branches.id, orders.branchId), eq(branches.organizationId, orders.organizationId)))
    .leftJoin(approver, eq(approver.id, orders.approvedByUserId))
    .where(where)
    .orderBy(asc(orders.approvedAt), asc(orders.id))
    .limit(CONSOLIDATED_INVOICE_MAX_ROWS + 1)

  const total = rows.length > CONSOLIDATED_INVOICE_MAX_ROWS
    ? Number((await db.select({ value: count() }).from(orders)
      .innerJoin(branches, and(eq(branches.id, orders.branchId), eq(branches.organizationId, orders.organizationId)))
      .where(where))[0]?.value ?? 0)
    : rows.length

  return {
    total,
    sources: rows.map((row) => {
      const totalCents = Number(row.totalCents)
      const taxCents = Number(row.taxCents)
      const refunds = (row.approvedRefunds ?? []).map((refund) => ({
        amountCents: Number(refund.amountCents),
        taxRefundCents: Number(refund.taxRefundCents),
        lines: (refund.lines ?? []).map((line) => ({
          grossCents: Number(line.grossCents),
          taxRateBp: line.taxRateBp === null ? null : Number(line.taxRateBp),
        })),
      }))
      // What a refund before delivery took back, split as the ledger splits it.
      const creditedTotalCents = Math.min(Math.max(0, Number(row.refundAmountCents ?? 0)), totalCents)
      const creditedTaxCents = Math.min(legacyCreditedTaxCents({ approvedRefunds: refunds, taxCents, totalCents }), creditedTotalCents, taxCents)
      return {
        orderId: row.orderId,
        invoiceNumber: reservedInvoiceNumber({ invoiceNumber: row.reservedNumber }, row.tid),
        date: row.approvedOn,
        orderStatus: row.orderStatus,
        refundAmountCents: row.refundAmountCents,
        invoiceStatus: "PROFORMA_AVAILABLE",
        paymentStatus: row.paymentStatus,
        department: row.department,
        approver: approverName(null, row.approverFullName !== undefined ? {
          fullName: row.approverFullName, firstName: row.approverFirstName, lastName: row.approverLastName,
          username: row.approverUsername, email: row.approverEmail,
        } : null),
        approvalLevel: row.approvalLevel,
        costCenterId: row.costCenterId,
        quantity: Number(row.quantity),
        creditedQuantity: Number(row.refundedQuantity),
        taxRatesBp: rates(row.taxRates),
        netCents: Number(row.subtotalCents),
        taxCents,
        totalCents,
        creditedNetCents: creditedTotalCents - creditedTaxCents,
        creditedTaxCents,
        creditedTotalCents,
      }
    }),
  }
}

/**
 * The whole report for this request: parse, authorize, scope, fence, read,
 * build. Returns a refusal with its status for each way it can fail.
 */
export async function loadConsolidatedInvoiceReport(params: URLSearchParams, now: Date = new Date()): Promise<ReportOutcome> {
  const parsed = parseConsolidatedInvoiceQuery(params, karachiToday(now))
  // Identity is checked before the query is judged, so an anonymous caller
  // learns nothing about what a valid query looks like.
  const resolved = await resolveOrganization(parsed.ok ? parsed.query : { organizationId: null } as ConsolidatedInvoiceQuery)
  if (!resolved.ok && resolved.status !== 400) return resolved
  if (!parsed.ok) return { ok: false, status: 400, error: parsed.error }
  if (!resolved.ok) return resolved
  const { query } = parsed
  const { caller, organization } = resolved

  const fenced = await fenceFilters(organization.id, query)
  if (fenced) return { ok: false, ...fenced }

  const { sources, total } = query.mode === "invoices"
    ? await loadInvoiceSources(organization.id, query)
    : await loadProformaSources(organization.id, query)
  if (total > CONSOLIDATED_INVOICE_MAX_ROWS) {
    return {
      ok: false,
      status: 422,
      count: total,
      error: `This selection has ${total.toLocaleString("en-US")} ${query.mode === "invoices" ? "invoices" : "proformas"}, more than ${CONSOLIDATED_INVOICE_MAX_ROWS.toLocaleString("en-US")}: narrow the period or branches.`,
    }
  }

  const rows = buildConsolidatedInvoiceRows(query.mode, sources, query.sort)
  return {
    ok: true,
    caller,
    query,
    report: {
      mode: query.mode,
      title: consolidatedInvoiceTitle(query.mode),
      statement: consolidatedInvoiceStatement(query.mode),
      footnote: legacyDateFootnote(query.mode, query.from),
      filterNote: consolidatedInvoiceFilterNote(query.paymentStatus),
      billTo: organization,
      period: { from: query.from, to: query.to, label: consolidatedInvoicePeriodLabel(query.from, query.to) },
      rows,
      totals: consolidatedInvoiceTotals(rows),
    },
  }
}
