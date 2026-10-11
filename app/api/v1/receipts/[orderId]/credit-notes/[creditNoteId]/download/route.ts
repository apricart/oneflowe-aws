import { NextRequest, NextResponse } from "next/server"

import { creditNoteDocument } from "@/lib/invoice-ledger-document"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { safeFilenamePart } from "@/lib/security"
import { authorizeInvoiceRequest } from "@/lib/server/invoice-access"
import { loadCreditNoteForOrder } from "@/lib/server/invoice-ledger-reads"
import { renderInvoicePdf } from "@/lib/server/invoice-pdf"

const POSITIVE_ID = /^[1-9]\d{0,9}$/

/**
 * GET /api/v1/receipts/[orderId]/credit-notes/[creditNoteId]/download
 *
 * A credit note issued against an order's invoice
 * (plans/OF-INVOICE-invoice-ledger.md, D4). Whoever may download the order's
 * invoice may download its credit notes, and nobody else: access is the same
 * `authorizeInvoiceRequest` the invoice download uses, the credit note is read
 * only through that order, and a price-restricted caller is refused as for the
 * invoice itself.
 */
export async function GET(
  _req: NextRequest,
  props: { params: Promise<{ orderId: string; creditNoteId: string }> },
) {
  try {
    const { orderId: orderIdParam, creditNoteId: creditNoteIdParam } = await props.params
    if (!POSITIVE_ID.test(orderIdParam) || !POSITIVE_ID.test(creditNoteIdParam)) {
      return NextResponse.json({ error: "Invalid ID" }, { status: 400 })
    }

    const access = await authorizeInvoiceRequest(Number(orderIdParam))
    if (!access.ok) {
      return NextResponse.json({ error: access.denial.error }, { status: access.denial.status })
    }
    const { order, role } = access

    if (await shouldHidePricesForRole(role, order.organizationId)) {
      return NextResponse.json({ error: "Credit note download is unavailable while prices are hidden" }, { status: 403 })
    }

    const ledger = await loadCreditNoteForOrder(order, Number(creditNoteIdParam))
    if (!ledger) return NextResponse.json({ error: "Credit note not found" }, { status: 404 })

    const pdf = renderInvoicePdf(creditNoteDocument({
      creditNote: ledger.creditNote,
      lines: ledger.lines,
      invoice: ledger.invoice,
      order: { id: order.id, tid: order.tid },
    }))
    const fileName = `credit-note-${safeFilenamePart(ledger.creditNote.number, String(ledger.creditNote.id))}.pdf`

    return new NextResponse(pdf, {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    console.error("Credit note generation error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}
