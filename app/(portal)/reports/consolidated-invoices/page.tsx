"use client"

import { Suspense } from "react"

import { ConsolidatedInvoiceReport } from "@/components/reports/consolidated-invoice/consolidated-invoice-report"

/**
 * Reports → Consolidated Invoice Report. Super Admin and Head Office only:
 * `proxy.ts` sends anyone else back to /reports, and both API routes refuse
 * them (plans/OF-INVOICE-consolidated-invoices.md, D1).
 */
export default function ConsolidatedInvoicesPage() {
  return (
    <Suspense fallback={null}>
      <ConsolidatedInvoiceReport />
    </Suspense>
  )
}
