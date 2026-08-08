import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { TopProductsRanking } from "@/components/reports/top-products-ranking"

const products = [
  {
    productId: 1,
    productCode: "PRD-001",
    productName: "Coffee Beans",
    unit: "bag",
    revenueGeneratedCents: 45_000,
    qtyOrdered: 12,
    qtyFulfilled: 10,
    qtyRefunded: 2,
    totalOrders: 4,
  },
]

describe("TopProductsRanking", () => {
  it("shows ranked product metrics and changes ranking mode", () => {
    const onRankByChange = vi.fn()

    render(
      <TopProductsRanking
        products={products}
        rankBy="netValue"
        pricesHidden={false}
        valueLabel="Net Revenue"
        isLoading={false}
        onRankByChange={onRankByChange}
      />,
    )

    expect(screen.getByText("Coffee Beans")).toBeTruthy()
    expect(screen.getByText("PRD-001")).toBeTruthy()
    expect(screen.getByText("10 fulfilled")).toBeTruthy()
    expect(screen.getByText("16.7% refunded")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: /order count/i }))
    expect(onRankByChange).toHaveBeenCalledWith("orderCount")
  })

  it("removes value ranking when prices are hidden", () => {
    render(
      <TopProductsRanking
        products={products}
        rankBy="fulfilledQty"
        pricesHidden
        valueLabel="Net Purchase Value"
        isLoading={false}
        onRankByChange={() => {}}
      />,
    )

    expect(screen.queryByRole("button", { name: /net purchase value/i })).toBeNull()
    expect(screen.getByRole("button", { name: /fulfilled qty/i })).toBeTruthy()
  })
})
