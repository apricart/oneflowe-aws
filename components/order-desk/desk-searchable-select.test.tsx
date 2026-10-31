import { beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

import { DeskSearchableSelect } from "@/components/order-desk/desk-searchable-select"
import { installDomPolyfills } from "@/tests/support/ui-mocks"

const OPTIONS = [
  { id: 1, label: "Habib Bank Limited", keywords: "HBL" },
  { id: 2, label: "Attock Cement Pakistan Limited", keywords: "0008" },
  { id: 3, label: "United Bank Limited", hint: "Karachi" },
]

function renderSelect(props: Partial<Parameters<typeof DeskSearchableSelect>[0]> = {}) {
  const onValueChange = vi.fn()
  render(
    <DeskSearchableSelect
      ariaLabel="Organization"
      value={null}
      options={OPTIONS}
      placeholder="Select organization"
      searchLabel="Search organizations"
      emptyLabel="No organization found."
      onValueChange={onValueChange}
      {...props}
    />,
  )
  return onValueChange
}

function open() {
  fireEvent.click(screen.getByRole("combobox", { name: /Organization/ }))
}

function search(text: string) {
  fireEvent.change(screen.getByPlaceholderText("Search organizations..."), { target: { value: text } })
}

describe("DeskSearchableSelect", () => {
  beforeAll(installDomPolyfills)

  it("narrows the list by name, hidden keyword or hint, and picks the match", () => {
    const onValueChange = renderSelect()
    open()
    search("attock")
    expect(screen.queryByRole("option", { name: /Habib/ })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: /Attock/ }))
    expect(onValueChange).toHaveBeenCalledWith(2)

    open()
    search("hbl")
    expect(screen.getByRole("option", { name: /Habib/ })).toBeTruthy()
    search("karachi")
    expect(screen.getByRole("option", { name: /United/ })).toBeTruthy()
  })

  it("says so when nothing matches", () => {
    renderSelect()
    open()
    search("no such company")
    expect(screen.getByText("No organization found.")).toBeTruthy()
  })

  it("offers a clearing entry only when it is a filter", () => {
    const onValueChange = renderSelect({ value: 1, allLabel: "All organizations" })
    expect(screen.getByRole("combobox", { name: "Organization: Habib Bank Limited" })).toBeTruthy()
    open()
    fireEvent.click(screen.getByRole("option", { name: "All organizations" }))
    expect(onValueChange).toHaveBeenCalledWith(null)
  })

  it("has no clearing entry in a required choice and cannot open while disabled", () => {
    renderSelect({ disabled: true })
    const trigger = screen.getByRole("combobox", { name: /Organization/ })
    expect(trigger).toHaveProperty("disabled", true)
    fireEvent.click(trigger)
    expect(screen.queryByRole("option")).toBeNull()
  })
})
