import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const swr = vi.hoisted(() => ({ targets: [] as unknown[] }))

vi.mock("swr", () => ({
  default: (key: string | null) => {
    if (key === "/api/v1/order-desk/targets") return { data: { items: swr.targets }, error: undefined, isLoading: false }
    return { data: undefined, error: undefined, isLoading: false }
  },
}))

import { NewDeskOrder } from "./new-desk-order"

afterEach(() => cleanup())

describe("a new desk order", () => {
  it("explains what to do when the desk user has no organizations yet", () => {
    swr.targets = []
    render(<NewDeskOrder onViewOrders={vi.fn()} />)
    expect(screen.getByText("No organizations assigned yet")).toBeTruthy()
    expect(screen.getByText(/Order Desk Team/)).toBeTruthy()
  })

  it("reads as three numbered steps with a summary that lists what is missing", () => {
    swr.targets = [{ id: 1, name: "Meezan", code: "MEZ", branches: [{ id: 2, name: "Clifton", city: "Karachi" }] }]
    render(<NewDeskOrder onViewOrders={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "Customer" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Products" })).toBeTruthy()
    expect(screen.getByRole("heading", { name: "Where the order came from" })).toBeTruthy()

    const checklist = screen.getByRole("list", { name: "What this order still needs" })
    expect(within(checklist).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "Organization and branchstill needed",
      "At least one productstill needed",
      "Order channelstill needed",
      "Message referencestill needed",
    ])
    expect((screen.getByRole("button", { name: "Create order" }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText(/Choose the organization and branch first/)).toBeTruthy()
  })

  it("labels the channel 'Order channel' and marks the choice", () => {
    swr.targets = [{ id: 1, name: "Meezan", code: null, branches: [] }]
    render(<NewDeskOrder onViewOrders={vi.fn()} />)
    // The fieldset is named by its legend; the checklist beside it repeats the words.
    expect(screen.getByRole("group", { name: "Order channel" })).toBeTruthy()
    expect(screen.queryByText("Received by")).toBeNull()

    const whatsapp = screen.getByRole("button", { name: "WhatsApp" })
    expect(whatsapp.getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(whatsapp)
    expect(whatsapp.getAttribute("aria-pressed")).toBe("true")

    fireEvent.change(screen.getByLabelText("Reference"), { target: { value: "Ali, 10:14" } })
    const checklist = screen.getByRole("list", { name: "What this order still needs" })
    expect(within(checklist).getByText("Order channel").parentElement?.textContent).toContain("done")
    expect(within(checklist).getByText("Message reference").parentElement?.textContent).toContain("done")
  })
})
