/**
 * The Consolidated Invoice Report, as pure rules
 * (plans/OF-INVOICE-consolidated-invoices.md).
 *
 * Everything that decides what the report says lives here: the query it
 * accepts, the period it covers, each row's figures, the totals, the order,
 * and the document's wording. The preview and the PDF render what this
 * returns, so they cannot disagree. Money is integer cents throughout.
 */
import { z } from "zod"

import { formatInvoiceDisplayDate } from "@/lib/invoice-format"
import { toInvoiceStatus, type InvoiceStatus } from "@/lib/invoice-status"
import {
  CONSOLIDATED_INVOICE_SORT_KEYS,
  type ConsolidatedInvoiceSortKey,
} from "@/lib/list-sort-keys"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { PAYMENT_STATUSES, PAYMENT_STATUS_LABELS, normalizePaymentStatus, type PaymentStatus } from "@/lib/payment-status"
import { roundQuantity } from "@/lib/quantity"
import { safeFilenamePart } from "@/lib/security"
import { sortRows, type SortState, type SortValue } from "@/lib/table-sort"

export const CONSOLIDATED_INVOICE_MAX_ROWS = 1_000
export const CONSOLIDATED_INVOICE_MAX_BRANCH_IDS = 200
export const CONSOLIDATED_INVOICE_MAX_RANGE_DAYS = 366
/** Invoices dated before this carry their order date; later ones the date they were issued. */
export const LEDGER_GO_LIVE_DATE = "2026-10-11"

export const CONSOLIDATED_INVOICE_MODES = ["invoices", "proformas"] as const
export type ConsolidatedInvoiceMode = (typeof CONSOLIDATED_INVOICE_MODES)[number]

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const POSITIVE_ID = /^[1-9]\d{0,9}$/

const querySchema = z.object({
  organizationId: z.string().regex(POSITIVE_ID).optional(),
  mode: z.enum(CONSOLIDATED_INVOICE_MODES).optional(),
  period: z.enum(["month", "range"]),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM").optional(),
  from: z.string().regex(ISO_DATE, "from must be YYYY-MM-DD").optional(),
  to: z.string().regex(ISO_DATE, "to must be YYYY-MM-DD").optional(),
  branchIds: z.string().regex(/^[1-9]\d{0,9}(,[1-9]\d{0,9})*$/, "branchIds must be a comma-separated list of ids").optional(),
  groupId: z.string().regex(POSITIVE_ID).optional(),
  includeCredited: z.enum(["true", "false"]).optional(),
  paymentStatus: z.enum(PAYMENT_STATUSES).optional(),
  sort: z.enum(CONSOLIDATED_INVOICE_SORT_KEYS).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
}).strict()

export type ConsolidatedInvoiceQuery = {
  /** As sent; only Super Admin's is honoured (the handler decides). */
  organizationId: number | null
  mode: ConsolidatedInvoiceMode
  from: string
  to: string
  branchIds: number[]
  groupId: number | null
  includeCredited: boolean
  /** Invoices only: those marked paid, or those not. Null is every invoice. */
  paymentStatus: PaymentStatus | null
  sort: SortState<ConsolidatedInvoiceSortKey>
}

export type QueryParse = { ok: true; query: ConsolidatedInvoiceQuery } | { ok: false; error: string }

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

/** Inclusive number of calendar days from `from` to `to`. */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
}

function lastDayOfMonth(month: string): string {
  const [year, monthNumber] = month.split("-").map(Number)
  const last = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return `${month}-${String(last).padStart(2, "0")}`
}

function resolvePeriod(input: { period: "month" | "range"; month?: string; from?: string; to?: string }, today: string):
  | { ok: true; from: string; to: string }
  | { ok: false; error: string } {
  if (input.period === "month") {
    if (!input.month) return { ok: false, error: "month is required for a monthly period" }
    if (input.from || input.to) return { ok: false, error: "from and to belong to a custom range, not a month" }
    if (`${input.month}-01` > today) return { ok: false, error: "The month cannot be in the future" }
    const to = lastDayOfMonth(input.month)
    return { ok: true, from: `${input.month}-01`, to: to > today ? today : to }
  }
  if (input.month) return { ok: false, error: "month belongs to a monthly period, not a custom range" }
  if (!input.from || !input.to) return { ok: false, error: "from and to are required for a custom range" }
  if (!isCalendarDate(input.from) || !isCalendarDate(input.to)) return { ok: false, error: "from and to must be real dates" }
  if (input.from > input.to) return { ok: false, error: "from must not be after to" }
  if (input.to > today) return { ok: false, error: "to cannot be in the future" }
  if (daysInclusive(input.from, input.to) > CONSOLIDATED_INVOICE_MAX_RANGE_DAYS) {
    return { ok: false, error: `A custom range covers at most ${CONSOLIDATED_INVOICE_MAX_RANGE_DAYS} days` }
  }
  return { ok: true, from: input.from, to: input.to }
}

/**
 * The report's query string, strictly. An unknown or repeated parameter is
 * refused rather than ignored: either would let the report cover something
 * other than what was asked for.
 *
 * `today` is the Karachi date the request is made on.
 */
export function parseConsolidatedInvoiceQuery(params: URLSearchParams, today: string): QueryParse {
  const keys = [...params.keys()]
  if (new Set(keys).size !== keys.length) return { ok: false, error: "Each parameter may be sent once" }
  const parsed = querySchema.safeParse(Object.fromEntries(params.entries()))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: issue ? `${issue.path.join(".") || "query"}: ${issue.message}` : "Invalid query" }
  }
  const input = parsed.data
  const period = resolvePeriod(input, today)
  if (!period.ok) return period

  const branchIds = input.branchIds ? input.branchIds.split(",").map(Number) : []
  if (branchIds.length > CONSOLIDATED_INVOICE_MAX_BRANCH_IDS) {
    return { ok: false, error: `At most ${CONSOLIDATED_INVOICE_MAX_BRANCH_IDS} branches may be selected` }
  }
  if (new Set(branchIds).size !== branchIds.length) return { ok: false, error: "A branch may be selected once" }
  if (input.dir && !input.sort) return { ok: false, error: "dir needs a sort column" }
  // A proforma is never paid (payment status moves only once an order is
  // delivered), so the filter would silently match all of them or none.
  if (input.paymentStatus && input.mode === "proformas") {
    return { ok: false, error: "paymentStatus applies to invoices, not proformas" }
  }

  return {
    ok: true,
    query: {
      organizationId: input.organizationId ? Number(input.organizationId) : null,
      mode: input.mode ?? "invoices",
      from: period.from,
      to: period.to,
      branchIds,
      groupId: input.groupId ? Number(input.groupId) : null,
      includeCredited: input.includeCredited === "true",
      paymentStatus: input.paymentStatus ?? null,
      sort: input.sort ? { key: input.sort, direction: input.dir ?? "asc" } : null,
    },
  }
}

/** One invoice (or proforma) as read from the database, before any rule is applied. */
export type ConsolidatedInvoiceSource = {
  orderId: number
  /** The ledger number; for a proforma, the number reserved at placement, if any. */
  invoiceNumber: string | null
  /** YYYY-MM-DD: the invoice's issue date, or a proforma's approval date. */
  date: string
  orderStatus: string | null
  refundAmountCents: number | null
  invoiceStatus: string | null
  paymentStatus: string | null
  department: string | null
  approver: string | null
  /** `orders.approval_level`: the level the order was decided at; null when it was not levelled. */
  approvalLevel: number | null
  costCenterId: string | null
  quantity: number
  creditedQuantity: number
  taxRatesBp: number[]
  netCents: number
  taxCents: number
  totalCents: number
  creditedNetCents: number
  creditedTaxCents: number
  creditedTotalCents: number
}

export type ConsolidatedInvoiceRow = {
  serial: number
  orderId: number
  invoiceNumber: string
  /** YYYY-MM-DD, for sorting. */
  date: string
  invoiceDate: string
  orderStatus: string
  invoiceStatus: InvoiceStatus | null
  paymentStatus: PaymentStatus
  department: string
  approver: string
  /** "Level 1"…; blank when the order was not decided at a level. */
  approverLevel: string
  /** The level, for sorting; null when the order was not levelled. */
  approvalLevel: number | null
  designation: string
  crc: string
  quantity: number
  taxRateLabel: string
  /** The single rate, for sorting; null when mixed or unknown. */
  taxRateBp: number | null
  valueExclTaxCents: number
  taxCents: number
  totalCents: number
}

export type ConsolidatedInvoiceTotals = {
  orders: number
  quantity: number
  valueExclTaxCents: number
  taxCents: number
  totalCents: number
}

const cents = (value: unknown): number => {
  const parsed = Math.round(Number(value))
  return Number.isFinite(parsed) ? parsed : 0
}

const text = (value: unknown): string =>
  typeof value === "string" && value.trim() ? value.trim() : ""

function formatRate(bp: number): string {
  return `${Number((bp / 100).toFixed(2))}%`
}

/**
 * The rate an invoice was charged at: one rate is named, several are "Mixed".
 * A line without a recorded rate (older K-Electric imports) is inferred from
 * the invoice's own net and tax, only when the cents reconstruct it.
 */
export function taxRateOf(source: Pick<ConsolidatedInvoiceSource, "taxRatesBp" | "netCents" | "taxCents">): { label: string; bp: number | null } {
  const rates = [...new Set(source.taxRatesBp.filter((rate) => Number.isInteger(rate) && rate > 0))]
  if (rates.length === 1) return { label: formatRate(rates[0]), bp: rates[0] }
  if (rates.length > 1) return { label: "Mixed", bp: null }
  const net = cents(source.netCents)
  const tax = cents(source.taxCents)
  if (net > 0 && tax > 0) {
    const bp = Math.round((tax * 10_000) / net)
    if (bp > 0 && bp <= 10_000 && Math.abs(Math.round((net * bp) / 10_000) - tax) <= 1) return { label: formatRate(bp), bp }
  }
  return { label: "—", bp: null }
}

function displayedNumber(mode: ConsolidatedInvoiceMode, number: string | null): string {
  const value = text(number)
  if (mode === "invoices") return value || "—"
  return value ? `${value} (when processed)` : "When processed"
}

/**
 * The level the order was approved at, as printed beside the approver. Only a
 * level the database could hold (1–10, `orders_approval_level_ck`) is named;
 * anything else prints blank, as an order decided without levels does.
 */
export function approverLevelOf(level: number | null | undefined): { approverLevel: string; approvalLevel: number | null } {
  return Number.isInteger(level) && (level as number) >= 1 && (level as number) <= 10
    ? { approverLevel: `Level ${level}`, approvalLevel: level as number }
    : { approverLevel: "", approvalLevel: null }
}

/** One row: the invoice less everything credited against it (D4). */
export function buildConsolidatedInvoiceRow(mode: ConsolidatedInvoiceMode, source: ConsolidatedInvoiceSource, serial: number): ConsolidatedInvoiceRow {
  const rate = taxRateOf(source)
  const derived = getOrderDerivedStatus({ status: source.orderStatus ?? "", refundAmountCents: source.refundAmountCents }, "fulfilled")
  return {
    serial,
    orderId: source.orderId,
    invoiceNumber: displayedNumber(mode, source.invoiceNumber),
    date: source.date,
    invoiceDate: formatInvoiceDisplayDate(source.date) || source.date,
    orderStatus: derived.label,
    invoiceStatus: toInvoiceStatus(source.invoiceStatus),
    paymentStatus: normalizePaymentStatus(source.paymentStatus),
    department: text(source.department),
    approver: text(source.approver),
    ...approverLevelOf(source.approvalLevel),
    designation: "",
    crc: text(source.costCenterId),
    quantity: Math.max(0, roundQuantity(Number(source.quantity) - Number(source.creditedQuantity))),
    taxRateLabel: rate.label,
    taxRateBp: rate.bp,
    valueExclTaxCents: Math.max(0, cents(source.netCents) - cents(source.creditedNetCents)),
    taxCents: Math.max(0, cents(source.taxCents) - cents(source.creditedTaxCents)),
    totalCents: Math.max(0, cents(source.totalCents) - cents(source.creditedTotalCents)),
  }
}

const SORT_ACCESSORS: Record<ConsolidatedInvoiceSortKey, (row: ConsolidatedInvoiceRow) => SortValue> = {
  invoiceNumber: (row) => row.invoiceNumber,
  invoiceDate: (row) => row.date,
  orderId: (row) => row.orderId,
  orderStatus: (row) => row.orderStatus,
  department: (row) => row.department.toLowerCase(),
  approver: (row) => row.approver.toLowerCase(),
  approverLevel: (row) => row.approvalLevel,
  crc: (row) => row.crc.toLowerCase(),
  quantity: (row) => row.quantity,
  valueExclTax: (row) => row.valueExclTaxCents,
  taxRate: (row) => row.taxRateBp,
  tax: (row) => row.taxCents,
  total: (row) => row.totalCents,
}

/**
 * Every row, in the requested order (or the query's own: invoice date, then
 * number), numbered in that order.
 */
export function buildConsolidatedInvoiceRows(
  mode: ConsolidatedInvoiceMode,
  sources: ConsolidatedInvoiceSource[],
  sort: SortState<ConsolidatedInvoiceSortKey>,
): ConsolidatedInvoiceRow[] {
  const rows = sources.map((source, index) => buildConsolidatedInvoiceRow(mode, source, index + 1))
  return sortRows(rows, sort, SORT_ACCESSORS).map((row, index) => ({ ...row, serial: index + 1 }))
}

export function consolidatedInvoiceTotals(rows: ConsolidatedInvoiceRow[]): ConsolidatedInvoiceTotals {
  return rows.reduce<ConsolidatedInvoiceTotals>((sum, row) => ({
    orders: sum.orders + 1,
    quantity: roundQuantity(sum.quantity + row.quantity),
    valueExclTaxCents: sum.valueExclTaxCents + row.valueExclTaxCents,
    taxCents: sum.taxCents + row.taxCents,
    totalCents: sum.totalCents + row.totalCents,
  }), { orders: 0, quantity: 0, valueExclTaxCents: 0, taxCents: 0, totalCents: 0 })
}

export function consolidatedInvoiceTitle(mode: ConsolidatedInvoiceMode): string {
  return mode === "invoices" ? "CONSOLIDATED INVOICE" : "CONSOLIDATED PROFORMA"
}

/** What the document is, said on every page. */
export function consolidatedInvoiceStatement(mode: ConsolidatedInvoiceMode): string {
  return mode === "invoices"
    ? "Summary of the tax invoices listed; sales tax is charged on each. Not a separate tax invoice."
    : "Proformas only; no tax invoice has been issued for these orders."
}

/** Shown when the period includes invoices dated before the ledger, which carry their order date. */
export function legacyDateFootnote(mode: ConsolidatedInvoiceMode, from: string): string | null {
  if (mode !== "invoices" || from >= LEDGER_GO_LIVE_DATE) return null
  return "Invoices dated before 11 Oct 2026 carry their order date; later invoices carry the date they were issued."
}

/**
 * What a payment-status filter left out, said on the document beside the
 * period, so a Grand Total covering only unpaid invoices is never read as the
 * whole period's.
 */
export function consolidatedInvoiceFilterNote(paymentStatus: PaymentStatus | null): string | null {
  return paymentStatus ? `${PAYMENT_STATUS_LABELS[paymentStatus]} invoices only` : null
}

export function consolidatedInvoicePeriodLabel(from: string, to: string): string {
  return `${formatInvoiceDisplayDate(from) || from} – ${formatInvoiceDisplayDate(to) || to}`
}

/** The formats the report downloads in; each is built from the same rows. */
export const CONSOLIDATED_INVOICE_DOWNLOAD_FORMATS = ["pdf", "xlsx", "csv"] as const
export type ConsolidatedInvoiceDownloadFormat = (typeof CONSOLIDATED_INVOICE_DOWNLOAD_FORMATS)[number]

export function consolidatedInvoiceFileName(
  mode: ConsolidatedInvoiceMode,
  organizationCode: string | null,
  from: string,
  to: string,
  paymentStatus: PaymentStatus | null = null,
  format: ConsolidatedInvoiceDownloadFormat = "pdf",
): string {
  const kind = mode === "invoices" ? "invoice" : "proforma"
  const filter = paymentStatus ? `-${paymentStatus.toLowerCase()}` : ""
  return `consolidated-${kind}-${safeFilenamePart(organizationCode ?? "", "organization")}-${from}_${to}${filter}.${format}`
}

/** What the download audit's digest covers: each row's number and total, in printed order. */
export function consolidatedInvoiceDigestInput(rows: ConsolidatedInvoiceRow[]): string {
  return JSON.stringify(rows.map((row) => [row.invoiceNumber, row.totalCents]))
}

/** A quantity as the report prints it: whole numbers plain, fractions to three places at most. */
export function formatReportQuantity(value: number): string {
  if (!Number.isFinite(value)) return "0"
  return Number.isInteger(value)
    ? value.toLocaleString("en-US")
    : value.toLocaleString("en-US", { maximumFractionDigits: 3 })
}

/** Cents as the report prints money: 1,234.50. */
export function formatReportMoney(valueCents: number): string {
  return (cents(valueCents) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** The Karachi calendar date of an instant, as `YYYY-MM-DD`. */
export function karachiToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
}
