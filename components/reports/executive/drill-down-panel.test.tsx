import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { DRILLDOWN_DEFAULT_ROWS } from "@/lib/executive-analytics"

/**
 * The detail table behind a clicked bar.
 *
 * What matters here is the request it makes — every filter the chart was drawn
 * with, the clicked entity, the clicked bucket, the sort and the page — because
 * a table asking a narrower or wider question than its chart is the one failure
 * a drill-down must never have. The rows themselves come from the server and
 * are covered by the integration suite.
 */

const requested: string[] = []
let response: any = null

vi.mock("@/lib/hooks/use-api", () => ({
  useAPI: (url: string | null) => {
    if (url) requested.push(url)
    return { data: response, error: null, isLoading: false }
  },
}))

import { DrillDownPanel } from "./drill-down-panel"

const filters = {
  startDate: "2026-07-01",
  endDate: "2026-09-12",
  organizationIds: ["3"],
  groupIds: ["4"],
  branchIds: ["7", "9"],
  categoryIds: ["21"],
  productIds: ["186"],
  userIds: ["6ec33598-9ec2-4a1a-86df-cd0801ee0178"],
}

const line = (over: Record<string, unknown> = {}) => ({
  lineId: 1,
  orderId: 24871,
  tid: "ORD-24871",
  createdAt: "2026-09-11T08:00:00.000Z",
  status: "FULFILLED",
  branchName: "North Zone",
  requesterName: "Sana Malik",
  productName: "A4 Paper Ream 80gsm",
  categoryName: "Stationery",
  unit: "Ream",
  quantity: 20,
  unitPriceCents: 420_000,
  valueCents: 8_400_000,
  ...over,
})

function respond(over: Record<string, unknown> = {}) {
  response = {
    dimensionLabel: "Branch",
    metricLabel: "Procurement Value",
    period: { startDate: "2026-06-30T19:00:00.000Z", endDate: "2026-09-12T18:59:59.999Z" },
    rows: [line(), line({ lineId: 2, tid: "ORD-24802", unit: "Box", quantity: 3 })],
    totals: {
      lineCount: 2,
      orderCount: 2,
      valueCents: 16_800_000,
      quantity: 23,
      quantityByUnit: [{ unit: "Ream", quantity: 20 }, { unit: "Box", quantity: 3 }],
    },
    hasMore: false,
    ...over,
  }
}

const lastUrl = () => new URL(`http://x${requested[requested.length - 1]}`)
const param = (name: string) => lastUrl().searchParams.get(name)

beforeEach(() => {
  requested.length = 0
  respond()
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
})

describe("the status set", () => {
  it("sends nothing by default, so every existing request is unchanged", () => {
    respond()
    render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North" }} filters={filters} metric="spend" onClose={vi.fn()} />)
    expect(new URL(`http://localhost${requested.at(-1)}`).searchParams.has("statuses")).toBe(false)
  })

  it("asks for consumed lines when told to, and says pending orders are included", () => {
    respond()
    render(<DrillDownPanel target={{ dimension: "user", key: "6ec33598-9ec2-4a1a-86df-cd0801ee0178", label: "Sana" }} filters={filters} metric="spend" statuses="consumed" onClose={vi.fn()} />)
    expect(new URL(`http://localhost${requested.at(-1)}`).searchParams.get("statuses")).toBe("consumed")
    expect(screen.getByText(/Orders still awaiting approval are included and marked pending/)).toBeTruthy()
  })
})

describe("the request behind the table", () => {
  it("carries every filter the chart was drawn with, plus the clicked entity", () => {
    render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North Zone" }} filters={filters} metric="spend" onClose={() => {}} />)
    const url = lastUrl()
    expect(url.pathname).toBe("/api/v1/analytics/executive/drill-down")
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      startDate: "2026-07-01",
      endDate: "2026-09-12",
      organizationIds: "3",
      branchIds: "7,9",
      categoryIds: "21",
      productIds: "186",
      userIds: "6ec33598-9ec2-4a1a-86df-cd0801ee0178",
      dimension: "branch",
      key: "7",
      metric: "spend",
      sort: "date",
      direction: "desc",
      limit: String(DRILLDOWN_DEFAULT_ROWS),
      offset: "0",
    })
    // No bucket was clicked, so none is sent.
    expect(url.searchParams.has("period")).toBe(false)
  })

  it("sends the clicked month alongside the entity for a point on a trend", () => {
    render(<DrillDownPanel target={{ dimension: "user", key: "u1", label: "Sana · 2026-08", period: "2026-08" }} filters={filters} metric="quantity" onClose={() => {}} />)
    expect(param("period")).toBe("2026-08")
    expect(param("metric")).toBe("quantity")
  })

  it("toggles direction on the same column, resets to page one on a new column", () => {
    respond({ hasMore: true })
    render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North Zone" }} filters={filters} metric="spend" onClose={() => {}} />)

    fireEvent.click(screen.getByLabelText("Next page"))
    expect(param("offset")).toBe(String(DRILLDOWN_DEFAULT_ROWS))

    fireEvent.click(screen.getByRole("button", { name: /^Date/ }))
    expect(param("sort")).toBe("date")
    expect(param("direction")).toBe("asc")
    // Reversing the same column keeps the page.
    expect(param("offset")).toBe(String(DRILLDOWN_DEFAULT_ROWS))

    fireEvent.click(screen.getByRole("button", { name: /^Value/ }))
    expect(param("sort")).toBe("value")
    expect(param("direction")).toBe("desc")
    expect(param("offset")).toBe("0")
  })

  it("starts paging over when a different bar is selected", () => {
    respond({ hasMore: true })
    const { rerender } = render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North" }} filters={filters} metric="spend" onClose={() => {}} />)
    fireEvent.click(screen.getByLabelText("Next page"))
    expect(param("offset")).toBe(String(DRILLDOWN_DEFAULT_ROWS))

    rerender(<DrillDownPanel target={{ dimension: "branch", key: "9", label: "South" }} filters={filters} metric="spend" onClose={() => {}} />)
    expect(param("key")).toBe("9")
    expect(param("offset")).toBe("0")
  })

  it("lets a grid cell narrow the screen's focus to its own product, and pages that pair on its own", () => {
    respond({ hasMore: true })
    // The screen has two products in focus; the cell is Ahmed × the second.
    const twoInFocus = { ...filters, productIds: ["186", "187"] }
    const cell = (productId: string) => ({
      dimension: "user" as const,
      key: "6ec33598-9ec2-4a1a-86df-cd0801ee0178",
      label: "Ahmed · Toner",
      narrow: { productIds: [productId] },
    })
    const { rerender } = render(<DrillDownPanel target={cell("187")} filters={twoInFocus} metric="spend" onClose={() => {}} />)
    expect(param("dimension")).toBe("user")
    expect(param("key")).toBe("6ec33598-9ec2-4a1a-86df-cd0801ee0178")
    expect(param("productIds")).toBe("187")
    // Everything the cell did not name is still the screen's.
    expect(param("branchIds")).toBe("7,9")
    expect(param("unit")).toBeNull()

    fireEvent.click(screen.getByLabelText("Next page"))
    expect(param("offset")).toBe(String(DRILLDOWN_DEFAULT_ROWS))
    // The cell beside it is a different question: same person, other product.
    rerender(<DrillDownPanel target={cell("186")} filters={twoInFocus} metric="spend" onClose={() => {}} />)
    expect(param("productIds")).toBe("186")
    expect(param("offset")).toBe("0")
  })
})

describe("what the panel shows", () => {
  it("names the selection, its dimension and the period, and totals raw quantity", () => {
    render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North Zone" }} filters={filters} metric="spend" onClose={() => {}} />)
    const heading = screen.getByRole("heading", { level: 3 })
    expect(heading.textContent).toContain("North Zone")
    // The dimension badge sits in the heading; "Branch" is also a column header.
    expect(heading.textContent).toContain("Branch")
    expect(screen.getByText(/01 Jul 2026 – 12 Sept? 2026/)).toBeTruthy()
    expect(screen.getByText("Quantity")).toBeTruthy()
    expect(screen.getByText("23")).toBeTruthy()
    expect(screen.queryByText("Qty (Ream)")).toBeNull()
    expect(screen.getAllByText(/ORD-248/)).toHaveLength(2)
  })

  it("shows the pager only once there is more than one page", () => {
    render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North Zone" }} filters={filters} metric="spend" onClose={() => {}} />)
    expect(screen.queryByLabelText("Next page")).toBeNull()
  })

  it("warns that a budget figure's rows will not add up to its bar", () => {
    render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North Zone" }} filters={filters} metric="utilization" onClose={() => {}} />)
    expect(screen.getByText(/is a budget position, not a purchase/)).toBeTruthy()
  })

  it("explains an empty selection and surfaces a request error", () => {
    respond({ rows: [], totals: { lineCount: 0, orderCount: 0, valueCents: 0, quantity: 0, quantityByUnit: [] } })
    const { unmount } = render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North Zone" }} filters={filters} metric="spend" onClose={() => {}} />)
    expect(screen.getByText("No order lines behind this selection, under this period and these filters.")).toBeTruthy()
    unmount()

    respond({ error: "Forbidden: Insufficient permissions", rows: undefined, totals: undefined })
    render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North Zone" }} filters={filters} metric="spend" onClose={() => {}} />)
    expect(screen.getByText("Forbidden: Insufficient permissions")).toBeTruthy()
  })

  it("closes on request", () => {
    const onClose = vi.fn()
    render(<DrillDownPanel target={{ dimension: "branch", key: "7", label: "North Zone" }} filters={filters} metric="spend" onClose={onClose} />)
    fireEvent.click(screen.getByRole("button", { name: /Close/ }))
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})
