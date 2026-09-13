import { fireEvent, render, screen, within } from "@testing-library/react"
import { beforeAll, describe, expect, it, vi } from "vitest"

import { MAX_COMPARE_ENTITIES } from "@/lib/executive-analytics"

import { EntityPicker, type EntityOption } from "./entity-picker"

/**
 * The searchable multi-select behind "Product" and "Requesters to compare".
 *
 * It never decides what may be listed — the server does — so these tests are
 * about the interaction: what the trigger says, what a tick does, where the cap
 * bites, and that a search narrows without losing what is already ticked.
 */

// Radix positions the popover with floating-ui, which observes its anchor;
// jsdom has no ResizeObserver.
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver
})

const options: EntityOption[] = [
  { key: "10", label: "A4 Paper Ream 80gsm", hint: "per Ream · 128 orders" },
  { key: "11", label: "Toner Cartridge", hint: "per Box, Piece · 74 orders" },
  { key: "12", label: "Diesel", hint: "per Litre · 61 orders" },
]

function renderPicker(over: Partial<React.ComponentProps<typeof EntityPicker>> = {}) {
  const onChange = vi.fn()
  const utils = render(
    <EntityPicker
      noun="products"
      options={options}
      selected={[]}
      onChange={onChange}
      loading={false}
      emptyLabel="All products"
      {...over}
    />,
  )
  return { ...utils, onChange }
}

function open() {
  fireEvent.click(screen.getByRole("button"))
  return screen.getByRole("list")
}

describe("the trigger label", () => {
  it("says what is selected without opening the list", () => {
    const { rerender, onChange } = renderPicker()
    expect(screen.getByRole("button").textContent).toContain("All products")

    rerender(<EntityPicker noun="products" options={options} selected={["11"]} onChange={onChange} loading={false} emptyLabel="All products" />)
    expect(screen.getByRole("button").textContent).toContain("Toner Cartridge")

    rerender(<EntityPicker noun="products" options={options} selected={["11", "12"]} onChange={onChange} loading={false} emptyLabel="All products" />)
    expect(screen.getByRole("button").textContent).toContain("2 of 3 products")
  })

  it("says it is loading, and cannot be opened, while the list is fetched", () => {
    renderPicker({ loading: true })
    const trigger = screen.getByRole("button")
    expect(trigger.textContent).toContain("Loading…")
    expect(trigger).toHaveProperty("disabled", true)
  })
})

describe("ticking", () => {
  it("adds a key on first click and removes it on the second", () => {
    const { onChange } = renderPicker({ selected: ["10"] })
    const list = open()
    fireEvent.click(within(list).getByText("Diesel"))
    expect(onChange).toHaveBeenLastCalledWith(["10", "12"])

    fireEvent.click(within(list).getByText("A4 Paper Ream 80gsm"))
    expect(onChange).toHaveBeenLastCalledWith([])
  })

  it("shows each option's hint so a reader can see units and activity", () => {
    renderPicker()
    const list = open()
    expect(within(list).getByText("per Box, Piece · 74 orders")).toBeTruthy()
  })

  it("stops at the cap, and says so, but still lets a ticked row be unticked", () => {
    const many = Array.from({ length: MAX_COMPARE_ENTITIES + 1 }, (_, i) => ({ key: String(i), label: `Entity ${i}` }))
    const selected = many.slice(0, MAX_COMPARE_ENTITIES).map((o) => o.key)
    const { onChange } = renderPicker({ options: many, selected })
    const list = open()

    const blocked = within(list).getByText(`Entity ${MAX_COMPARE_ENTITIES}`).closest("button") as HTMLButtonElement
    expect(blocked.disabled).toBe(true)
    fireEvent.click(blocked)
    expect(onChange).not.toHaveBeenCalled()
    expect(screen.getByText(`${MAX_COMPARE_ENTITIES} is the most that can be selected at once.`)).toBeTruthy()

    fireEvent.click(within(list).getByText("Entity 0"))
    expect(onChange).toHaveBeenLastCalledWith(selected.slice(1))
  })
})

describe("searching", () => {
  it("narrows the list by label, case-insensitively, and explains an empty result", () => {
    renderPicker()
    const list = open()
    const search = screen.getByPlaceholderText("Search products…")

    fireEvent.change(search, { target: { value: "ton" } })
    expect(within(list).queryByText("Diesel")).toBeNull()
    expect(within(list).getByText("Toner Cartridge")).toBeTruthy()

    fireEvent.change(search, { target: { value: "zzz" } })
    expect(within(list).getByText("No products with activity in the selected period.")).toBeTruthy()
  })

  it("offers Clear only once something is ticked, and clears everything", () => {
    const { onChange, rerender } = renderPicker()
    open()
    expect(screen.queryByText("Clear")).toBeNull()

    rerender(<EntityPicker noun="products" options={options} selected={["10", "12"]} onChange={onChange} loading={false} />)
    fireEvent.click(screen.getByText("Clear"))
    expect(onChange).toHaveBeenLastCalledWith([])
  })
})
