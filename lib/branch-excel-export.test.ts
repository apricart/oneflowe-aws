import { describe, expect, it } from "vitest"
import {
  BRANCH_LIST_HEADERS,
  buildBranchListWorkbookData,
  getBranchExportFilename,
  getBranchListExportFilename,
  resolveBranchSheetWidths,
  type BranchExportSheet,
} from "./branch-excel-export"

describe("buildBranchListWorkbookData", () => {
  it("creates branch rows with exactly eight relevant columns", () => {
    const rows = buildBranchListWorkbookData(
      [
        {
          id: 11,
          organizationId: 7,
          name: "Karachi Office",
          code: "ACME-KHI",
          status: "active",
          province: "Sindh",
          city: "Karachi",
          address: "Shahrah-e-Faisal",
          costCenterId: "CC-100",
        },
      ],
      [{ id: 7, name: "Acme Holdings", code: "ACME" }],
    )

    expect(BRANCH_LIST_HEADERS).toHaveLength(8)
    expect(rows).toHaveLength(1)
    expect(Object.keys(rows[0])).toEqual([...BRANCH_LIST_HEADERS])
    expect(rows[0]).toEqual({
      "Organization Name": "Acme Holdings",
      "Branch Name": "Karachi Office",
      "Branch Code": "ACME-KHI",
      "Status": "Active",
      "Province": "Sindh",
      "City": "Karachi",
      "Address": "Shahrah-e-Faisal",
      "Cost Center ID": "CC-100",
    })
  })
})

describe("getBranchExportFilename", () => {
  it("creates a safe dated Excel filename from the branch code", () => {
    expect(getBranchExportFilename(
      { name: "Karachi Main", code: "../../KHI / 01" },
      new Date("2026-07-27T12:00:00.000Z"),
    )).toBe("KHI_01-complete-details-2026-07-27.xlsx")
  })

  it("creates a selected-organization branch list filename", () => {
    expect(getBranchListExportFilename(
      { id: 7, name: "Acme Holdings", code: "../../ACME / North" },
      new Date("2026-07-31T12:00:00.000Z"),
    )).toBe("ACME_North-branches-2026-07-31.xlsx")
  })

  it("creates an all-branches filename when no organization is selected", () => {
    expect(getBranchListExportFilename(
      null,
      new Date("2026-07-31T12:00:00.000Z"),
    )).toBe("all-branches-2026-07-31.xlsx")
  })
})

describe("resolveBranchSheetWidths", () => {
  it("uses configured widths and keeps them within Excel-friendly limits", () => {
    const sheet: BranchExportSheet = {
      name: "Orders",
      headers: ["TID", "Notes"],
      rows: [],
      columnWidths: [8, 100],
    }

    expect(resolveBranchSheetWidths(sheet)).toEqual([{ wch: 10 }, { wch: 60 }])
  })

  it("derives widths from headers and row values", () => {
    const sheet: BranchExportSheet = {
      name: "Users",
      headers: ["Name", "Email"],
      rows: [{ Name: "A long display name", Email: "a@example.com" }],
    }

    expect(resolveBranchSheetWidths(sheet)).toEqual([{ wch: 21 }, { wch: 15 }])
  })
})
