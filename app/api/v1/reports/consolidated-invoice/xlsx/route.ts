import { NextRequest, NextResponse } from "next/server"

import { getSharedServerSession } from "@/lib/auth"
import { consolidatedInvoiceFileName } from "@/lib/consolidated-invoice"
import { withRateLimit } from "@/lib/rate-limiter"
import { recordConsolidatedInvoiceDownload } from "@/lib/server/consolidated-invoice-download"
import { loadConsolidatedInvoiceReport } from "@/lib/server/consolidated-invoice-report"
import { renderConsolidatedInvoiceXlsx } from "@/lib/server/consolidated-invoice-spreadsheet"

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" }

/**
 * GET /api/v1/reports/consolidated-invoice/xlsx
 *
 * The Consolidated Invoice Report as an Excel workbook. Built from the very
 * report the JSON preview and the PDF return — same authorization,
 * organization, fence, rows and order — and audited like the PDF, with a
 * digest of what it lists.
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
    const workbook = renderConsolidatedInvoiceXlsx({
      mode: report.mode,
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

    await recordConsolidatedInvoiceDownload({ format: "xlsx", report, query, caller, generatedAt })

    const fileName = consolidatedInvoiceFileName(report.mode, report.billTo.code, report.period.from, report.period.to, query.paymentStatus, "xlsx")
    return new NextResponse(workbook as BodyInit, {
      headers: {
        ...NO_STORE,
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    console.error("Consolidated invoice Excel error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500, headers: NO_STORE })
  }
}
