/**
 * When an invoice is numbered (plans/OF-INVOICE-invoice-ledger.md, D6).
 *
 * `"delivery"`: an order carries no invoice number until its delivery is
 * recorded, when the tax invoice is issued, numbered and dated
 * (`issueTaxInvoiceAtDelivery`). Rejected and cancelled orders therefore burn no
 * number, and the series stays gap-free.
 *
 * `"creation"`: the behaviour before the ledger, kept as the switch back. Each
 * order draws its number when it is placed; the tax invoice still issues at
 * delivery, with that number.
 *
 * A constant in code, deliberately not an environment variable, like
 * `PASSWORD_CHANGE_EMAIL_VERIFICATION`: the numbering of tax invoices is not
 * something a deployment should be able to change by accident.
 */
export type InvoiceIssuePoint = "creation" | "delivery"

export const INVOICE_ISSUE_POINT: InvoiceIssuePoint = "delivery"

export function drawsInvoiceNumberAtCreation(point: InvoiceIssuePoint = INVOICE_ISSUE_POINT): boolean {
  return point === "creation"
}
