import { describe, expect, it } from "vitest"

import {
  formatPriceInput,
  hasPriceChanged,
  isPriceInputInvalid,
  parsePriceInput,
} from "@/lib/group-price-input"
import { MAX_PRICE_CENTS } from "@/lib/price-ladder"

describe("parsing a typed group price", () => {
  it("converts whole rupees to cents", () => {
    expect(parsePriceInput("1250")).toEqual({ ok: true, cents: 125_000 })
  })

  it("converts one and two decimal places to cents", () => {
    expect(parsePriceInput("1250.5")).toEqual({ ok: true, cents: 125_050 })
    expect(parsePriceInput("1250.55")).toEqual({ ok: true, cents: 125_055 })
  })

  it("rounds away the float error instead of truncating it", () => {
    // 12.35 * 100 is 1234.9999999999998 in IEEE 754. Truncating would charge a
    // cent less than the administrator typed, on every unit, forever.
    expect(parsePriceInput("12.35")).toEqual({ ok: true, cents: 1_235 })
    expect(parsePriceInput("1.005")).toEqual({ ok: false, error: "malformed" })
  })

  it("accepts zero as a deliberate price", () => {
    // Distinct from an empty box: zero is a price the group pays, not an
    // instruction to inherit the organization's.
    expect(parsePriceInput("0")).toEqual({ ok: true, cents: 0 })
    expect(parsePriceInput("0.00")).toEqual({ ok: true, cents: 0 })
  })

  it("treats an empty or whitespace-only box as a clear, not an error", () => {
    expect(parsePriceInput("")).toEqual({ ok: true, cents: null })
    expect(parsePriceInput("   ")).toEqual({ ok: true, cents: null })
  })

  it("trims the surrounding whitespace of a real amount", () => {
    expect(parsePriceInput("  1250  ")).toEqual({ ok: true, cents: 125_000 })
  })

  it.each([
    ["a negative amount", "-5"],
    ["three decimal places", "12.345"],
    ["a trailing decimal point", "12."],
    ["a thousands separator", "1,250"],
    ["a currency symbol", "PKR 1250"],
    ["letters", "abc"],
    ["scientific notation", "1e5"],
    ["a leading plus", "+12"],
    ["a lone decimal point", "."],
  ])("rejects %s", (_label, input) => {
    expect(parsePriceInput(input)).toEqual({ ok: false, error: "malformed" })
    expect(isPriceInputInvalid(input)).toBe(true)
  })

  it("rejects an amount above the storable range", () => {
    // Above this the database's integer column would reject the write, which
    // the user would see as an opaque failure instead of a corrected field.
    const overCeiling = String(MAX_PRICE_CENTS / 100 + 1)
    expect(parsePriceInput(overCeiling)).toEqual({ ok: false, error: "too-large" })
    expect(parsePriceInput(String(MAX_PRICE_CENTS / 100))).toEqual({
      ok: true,
      cents: MAX_PRICE_CENTS,
    })
  })

  it("does not flag an empty box as invalid", () => {
    expect(isPriceInputInvalid("")).toBe(false)
  })
})

describe("rendering a stored group price", () => {
  it("shows an override to two decimal places", () => {
    expect(formatPriceInput(125_000)).toBe("1250.00")
    expect(formatPriceInput(1_235)).toBe("12.35")
    expect(formatPriceInput(0)).toBe("0.00")
  })

  it("shows no override as an empty box", () => {
    expect(formatPriceInput(null)).toBe("")
  })

  it("round-trips a parsed amount", () => {
    for (const cents of [0, 1, 999, 125_055, MAX_PRICE_CENTS]) {
      const rendered = formatPriceInput(cents)
      expect(parsePriceInput(rendered)).toEqual({ ok: true, cents })
    }
  })
})

describe("detecting an edited price", () => {
  it("ignores a value retyped exactly as stored", () => {
    // Rewriting an unchanged price would add a meaningless audit entry.
    expect(hasPriceChanged("1250.00", 125_000)).toBe(false)
    expect(hasPriceChanged("  1250.00 ", 125_000)).toBe(false)
  })

  it("sees a new amount, a cleared box, and a first-time price", () => {
    expect(hasPriceChanged("1300.00", 125_000)).toBe(true)
    expect(hasPriceChanged("", 125_000)).toBe(true)
    expect(hasPriceChanged("1250.00", null)).toBe(true)
  })

  it("does not treat an untouched empty box as a change", () => {
    expect(hasPriceChanged("", null)).toBe(false)
  })

  it("counts a differently formatted but equal amount as a change", () => {
    // "1250" and "1250.00" are the same money; the comparison is textual, so
    // this is reported as an edit and saved as a no-op write rather than
    // silently dropped. Reporting a change the user made is the safe direction.
    expect(hasPriceChanged("1250", 125_000)).toBe(true)
  })
})
