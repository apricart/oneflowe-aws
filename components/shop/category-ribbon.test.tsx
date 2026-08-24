import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { CategoryRibbon } from "./category-ribbon"

const ITEMS = ["All", "Batteries", "Green Tea", "Milk", "Tissue Papers"]

/** jsdom performs no layout, so overflow has to be described to it. */
function stubLayout({ scrollWidth, clientWidth }: { scrollWidth: number; clientWidth: number }) {
  for (const [property, value] of Object.entries({ scrollWidth, clientWidth })) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value })
  }
}

function restoreLayout() {
  for (const property of ["scrollWidth", "clientWidth"]) {
    Object.defineProperty(HTMLElement.prototype, property, { configurable: true, value: 0 })
  }
}

const scroller = () => screen.getByTestId("shop-category-ribbon")

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollBy", { configurable: true, value: vi.fn() })
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: vi.fn() })
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

afterEach(() => {
  cleanup()
  restoreLayout()
  vi.restoreAllMocks()
})

describe("CategoryRibbon", () => {
  it("renders nothing when there is only the All chip", () => {
    const { container } = render(<CategoryRibbon items={["All"]} activeItem="All" onSelect={vi.fn()} />)
    expect(container.firstChild).toBeNull()
  })

  it("hides the native scrollbar on the scroller", () => {
    render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={vi.fn()} />)
    expect(scroller().className).toContain("no-scrollbar")
  })

  it("shows no arrows when every chip already fits", () => {
    stubLayout({ scrollWidth: 300, clientWidth: 300 })
    render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={vi.fn()} />)

    expect(screen.queryByRole("button", { name: "Scroll categories left" })).toBeNull()
    expect(screen.queryByRole("button", { name: "Scroll categories right" })).toBeNull()
  })

  it("offers only the right arrow at the start of an overflowing list", () => {
    stubLayout({ scrollWidth: 1200, clientWidth: 400 })
    render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={vi.fn()} />)

    expect(screen.queryByRole("button", { name: "Scroll categories left" })).toBeNull()
    expect(screen.getByRole("button", { name: "Scroll categories right" })).toBeTruthy()
  })

  it("offers both arrows midway through the list", () => {
    stubLayout({ scrollWidth: 1200, clientWidth: 400 })
    render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={vi.fn()} />)

    scroller().scrollLeft = 400
    fireEvent.scroll(scroller())

    expect(screen.getByRole("button", { name: "Scroll categories left" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Scroll categories right" })).toBeTruthy()
  })

  it("drops the right arrow once the end is reached", () => {
    stubLayout({ scrollWidth: 1200, clientWidth: 400 })
    render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={vi.fn()} />)

    scroller().scrollLeft = 800
    fireEvent.scroll(scroller())

    expect(screen.getByRole("button", { name: "Scroll categories left" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Scroll categories right" })).toBeNull()
  })

  it("scrolls by most of a screenful, in the arrow's direction", () => {
    stubLayout({ scrollWidth: 1200, clientWidth: 400 })
    render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={vi.fn()} />)

    fireEvent.click(screen.getByRole("button", { name: "Scroll categories right" }))
    expect(scroller().scrollBy).toHaveBeenCalledWith({ left: 300, behavior: "smooth" })

    scroller().scrollLeft = 400
    fireEvent.scroll(scroller())
    fireEvent.click(screen.getByRole("button", { name: "Scroll categories left" }))
    expect(scroller().scrollBy).toHaveBeenCalledWith({ left: -300, behavior: "smooth" })
  })

  it("reports the chip that was clicked", () => {
    const onSelect = vi.fn()
    render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={onSelect} />)

    fireEvent.click(screen.getByRole("button", { name: "Milk" }))

    expect(onSelect).toHaveBeenCalledWith("Milk")
  })

  it("marks only the active chip", () => {
    render(<CategoryRibbon items={ITEMS} activeItem="Milk" onSelect={vi.fn()} />)

    const active = Array.from(scroller().querySelectorAll("[data-active='true']"))
    expect(active.map((node) => node.textContent)).toEqual(["Milk"])
  })

  it("brings an active chip that sits past the right edge back into view", () => {
    stubLayout({ scrollWidth: 1200, clientWidth: 400 })
    const { rerender } = render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={vi.fn()} />)

    rerender(<CategoryRibbon items={ITEMS} activeItem="Milk" onSelect={vi.fn()} />)
    const chip = scroller().querySelector<HTMLElement>("[data-active='true']")!
    Object.defineProperty(chip, "offsetLeft", { configurable: true, value: 900 })
    Object.defineProperty(chip, "offsetWidth", { configurable: true, value: 80 })

    rerender(<CategoryRibbon items={ITEMS} activeItem="Green Tea" onSelect={vi.fn()} />)
    rerender(<CategoryRibbon items={ITEMS} activeItem="Milk" onSelect={vi.fn()} />)

    expect(scroller().scrollTo).toHaveBeenCalledWith({ left: 596, behavior: "smooth" })
  })

  it("leaves an already visible active chip where it is", () => {
    stubLayout({ scrollWidth: 1200, clientWidth: 400 })
    const { rerender } = render(<CategoryRibbon items={ITEMS} activeItem="All" onSelect={vi.fn()} />)
    vi.mocked(scroller().scrollTo).mockClear()

    rerender(<CategoryRibbon items={ITEMS} activeItem="Batteries" onSelect={vi.fn()} />)

    expect(scroller().scrollTo).not.toHaveBeenCalled()
  })
})
