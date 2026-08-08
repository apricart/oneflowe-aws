import { describe, expect, it } from "vitest"
import * as XLSX from "xlsx"

const sourceRows = [
  {
    Tenant: "Acme",
    Role: "BRANCH_ADMIN",
    Quantity: 12.5,
    FormulaLike: "'=1+1",
  },
  {
    Tenant: "UBL",
    Role: "HEAD_OFFICE",
    Quantity: 0,
    FormulaLike: "'@SUM(1,2)",
  },
]

function createWorkbook() {
  const workbook = XLSX.utils.book_new()
  const worksheet = XLSX.utils.json_to_sheet(sourceRows)
  XLSX.utils.book_append_sheet(workbook, worksheet, "Users")
  return workbook
}

describe("spreadsheet workbook compatibility", () => {
  it.each([
    ["XLSX", "xlsx"],
    ["legacy XLS", "biff8"],
  ] as const)("round-trips %s workbooks without changing tenant data", (_, bookType) => {
    const buffer = XLSX.write(createWorkbook(), {
      type: "buffer",
      bookType,
    })
    const parsed = XLSX.read(buffer, {
      type: "buffer",
      cellDates: false,
    })

    expect(parsed.SheetNames).toEqual(["Users"])
    expect(XLSX.utils.sheet_to_json(parsed.Sheets.Users, { defval: "" }))
      .toEqual(sourceRows)
  })
})
