import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, describe, expect, it, vi } from "vitest"

const { fetcher } = vi.hoisted(() => ({ fetcher: vi.fn() }))
vi.mock("@/lib/fetcher", () => ({ fetcher, jsonFetcher: vi.fn() }))

import { ApprovalLevelCoverage } from "./approval-level-coverage"

/**
 * The Users page's coverage panel (plans/OF-APPROVAL-LEVELS-route-orders-by-level.md,
 * R11). An organization without levels must see nothing new, and a branch an
 * order would be refused at must be the first thing shown.
 */

const COVERAGE = {
  active: true,
  levels: [
    { level: 1, fromCents: 8_000_000, belowCents: null },
    { level: 2, fromCents: null, belowCents: 8_000_000 },
  ],
  branches: [
    { id: 1, name: "Clifton", holders: { 1: 1, 2: 2 }, missingLevels: [] },
    { id: 2, name: "Saddar", holders: { 1: 0, 2: 1 }, missingLevels: [1] },
  ],
}

function renderPanel(answer: unknown, props: { organizationId?: number | null; role?: string } = {}) {
  fetcher.mockResolvedValue(answer)
  return render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ApprovalLevelCoverage organizationId={props.organizationId === undefined ? 4 : props.organizationId} role={props.role ?? "HEAD_OFFICE"} />
    </SWRConfig>,
  )
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe("ApprovalLevelCoverage", () => {
  it("shows the branches missing a level first, and every branch on request", async () => {
    renderPanel(COVERAGE)
    expect(await screen.findByText("Saddar")).toBeTruthy()
    expect(screen.queryByText("Clifton")).toBeNull()
    expect(screen.getByText("None")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Show all branches" }))
    expect(screen.getByText("Clifton")).toBeTruthy()
  })

  it("says so when every branch has every level", async () => {
    renderPanel({ ...COVERAGE, branches: [COVERAGE.branches[0]] })
    expect(await screen.findByText("Every branch has someone at every level.")).toBeTruthy()
  })

  it("draws nothing for an organization that does not use levels", async () => {
    const { container } = renderPanel({ active: false, levels: [], branches: [] })
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalled())
    expect(container.textContent).toBe("")
  })

  it.each(["BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL"])("does not ask the server for %s", (role) => {
    const { container } = renderPanel(COVERAGE, { role })
    expect(fetcher).not.toHaveBeenCalled()
    expect(container.textContent).toBe("")
  })

  it("does not ask without an organization", () => {
    renderPanel(COVERAGE, { organizationId: null })
    expect(fetcher).not.toHaveBeenCalled()
  })

  it("asks Super Admin's question about the organization being viewed", async () => {
    renderPanel(COVERAGE, { role: "SUPER_ADMIN", organizationId: 12 })
    await screen.findByText("Saddar")
    expect(fetcher.mock.calls[0][0]).toBe("/api/v1/approval-levels/coverage?organizationId=12")
  })
})
