import { useState } from "react"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const swr = vi.hoisted(() => ({ keys: [] as string[], pages: new Map<string, unknown>() }))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key) swr.keys.push(key)
    const data = key ? swr.pages.get(key) : undefined
    return { data, error: undefined, isLoading: data === undefined }
  },
}))

import { withLinePrice, withLineQuantity, type DeskLineProduct, type DeskLines } from "@/lib/order-desk-draft"

import { DeskProductPicker } from "./desk-product-picker"

const BASE = "/api/v1/order-desk/catalogue?organizationId=7&branchId=70"

const item = (globalProductId: number, name: string, carried: number | null = null) => ({
  globalProductId,
  organizationInventoryId: carried === null ? null : globalProductId * 10,
  productCode: `P-${globalProductId}`,
  name,
  unit: "piece",
  allowDecimalQuantity: false,
  quantityStep: 1,
  stockQuantity: globalProductId === 3 ? 0 : 50,
  assignedToBranch: carried !== null,
  cataloguePriceCents: carried,
})

const page = (items: ReturnType<typeof item>[], current: number, totalPages: number) => ({
  items,
  pagination: { page: current, limit: 25, total: totalPages * 25, totalPages },
})

/** The picker with its lines held the way the forms hold them. */
function Harness({ initialView }: Readonly<{ initialView?: "all" | "selected" }>) {
  const [lines, setLines] = useState<DeskLines>({})
  return (
    <DeskProductPicker
      organizationId={7}
      branchId={70}
      lines={lines}
      initialView={initialView}
      disabled={false}
      onQuantity={(product: DeskLineProduct, quantity: string) => setLines((current) => withLineQuantity(current, product, quantity))}
      onPrice={(product: DeskLineProduct, price: string) => setLines((current) => withLinePrice(current, product, price))}
    />
  )
}

const priceBox = (name: string) => screen.getByLabelText(`Price per piece of ${name}, in rupees including tax`) as HTMLInputElement

beforeEach(() => {
  vi.useFakeTimers()
  swr.keys = []
  swr.pages = new Map([
    [BASE, page([item(1, "Boxes", 1_000), item(2, "Gloves")], 1, 2)],
    [`${BASE}&page=2`, page([item(3, "Tape")], 2, 2)],
    [`${BASE}&q=glo`, page([item(2, "Gloves")], 1, 1)],
  ])
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("the desk's product picker", () => {
  it("lists Apricart's products for the branch, saying which the branch carries and at what price", () => {
    render(<Harness />)
    expect(swr.keys).toContain(BASE)
    const boxes = screen.getByText("Boxes").closest("li")!
    expect(within(boxes).getByText("Branch price Rs 10.00", { exact: false })).toBeTruthy()
    const gloves = screen.getByText("Gloves").closest("li")!
    expect(within(gloves).getByText("Not in branch catalogue")).toBeTruthy()
  })

  it("starts every price box empty, the branch's own price included", () => {
    render(<Harness />)
    expect(priceBox("Boxes").value).toBe("")
    expect(priceBox("Gloves").value).toBe("")
    expect(priceBox("Boxes").placeholder).toBe("Price incl. tax")
  })

  it("asks for a price once a product is ordered, and accepts one above zero", () => {
    render(<Harness />)
    expect(screen.queryByText("Price required")).toBeNull()
    fireEvent.click(screen.getByRole("button", { name: "Increase Quantity of Gloves" }))
    expect(screen.getByText("Price required")).toBeTruthy()
    expect(priceBox("Gloves").getAttribute("aria-invalid")).toBe("true")
    expect(priceBox("Gloves").getAttribute("aria-required")).toBe("true")

    fireEvent.change(priceBox("Gloves"), { target: { value: "0" } })
    expect(screen.getByText("The price for Gloves must be more than zero")).toBeTruthy()

    fireEvent.change(priceBox("Gloves"), { target: { value: "45" } })
    expect(screen.queryByText("Price required")).toBeNull()
    expect(priceBox("Gloves").getAttribute("aria-invalid")).toBe("false")
  })

  it("notes a typed price that differs from the branch's own", () => {
    render(<Harness />)
    fireEvent.change(priceBox("Boxes"), { target: { value: "12" } })
    expect(screen.getByText("Differs from branch price")).toBeTruthy()
    fireEvent.change(priceBox("Boxes"), { target: { value: "10" } })
    expect(screen.queryByText("Differs from branch price")).toBeNull()
  })

  it("pages through the whole catalogue", () => {
    render(<Harness />)
    expect(screen.getByText("50 products · page 1 of 2")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Previous page" }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    expect(swr.keys).toContain(`${BASE}&page=2`)
    expect(within(screen.getByText("Tape").closest("li")!).getByText("· Out of stock")).toBeTruthy()
    expect((screen.getByRole("button", { name: "Next page" }) as HTMLButtonElement).disabled).toBe(true)
  })

  it("searches on the server once typing pauses, starting again at page 1", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Next page" }))
    fireEvent.change(screen.getByLabelText("Search products"), { target: { value: " glo " } })
    expect(swr.keys).not.toContain(`${BASE}&q=glo`)
    act(() => { vi.advanceTimersByTime(300) })
    expect(swr.keys.at(-1)).toBe(`${BASE}&q=glo`)
    expect(screen.queryByText("Boxes")).toBeNull()
  })

  it("keeps chosen products, with their prices, across a search and in the Selected view", () => {
    render(<Harness />)
    fireEvent.click(screen.getByRole("button", { name: "Increase Quantity of Boxes" }))
    fireEvent.change(priceBox("Boxes"), { target: { value: "9.5" } })
    fireEvent.change(screen.getByLabelText("Search products"), { target: { value: "glo" } })
    act(() => { vi.advanceTimersByTime(300) })
    expect(screen.queryByText("Boxes")).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Selected (1)" }))
    const selected = screen.getByRole("list", { name: "Selected products" })
    expect(within(selected).getByText("Boxes")).toBeTruthy()
    expect(priceBox("Boxes").value).toBe("9.5")
    expect((screen.getByLabelText("Quantity of Boxes") as HTMLInputElement).value).toBe("1")
  })

  it("can open on the products already chosen without loading the catalogue", () => {
    render(<Harness initialView="selected" />)
    expect(screen.getByText("No products chosen yet.")).toBeTruthy()
    expect(swr.keys).toEqual([])
  })
})
