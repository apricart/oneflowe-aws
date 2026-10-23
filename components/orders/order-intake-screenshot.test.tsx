import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { OrderIntakeScreenshot } from "./order-intake-screenshot"

afterEach(() => {
  cleanup()
})

const SRC = "/api/v1/orders/42/intake-screenshot"

describe("the customer's screenshot on an order", () => {
  it("loads the image from the reader's route and links to it full size in a new tab", () => {
    render(<OrderIntakeScreenshot src={SRC} orderTid="T-42" />)
    expect(screen.getByText(/Loading screenshot/)).toBeTruthy()

    const image = screen.getByRole("img", { hidden: true, name: "Screenshot of the customer's message for order T-42" })
    expect(image.getAttribute("src")).toBe(SRC)
    fireEvent.load(image)
    expect(screen.queryByText(/Loading screenshot/)).toBeNull()

    const link = screen.getByRole("link", { name: /Open full size/ })
    expect(link.getAttribute("href")).toBe(SRC)
    expect(link.getAttribute("target")).toBe("_blank")
    expect(link.getAttribute("rel")).toContain("noopener")
  })

  it("says it could not be loaded when the route refuses it", () => {
    render(<OrderIntakeScreenshot src={SRC} orderTid="T-42" />)
    fireEvent.error(screen.getByRole("img", { hidden: true }))
    expect(screen.getByRole("status").textContent).toMatch(/could not be loaded/)
    expect(screen.queryByRole("link")).toBeNull()
  })

  it("starts loading again when it is shown for another order", () => {
    const { rerender } = render(<OrderIntakeScreenshot src={SRC} orderTid="T-42" />)
    fireEvent.error(screen.getByRole("img", { hidden: true }))
    rerender(<OrderIntakeScreenshot src="/api/v1/orders/43/intake-screenshot" orderTid="T-43" />)
    expect(screen.getByText(/Loading screenshot/)).toBeTruthy()
    expect(screen.getByRole("img", { hidden: true }).getAttribute("src")).toBe("/api/v1/orders/43/intake-screenshot")
  })
})
