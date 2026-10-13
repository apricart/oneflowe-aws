import { FULFILLMENT_STATUSES, normalizeFulfillmentStatus, type FulfillmentStatus } from "@/lib/fulfillment-status"

/**
 * When an invoice is numbered (plans/OF-INVOICE-invoice-ledger.md, D6, as
 * amended by plans/OF-INVOICE-issue-at-processing.md).
 *
 * `"processing"`: an order carries no invoice number until it is marked In
 * Process, when the tax invoice is issued, numbered and dated
 * (`issueTaxInvoice`), so the warehouse can print it and send it with the
 * goods. Rejected and cancelled orders therefore burn no number, and the series
 * stays gap-free.
 *
 * `"creation"`: the behaviour before the ledger, kept as the switch back. Each
 * order draws its number when it is placed; the tax invoice still issues at
 * `TAX_INVOICE_ISSUE_STAGE`, with that number.
 *
 * A constant in code, deliberately not an environment variable, like
 * `PASSWORD_CHANGE_EMAIL_VERIFICATION`: the numbering of tax invoices is not
 * something a deployment should be able to change by accident.
 */
export type InvoiceIssuePoint = "creation" | "processing"

export const INVOICE_ISSUE_POINT: InvoiceIssuePoint = "processing"

export function drawsInvoiceNumberAtCreation(point: InvoiceIssuePoint = INVOICE_ISSUE_POINT): boolean {
  return point === "creation"
}

/**
 * The delivery stage whose recording issues the tax invoice. Was `DELIVERED`
 * until 2026-10-13; the warehouse hands the invoice over with the goods, so it
 * has to exist before they leave.
 */
export const TAX_INVOICE_ISSUE_STAGE: FulfillmentStatus = "IN_PROCESS"

const ISSUE_STAGE_INDEX = FULFILLMENT_STATUSES.indexOf(TAX_INVOICE_ISSUE_STAGE)

/** The stages at which an order has no tax invoice yet. */
export const STAGES_BEFORE_TAX_INVOICE: readonly FulfillmentStatus[] = FULFILLMENT_STATUSES.slice(0, ISSUE_STAGE_INDEX)

/**
 * Whether moving an order to `nextStatus` issues its tax invoice: the issue
 * stage, and every stage after it. Issuing is idempotent, so an order that
 * passed the issue stage without one (it was already there when the stage
 * moved) is issued it on its next step rather than never.
 */
export function issuesTaxInvoiceOnStep(nextStatus: FulfillmentStatus): boolean {
  return FULFILLMENT_STATUSES.indexOf(nextStatus) >= ISSUE_STAGE_INDEX
}

/** Whether an order at this delivery stage has not reached the issue stage yet. */
export function isBeforeTaxInvoiceStage(fulfillmentStatus: string | null | undefined): boolean {
  return STAGES_BEFORE_TAX_INVOICE.includes(normalizeFulfillmentStatus(fulfillmentStatus))
}
