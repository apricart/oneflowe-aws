import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

import { ReportTableScroll } from "./report-table-scroll"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * Every table under the Reports menu. A report table missing from this list is
 * free to fall back to page scrolling, which hides its horizontal scrollbar
 * below the last row — add a new one here when it is built.
 */
const REPORT_TABLE_SOURCES: Array<[path: string, tables: number]> = [
  ["app/(portal)/reports/organization-report/page.tsx", 1],
  ["app/(portal)/reports/order-report/page.tsx", 1],
  ["app/(portal)/reports/refund-report/page.tsx", 1],
  ["app/(portal)/reports/budget-summary/page.tsx", 1],
  ["app/(portal)/reports/product-performance/page.tsx", 2],
  ["app/(portal)/reports/user-report/page.tsx", 1],
  ["app/(portal)/reports/branch-reports/page.tsx", 1],
  ["app/(portal)/reports/groups/page.tsx", 1],
  ["components/group-portal/group-order-report.tsx", 2],
]

describe("ReportTableScroll", () => {
  afterEach(() => {
    cleanup()
  })

  it("bounds the table in its own scroll box so the horizontal scrollbar stays in view", () => {
    render(
      <ReportTableScroll data-testid="box" className="flex-1">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Branch</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell>North</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </ReportTableScroll>,
    )

    const box = screen.getByTestId("box")
    expect(box.className).toContain("report-table-scroll")
    expect(box.className).toMatch(/max-h-\[/)
    expect(box.className).toContain("flex-1")
    // The Table primitive's own overflow wrapper must be the direct child, or
    // the scroll, sticky-header and spacing rules in globals.css never reach it.
    expect(box.firstElementChild?.getAttribute("data-slot")).toBe("table-container")
  })

  it("scrolls on both axes, neutralises the inner wrapper and sticks the header row", () => {
    const css = source("app/globals.css")

    expect(css).toMatch(/\.report-table-scroll \{\s*overflow: auto;/)
    expect(css).toMatch(/\.report-table-scroll > \[data-slot="table-container"\] \{\s*overflow: visible;/)
    expect(css).toMatch(
      /\.report-table-scroll > \[data-slot="table-container"\] > table > thead > tr > th \{\s*position: sticky;\s*top: 0;/,
    )
  })

  it.each(REPORT_TABLE_SOURCES)("wraps every table in %s", (path, tables) => {
    const file = source(path)
    const opened = file.match(/<Table[\s>]/g)?.length ?? 0
    const wrapped = file.match(/<ReportTableScroll[\s>]/g)?.length ?? 0

    expect(opened).toBe(tables)
    expect(wrapped).toBe(tables)
  })
})
