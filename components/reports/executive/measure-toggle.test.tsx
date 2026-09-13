import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { MeasureToggle } from "./measure-toggle"

/**
 * Amount ⇄ Quantity. Small, but it is the most-used control on the screen, and
 * a wrong pressed state or a silently disabled side would mislead every panel.
 */
describe("MeasureToggle", () => {
  it("presses exactly the current side", () => {
    render(<MeasureToggle value="quantity" onChange={() => {}} />)
    expect(screen.getByRole("button", { name: "Amount" }).getAttribute("aria-pressed")).toBe("false")
    expect(screen.getByRole("button", { name: "Quantity" }).getAttribute("aria-pressed")).toBe("true")
  })

  it("reports the other side when clicked, and nothing else", () => {
    const onChange = vi.fn()
    render(<MeasureToggle value="amount" onChange={onChange} />)
    fireEvent.click(screen.getByRole("button", { name: "Quantity" }))
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith("quantity")
  })

  it("disables Quantity with the reason on show when it cannot be totalled", () => {
    const onChange = vi.fn()
    render(<MeasureToggle value="amount" onChange={onChange} disabledReason="Litres and packs cannot be added." />)
    const quantity = screen.getByRole("button", { name: "Quantity" }) as HTMLButtonElement
    expect(quantity.disabled).toBe(true)
    expect(quantity.title).toBe("Litres and packs cannot be added.")
    fireEvent.click(quantity)
    expect(onChange).not.toHaveBeenCalled()
    // Amount is never blocked: money is always addable.
    expect((screen.getByRole("button", { name: "Amount" }) as HTMLButtonElement).disabled).toBe(false)
  })
})
