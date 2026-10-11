import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const files = vi.hoisted(() => ({ written: [] as Array<{ name: string; rows: unknown[][] }> }))
vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>()
  return {
    ...actual,
    writeFile: vi.fn((book: any, name: string) => {
      const sheet = book.Sheets[book.SheetNames[0]]
      files.written.push({ name, rows: actual.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][] })
    }),
  }
})
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import OrderReportPage from "./page"

/**
 * The Order Report with its real table, tabs and export. The table is
 * server-paginated, so search and status filters must be sent to the server,
 * and the export must collect every page of the filtered set rather than the
 * page on screen.
 */
function order(id: number, overrides: Record<string, unknown> = {}) {
  return {
    id,
    tid: `TID-${String(id).padStart(4, "0")}`,
    createdAt: "2026-08-10T10:00:00.000Z",
    status: "FULFILLED",
    fulfillmentStatus: "DELIVERED",
    paymentStatus: "UNPAID",
    totalCents: 100_000,
    subtotalCents: 100_000,
    taxCents: 0,
    refundAmountCents: 0,
    organizationName: "Acme",
    branchName: "North",
    userName: "Ahmed Khan",
    userId: "u-1",
    employeeId: "E-1",
    ...overrides,
  }
}

function routes(pages: Array<ReturnType<typeof order>[]> = [[order(1), order(2, { status: "PENDING", branchName: "South" })]]) {
  const total = pages.flat().length
  installFetch([
    ["/api/v1/analytics/summary", (url: URL) => {
      if (url.searchParams.get("summaryOnly") === "true") {
        return { pricesHidden: false, summary: { totalSales: 200_000, totalRefunds: 0, totalTax: 0, totalSubtotal: 200_000, orderCount: total, totalOrderCount: total } }
      }
      if (url.searchParams.get("trendOnly") === "true" || url.searchParams.get("allTime") === "true") {
        return { pricesHidden: false, orders: pages.flat(), trend: [] }
      }
      const page = Number(url.searchParams.get("page") || 1)
      return {
        pricesHidden: false,
        orders: pages[page - 1] ?? [],
        pagination: { page, limit: 25, total, totalPages: pages.length },
      }
    }],
    ["/api/v1/analytics/earliest-record", { year: 2025 }],
    ["/api/v1/groups", { items: [] }],
    ["/api/v1/branches", { items: [{ id: 11, name: "North" }] }],
    ["/api/v1/organizations", { items: [{ id: 5, name: "Acme" }] }],
  ])
}

async function openReports() {
  const tab = await screen.findByRole("tab", { name: /Reports/ })
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
  fireEvent.click(tab)
}

async function exportAs(label: RegExp) {
  const trigger = await screen.findByText("EXPORT")
  await waitFor(() => expect((trigger.closest("button") as HTMLButtonElement).disabled).toBe(false))
  fireEvent.pointerDown(trigger.closest("button")!, { button: 0, ctrlKey: false, pointerType: "mouse" })
  fireEvent.click(await screen.findByText(label))
}

beforeEach(() => {
  resetUi({ id: "ho-1", role: "HEAD_OFFICE", organizationId: 5 })
  files.written.length = 0
  toast.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Order Report", () => {
  it("lists the report page of orders for the organization", async () => {
    routes()
    renderWithApp(<OrderReportPage />)
    await openReports()

    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))
    expect(screen.getAllByText("TID-0002").length).toBeGreaterThan(0)
    const report = callsTo("/api/v1/analytics/summary").find((call) => call.url.includes("ordersOnly=true"))!
    expect(report.url).toContain("organizationId=5")
  })

  it("sends the status filter and the search to the server, not just the page on screen", async () => {
    routes()
    renderWithApp(<OrderReportPage />)
    await openReports()
    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))

    fireEvent.click(screen.getAllByText("Pending Approval").find((node) => node.tagName === "BUTTON")!)
    await waitFor(() => expect(callsTo("/api/v1/analytics/summary").some((call) => call.url.includes("status=pending"))).toBe(true))

    fireEvent.change(screen.getByPlaceholderText("Search Transaction..."), { target: { value: "TID-0002" } })
    await waitFor(() => expect(callsTo("/api/v1/analytics/summary").some((call) => call.url.includes("q=TID-0002"))).toBe(true), { timeout: 3000 })
  })

  it("exports every page of the filtered orders, not only the visible one", async () => {
    routes([[order(1), order(2)], [order(3)], [order(4)]])
    renderWithApp(<OrderReportPage />)
    await openReports()
    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))

    await exportAs(/EXCEL WORKBOOK/)
    await waitFor(() => expect(files.written).toHaveLength(1))
    const [file] = files.written
    expect(file.name).toMatch(/^order-report-\d+\.xlsx$/)
    const body = file.rows.slice(1).map((row) => row.join("|"))
    for (const tid of ["TID-0001", "TID-0002", "TID-0003", "TID-0004"]) {
      expect(body.some((row) => row.includes(tid)), tid).toBe(true)
    }
    expect(body).toHaveLength(4)
  })

  it("neutralises spreadsheet formulas typed into exported fields", async () => {
    routes([[order(1, { userName: "=HYPERLINK(\"http://evil\")" })]])
    renderWithApp(<OrderReportPage />)
    await openReports()
    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))

    await exportAs(/CSV ARCHIVE/)
    await waitFor(() => expect(files.written).toHaveLength(1))
    const cells = files.written[0].rows.flat().map(String)
    expect(cells.some((cell) => cell.startsWith("="))).toBe(false)
  })

  it("reports an export failure instead of failing silently", async () => {
    routes()
    renderWithApp(<OrderReportPage />)
    await openReports()
    await waitFor(() => expect(screen.getAllByText("TID-0001").length).toBeGreaterThan(0))

    installFetch([["/api/v1/analytics/summary", { status: 500, body: { error: "boom" } }]])
    await exportAs(/CSV ARCHIVE/)
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Export failed" })))
    expect(files.written).toHaveLength(0)
  })
})
