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
    expect(parsed.orderApprovalRequired).toBe(true)
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

  it("accepts only booleans for the order approval policy", () => {
    expect(organizationCreateSchema.safeParse({
      name: "Immediate Approval Company",
      code: "IMMEDIATE",
      orderApprovalRequired: false,
    }).success).toBe(true)
    expect(organizationUpdateSchema.safeParse({
      orderApprovalRequired: false,
    }).success).toBe(true)
    expect(organizationUpdateSchema.safeParse({
      orderApprovalRequired: "false",
    }).success).toBe(false)
  })
})

describe("organization unpaid-invoice ordering block validation", () => {
  it("defaults new organizations to not blocking, so nobody is blocked by accident", () => {
    const parsed = organizationCreateSchema.parse({ name: "Example Company", code: "EXAMPLE" })
    expect(parsed.blockOrderingOnUnpaidInvoices).toBe(false)
  })

  it("accepts the toggle on create and on update", () => {
    expect(organizationCreateSchema.parse({
      name: "Strict Company",
      code: "STRICT",
      blockOrderingOnUnpaidInvoices: true,
    }).blockOrderingOnUnpaidInvoices).toBe(true)
    expect(organizationUpdateSchema.parse({ blockOrderingOnUnpaidInvoices: true }))
      .toEqual({ blockOrderingOnUnpaidInvoices: true })
    expect(organizationUpdateSchema.parse({ blockOrderingOnUnpaidInvoices: false }))
      .toEqual({ blockOrderingOnUnpaidInvoices: false })
  })

  it.each(["true", 1, 0, null, {}])("accepts only a boolean, never %j", (value) => {
    expect(organizationUpdateSchema.safeParse({ blockOrderingOnUnpaidInvoices: value }).success).toBe(false)
    expect(organizationCreateSchema.safeParse({
      name: "Example Company",
      code: "EXAMPLE",
      blockOrderingOnUnpaidInvoices: value,
    }).success).toBe(false)
  })

  it("an update does not leave the toggle set when it was not sent", () => {
    expect(organizationUpdateSchema.parse({ name: "Renamed Company" })).not.toHaveProperty("blockOrderingOnUnpaidInvoices")
  })
})

describe("organization unacknowledged-delivery ordering block validation", () => {
  it("defaults new organizations to not blocking, so nobody is blocked by accident", () => {
    const parsed = organizationCreateSchema.parse({ name: "Example Company", code: "EXAMPLE" })
    expect(parsed.blockOrderingOnUnacknowledgedDeliveries).toBe(false)
  })

  it("accepts the toggle on create and on update, independently of the unpaid-invoice one", () => {
    const created = organizationCreateSchema.parse({
      name: "Strict Company",
      code: "STRICT",
      blockOrderingOnUnacknowledgedDeliveries: true,
    })
    expect(created.blockOrderingOnUnacknowledgedDeliveries).toBe(true)
    expect(created.blockOrderingOnUnpaidInvoices).toBe(false)
    expect(organizationUpdateSchema.parse({ blockOrderingOnUnacknowledgedDeliveries: true }))
      .toEqual({ blockOrderingOnUnacknowledgedDeliveries: true })
    expect(organizationUpdateSchema.parse({ blockOrderingOnUnacknowledgedDeliveries: false }))
      .toEqual({ blockOrderingOnUnacknowledgedDeliveries: false })
  })

  it.each(["true", 1, 0, null, {}])("accepts only a boolean, never %j", (value) => {
    expect(organizationUpdateSchema.safeParse({ blockOrderingOnUnacknowledgedDeliveries: value }).success).toBe(false)
    expect(organizationCreateSchema.safeParse({
      name: "Example Company",
      code: "EXAMPLE",
      blockOrderingOnUnacknowledgedDeliveries: value,
    }).success).toBe(false)
  })

  it("an update does not leave the toggle set when it was not sent", () => {
    expect(organizationUpdateSchema.parse({ name: "Renamed Company" })).not.toHaveProperty("blockOrderingOnUnacknowledgedDeliveries")
  })

  it("a misspelt field is refused rather than ignored", () => {
    expect(organizationUpdateSchema.safeParse({ blockOrderingOnUnacknowledgedDelivery: true }).success).toBe(false)
  })
})

