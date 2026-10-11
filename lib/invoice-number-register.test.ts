import { describe, expect, it } from "vitest"

import { classifyRegisteredNumber, registerNumberCandidates, type RegisterOrder } from "./invoice-number-register"

const order = (overrides: Partial<RegisterOrder>): RegisterOrder => ({
  orderId: 1,
  status: "FULFILLED",
  fulfillmentStatus: "DELIVERED",
  statusAtRefund: null,
  invoiceIssueDate: null,
  ...overrides,
})

describe("registerNumberCandidates", () => {
  it("tries the prefixed number first, then the unprefixed one used before 2026-09-24", () => {
    expect(registerNumberCandidates("ubl", 36)).toEqual(["UBL-APR-000036", "APR-000036"])
    expect(registerNumberCandidates("", 36)).toEqual(["APR-000036"])
  })
})

describe("classifyRegisteredNumber", () => {
  const candidates = ["UBL-APR-000036", "APR-000036"]

  it.each([
    [{ status: "FULFILLED" }, "ISSUED"],
    [{ status: "APPROVED", fulfillmentStatus: "IN_PROCESS" }, "RESERVED"],
    [{ status: "PENDING", fulfillmentStatus: "NOT_STARTED" }, "PENDING"],
    [{ status: "REJECTED", fulfillmentStatus: "NOT_STARTED" }, "NOT_ISSUED_REJECTED"],
    [{ status: "CANCELLED", fulfillmentStatus: "IN_PROCESS" }, "NOT_ISSUED_CANCELLED"],
    [{ status: "REFUNDED", fulfillmentStatus: "NOT_STARTED", statusAtRefund: "APPROVED" }, "NOT_ISSUED_REFUNDED"],
  ] as const)("explains an order that is %o as %s", (overrides, fate) => {
    const orders = new Map([["APR-000036", order(overrides)]])
    expect(classifyRegisteredNumber(candidates, orders, new Map()).fate).toBe(fate)
  })

  it("names a deleted order from its audit row", () => {
    const entry = classifyRegisteredNumber(candidates, new Map(), new Map([["UBL-APR-000036", { orderId: "1784", deletedAt: "2026-09-30T00:00:00.000Z" }]]))
    expect(entry).toMatchObject({ fate: "DELETED", orderId: "1784", number: "UBL-APR-000036" })
  })

  it("says plainly when nothing accounts for a number", () => {
    expect(classifyRegisteredNumber(candidates, new Map(), new Map())).toMatchObject({ fate: "UNACCOUNTED", number: "UBL-APR-000036" })
  })
})
