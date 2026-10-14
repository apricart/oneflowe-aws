import { describe, expect, it } from "vitest"

import { MAX_APPROVAL_LEVELS } from "@/lib/order-approval-levels"
import { organizationCreateSchema, orderApprovalLevelsSchema } from "@/lib/server/mutation-validation"

/**
 * The request shapes for order approval levels
 * (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md). The list rule
 * itself is `approvalLevelsError`, tested in lib/order-approval-levels.test.ts;
 * this pins that the schema applies it and refuses everything around it.
 */
const levels = (...amounts: number[]) => amounts.map((maxAmountCents) => ({ maxAmountCents }))

describe("orderApprovalLevelsSchema", () => {
  it("accepts levels that strictly increase", () => {
    const parsed = orderApprovalLevelsSchema.safeParse({ enabled: true, levels: levels(4_000_000, 8_000_000) })
    expect(parsed.success).toBe(true)
  })

  it("accepts switching off without levels, which keeps the stored ones", () => {
    expect(orderApprovalLevelsSchema.safeParse({ enabled: false }).success).toBe(true)
  })

  it("accepts switching off with levels, which replaces them", () => {
    expect(orderApprovalLevelsSchema.safeParse({ enabled: false, levels: levels(100) }).success).toBe(true)
    expect(orderApprovalLevelsSchema.safeParse({ enabled: false, levels: [] }).success).toBe(true)
  })

  it.each([
    ["switching on without levels", { enabled: true }],
    ["switching on with an empty list", { enabled: true, levels: [] }],
    ["an amount sent as a string", { enabled: true, levels: [{ maxAmountCents: "4000000" }] }],
    ["a fractional amount", { enabled: true, levels: levels(400.5) }],
    ["a zero amount", { enabled: true, levels: levels(0) }],
    ["a negative amount", { enabled: true, levels: levels(-100) }],
    ["an amount over the maximum", { enabled: true, levels: levels(100_000_000_001) }],
    ["equal amounts", { enabled: true, levels: levels(4_000_000, 4_000_000) }],
    ["a falling amount", { enabled: true, levels: levels(8_000_000, 4_000_000) }],
    ["a falling amount while switched off", { enabled: false, levels: levels(8_000_000, 4_000_000) }],
    ["an unknown field on a level", { enabled: true, levels: [{ maxAmountCents: 100, level: 7 }] }],
    ["an unknown field on the body", { enabled: true, levels: levels(100), organizationId: 9 }],
    ["a missing switch", { levels: levels(100) }],
    ["a switch sent as a string", { enabled: "true", levels: levels(100) }],
  ])("refuses %s", (_label, body) => {
    expect(orderApprovalLevelsSchema.safeParse(body).success).toBe(false)
  })

  it("allows exactly the maximum number of levels and not one more", () => {
    const amounts = (count: number) => Array.from({ length: count }, (_, index) => (index + 1) * 100)
    expect(orderApprovalLevelsSchema.safeParse({ enabled: true, levels: levels(...amounts(MAX_APPROVAL_LEVELS)) }).success)
      .toBe(true)
    expect(orderApprovalLevelsSchema.safeParse({ enabled: true, levels: levels(...amounts(MAX_APPROVAL_LEVELS + 1)) }).success)
      .toBe(false)
  })
})

describe("organizationCreateSchema.orderApprovalLevels", () => {
  const company = { name: "Acme Inc.", code: "ACME" }

  it("is optional", () => {
    const parsed = organizationCreateSchema.safeParse(company)
    expect(parsed.success).toBe(true)
    expect(parsed.success && parsed.data.orderApprovalLevels).toBeUndefined()
  })

  it("carries the same rules as the Edit endpoint", () => {
    expect(organizationCreateSchema.safeParse({
      ...company,
      orderApprovalLevels: { enabled: true, levels: levels(4_000_000, 8_000_000) },
    }).success).toBe(true)
    expect(organizationCreateSchema.safeParse({
      ...company,
      orderApprovalLevels: { enabled: true, levels: levels(8_000_000, 4_000_000) },
    }).success).toBe(false)
    expect(organizationCreateSchema.safeParse({
      ...company,
      orderApprovalLevels: { enabled: true },
    }).success).toBe(false)
  })
})
