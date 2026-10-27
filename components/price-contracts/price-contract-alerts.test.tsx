import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const useSWR = vi.fn()
vi.mock("swr", () => ({ default: (...args: unknown[]) => useSWR(...args) }))

import { PRICE_CONTRACT_ALERTS_KEY, PriceContractAlerts } from "@/components/price-contracts/price-contract-alerts"

describe("PriceContractAlerts", () => {
  beforeEach(() => useSWR.mockReset())

  it("reads the alert endpoint and renders nothing while there is nothing to say", () => {
    useSWR.mockReturnValue({ data: { reminderDays: 7, items: [] } })
    const { container } = render(<PriceContractAlerts />)
    expect(useSWR.mock.calls[0][0]).toBe(PRICE_CONTRACT_ALERTS_KEY)
    expect(container.innerHTML).toBe("")
  })

  it("renders nothing before the response arrives", () => {
    useSWR.mockReturnValue({ data: undefined })
    const { container } = render(<PriceContractAlerts />)
    expect(container.innerHTML).toBe("")
  })

  it("lists expired contracts apart from expiring ones, with each date and how long", () => {
    useSWR.mockReturnValue({
      data: {
        reminderDays: 7,
        items: [
          { organizationId: 2, name: "Beta", code: "BET", validUntil: "2026-10-20", daysLeft: -7, status: "expired" },
          { organizationId: 1, name: "Acme", code: "ACM", validUntil: "2026-10-30", daysLeft: 3, status: "expiring" },
          { organizationId: 3, name: "Gamma", code: null, validUntil: "2026-10-27", daysLeft: 0, status: "expiring" },
        ],
      },
    })
    render(<PriceContractAlerts />)

    const sections = screen.getAllByTestId("price-contract-alert")
    expect(sections.map((section) => section.dataset.kind)).toEqual(["expired", "expiring"])
    expect(sections[0].getAttribute("role")).toBe("alert")
    expect(sections[0].textContent).toContain("A price contract has expired")
    expect(sections[0].textContent).toContain("Beta (BET) — valid until 20 Oct 2026, expired 7 days ago")
    expect(sections[1].getAttribute("role")).toBe("status")
    expect(sections[1].textContent).toContain("2 price contracts expire within 7 days")
    expect(sections[1].textContent).toContain("Acme (ACM) — valid until 30 Oct 2026, expires in 3 days")
    expect(sections[1].textContent).toContain("Gamma — valid until 27 Oct 2026, expires today")
    expect(sections[1].textContent).toContain("Ordering is not affected")
  })
})
