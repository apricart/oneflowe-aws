import { describe, expect, it } from "vitest"

import {
  DELIVERY_ADDRESS_DECISIONS,
  DELIVERY_ADDRESS_STATUSES,
  DELIVERY_ADDRESS_UNAVAILABLE,
  MAX_DELIVERY_ADDRESS_LABEL,
  MAX_DELIVERY_ADDRESS_PAGE,
  deliveryAddressLabelKey,
  describeDeliveryAddress,
  formatDeliveryAddress,
  isDeliveryAddressDecision,
  isDeliveryAddressStatus,
  isUsableDeliveryAddress,
  normalizeDeliveryAddressLabel,
  statusForDecision,
} from "@/lib/delivery-address"

describe("delivery address statuses", () => {
  it("admits exactly the three the check constraint allows", () => {
    expect([...DELIVERY_ADDRESS_STATUSES]).toEqual(["pending", "approved", "rejected"])
  })

  it.each(DELIVERY_ADDRESS_STATUSES)("recognises %s", (status) => {
    expect(isDeliveryAddressStatus(status)).toBe(true)
  })

  it.each([
    ["a status that does not exist", "archived"],
    ["a different case", "Pending"],
    ["whitespace around a real one", " pending "],
    ["a non-string", 1],
    ["null", null],
    ["undefined", undefined],
  ])("rejects %s", (_label, value) => {
    expect(isDeliveryAddressStatus(value)).toBe(false)
  })
})

describe("decisions", () => {
  it("offers only approve and reject", () => {
    expect([...DELIVERY_ADDRESS_DECISIONS]).toEqual(["approve", "reject"])
  })

  it.each([
    ["approve", "approved"],
    ["reject", "rejected"],
  ] as const)("maps %s to %s", (decision, status) => {
    expect(statusForDecision(decision)).toBe(status)
  })

  it("never maps a decision to pending", () => {
    for (const decision of DELIVERY_ADDRESS_DECISIONS) {
      expect(statusForDecision(decision)).not.toBe("pending")
    }
  })

  it.each([["approved", "approved"], ["delete", "delete"], ["", ""]])(
    "rejects %s as a decision",
    (_label, value) => {
      expect(isDeliveryAddressDecision(value)).toBe(false)
    },
  )
})

describe("normalizeDeliveryAddressLabel", () => {
  it.each([
    ["trims", "  Warehouse Gate 2  ", "Warehouse Gate 2"],
    ["collapses runs of spaces", "Gate    2", "Gate 2"],
    ["collapses tabs and newlines", "Site\tOffice\nB", "Site Office B"],
    ["leaves a clean label alone", "Warehouse Gate 2", "Warehouse Gate 2"],
    ["preserves case", "warehouse GATE 2", "warehouse GATE 2"],
    ["yields empty for whitespace only", "   ", ""],
  ])("%s", (_label, input, expected) => {
    expect(normalizeDeliveryAddressLabel(input)).toBe(expected)
  })
})

describe("deliveryAddressLabelKey", () => {
  it("is the normalized label, lower-cased", () => {
    expect(deliveryAddressLabelKey("  Warehouse   Gate 2 ")).toBe("warehouse gate 2")
  })

  /**
   * The load-bearing property. The key decides what the partial unique index
   * treats as a duplicate; if it disagreed with the display form, one address
   * would be admitted into a branch twice under two spellings of one name.
   */
  it.each([
    ["Warehouse Gate 2", "warehouse gate 2"],
    ["WAREHOUSE  GATE  2", " warehouse gate 2 "],
    ["Site\tOffice B", "site office b"],
  ])("treats %s and %s as the same address", (left, right) => {
    expect(deliveryAddressLabelKey(left)).toBe(deliveryAddressLabelKey(right))
  })

  it("keeps genuinely different names apart", () => {
    expect(deliveryAddressLabelKey("Gate 2")).not.toBe(deliveryAddressLabelKey("Gate 3"))
  })

  it("agrees with the display form on what is empty", () => {
    expect(deliveryAddressLabelKey("   ")).toBe("")
    expect(normalizeDeliveryAddressLabel("   ")).toBe("")
  })

  it("is idempotent, so re-normalizing a stored key cannot change it", () => {
    const once = deliveryAddressLabelKey("  Warehouse   Gate 2 ")
    expect(deliveryAddressLabelKey(once)).toBe(once)
  })
})

describe("formatDeliveryAddress", () => {
  it("joins the parts the invoice joins, in the same order", () => {
    expect(formatDeliveryAddress({
      address: "Plot 14, Sector 23",
      city: "Karachi",
      province: "Sindh",
    })).toBe("Plot 14, Sector 23, Karachi, Sindh")
  })

  it("drops missing and blank parts rather than leaving stray commas", () => {
    expect(formatDeliveryAddress({ address: "Plot 14", city: "  ", province: null }))
      .toBe("Plot 14")
  })

  it.each([[null], [undefined]])("returns an empty string for %s", (value) => {
    expect(formatDeliveryAddress(value)).toBe("")
  })
})

describe("describeDeliveryAddress", () => {
  it("leads with the label the selector is read by", () => {
    expect(describeDeliveryAddress({
      label: "Warehouse Gate 2",
      address: "Plot 14",
      city: "Karachi",
      province: null,
    })).toBe("Warehouse Gate 2 — Plot 14, Karachi")
  })

  it("falls back to the line alone when there is no label", () => {
    expect(describeDeliveryAddress({ label: "", address: "Plot 14", city: null, province: null }))
      .toBe("Plot 14")
  })

  it("falls back to the label alone when there is no line", () => {
    expect(describeDeliveryAddress({ label: "Gate 2", address: "", city: null, province: null }))
      .toBe("Gate 2")
  })
})

describe("isUsableDeliveryAddress", () => {
  it("is true only for an approved address", () => {
    expect(isUsableDeliveryAddress({ status: "approved" })).toBe(true)
  })

  it.each([
    ["pending", { status: "pending" }],
    ["rejected", { status: "rejected" }],
    ["an unknown status", { status: "archived" }],
    ["no status", {}],
    ["null", null],
    ["undefined", undefined],
  ])("is false for %s", (_label, value) => {
    expect(isUsableDeliveryAddress(value as never)).toBe(false)
  })
})

describe("bounds and the refusal message", () => {
  it("bounds the label at the column width", () => {
    expect(MAX_DELIVERY_ADDRESS_LABEL).toBe(120)
  })

  it("bounds a page, so a list endpoint cannot be asked for a whole tenant", () => {
    expect(MAX_DELIVERY_ADDRESS_PAGE).toBeGreaterThan(0)
    expect(Number.isSafeInteger(MAX_DELIVERY_ADDRESS_PAGE)).toBe(true)
  })

  /**
   * The message is deliberately uninformative: pending, rejected, another
   * branch's and another tenant's address are all refused in the same words,
   * so the order endpoint cannot be used to probe which ids exist.
   */
  it("says nothing about why the address is unavailable", () => {
    expect(DELIVERY_ADDRESS_UNAVAILABLE).toBe("That delivery address is not available for this branch")
    for (const status of DELIVERY_ADDRESS_STATUSES) {
      expect(DELIVERY_ADDRESS_UNAVAILABLE).not.toContain(status)
    }
    expect(DELIVERY_ADDRESS_UNAVAILABLE.toLowerCase()).not.toContain("tenant")
    expect(DELIVERY_ADDRESS_UNAVAILABLE.toLowerCase()).not.toContain("organization")
  })
})
