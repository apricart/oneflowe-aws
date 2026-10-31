import { beforeAll, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"

import { OrganizationSearchSelect } from "@/components/inventory/organization-search-select"
import { installDomPolyfills } from "@/tests/support/ui-mocks"

const ORGANIZATIONS = [
  { id: 4, name: "EFU" },
  { id: 10, name: "K-Electric Limited" },
  { id: 11, name: "Meezan (Demo)" },
]

function renderSelect(value = "") {
  const onValueChange = vi.fn()
  render(
    <OrganizationSearchSelect
      value={value}
      organizations={ORGANIZATIONS}
      placeholder="Select organization"
      onValueChange={onValueChange}
    />,
  )
  return onValueChange
}

describe("OrganizationSearchSelect", () => {
  beforeAll(installDomPolyfills)

  it("shows the placeholder when nothing is chosen", () => {
    renderSelect()
    expect(screen.getByRole("combobox", { name: /Select organization/ })).toBeTruthy()
  })

  it("shows the chosen organization's name from its string id", () => {
    renderSelect("10")
    expect(screen.getByRole("combobox", { name: /K-Electric Limited/ })).toBeTruthy()
  })

  it("narrows the list by search and hands back the string id", () => {
    const onValueChange = renderSelect()
    fireEvent.click(screen.getByRole("combobox", { name: /Organization/ }))
    fireEvent.change(screen.getByPlaceholderText("Search organizations..."), { target: { value: "meez" } })
    expect(screen.queryByRole("option", { name: /EFU/ })).toBeNull()
    fireEvent.click(screen.getByRole("option", { name: /Meezan/ }))
    expect(onValueChange).toHaveBeenCalledWith("11")
  })

  it("says so when nothing matches", () => {
    renderSelect()
    fireEvent.click(screen.getByRole("combobox", { name: /Organization/ }))
    fireEvent.change(screen.getByPlaceholderText("Search organizations..."), { target: { value: "no such company" } })
    expect(screen.getByText("No organization found.")).toBeTruthy()
  })
})
