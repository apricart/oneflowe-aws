import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { BankingKPICard } from "./banking-kpi-card"

const TestIcon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />

describe("BankingKPICard", () => {
  it("shows separate amounts for each detail and keeps their actions isolated", () => {
    const onCardClick = vi.fn()
    const onRefundedClick = vi.fn()

    render(
      <BankingKPICard
        icon={TestIcon}
        title="Refunded / Rejected"
        value="5"
        gradient="from-red-500 to-slate-700"
        iconBg="text-red-600 bg-red-600"
        onClick={onCardClick}
        details={[
          { label: "Refunded", value: "2", amount: "PKR 5,000", onClick: onRefundedClick },
          { label: "Rejected", value: "3", amount: "PKR 7,500" },
        ]}
      />,
    )

    expect(screen.getAllByText("Amount")).toHaveLength(2)
    expect(screen.getByText("PKR 5,000")).toBeTruthy()
    expect(screen.getByText("PKR 7,500")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /refunded\s+2\s+amount\s+pkr 5,000/i }))

    expect(onRefundedClick).toHaveBeenCalledOnce()
    expect(onCardClick).not.toHaveBeenCalled()
  })
})
