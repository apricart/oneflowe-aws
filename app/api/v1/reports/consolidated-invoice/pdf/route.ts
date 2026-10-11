import { createHash } from "node:crypto"
import { NextRequest, NextResponse } from "next/server"

import { getSharedServerSession } from "@/lib/auth"
import { consolidatedInvoiceDigestInput, consolidatedInvoiceFileName } from "@/lib/consolidated-invoice"
import { db } from "@/lib/db"
import { withRateLimit } from "@/lib/rate-limiter"
import { auditActorFromSession, recordAuditEvent } from "@/lib/server/activity-audit"
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
      billTo: report.billTo,
      periodLabel: report.period.label,
      rows: report.rows,
      totals: report.totals,
      generatedAt,
    })

    const digest = createHash("sha256").update(consolidatedInvoiceDigestInput(report.rows)).digest("hex")
    await recordAuditEvent(db, {
      action: "DOWNLOAD_CONSOLIDATED_INVOICE_REPORT",
      entity: "consolidated_invoice_report",
      entityId: digest.slice(0, 16),
      actor: auditActorFromSession(caller.session),
      organizationId: report.billTo.id,
      context: {
        mode: report.mode,
        from: report.period.from,
        to: report.period.to,
        branchIds: query.branchIds,
        groupId: query.groupId,
        includeCredited: query.includeCredited,
        sort: query.sort,
        rowCount: report.rows.length,
        totalCents: report.totals.totalCents,
        digest,
        generatedAt: generatedAt.toISOString(),
      },
    })

    const fileName = consolidatedInvoiceFileName(report.mode, report.billTo.code, report.period.from, report.period.to)
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
