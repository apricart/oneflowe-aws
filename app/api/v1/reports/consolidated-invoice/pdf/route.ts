import { NextRequest, NextResponse } from "next/server"

import { getSharedServerSession } from "@/lib/auth"
import { consolidatedInvoiceFileName } from "@/lib/consolidated-invoice"
import { withRateLimit } from "@/lib/rate-limiter"
import { recordConsolidatedInvoiceDownload } from "@/lib/server/consolidated-invoice-download"
import { renderConsolidatedInvoicePdf } from "@/lib/server/consolidated-invoice-pdf"
import { loadConsolidatedInvoiceReport } from "@/lib/server/consolidated-invoice-report"

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" }

/**
 * GET /api/v1/reports/consolidated-invoice/pdf
 *
 * The Consolidated Invoice Report as a PDF in the supplied template
 * (plans/OF-INVOICE-consolidated-invoices.md). It is built from the very
 * report the JSON preview returns — same authorization, organization, fence,
 * rows and order — and each download is audited with a digest of what it
 * printed, so a document handed to a client can be verified later.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSharedServerSession()
    const userId = (session?.user as { id?: unknown } | undefined)?.id
    const limited = await withRateLimit("report", typeof userId === "string" ? userId : undefined)
    if (limited) return limited

    const outcome = await loadConsolidatedInvoiceReport(new URL(req.url).searchParams)
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error, ...(outcome.count === undefined ? {} : { count: outcome.count }) },
        { status: outcome.status, headers: NO_STORE },
      )
    }

    const { report, query, caller } = outcome
    const generatedAt = new Date()
    const pdf = renderConsolidatedInvoicePdf({
      title: report.title,
      statement: report.statement,
      footnote: report.footnote,
      filterNote: report.filterNote,
      billTo: report.billTo,
      periodLabel: report.period.label,
      rows: report.rows,
      totals: report.totals,
      generatedAt,
    })

    await recordConsolidatedInvoiceDownload({ format: "pdf", report, query, caller, generatedAt })

    const fileName = consolidatedInvoiceFileName(report.mode, report.billTo.code, report.period.from, report.period.to, query.paymentStatus, "pdf")
    return new NextResponse(pdf, {
      headers: {
        ...NO_STORE,
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    console.error("Consolidated invoice PDF error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500, headers: NO_STORE })
  }
}
