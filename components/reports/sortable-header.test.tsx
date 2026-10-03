import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SortableHeader, ariaSortFor, useTableSort } from "./sortable-header"

describe("SortableHeader", () => {
  afterEach(() => {
    cleanup()
  })

  it("asks to sort its own column, at its first direction, when clicked", () => {
    const onSort = vi.fn()
    render(<SortableHeader label="Amount" sortKey="amount" sort={null} onSort={onSort} firstDirection="desc" />)

    fireEvent.click(screen.getByRole("button", { name: /amount/i }))

    expect(onSort).toHaveBeenCalledWith("amount", "desc")
  })

  it("shows a faded neutral icon until its column is the sorted one", () => {
    const { container, rerender } = render(
      <SortableHeader label="Branch" sortKey="branch" sort={{ key: "amount", direction: "asc" }} onSort={vi.fn()} />,
    )
    expect(container.querySelector("svg")?.getAttribute("class")).toContain("opacity-40")
    expect(container.querySelector(".lucide-arrow-up-down")).not.toBeNull()

    rerender(<SortableHeader label="Branch" sortKey="branch" sort={{ key: "branch", direction: "asc" }} onSort={vi.fn()} />)
    expect(container.querySelector(".lucide-arrow-up")).not.toBeNull()

    rerender(<SortableHeader label="Branch" sortKey="branch" sort={{ key: "branch", direction: "desc" }} onSort={vi.fn()} />)
    expect(container.querySelector(".lucide-arrow-down")).not.toBeNull()
  })
})

describe("ariaSortFor", () => {
  it("names the direction only on the sorted column", () => {
    expect(ariaSortFor({ key: "branch", direction: "asc" }, "branch")).toBe("ascending")
    expect(ariaSortFor({ key: "branch", direction: "desc" }, "branch")).toBe("descending")
    expect(ariaSortFor({ key: "branch", direction: "desc" }, "amount")).toBeUndefined()
    expect(ariaSortFor(null, "amount")).toBeUndefined()
  })
})

describe("useTableSort", () => {
  it("starts from the given sort and toggles through nextSortState", () => {
    const { result } = renderHook(() => useTableSort<"tid" | "amount">({ key: "tid", direction: "asc" }))

    act(() => result.current.toggleSort("tid"))
    expect(result.current.sort).toEqual({ key: "tid", direction: "desc" })

    act(() => result.current.toggleSort("amount", "desc"))
    expect(result.current.sort).toEqual({ key: "amount", direction: "desc" })
  })
})
