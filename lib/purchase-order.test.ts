import { describe, expect, it } from "vitest"

import { MAX_PO_NUMBER_LENGTH, normalizePoNumberInput } from "./purchase-order"
import {
  groupOrderCreateSchema,
  orderCreateSchema,
  orderUpdateSchema,
} from "./server/mutation-validation"

const items = [{ organizationInventoryId: 10, quantity: 2 }]
const groupSubmission = {
  groupId: 4,
  entries: [{ branchIds: [1], items }],
}

function parsedPoNumber(input: unknown) {
  const parsed = orderCreateSchema.safeParse({ items, poNumber: input })
  return parsed.success ? parsed.data.poNumber : undefined
}

describe("purchase order number input", () => {
  it("keeps what a purchase order reference is actually made of", () => {
    expect(normalizePoNumberInput("PO-2026/0148 #A_1.2")).toBe("PO-2026/0148 #A_1.2")
  })

  it("drops characters the invoice must never carry", () => {
    expect(normalizePoNumberInput("PO<script>alert(1)</script>")).toBe("POscriptalert1/script")
    expect(normalizePoNumberInput("=SUM(A1)")).toBe("SUMA1")
  })

  it("holds the field to the stored width", () => {
    expect(normalizePoNumberInput("A".repeat(200))).toHaveLength(MAX_PO_NUMBER_LENGTH)
  })
})

describe("purchase order number validation", () => {
  it("accepts an ordinary reference and treats a blank one as no purchase order", () => {
    expect(parsedPoNumber("PO-2026-0148")).toBe("PO-2026-0148")
    expect(parsedPoNumber("  PO-2026-0148  ")).toBe("PO-2026-0148")
    expect(parsedPoNumber("")).toBeUndefined()
    expect(parsedPoNumber("   ")).toBeUndefined()
    expect(orderCreateSchema.safeParse({ items }).success).toBe(true)
  })

  it("refuses markup, control characters, and an over-long reference", () => {
    expect(orderCreateSchema.safeParse({ items, poNumber: "<b>PO</b>" }).success).toBe(false)
    expect(orderCreateSchema.safeParse({ items, poNumber: "PO\n0148" }).success).toBe(false)
    expect(orderCreateSchema.safeParse({ items, poNumber: "=SUM(A1)" }).success).toBe(false)
    expect(orderCreateSchema.safeParse({ items, poNumber: "-PO-1" }).success).toBe(false)
    expect(orderCreateSchema.safeParse({
      items,
      poNumber: "A".repeat(MAX_PO_NUMBER_LENGTH + 1),
    }).success).toBe(false)
  })

  it("refuses a non-string reference rather than coercing one", () => {
    expect(orderCreateSchema.safeParse({ items, poNumber: 148 }).success).toBe(false)
    expect(orderCreateSchema.safeParse({ items, poNumber: { toString: "PO-1" } }).success).toBe(false)
  })

  it("lets an edit clear a reference recorded earlier", () => {
    const cleared = orderUpdateSchema.safeParse({ items, poNumber: "" })
    expect(cleared.success && cleared.data.poNumber).toBeNull()

    const untouched = orderUpdateSchema.safeParse({ items })
    expect(untouched.success && untouched.data.poNumber).toBeUndefined()
  })

  it("applies the same rule to a group order submission", () => {
    expect(groupOrderCreateSchema.safeParse({
      ...groupSubmission,
      poNumber: "PO-2026-0148",
    }).success).toBe(true)
    expect(groupOrderCreateSchema.safeParse(groupSubmission).success).toBe(true)
    expect(groupOrderCreateSchema.safeParse({
      ...groupSubmission,
      poNumber: "<b>PO</b>",
    }).success).toBe(false)
  })
})
