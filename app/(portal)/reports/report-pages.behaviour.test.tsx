import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import captured from "@/tests/fixtures/report-responses.json"
import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
vi.mock("xlsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("xlsx")>()
  return { ...actual, writeFile: vi.fn() }
})
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import GroupsReportPage from "./groups/page"
import OrganizationReportPage from "./organization-report/page"
import RefundReportPage from "./refund-report/page"

/**
 * The Groups, Organization and Refund reports, fed responses captured from the
 * real handlers over the synthetic executive-analytics history
 * (`tests/fixtures/report-responses.json`), so the shapes are the ones the
 * server really sends.
 */
async function openTab(name: RegExp) {
  const tab = await screen.findByRole("tab", { name })
  fireEvent.mouseDown(tab, { button: 0, ctrlKey: false })
  fireEvent.click(tab)
}

const common: Array<[string | RegExp, unknown]> = [
  ["/api/v1/analytics/earliest-record", { year: 2025 }],
  ["/api/v1/groups", { items: [{ id: 228, name: "Distribution" }] }],
  ["/api/v1/branches", { items: [] }],
  ["/api/v1/organizations", { items: [{ id: 321, name: "IT Exec Org S" }] }],
]

beforeEach(() => {
  resetUi({ id: "ho-1", role: "HEAD_OFFICE", organizationId: 321 })
  toast.mockClear()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("Groups report", () => {
  function routes(groups = captured.groups) {
    installFetch([
      ["/api/v1/analytics/groups", (url: URL) => {
        if (url.searchParams.get("allTime") === "true") return captured.groupsAllTime
        if (url.searchParams.get("summaryOnly") === "true") return captured.groupsSummary
        if (url.searchParams.get("trendOnly") === "true") return captured.groupsTrend
        return groups
      }],
      ...common,
    ])
  }

  it("asks for the organization's groups and lists them", async () => {
    routes()
    renderWithApp(<GroupsReportPage />)
    await openTab(/Reports?/i)
    await waitFor(() => expect(screen.getAllByText("Distribution").length).toBeGreaterThan(0))
    expect(callsTo("/api/v1/analytics/groups").every((call) => call.url.includes("organizationId=321"))).toBe(true)
  })

  it("filters groups by name", async () => {
    routes()
    renderWithApp(<GroupsReportPage />)
    await openTab(/Reports?/i)
    await waitFor(() => expect(screen.getAllByText("Distribution").length).toBeGreaterThan(0))
    fireEvent.change(screen.getByPlaceholderText("Search groups..."), { target: { value: "zzz" } })
    await waitFor(() => {
      const table = screen.getByPlaceholderText("Search groups...").closest("div[class]")?.parentElement?.parentElement
      expect(table?.textContent ?? "").not.toMatch(/Distribution\s*active/i)
    })
  })

  it("renders with no groups", async () => {
    routes({ ...captured.groups, groups: [] })
    renderWithApp(<GroupsReportPage />)
    await openTab(/Reports?/i)
    await waitFor(() => expect(callsTo("/api/v1/analytics/groups").length).toBeGreaterThan(2))
    expect(document.body.textContent?.length).toBeGreaterThan(0)
  })
})

describe("Organization report", () => {
  function routes(stats = captured.orgStats) {
    installFetch([
      ["/api/v1/analytics/organization-stats", (url: URL) => (url.searchParams.get("allTime") === "true" ? captured.orgStatsAllTime : stats)],
      ...common,
    ])
  }

  it("shows each organization's figures", async () => {
    resetUi({ id: "sa", role: "SUPER_ADMIN" })
    routes()
    renderWithApp(<OrganizationReportPage />)
    await waitFor(() => expect(screen.getAllByText("IT Exec Org S").length).toBeGreaterThan(0))
    await openTab(/Reports?/i)
    await waitFor(() => expect(screen.getAllByText("IT Exec Org S").length).toBeGreaterThan(0))

    fireEvent.change(screen.getByPlaceholderText("Search companies..."), { target: { value: "nothing" } })
    await waitFor(() => expect(screen.queryAllByText("IT Exec Org S").filter((node) => node.closest("tbody"))).toHaveLength(0))
  })

  it("renders an empty answer", async () => {
    resetUi({ id: "sa", role: "SUPER_ADMIN" })
    routes({ items: [], trend: [] } as any)
    renderWithApp(<OrganizationReportPage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/organization-stats").length).toBeGreaterThan(0))
    expect(document.body.textContent?.length).toBeGreaterThan(0)
  })
})

describe("Refund report", () => {
  const ITEM = {
    id: 9,
    refundNumber: "Refund-000009",
    tid: "TID-0041",
    status: "APPROVED",
    refundType: "PARTIAL",
    amountCents: 50_000,
    itemRefundCents: 50_000,
    taxRefundCents: 0,
    orderTotalCents: 550_000,
    quantityRefunded: 2,
    reason: "Damaged",
    createdAt: "2026-09-10T10:00:00.000Z",
    organizationName: "IT Exec Org S",
    branchName: "North S",
    groupName: "Distribution",
    requestedByName: "Ahmed",
    requestedByEmail: "ahmed@example.test",
    requestedByEmployeeId: "E-1",
    processedByName: "Admin",
    processedByEmail: "admin@example.test",
    items: [{ productName: "Paper", quantity: 2, amountCents: 50_000 }],
  }

  function routes(items: unknown[] = [ITEM]) {
    installFetch([
      ["/api/v1/analytics/refunds", {
        ...captured.refunds,
        items,
        count: items.length,
        summary: { ...captured.refunds.summary, totalRefunds: items.length, approvedRefunds: items.length, approvedAmountCents: 50_000 },
        pagination: { page: 1, limit: 25, total: items.length, totalPages: items.length ? 1 : 0, hasMore: false },
      }],
      ...common,
    ])
  }

  it("lists refunds and sends its search to the server", async () => {
    routes()
    renderWithApp(<RefundReportPage />)
    await waitFor(() => expect(screen.getAllByText("Refund-000009").length).toBeGreaterThan(0))

    fireEvent.change(screen.getByPlaceholderText("Search refund, order or person..."), { target: { value: "TID-0041" } })
    await waitFor(() => expect(callsTo("/api/v1/analytics/refunds").some((call) => /q=TID-0041|search=TID-0041/.test(call.url))).toBe(true), { timeout: 3000 })
  })

  it("says there is nothing to export when no refund matches", async () => {
    routes([])
    renderWithApp(<RefundReportPage />)
    await waitFor(() => expect(callsTo("/api/v1/analytics/refunds").length).toBeGreaterThan(0))
    expect(screen.queryAllByText("Refund-000009")).toHaveLength(0)
  })
})
