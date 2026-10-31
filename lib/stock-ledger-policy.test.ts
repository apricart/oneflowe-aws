import { readFileSync } from "node:fs"

import { describe, expect, it } from "vitest"

import { STOCK_LEDGER_MODE, usesWarehouseStock } from "@/lib/stock-ledger-policy"
import { canManageWarehouseStock } from "@/lib/warehouse-stock-access"

describe("the stock ledger switch", () => {
  it("ships counting stock globally, exactly as before, until it is moved deliberately", () => {
    // Moving it is a reviewed deploy taken after migration 20261105120000 and
    // the opening run (plans/OF-STOCK-per-warehouse-stock.md). Change this
    // line in the same commit, never on its own.
    expect(STOCK_LEDGER_MODE).toBe("global")
    expect(readFileSync("lib/stock-ledger-policy.ts", "utf8"))
      .toContain('export const STOCK_LEDGER_MODE: StockLedgerMode = "global"')
  })

  it("reads each mode", () => {
    expect(usesWarehouseStock("global")).toBe(false)
    expect(usesWarehouseStock("warehouse")).toBe(true)
  })

  it("gives the Warehouse Stock page to Super Admin alone", () => {
    expect(canManageWarehouseStock("SUPER_ADMIN")).toBe(true)
    for (const role of ["HEAD_OFFICE", "WAREHOUSE", "APRICART_EXECUTIVE", "FINANCE", "ORDER_DESK", "VIEWER", undefined, null]) {
      expect(canManageWarehouseStock(role)).toBe(false)
    }
  })
})
