import { useState } from "react"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const requestedKeys: string[] = []

vi.mock("swr", () => ({
  default: (key: unknown) => {
    if (typeof key === "string") requestedKeys.push(key)
    return {
      data: {
        items: [{
          organizationInventoryId: 30,
          globalProductId: 30,
          name: "Stapler",
          productCode: null,
          description: null,
          imageUrl: null,
          unit: "pcs",
          priceCents: 50_000,
          stockQuantity: 10,
          allowDecimalQuantity: false,
          quantityStep: 1,
          categoryName: null,
          quantityBudgetRemaining: null,
        }],
        total: 1,
        page: 1,
        limit: 20,
        excludedProductCount: 0,
        quantityBudgetActive: false,
        categoryFacets: [],
      },
      error: undefined,
      isLoading: false,
    }
  },
}))

import { replaceBranchPlanLines } from "@/components/group-portal/group-order-plan"
import { ReviewStep } from "@/components/group-portal/review-step"
import type { BranchPlan, SelectedLine } from "@/components/group-portal/types"

const freshener: SelectedLine = {
  organizationInventoryId: 10,
  quantity: 1,
  name: "Air Freshener",
  unit: "pcs",
  priceCents: 6_000,
}

const branchPlan = (id: number, name: string): BranchPlan => ({
  branch: { id, name, city: null, costCenterId: null, groupId: 7 },
  lines: [freshener],
  totalCents: 6_000,
})

const startingPlans = () => [branchPlan(1, "Payroll & Funds"), branchPlan(2, "Account Payable")]

/** The storefront's role: hold the plans and commit an edited set, or refuse it. */
function Harness({
  accept = true,
  busy = false,
  onReplace,
}: Readonly<{
  accept?: boolean
  busy?: boolean
  onReplace?: (branchId: number, lines: SelectedLine[]) => void
}>) {
  const [plans, setPlans] = useState(startingPlans)
  return (
    <ReviewStep
      groupId={7}
      groupName="Enabling Group"
      branchPlans={plans}
      notes=""
      poNumber=""
      submitting={busy}
      checkingInvoices={false}
      onNotesChange={() => {}}
      onPoNumberChange={() => {}}
      onQuantityChange={() => {}}
      onApplyQuantityToAll={() => {}}
      onReplaceBranchLines={(branchId, lines) => {
        onReplace?.(branchId, lines)
        if (!accept) return false
        setPlans((current) => replaceBranchPlanLines(current, branchId, lines))
        return true
      }}
      onRemoveBranch={(branchId) => setPlans((current) => current.filter((plan) => plan.branch.id !== branchId))}
      onBack={() => {}}
      onSubmit={() => {}}
    />
  )
}

/**
 * The rows the review card for one location shows, by product name. Hidden
 * elements are included because an open sheet marks the page behind it hidden.
 */
const productsOn = (locationName: string) => {
  const card = screen.getByText(locationName).closest("[data-slot='card']") as HTMLElement
  return within(card).getAllByRole("row", { hidden: true }).slice(1).map((row) => row.querySelector("td")?.textContent)
}

describe("ReviewStep — editing one location", () => {
  afterEach(() => {
    cleanup()
    requestedKeys.length = 0
  })

  it("offers an edit control on every location", () => {
    render(<Harness />)

    expect(screen.getByRole("button", { name: "Edit items for Payroll & Funds" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Edit items for Account Payable" })).toBeTruthy()
  })

  it("opens the editor on the location that was chosen, reading that location's catalogue", () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: "Edit items for Account Payable" }))

    expect(within(screen.getByRole("dialog")).getByText("Edit Account Payable")).toBeTruthy()
    const params = new URL(requestedKeys.at(-1)!, "http://localhost").searchParams
    expect(params.get("branchIds")).toBe("2")
    expect(params.get("groupId")).toBe("7")
  })

  it("adds a product to the edited location only, and closes the editor", () => {
    const onReplace = vi.fn()
    render(<Harness onReplace={onReplace} />)

    fireEvent.click(screen.getByRole("button", { name: "Edit items for Account Payable" }))
    fireEvent.click(screen.getByRole("button", { name: "Add Stapler" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply to this location" }))

    expect(onReplace).toHaveBeenCalledWith(2, expect.any(Array))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(productsOn("Account Payable")).toEqual(["Air Freshener", "Stapler"])
    expect(productsOn("Payroll & Funds")).toEqual(["Air Freshener"])
  })

  it("keeps the editor open with its draft when the edit is refused", () => {
    render(<Harness accept={false} />)

    fireEvent.click(screen.getByRole("button", { name: "Edit items for Account Payable" }))
    fireEvent.click(screen.getByRole("button", { name: "Add Stapler" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply to this location" }))

    const dialog = screen.getByRole("dialog")
    expect(within(dialog).getByText("Stapler", { selector: "p" })).toBeTruthy()
    expect(productsOn("Account Payable")).toEqual(["Air Freshener"])
  })

  it("starts each location from its own lines, not the last location's draft", () => {
    render(<Harness />)

    fireEvent.click(screen.getByRole("button", { name: "Edit items for Account Payable" }))
    fireEvent.click(screen.getByRole("button", { name: "Add Stapler" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    fireEvent.click(screen.getByRole("button", { name: "Edit items for Payroll & Funds" }))

    const dialog = screen.getByRole("dialog")
    expect(within(dialog).queryByText("Stapler", { selector: "p" })).toBeNull()
  })

  it("cannot be opened while the order is being submitted", () => {
    render(<Harness busy />)

    const edit = screen.getByRole("button", { name: "Edit items for Payroll & Funds" }) as HTMLButtonElement
    expect(edit.disabled).toBe(true)
  })
})
