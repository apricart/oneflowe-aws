import { describe, expect, it } from "vitest"

import {
  MAX_BUSINESS_QUANTITY,
  canTransitionOrderStatus,
  isPaidForRefund,
  isRefundEligibleOrderStatus,
} from "./business-rules"
import {
  adminRefundProcessSchema,
  orderCreateSchema,
  refundRequestSchema,
} from "./server/mutation-validation"

describe("business rules", () => {
  it("allows only the documented order status transitions", () => {
    expect(canTransitionOrderStatus("PENDING", "APPROVED")).toBe(true)
    expect(canTransitionOrderStatus("PENDING", "REJECTED")).toBe(true)
    expect(canTransitionOrderStatus("PENDING", "REFUNDED")).toBe(true)
    expect(canTransitionOrderStatus("APPROVED", "FULFILLED")).toBe(true)
    expect(canTransitionOrderStatus("FULFILLED", "REFUNDED")).toBe(true)

    expect(canTransitionOrderStatus("PENDING", "FULFILLED")).toBe(false)
    expect(canTransitionOrderStatus("REJECTED", "APPROVED")).toBe(false)
    expect(canTransitionOrderStatus("REFUNDED", "FULFILLED")).toBe(false)
  })

  it("requires a paid, non-terminal order for refunds", () => {
    expect(isRefundEligibleOrderStatus("PENDING")).toBe(true)
    expect(isRefundEligibleOrderStatus("APPROVED")).toBe(true)
    expect(isRefundEligibleOrderStatus("FULFILLED")).toBe(true)
    expect(isRefundEligibleOrderStatus("REJECTED")).toBe(false)
    expect(isRefundEligibleOrderStatus("REFUNDED")).toBe(false)
    expect(isPaidForRefund("PAID")).toBe(true)
    expect(isPaidForRefund("UNPAID")).toBe(false)
  })

  it("rejects duplicate order and refund lines", () => {
    expect(orderCreateSchema.safeParse({
      items: [
        { organizationInventoryId: 1, quantity: 1 },
        { organizationInventoryId: 1, quantity: 1 },
      ],
    }).success).toBe(false)

    expect(refundRequestSchema.safeParse({
      items: [{ id: 1, quantity: 1 }, { id: 1, quantity: 1 }],
    }).success).toBe(false)

    expect(adminRefundProcessSchema.safeParse({
      orderId: 1,
      items: [{ itemId: 1, quantity: 1 }, { itemId: 1, quantity: 1 }],
    }).success).toBe(false)
  })

  it("enforces the per-line maximum quantity", () => {
    expect(orderCreateSchema.safeParse({
      items: [{ organizationInventoryId: 1, quantity: MAX_BUSINESS_QUANTITY }],
    }).success).toBe(true)
    expect(orderCreateSchema.safeParse({
      items: [{ organizationInventoryId: 1, quantity: MAX_BUSINESS_QUANTITY + 0.001 }],
    }).success).toBe(false)
  })
})
