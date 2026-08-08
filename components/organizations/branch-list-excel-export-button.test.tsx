import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const xlsxMocks = vi.hoisted(() => ({
  jsonToSheet: vi.fn((
    _rows: Record<string, unknown>[],
    _options: { header: string[] },
  ) => ({ "!ref": "A1:H2" })),
  bookNew: vi.fn(() => ({})),
  appendSheet: vi.fn((_workbook: object, _worksheet: object, _name: string) => undefined),
  writeFile: vi.fn((_workbook: object, _filename: string, _options: object) => undefined),
}))

vi.mock("xlsx", () => ({
  utils: {
    json_to_sheet: xlsxMocks.jsonToSheet,
    book_new: xlsxMocks.bookNew,
    book_append_sheet: xlsxMocks.appendSheet,
  },
  writeFile: xlsxMocks.writeFile,
}))

import { BranchListExcelExportButton } from "./branch-list-excel-export-button"

describe("BranchListExcelExportButton", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("exports only the selected organization's branches in one eight-column sheet", async () => {
    render(
      <BranchListExcelExportButton
        organizations={[
          { id: 7, name: "Acme Holdings", code: "ACME" },
          { id: 8, name: "Beta Limited", code: "BETA" },
        ]}
        selectedOrganization={{ id: 7, name: "Acme Holdings", code: "ACME" }}
        branches={[
          {
            id: 11,
            organizationId: 7,
            name: "Karachi",
            code: "KHI",
            status: "active",
          },
          {
            id: 12,
            organizationId: 8,
            name: "Lahore",
            code: "LHE",
            status: "active",
          },
        ]}
      />,
    )

    fireEvent.click(
      screen.getByRole("button", {
        name: "Download all branches for Acme Holdings as Excel",
      }),
    )

    await waitFor(() => expect(xlsxMocks.writeFile).toHaveBeenCalledOnce())
    expect(xlsxMocks.jsonToSheet.mock.calls[0][0]).toHaveLength(1)
    expect(xlsxMocks.jsonToSheet.mock.calls[0][0][0]).toMatchObject({
      "Organization Name": "Acme Holdings",
      "Branch Name": "Karachi",
    })
    expect(xlsxMocks.jsonToSheet.mock.calls[0][1].header).toHaveLength(8)
    expect(xlsxMocks.appendSheet).toHaveBeenCalledOnce()
    expect(xlsxMocks.appendSheet).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      "Branches",
    )
  })
})
