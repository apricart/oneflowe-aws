import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

/**
 * The Consolidated Invoice Report's structural guarantees
 * (plans/OF-INVOICE-consolidated-invoices.md). Each is a rule the behaviour
 * tests cannot see on their own: that both routes go through one loader, that
 * the organization comes from the user row, and that navigation offers the
 * report to the two roles that may read it and nobody else.
 */
const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const ROUTES = [
  "app/api/v1/reports/consolidated-invoice/route.ts",
  "app/api/v1/reports/consolidated-invoice/pdf/route.ts",
  "app/api/v1/reports/consolidated-invoice/xlsx/route.ts",
  "app/api/v1/reports/consolidated-invoice/csv/route.ts",
]

const DOWNLOAD_ROUTES: ReadonlyArray<[path: string, format: string]> = [
  ["app/api/v1/reports/consolidated-invoice/pdf/route.ts", "pdf"],
  ["app/api/v1/reports/consolidated-invoice/xlsx/route.ts", "xlsx"],
  ["app/api/v1/reports/consolidated-invoice/csv/route.ts", "csv"],
]

describe("the consolidated invoice report", () => {
  it("is served by both routes through the one loader, with no query of their own", () => {
    for (const path of ROUTES) {
      const route = source(path)
      expect(route).toContain("await loadConsolidatedInvoiceReport(new URL(req.url).searchParams)")
      expect(route).not.toMatch(/db\s*\.\s*select|from\(invoices\)|from\(orders\)/)
      expect(route).toContain("withRateLimit(")
      expect(route).toContain("no-store")
    }
  })

  it("checks the role and takes Head Office's organization from its user row", () => {
    const report = source("lib/server/consolidated-invoice-report.ts")
    // Checked on the read role: an organization-wide Viewer reads it as Head
    // Office (its own organization below), a pinned one maps to no role.
    expect(report).toContain("let readRole = viewerReadRole(user)")
    // Finance reads it as Super Admin, but only for an organization assigned
    // to it (plans/OF-FINANCE-finance-role.md).
    expect(report).toContain("const financeScope = await resolveFinanceReadScope({")
    expect(report).toContain("if (financeScope && !financeScope.ok) return { ok: false, status: financeScope.status, error: financeScope.error }")
    expect(report).toContain("canReadConsolidatedInvoiceReport(readRole)")
    expect(report).toContain("const scope = await getRequestScope()")
    expect(report).toContain("organizationId = scope?.organizationId ?? null")
  })

  it("reads invoices by their ledger date and never parses a snapshot date", () => {
    const report = source("lib/server/consolidated-invoice-report.ts")
    expect(report).toContain("gte(invoices.issueDate, query.from)")
    expect(report).toContain("lte(invoices.issueDate, query.to)")
    expect(report).not.toContain("'date'")
    expect(report).not.toContain("to_date(")
  })

  it("audits every download, in every format, with a digest of what it printed", () => {
    const audit = source("lib/server/consolidated-invoice-download.ts")
    expect(audit).toContain('action: "DOWNLOAD_CONSOLIDATED_INVOICE_REPORT"')
    expect(audit).toContain("consolidatedInvoiceDigestInput(report.rows)")
    for (const [path, format] of DOWNLOAD_ROUTES) {
      const route = source(path)
      expect(route, path).toContain(`await recordConsolidatedInvoiceDownload({ format: "${format}", report, query, caller, generatedAt })`)
      expect(route, path).toContain("X-Content-Type-Options")
      expect(route, path).toContain("attachment; filename=")
    }
  })

  it("is offered only to Super Admin and Head Office, and gated for everyone else", () => {
    const sidebar = source("components/shell/sidebar.tsx")
    expect(sidebar.split('href: "/reports/consolidated-invoices"').length - 1).toBe(2)
    expect(source("app/(portal)/reports/page.tsx")).toContain("canReadConsolidatedInvoiceReport(role)")
    expect(source("proxy.ts")).toContain(
      "{ prefix: CONSOLIDATED_INVOICE_REPORT_AREA, roles: [...CONSOLIDATED_INVOICE_REPORT_ROLES, \"VIEWER\"], home: \"/reports\" }",
    )
  })
})
