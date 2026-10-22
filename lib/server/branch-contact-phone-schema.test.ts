import { describe, expect, it } from "vitest"

import { branchCreateSchema, branchUpdateSchema } from "./mutation-validation"

const base = {
  organizationId: 12,
  name: "Saddar Branch",
  province: "Sindh",
  city: "Karachi",
  address: "3 Zaibunnisa Street",
}

describe("branch schemas: contactPhone (plans/OF-BRANCH-contact-phone.md)", () => {
  it("is optional on create and stays absent when not sent", () => {
    const parsed = branchCreateSchema.parse(base)
    expect(parsed.contactPhone).toBeUndefined()
  })

  it("stores a phone normalised, and blank or null as null", () => {
    expect(branchCreateSchema.parse({ ...base, contactPhone: "  0300   1234567 " }).contactPhone).toBe("0300 1234567")
    expect(branchCreateSchema.parse({ ...base, contactPhone: "   " }).contactPhone).toBeNull()
    expect(branchCreateSchema.parse({ ...base, contactPhone: null }).contactPhone).toBeNull()
    expect(branchUpdateSchema.parse({ contactPhone: null }).contactPhone).toBeNull()
    expect(branchUpdateSchema.parse({ contactPhone: "042-35453651" }).contactPhone).toBe("042-35453651")
  })

  it("refuses something that is not a phone number", () => {
    for (const contactPhone of ["N/A", "021-32116000 Ext 2110", "123", "1".repeat(16), "0".repeat(80), 3001234567]) {
      expect(branchCreateSchema.safeParse({ ...base, contactPhone }).success, String(contactPhone)).toBe(false)
      expect(branchUpdateSchema.safeParse({ contactPhone }).success, String(contactPhone)).toBe(false)
    }
  })

  it("is the only new field: an unknown phone-like key is still refused", () => {
    expect(branchCreateSchema.safeParse({ ...base, phone: "0300-1234567" }).success).toBe(false)
    expect(branchUpdateSchema.safeParse({ phone: "0300-1234567" }).success).toBe(false)
  })
})
