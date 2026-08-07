import { readFileSync } from "fs"
import { resolve } from "path"

import { describe, expect, it } from "vitest"

describe("order report global date filter contract", () => {
  it("propagates global month and year selections to the report table", () => {
    const page = readFileSync(
      resolve(process.cwd(), "app/(portal)/reports/order-report/page.tsx"),
      "utf8",
    )

    expect(page).toContain("setReportMonths([...selectedMonths])")
    expect(page).toContain("setReportYears([...selectedYears])")
  })
})
