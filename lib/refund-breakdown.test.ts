import { readFileSync } from "fs"
import { resolve } from "path"
import { describe, expect, it } from "vitest"

import { buildRefundBreakdownCents, refundBreakdownReconciles } from "./refund-breakdown"

describe("refund tax breakdown", () => {
  it("keeps the existing refund amount as the gross item-plus-tax value", () => {
    expect(buildRefundBreakdownCents(64_500, 11_610)).toEqual({
      itemRefundCents: 64_500,
      taxRefundCents: 11_610,
      grossRefundCents: 76_110,
    })
    expect(buildRefundBreakdownCents(19_600, 3_528)).toEqual({
      itemRefundCents: 19_600,
      taxRefundCents: 3_528,
      grossRefundCents: 23_128,
    })
  })

  it("preserves ordinary zero-tax refund behavior", () => {
    expect(buildRefundBreakdownCents(11_800, 0)).toEqual({
      itemRefundCents: 11_800,
      taxRefundCents: 0,
      grossRefundCents: 11_800,
    })
  })

  it("rejects negative or unsafe components and detects a mismatched gross", () => {
    expect(() => buildRefundBreakdownCents(100, -1)).toThrow()
    expect(() => buildRefundBreakdownCents(Number.MAX_SAFE_INTEGER, 1)).toThrow()
    expect(refundBreakdownReconciles({
      itemRefundCents: 100,
      taxRefundCents: 18,
      grossRefundCents: 100,
    })).toBe(false)
  })

  it("uses an additive zero-defaulted, range-constrained migration", () => {
    const migration = readFileSync(
      resolve(process.cwd(), "drizzle/20260805090000_add_refund_tax_cents.sql"),
      "utf8",
    )
    expect(migration).toContain('ADD COLUMN IF NOT EXISTS "tax_refund_cents" bigint DEFAULT 0 NOT NULL')
    expect(migration).toContain('"tax_refund_cents" >= 0')
    expect(migration).toContain('"tax_refund_cents" <= "amount_cents"')
  })
})
