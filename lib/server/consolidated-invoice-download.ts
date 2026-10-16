import "server-only"

import { createHash } from "node:crypto"

import { consolidatedInvoiceDigestInput, type ConsolidatedInvoiceDownloadFormat, type ConsolidatedInvoiceQuery } from "@/lib/consolidated-invoice"
import { db } from "@/lib/db"
import { auditActorFromSession, recordAuditEvent } from "@/lib/server/activity-audit"
import type { ConsolidatedInvoiceReport, ReportCaller } from "@/lib/server/consolidated-invoice-report"

/**
 * Every download of the Consolidated Invoice Report — PDF, Excel or CSV — is
 * audited the same way, with a SHA-256 of the printed `(number, total)` list,
 * so a document handed to a client can be verified later whatever its format.
 */
export async function recordConsolidatedInvoiceDownload(input: {
  format: ConsolidatedInvoiceDownloadFormat
  report: ConsolidatedInvoiceReport
  query: ConsolidatedInvoiceQuery
  caller: ReportCaller
  generatedAt: Date
}): Promise<void> {
  const { format, report, query, caller, generatedAt } = input
  const digest = createHash("sha256").update(consolidatedInvoiceDigestInput(report.rows)).digest("hex")
  await recordAuditEvent(db, {
    action: "DOWNLOAD_CONSOLIDATED_INVOICE_REPORT",
    entity: "consolidated_invoice_report",
    entityId: digest.slice(0, 16),
    actor: auditActorFromSession(caller.session),
    organizationId: report.billTo.id,
    context: {
      format,
      mode: report.mode,
      from: report.period.from,
      to: report.period.to,
      branchIds: query.branchIds,
      groupId: query.groupId,
      includeCredited: query.includeCredited,
      paymentStatus: query.paymentStatus,
      sort: query.sort,
      rowCount: report.rows.length,
      totalCents: report.totals.totalCents,
      digest,
      generatedAt: generatedAt.toISOString(),
    },
  })
}
