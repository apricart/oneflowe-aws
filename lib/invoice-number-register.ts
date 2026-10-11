/**
 * What became of each number an organization's invoice series drew
 * (plans/OF-INVOICE-invoice-ledger.md, D6). Pure; the report script reads the
 * rows and writes the file.
 */
import { formatInvoiceNumber } from "@/lib/invoice-number"
import { isOrderSupplied } from "@/lib/invoice-status"

export type RegisterOrder = {
  orderId: number
  status: string | null
  fulfillmentStatus: string | null
  statusAtRefund: string | null
  invoiceIssueDate: string | null
}

export type RegisterFate =
  | "ISSUED"
  | "RESERVED"
  | "PENDING"
  | "NOT_ISSUED_REJECTED"
  | "NOT_ISSUED_CANCELLED"
  | "NOT_ISSUED_REFUNDED"
  | "NOT_ISSUED_OTHER"
  | "DELETED"
  | "UNACCOUNTED"

export type RegisterEntry = {
  number: string
  fate: RegisterFate
  orderId: number | string | null
  orderStatus: string | null
  invoiceIssueDate: string | null
  detail: string | null
}

/**
 * The spellings one sequence value has carried: `<CODE>-APR-000036` since
 * 2026-09-24, and the unprefixed `APR-000036` before it.
 */
export function registerNumberCandidates(organizationCode: string, sequence: number): string[] {
  const legacy = `APR-${String(sequence).padStart(6, "0")}`
  const code = organizationCode.trim().toUpperCase()
  if (!/^[A-Z0-9_]+$/.test(code)) return [legacy]
  return [formatInvoiceNumber(code, sequence), legacy]
}

function normalized(value: string | null): string {
  return String(value ?? "").trim().toUpperCase()
}

const NOT_ISSUED: Record<string, { fate: RegisterFate; detail: string }> = {
  APPROVED: { fate: "RESERVED", detail: "approved, awaiting delivery" },
  PENDING: { fate: "PENDING", detail: "awaiting approval" },
  REJECTED: { fate: "NOT_ISSUED_REJECTED", detail: "order rejected" },
  CANCELLED: { fate: "NOT_ISSUED_CANCELLED", detail: "order cancelled" },
  REFUNDED: { fate: "NOT_ISSUED_REFUNDED", detail: "refunded in full before delivery" },
}

/** What became of a number an order still holds. */
function fateOfOrder(number: string, order: RegisterOrder): RegisterEntry {
  const base = { number, orderId: order.orderId, orderStatus: order.status, invoiceIssueDate: order.invoiceIssueDate }
  if (order.invoiceIssueDate || isOrderSupplied(order)) return { ...base, fate: "ISSUED", detail: null }
  const known = NOT_ISSUED[normalized(order.status)]
  return known
    ? { ...base, ...known }
    : { ...base, fate: "NOT_ISSUED_OTHER", detail: `order status ${order.status ?? "unknown"}` }
}

export function classifyRegisteredNumber(
  candidates: string[],
  orderByNumber: Map<string, RegisterOrder>,
  deletedByNumber: Map<string, { orderId: string; deletedAt: string }>,
): RegisterEntry {
  for (const number of candidates) {
    const order = orderByNumber.get(number)
    if (order) return fateOfOrder(number, order)
  }
  for (const number of candidates) {
    const deleted = deletedByNumber.get(number)
    if (deleted) {
      return {
        number,
        fate: "DELETED",
        orderId: deleted.orderId,
        orderStatus: null,
        invoiceIssueDate: null,
        detail: `order deleted ${deleted.deletedAt}`,
      }
    }
  }
  return {
    number: candidates[0],
    fate: "UNACCOUNTED",
    orderId: null,
    orderStatus: null,
    invoiceIssueDate: null,
    detail: "no surviving order or deletion record",
  }
}
