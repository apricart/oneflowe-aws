import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative, resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * The invoice ledger's structural guarantees (plans/OF-INVOICE-invoice-ledger.md).
 * Each list below is the control: a new writer or a new approval path goes on
 * it deliberately, or this fails.
 */
const root = process.cwd()
const source = (path: string) => readFileSync(resolve(root, path), "utf8")

function filesUnder(dir: string): string[] {
  const absolute = resolve(root, dir)
  return readdirSync(absolute).flatMap((name) => {
    const path = join(absolute, name)
    if (statSync(path).isDirectory()) return name === "node_modules" ? [] : filesUnder(relative(root, path))
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [relative(root, path).replaceAll("\\", "/")] : []
  })
}

/** Every module allowed to write a ledger table. */
const LEDGER_WRITERS = new Set([
  "lib/server/invoice-issuance.ts",
  "lib/server/credit-notes.ts",
  "scripts/backfill-invoice-ledger.ts",
])

const LEDGER_WRITE = /\b(insert|update|delete)\((invoices|invoiceLines|creditNotes|creditNoteLines)\)|\b(insert\s+into|update|delete\s+from)\s+(invoices|invoice_lines|credit_notes|credit_note_lines)\b/i

describe("the invoice ledger", () => {
  it("is written only by the issuing modules and the backfill", () => {
    const writers = ["app", "lib", "scripts"].flatMap(filesUnder)
      .filter((path) => LEDGER_WRITE.test(source(path)))
    expect(writers.sort()).toEqual([...LEDGER_WRITERS].sort())
  })

  it("issues the tax invoice inside the delivery transaction, which is the only place delivery is recorded", () => {
    const progress = source("lib/server/order-fulfillment-progress.ts")
    expect(progress).toContain("await issueTaxInvoiceAtDelivery(tx, { orderId, actor })")
    const transaction = progress.slice(progress.indexOf("db.transaction"), progress.indexOf("transitionErrorOutcome(transitionError)"))
    expect(transaction).toContain("issueTaxInvoiceAtDelivery")
  })

  it("issues a credit note on both refund-approval paths", () => {
    for (const path of ["app/api/v1/orders/[id]/refunds/route.ts", "app/api/v1/admin/refunds/route.ts"]) {
      expect(source(path)).toContain("await issueCreditNoteForRefund(tx, {")
      expect(source(path)).toContain("...CREDIT_NOTE_CONFLICT_ERRORS")
    }
  })

  it("never rewrites an issued invoice's snapshot on refund", () => {
    for (const path of ["app/api/v1/orders/[id]/refunds/route.ts", "app/api/v1/admin/refunds/route.ts", "lib/receipt-generator.ts"]) {
      expect(source(path)).not.toContain("updateReceiptWithRefund")
    }
  })

  it("prints an issued invoice from its own rows on every invoice surface", () => {
    for (const path of ["app/api/v1/receipts/[orderId]/route.ts", "lib/server/invoice-document.ts"]) {
      expect(source(path)).toContain("await invoiceDocumentForOrder(order,")
    }
  })

  it("refuses to delete an order that carries a tax invoice", () => {
    expect(source("app/api/v1/admin/delete-order/route.ts")).toContain('throw new Error("ORDER_DELETE_TAX_INVOICED")')
  })

  it("keeps the database's immutability triggers in the migration", () => {
    const migration = source("drizzle/20261015120000_add_invoice_ledger.sql")
    for (const trigger of ["invoices_guard_trg", "invoice_lines_immutable_trg", "credit_notes_immutable_trg", "credit_note_lines_immutable_trg"]) {
      expect(migration).toContain(`CREATE TRIGGER ${trigger}`)
    }
    // The test-cleanup exception is bound to a database named for tests.
    expect(migration).toContain("SELECT current_database() LIKE '%test%'")
  })

  it("answers an organization with no company code plainly, at creation and at delivery", () => {
    for (const path of ["app/api/v1/orders/[id]/fulfillment-status/route.ts", "app/api/v1/warehouse/orders/[id]/progress/route.ts"]) {
      expect(source(path)).toContain('case "invoice-code-missing":')
      expect(source(path)).toContain("return error(INVOICE_CODE_MISSING_MESSAGE, 409)")
    }
    expect(source("app/api/v1/orders/route.ts")).toContain("if (isInvoiceCodeMissingError(caughtError)) {")
    expect(source("lib/server/group-order-creation.ts")).toContain("if (isInvoiceCodeMissingError(caughtError)) return caughtError.message")
  })

  it("prices every approved refund line through one rule, and re-checks it under the order lock", () => {
    for (const path of ["app/api/v1/orders/[id]/refunds/route.ts", "app/api/v1/admin/refunds/route.ts"]) {
      expect(source(path)).toContain("refundLineAmountCents({")
      expect(source(path)).toContain("refundDetailsStillPriced(")
      expect(source(path)).not.toContain("calculateLineCents(")
    }
  })

  it("sets the test-cleanup switch nowhere outside the integration helpers", () => {
    const offenders = ["app", "lib", "scripts", "components"].flatMap(filesUnder)
      .filter((path) => source(path).includes("invoice_ledger_test_cleanup"))
    expect(offenders).toEqual([])
  })
})
