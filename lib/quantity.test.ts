import { describe, expect, it } from "vitest"

import {
  calculateLineCents,
  isValidQuantityStep,
  roundQuantity,
  sanitizeQuantityStep,
  snapQuantityToStep,
  validateProductQuantity,
} from "@/lib/quantity"

/**
 * The quantity rules are shared by every ordering surface in the application,
 * so the contract that matters most here is what did *not* change: a caller
 * that does not ask for the stricter step rule has to behave exactly as it did
 * before the rule existed, or tightening it for the Group Order Portal would
 * quietly start refusing quantities `/shop` has always accepted.
 */
describe("step snapping", () => {
  it("puts a typed value onto the product's own grid", () => {
    expect(snapQuantityToStep(0.37, 0.5)).toBe(0.5)
    expect(snapQuantityToStep(0.8, 0.5)).toBe(1)
    expect(snapQuantityToStep(2.5, 0.5)).toBe(2.5)
    expect(snapQuantityToStep("3", 1)).toBe(3)
  })

  it("never snaps a positive quantity down to zero", () => {
    // Zero means "remove this line" to every caller, so rounding a small typed
    // value away would silently delete the line the user was editing.
    expect(snapQuantityToStep(0.01, 0.5)).toBe(0.5)
    expect(snapQuantityToStep(0.4, 1)).toBe(1)
  })

  it("still reads a cleared or unusable entry as a removal", () => {
    for (const value of ["", "  ", "abc", 0, -3, null, undefined]) {
      expect(snapQuantityToStep(value, 0.5)).toBe(0)
    }
  })

  it("leaves the quantity alone when the product has no usable step", () => {
    expect(snapQuantityToStep(1.25, 0)).toBe(1.25)
    expect(snapQuantityToStep(1.25, Number.NaN)).toBe(1.25)
  })

  it("produces a value the validator then accepts", () => {
    for (const typed of [0.1, 0.37, 1.2, 9.9]) {
      const snapped = snapQuantityToStep(typed, 0.5)
      expect(isValidQuantityStep(snapped, 0.5)).toBe(true)
      expect(validateProductQuantity(snapped, {
        allowDecimalQuantity: true,
        quantityStep: 0.5,
        enforceStep: true,
      }).ok).toBe(true)
    }
  })
})

describe("product quantity validation", () => {
  const halfKilo = { allowDecimalQuantity: true, quantityStep: 0.5 }

  it("accepts an off-grid decimal by default, exactly as it always has", () => {
    // Every pre-existing caller relies on this: the step has never been applied
    // to a decimal product, and turning that on everywhere at once would be a
    // behaviour change for roles this work does not touch.
    expect(validateProductQuantity(0.37, halfKilo).ok).toBe(true)
    expect(validateProductQuantity(1.234, halfKilo).ok).toBe(true)
  })

  it("refuses the same value once a caller opts in", () => {
    const refused = validateProductQuantity(0.37, { ...halfKilo, enforceStep: true })
    expect(refused.ok).toBe(false)
    expect(refused.ok === false && refused.error).toContain("increments of 0.5")
  })

  it("keeps whole-number products behaving identically either way", () => {
    const whole = { allowDecimalQuantity: false, quantityStep: 1 }
    expect(validateProductQuantity(2.5, whole).ok).toBe(false)
    expect(validateProductQuantity(2.5, { ...whole, enforceStep: true }).ok).toBe(false)
    expect(validateProductQuantity(3, whole).ok).toBe(true)
    expect(validateProductQuantity(3, { ...whole, enforceStep: true }).ok).toBe(true)
  })

  it("rejects a non-positive quantity whatever the step rule", () => {
    for (const enforceStep of [true, false]) {
      expect(validateProductQuantity(0, { ...halfKilo, enforceStep }).ok).toBe(false)
      expect(validateProductQuantity(-1, { ...halfKilo, enforceStep }).ok).toBe(false)
    }
  })

  it("names the product in the message so a failed branch says which line failed", () => {
    const refused = validateProductQuantity(0.37, {
      ...halfKilo,
      enforceStep: true,
      label: "Quantity for Basmati Rice",
    })
    expect(refused.ok === false && refused.error).toContain("Quantity for Basmati Rice")
  })
})

describe("quantity arithmetic", () => {
  it("rounds a subtraction back onto the stored scale", () => {
    // 0.3 - 0.1 - 0.1 is 0.09999999999999998 in binary floating point, which
    // reads as "0.1" on screen and then refuses a request for 0.1.
    expect(roundQuantity(0.3 - 0.1 - 0.1)).toBe(0.1)
    expect(roundQuantity(0.1 + 0.2)).toBe(0.3)
  })

  it("rounds a line total to whole cents the way the ledger stores it", () => {
    expect(calculateLineCents(333, 0.5)).toBe(167)
    expect(calculateLineCents(100, 2.5)).toBe(250)
  })

  it("forces a whole-number product onto a step of one", () => {
    expect(sanitizeQuantityStep(false, 0.5)).toBe(1)
    expect(sanitizeQuantityStep(true, 0.5)).toBe(0.5)
    expect(sanitizeQuantityStep(true, 0)).toBe(0.1)
  })
})
