import { describe, expect, it } from "vitest"

import {
  organizationCreateSchema,
  organizationUpdateSchema,
} from "@/lib/server/mutation-validation"

describe("organization order approver validation", () => {
  it("defaults new organizations to Branch Admin", () => {
    const parsed = organizationCreateSchema.parse({
      name: "Example Company",
      code: "EXAMPLE",
    })
    expect(parsed.orderApproverRole).toBe("BRANCH_ADMIN")
  })

  it("accepts Head Office and rejects every other approver value", () => {
    expect(organizationUpdateSchema.safeParse({
      orderApproverRole: "HEAD_OFFICE",
    }).success).toBe(true)
    expect(organizationUpdateSchema.safeParse({
      orderApproverRole: "SUPER_ADMIN",
    }).success).toBe(false)
    expect(organizationUpdateSchema.safeParse({
      orderApproverRole: "ORDER_PORTAL",
    }).success).toBe(false)
  })
})

