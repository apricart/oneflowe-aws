import { approverLevelOf } from "@/lib/consolidated-invoice"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { getOrderStatusDisplay } from "@/lib/order-status-display"

/**
 * The fixed column layout of the Order Report download.
 *
 * Unlike the table on screen, whose columns the reader toggles, the download is
 * a settled document handed to a tenant: the same columns, in the same order,
 * every time, so two exports taken weeks apart line up. The only column that is
 * ever withheld is a money column, and only where `lib/price-visibility.ts` has
 * already decided this role may not read prices.
 */
export type OrderReportExportColumnKey =
  | "serialNumber"
  | "orderId"
  | "tid"
  | "initiator"
  | "initiatedDate"
  | "approver"
  | "approvalLevel"
  | "approverDesignation"
  | "approvedDate"
  | "deliveredDate"
  | "fulfiller"
  | "fulfilledDate"
  | "group"
  | "branch"
  | "status"
  | "quantityOrdered"
  | "quantityDelivered"
  | "quantityRefunded"
  | "subtotal"
  | "refund"
  | "netTotal"
  | "invoiceNumber"
  | "paymentStatus"

export interface OrderReportExportColumn {
  key: OrderReportExportColumnKey
  label: string
  /** Buyer-facing wording, used where the tenant purchases rather than sells. */
  buyerLabel?: string
  /** Withheld when the caller's role may not read prices. */
  financial?: boolean
}

export const ORDER_REPORT_EXPORT_COLUMNS: readonly OrderReportExportColumn[] = [
  { key: "serialNumber", label: "S. No" },
  { key: "orderId", label: "Order ID" },
  { key: "tid", label: "Transaction ID" },
  { key: "initiator", label: "Initiator" },
  { key: "initiatedDate", label: "Initiated Date" },
  { key: "approver", label: "Approver" },
  { key: "approvalLevel", label: "Approval Level" },
  { key: "approverDesignation", label: "Approver Designation" },
  { key: "approvedDate", label: "Approved Date" },
  { key: "deliveredDate", label: "Delivered Date" },
  { key: "fulfiller", label: "Fulfiller" },
  { key: "fulfilledDate", label: "Fulfilled Date" },
  { key: "group", label: "Group" },
  { key: "branch", label: "Branch" },
  { key: "status", label: "Status" },
  { key: "quantityOrdered", label: "Qty Ordered" },
  { key: "quantityDelivered", label: "Qty Delivered" },
  { key: "quantityRefunded", label: "Qty Refunded" },
  { key: "subtotal", label: "Subtotal", financial: true },
  { key: "refund", label: "Refund", financial: true },
  { key: "netTotal", label: "Net Value", buyerLabel: "Net Purchased", financial: true },
  { key: "invoiceNumber", label: "Invoice No" },
  { key: "paymentStatus", label: "Payment Status" },
] as const

/** A date as it arrives from JSON, or as a `Date` when built in-process. */
type ReportDate = string | Date | null

/**
 * One order as the report endpoint returns it. Every field is optional because
 * the row is assembled from a JSON response, and an order that never reached
 * approval, delivery or fulfilment simply has no date or actor to report.
 */
export interface OrderReportExportRecord {
  id?: number | string | null
  tid?: string | null
  status?: string | null
  fulfillmentStatus?: string | null
  paymentStatus?: string | null
  userName?: string | null
  approverName?: string | null
  approverDesignation?: string | null
  /** The band the order was decided at (1 = highest), null when unlevelled. */
  approvalLevel?: number | null
  fulfillerName?: string | null
  createdAt?: ReportDate
  approvedAt?: ReportDate
  deliveredAt?: ReportDate
  fulfilledAt?: ReportDate
  refundedAt?: ReportDate
  groupName?: string | null
  branchName?: string | null
  invoiceNumber?: string | null
  quantityOrdered?: number | null
  quantityRefunded?: number | null
  subtotalCents?: number | null
  totalCents?: number | null
  refundAmountCents?: number | null
}

export interface OrderReportExportOptions {
  /** True where `lib/price-visibility.ts` has hidden prices from this role. */
  pricesHidden?: boolean
  /** True for roles that buy rather than sell, which renames the net column. */
  isBuyer?: boolean
}

/**
 * Absent values are left blank rather than dashed.
 *
 * A dash is not merely a style choice here: `sanitizeSpreadsheetRow` treats a
 * leading "-" as formula-like and prefixes it with an apostrophe, which Excel
 * hides but a CSV reader shows verbatim as `'-`. A blank cell needs no
 * neutralising, reads correctly in both formats, and keeps the numeric and date
 * columns sortable.
 */
const EMPTY_TEXT = ""
const EMPTY_DATE = ""

export function resolveOrderReportExportColumns(
  options: OrderReportExportOptions = {},
): OrderReportExportColumn[] {
  return ORDER_REPORT_EXPORT_COLUMNS.filter((column) => !(options.pricesHidden && column.financial))
}

export function resolveOrderReportExportHeaders(
  options: OrderReportExportOptions = {},
): string[] {
  return resolveOrderReportExportColumns(options).map((column) =>
    options.isBuyer && column.buyerLabel ? column.buyerLabel : column.label,
  )
}

function toText(value: unknown): string {
  if (value === null || value === undefined) return EMPTY_TEXT
  const text = String(value).trim()
  return text.length > 0 ? text : EMPTY_TEXT
}

function toDate(value: ReportDate | undefined): string {
  if (!value) return EMPTY_DATE
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? EMPTY_DATE : date.toLocaleDateString()
}

function toQuantity(value: number | null | undefined): number {
  return Number.isFinite(Number(value)) ? Number(value) : 0
}

/** Money is carried as integer cents everywhere and only formatted at the edge. */
function toMoney(cents: number | null | undefined): string {
  return (toQuantity(cents) / 100).toFixed(2)
}

export function resolveOrderReportExportValue(
  column: OrderReportExportColumn,
  order: OrderReportExportRecord,
  serialNumber: number,
): string | number {
  switch (column.key) {
    case "serialNumber":
      return serialNumber
    case "orderId":
      return toText(order.id)
    case "tid":
      return toText(order.tid)
    case "initiator":
      return toText(order.userName)
    case "initiatedDate":
      return toDate(order.createdAt)
    case "approver":
      return toText(order.approverName)
    case "approvalLevel":
      return approverLevelOf(order.approvalLevel).approverLevel
    case "approverDesignation":
      return toText(order.approverDesignation)
    case "approvedDate":
      return toDate(order.approvedAt)
    case "deliveredDate":
      return toDate(order.deliveredAt)
    case "fulfiller":
      return toText(order.fulfillerName)
    case "fulfilledDate":
      return toDate(order.fulfilledAt)
    case "group":
      return toText(order.groupName)
    case "branch":
      return toText(order.branchName)
    case "status":
      return getOrderDerivedStatus({ status: order.status as string }).label || EMPTY_TEXT
    case "quantityOrdered":
      return toQuantity(order.quantityOrdered)
    case "quantityDelivered":
      // What the branch kept: everything ordered less everything refunded back.
      return toQuantity(order.quantityOrdered) - toQuantity(order.quantityRefunded)
    case "quantityRefunded":
      return toQuantity(order.quantityRefunded)
    case "subtotal":
      return toMoney(order.subtotalCents)
    case "refund":
      return toMoney(order.refundAmountCents)
    case "netTotal":
      return toMoney(toQuantity(order.totalCents) - toQuantity(order.refundAmountCents))
    case "invoiceNumber":
      return toText(order.invoiceNumber)
    case "paymentStatus":
      return getOrderStatusDisplay(order as never).paymentStatus || EMPTY_TEXT
    default:
      return EMPTY_TEXT
  }
}

export function buildOrderReportExportRows(
  orders: readonly OrderReportExportRecord[],
  options: OrderReportExportOptions = {},
): (string | number)[][] {
  const columns = resolveOrderReportExportColumns(options)
  return orders.map((order, index) =>
    columns.map((column) => resolveOrderReportExportValue(column, order, index + 1)),
  )
}
