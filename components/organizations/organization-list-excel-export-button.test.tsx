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

import { OrganizationListExcelExportButton } from "./organization-list-excel-export-button"

describe("OrganizationListExcelExportButton", () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
  })

  it("downloads all supplied organizations in one sheet with eight columns", async () => {
    render(
      <OrganizationListExcelExportButton
        organizations={[
          {
            id: 7,
            name: "Acme Holdings",
            code: "ACME",
            status: "active",
            budgetAllocationMode: "money",
            orderApproverRole: "BRANCH_ADMIN",
          },
        ]}
        branches={[
          {
            id: 11,
            organizationId: 7,
            name: "Karachi",
            code: "KHI",
            status: "active",
          },
        ]}
      />,
    )

    fireEvent.click(screen.getByRole("button", { name: "Download all organizations as Excel" }))

    await waitFor(() => expect(xlsxMocks.writeFile).toHaveBeenCalledOnce())
    expect(xlsxMocks.jsonToSheet).toHaveBeenCalledWith(
      [expect.objectContaining({
        "Organization Name": "Acme Holdings",
        "Total Branches": 1,
      })],
      { header: expect.any(Array) },
    )
    expect(xlsxMocks.jsonToSheet.mock.calls[0][1].header).toHaveLength(8)
    expect(xlsxMocks.appendSheet).toHaveBeenCalledOnce()
    expect(xlsxMocks.appendSheet).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      "Organizations",
    )
  })
})
