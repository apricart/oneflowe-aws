import { describe, expect, it } from "vitest"
import {
  getBranchExportFilename,
  resolveBranchSheetWidths,
  type BranchExportSheet,
} from "./branch-excel-export"

describe("getBranchExportFilename", () => {
  it("creates a safe dated Excel filename from the branch code", () => {
    expect(getBranchExportFilename(
      { name: "Karachi Main", code: "../../KHI / 01" },
      new Date("2026-07-27T12:00:00.000Z"),
    )).toBe("KHI_01-complete-details-2026-07-27.xlsx")
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
