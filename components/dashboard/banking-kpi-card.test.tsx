import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { BankingKPICard } from "./banking-kpi-card"

const TestIcon = (props: React.SVGProps<SVGSVGElement>) => <svg {...props} />

describe("BankingKPICard", () => {
  it("shows an amount and lets a combined card keep separate detail actions", () => {
    const onCardClick = vi.fn()
    const onRefundedClick = vi.fn()

    render(
      <BankingKPICard
        icon={TestIcon}
        title="Refunded / Rejected"
        value="5"
        amount="PKR 12,500"
        gradient="from-red-500 to-slate-700"
        iconBg="text-red-600 bg-red-600"
        onClick={onCardClick}
        details={[
          { label: "Refunded", value: "2", onClick: onRefundedClick },
          { label: "Rejected", value: "3" },
        ]}
      />,
    )

    expect(screen.getByText("Amount")).toBeTruthy()
    expect(screen.getByText("PKR 12,500")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /refunded\s+2/i }))

    expect(onRefundedClick).toHaveBeenCalledOnce()
    expect(onCardClick).not.toHaveBeenCalled()
  })
})
