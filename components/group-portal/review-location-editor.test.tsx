import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const catalogItem = (id: number, name: string, overrides: Record<string, unknown> = {}) => ({
  organizationInventoryId: id,
  globalProductId: id,
  name,
  productCode: null,
  description: null,
  imageUrl: null,
  unit: "pcs",
  priceCents: 20_000,
  stockQuantity: 50,
  allowDecimalQuantity: false,
  quantityStep: 1,
  categoryName: null,
  quantityBudgetRemaining: null,
  ...overrides,
})

const requestedKeys: string[] = []
/** How many products the mocked catalogue claims, so paging can be exercised. */
let catalogTotal = 4

vi.mock("swr", () => ({
  default: (key: unknown) => {
    if (typeof key === "string") requestedKeys.push(key)
    return {
      data: {
        items: [
          catalogItem(10, "Air Freshener"),
          catalogItem(12, "Stapler"),
          catalogItem(13, "Toner", { stockQuantity: 0 }),
          catalogItem(14, "Sugar", { unit: "kg", allowDecimalQuantity: true, quantityStep: 0.5 }),
        ],
        total: catalogTotal,
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

import { ReviewLocationEditor } from "@/components/group-portal/review-location-editor"
import type { BranchPlan, SelectedLine } from "@/components/group-portal/types"

const plan: BranchPlan = {
  branch: { id: 42, name: "Payroll & Funds", city: null, costCenterId: null, groupId: 7 },
  lines: [
    { organizationInventoryId: 10, quantity: 1, name: "Air Freshener", unit: "pcs", priceCents: 6_000 },
    { organizationInventoryId: 11, quantity: 2, name: "BLC 80GSM", unit: "rim", priceCents: 20_000 },
  ],
  totalCents: 46_000,
}

function renderEditor(
  onApply = vi.fn<(lines: SelectedLine[]) => boolean>(() => true),
  onClose = vi.fn(),
  groupId: number | null = 7,
) {
  render(<ReviewLocationEditor plan={plan} groupId={groupId} onClose={onClose} onApply={onApply} />)
  return { onApply, onClose }
}

const lastCatalogParams = () => new URL(requestedKeys.at(-1)!, "http://localhost").searchParams

const applied = (onApply: ReturnType<typeof vi.fn<(lines: SelectedLine[]) => boolean>>) =>
  onApply.mock.calls[0][0].map((line) => [line.organizationInventoryId, line.quantity])

// `Intl` separates the currency symbol with a non-breaking space.
const plainText = (node: { textContent: string | null }) =>
  (node.textContent ?? "").replace(/\s+/g, " ")

describe("ReviewLocationEditor", () => {
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    requestedKeys.length = 0
    catalogTotal = 4
  })

  it("reads the catalogue for this one location and its group only", () => {
    renderEditor()

    const url = new URL(requestedKeys[0], "http://localhost")
    expect(url.pathname).toBe("/api/v1/group-portal/catalog")
    expect(url.searchParams.get("branchIds")).toBe("42")
    expect(url.searchParams.get("groupId")).toBe("7")
  })

  it("adds a product to this location and applies the location's full item list", () => {
    const { onApply, onClose } = renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Add Stapler" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply to this location" }))

    expect(onApply).toHaveBeenCalledTimes(1)
    const applied = onApply.mock.calls[0][0]
    expect(applied.map((line) => [line.organizationInventoryId, line.quantity])).toEqual([
      [10, 1],
      [11, 2],
      [12, 1],
    ])
    expect(onClose).toHaveBeenCalled()
  })

  it("adds one more step when the product is already on this location's order", () => {
    const { onApply } = renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Add Air Freshener" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply to this location" }))

    const applied = onApply.mock.calls[0][0]
    expect(applied.find((line) => line.organizationInventoryId === 10)?.quantity).toBe(2)
  })

  it("removes a product from this location", () => {
    const { onApply } = renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Remove BLC 80GSM from Payroll & Funds" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply to this location" }))

    const applied = onApply.mock.calls[0][0]
    expect(applied.map((line) => line.organizationInventoryId)).toEqual([10])
  })

  it("cannot add a product that is out of stock", () => {
    renderEditor()

    expect((screen.getByRole("button", { name: "Add Toner" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("will not apply an empty location", () => {
    const { onApply } = renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Remove Air Freshener from Payroll & Funds" }))
    fireEvent.click(screen.getByRole("button", { name: "Remove BLC 80GSM from Payroll & Funds" }))
    const apply = screen.getByRole("button", { name: "Apply to this location" }) as HTMLButtonElement

    expect(apply.disabled).toBe(true)
    fireEvent.click(apply)
    expect(onApply).not.toHaveBeenCalled()
  })

  it("leaves the location untouched on cancel", () => {
    const { onApply, onClose } = renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Add Stapler" }))
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onApply).not.toHaveBeenCalled()
    expect(onClose).toHaveBeenCalled()
  })

  it("stays open when the edit is refused", () => {
    const { onClose } = renderEditor(vi.fn(() => false))

    fireEvent.click(screen.getByRole("button", { name: "Add Stapler" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply to this location" }))

    expect(onClose).not.toHaveBeenCalled()
  })
  it("renders nothing while no location is being edited", () => {
    render(<ReviewLocationEditor plan={null} groupId={7} onClose={vi.fn()} onApply={vi.fn()} />)

    expect(screen.queryByRole("dialog")).toBeNull()
    expect(requestedKeys).toHaveLength(0)
  })

  it("omits the group for the ungrouped bucket, as the storefront does", () => {
    renderEditor(undefined, undefined, null)

    expect(lastCatalogParams().has("groupId")).toBe(false)
    expect(lastCatalogParams().get("branchIds")).toBe("42")
  })

  it("adds a decimal product by its own step, not by whole units", () => {
    const { onApply } = renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Add Sugar" }))
    fireEvent.click(screen.getByRole("button", { name: "Add Sugar" }))
    fireEvent.click(screen.getByRole("button", { name: "Apply to this location" }))

    expect(applied(onApply)).toContainEqual([14, 1])
  })

  it("applies a typed quantity, and treats a typed zero as removing the line", () => {
    const { onApply } = renderEditor()

    const blc = screen.getByRole("textbox", { name: "Quantity of BLC 80GSM for Payroll & Funds" })
    fireEvent.change(blc, { target: { value: "5" } })
    fireEvent.blur(blc)
    const freshener = screen.getByRole("textbox", { name: "Quantity of Air Freshener for Payroll & Funds" })
    fireEvent.change(freshener, { target: { value: "0" } })
    fireEvent.blur(freshener)
    fireEvent.click(screen.getByRole("button", { name: "Apply to this location" }))

    expect(applied(onApply)).toEqual([[11, 5]])
  })

  it("marks a product already on this location's order with its quantity", () => {
    renderEditor()

    expect(plainText(screen.getByRole("button", { name: "Add Air Freshener" }))).toContain("1 pcs")
    expect(plainText(screen.getByRole("button", { name: "Add Stapler" }))).not.toContain("pcs ·")
  })

  it("keeps the location total in step with the draft", () => {
    renderEditor()
    // 1 × 60 + 2 × 200 = 460 rupees.
    expect(plainText(document.body)).toMatch(/Location total\s*Rs 460/)

    fireEvent.click(screen.getByRole("button", { name: "Add Stapler" }))
    expect(plainText(document.body)).toMatch(/Location total\s*Rs 660/)
  })

  it("searches this location's catalogue once typing settles, from the first page", () => {
    vi.useFakeTimers()
    catalogTotal = 45
    renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(lastCatalogParams().get("page")).toBe("2")

    fireEvent.change(screen.getByRole("textbox", { name: /Search the catalogue/ }), { target: { value: "sta" } })
    act(() => { vi.advanceTimersByTime(300) })

    expect(lastCatalogParams().get("search")).toBe("sta")
    expect(lastCatalogParams().get("page")).toBe("1")
    expect(lastCatalogParams().get("branchIds")).toBe("42")
  })

  it("pages through a long catalogue and stops at either end", () => {
    catalogTotal = 45
    renderEditor()

    expect(plainText(document.body)).toContain("Page 1 of 3")
    expect((screen.getByRole("button", { name: "Previous" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    fireEvent.click(screen.getByRole("button", { name: "Next" }))
    expect(plainText(document.body)).toContain("Page 3 of 3")
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("shows no pager when the catalogue fits on one page", () => {
    renderEditor()
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull()
  })

  it("closes from the sheet's own close control without applying", () => {
    const { onApply, onClose } = renderEditor()

    fireEvent.click(screen.getByRole("button", { name: "Add Stapler" }))
    fireEvent.click(screen.getByRole("button", { name: "Close" }))

    expect(onClose).toHaveBeenCalled()
    expect(onApply).not.toHaveBeenCalled()
  })
})
