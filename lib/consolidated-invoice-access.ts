/**
 * Who may read the Consolidated Invoice Report
 * (plans/OF-INVOICE-consolidated-invoices.md, D1).
 *
 * A role allowlist rather than a `Permission` key: a new key only takes effect
 * after `db:seed` rewrites `role_permissions` on production (the reasoning in
 * lib/product-request-access.ts). Super Admin reads the organization it
 * selects; Head Office reads its own; Finance selects one of the organizations
 * assigned to it (`resolveFinanceReadScope`, which then reads it as Super
 * Admin). The sidebar, the Reports hub, `proxy.ts` and both route handlers
 * read this list.
 */
export const CONSOLIDATED_INVOICE_REPORT_ROLES = ["SUPER_ADMIN", "HEAD_OFFICE", "FINANCE"] as const

export const CONSOLIDATED_INVOICE_REPORT_AREA = "/reports/consolidated-invoices"

export function canReadConsolidatedInvoiceReport(role: unknown): boolean {
  return typeof role === "string"
    && (CONSOLIDATED_INVOICE_REPORT_ROLES as readonly string[]).includes(role)
}

/**
 * Super Admin and Finance name the organization (Finance one of its own,
 * checked on the server); every other reader is pinned to its own.
 */
export function choosesOrganization(role: unknown): boolean {
  return role === "SUPER_ADMIN" || role === "FINANCE"
}
