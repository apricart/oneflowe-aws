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


// plans/OF-ORDERING-BLOCK-configurable-thresholds.md
describe.each([
  "unpaidInvoiceBlockThreshold",
  "unacknowledgedDeliveryBlockThreshold",
] as const)("organization ordering-block threshold validation: %s", (field) => {
  it("defaults a new organization to 2, the fixed limit before it was configurable", () => {
    expect(organizationCreateSchema.parse({ name: "Example Company", code: "EXAMPLE" })[field]).toBe(2)
  })

  it.each([1, 2, 7, 99, 100])("accepts %i on create and on update", (value) => {
    expect(organizationCreateSchema.parse({ name: "Example Company", code: "EXAMPLE", [field]: value })[field]).toBe(value)
    expect(organizationUpdateSchema.parse({ [field]: value })).toEqual({ [field]: value })
  })

  it.each([0, -1, 101, 1_000, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3", "", null, true, {}, [3]])(
    "refuses %j on create and on update",
    (value) => {
      expect(organizationUpdateSchema.safeParse({ [field]: value }).success).toBe(false)
      expect(organizationCreateSchema.safeParse({ name: "Example Company", code: "EXAMPLE", [field]: value }).success).toBe(false)
    },
  )

  it("an update does not set it when it was not sent", () => {
    expect(organizationUpdateSchema.parse({ name: "Renamed Company" })).not.toHaveProperty(field)
  })

  it("is independent of its toggle: it may be set while the block is off", () => {
    expect(organizationUpdateSchema.parse({ [field]: 5, blockOrderingOnUnpaidInvoices: false, blockOrderingOnUnacknowledgedDeliveries: false }))
      .toEqual({ [field]: 5, blockOrderingOnUnpaidInvoices: false, blockOrderingOnUnacknowledgedDeliveries: false })
  })
})

it("a misspelt threshold field is refused rather than ignored", () => {
  expect(organizationUpdateSchema.safeParse({ unpaidInvoicesBlockThreshold: 3 }).success).toBe(false)
  expect(organizationUpdateSchema.safeParse({ unacknowledgedDeliveriesBlockThreshold: 3 }).success).toBe(false)
})
