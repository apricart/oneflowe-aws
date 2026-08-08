import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

describe("order-report table layout contract", () => {
  it("keeps all columns readable through horizontal scrolling instead of clipping", () => {
    const page = readFileSync(
      resolve(process.cwd(), "app/(portal)/reports/order-report/page.tsx"),
      "utf8",
    )

    expect(page).toContain("[&_[data-slot=table-container]]:overflow-x-auto")
    expect(page).toContain('Table className="min-w-[1850px] table-fixed"')
    expect(page).toContain('<col className="w-[185px]" />')
    expect(page).not.toContain("[&_[data-slot=table-container]]:overflow-hidden")
    expect(page).not.toContain("[&_td]:overflow-hidden")
  })
})
