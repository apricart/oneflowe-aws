import { NextRequest, NextResponse } from "next/server"

import { getSharedServerSession } from "@/lib/auth"
import { withRateLimit } from "@/lib/rate-limiter"
import { loadConsolidatedInvoiceReport } from "@/lib/server/consolidated-invoice-report"

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0" }

/**
 * GET /api/v1/reports/consolidated-invoice
 *
 * The Consolidated Invoice Report as JSON, for the preview
 * (plans/OF-INVOICE-consolidated-invoices.md). Super Admin and Head Office
 * only; Head Office is pinned to its own organization. Authorization, the
 * organization, the filter fence, the read and the figures all come from
 * `loadConsolidatedInvoiceReport`, which the PDF route shares.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getSharedServerSession()
    const userId = (session?.user as { id?: unknown } | undefined)?.id
    const limited = await withRateLimit("search", typeof userId === "string" ? userId : undefined)
    if (limited) return limited

    const outcome = await loadConsolidatedInvoiceReport(new URL(req.url).searchParams)
    if (!outcome.ok) {
      return NextResponse.json(
        { error: outcome.error, ...(outcome.count === undefined ? {} : { count: outcome.count }) },
        { status: outcome.status, headers: NO_STORE },
      )
    }

    const { report } = outcome
    return NextResponse.json({
      mode: report.mode,
      title: report.title,
      statement: report.statement,
      footnote: report.footnote,
      billTo: { name: report.billTo.name, code: report.billTo.code, ntn: report.billTo.ntn, strn: report.billTo.strn },
      period: report.period,
      rows: report.rows,
      totals: report.totals,
      count: report.rows.length,
    }, { headers: NO_STORE })
  } catch (error) {
    console.error("Consolidated invoice report error:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500, headers: NO_STORE })
  }
}
