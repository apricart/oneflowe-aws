import { describe, expect, it } from "vitest"

import {
  correctionNotificationEventKey,
  isAwaitingApproval,
  isAwaitingCorrection,
  normalizeCorrectionNote,
  orderCorrectionRefusalMessage,
  resubmissionRefusal,
  returnForCorrectionRefusal,
} from "@/lib/order-correction"
import { getOrderDerivedStatus } from "@/lib/order-status"

const returnedAt = "2026-10-05T10:00:00.000Z"

describe("who an order is waiting on", () => {
  it("is with the approver while pending and not returned", () => {
    expect(isAwaitingApproval({ status: "PENDING" })).toBe(true)
    expect(isAwaitingApproval({ status: "pending", returnedForCorrectionAt: null })).toBe(true)
    expect(isAwaitingCorrection({ status: "PENDING" })).toBe(false)
  })

  it("is with the requester while pending and returned", () => {
    const order = { status: "PENDING", returnedForCorrectionAt: returnedAt }
    expect(isAwaitingCorrection(order)).toBe(true)
    expect(isAwaitingApproval(order)).toBe(false)
    expect(isAwaitingCorrection({ status: "PENDING", returnedForCorrectionAt: new Date(returnedAt) })).toBe(true)
  })

  it("is with neither once decided, whatever the flag says", () => {
    for (const status of ["APPROVED", "REJECTED", "FULFILLED", "CANCELLED", "REFUNDED", "", null]) {
      expect(isAwaitingCorrection({ status, returnedForCorrectionAt: returnedAt })).toBe(false)
      expect(isAwaitingApproval({ status })).toBe(false)
    }
  })

  it("treats an empty timestamp as no request", () => {
    expect(isAwaitingCorrection({ status: "PENDING", returnedForCorrectionAt: "" })).toBe(false)
  })
})

describe("which transition is open", () => {
  it("lets an approver return a pending order once", () => {
    expect(returnForCorrectionRefusal({ status: "PENDING" })).toBeNull()
    expect(returnForCorrectionRefusal({ status: "PENDING", returnedForCorrectionAt: returnedAt }))
      .toBe("already-returned")
    expect(returnForCorrectionRefusal({ status: "APPROVED" })).toBe("not-pending")
    expect(returnForCorrectionRefusal({ status: "REJECTED" })).toBe("not-pending")
  })

  it("lets a requester resubmit only a returned pending order", () => {
    expect(resubmissionRefusal({ status: "PENDING", returnedForCorrectionAt: returnedAt })).toBeNull()
    expect(resubmissionRefusal({ status: "PENDING" })).toBe("not-returned")
    expect(resubmissionRefusal({ status: "APPROVED", returnedForCorrectionAt: returnedAt })).toBe("not-pending")
  })

  it("explains each refusal", () => {
    expect(orderCorrectionRefusalMessage("already-returned", "PENDING")).toMatch(/already been returned/)
    expect(orderCorrectionRefusalMessage("not-returned", "PENDING")).toMatch(/not awaiting correction/)
    expect(orderCorrectionRefusalMessage("not-pending", "APPROVED")).toMatch(/APPROVED/)
  })
})

describe("notes and keys", () => {
  it("records a blank reply as no reply", () => {
    expect(normalizeCorrectionNote(undefined)).toBeNull()
    expect(normalizeCorrectionNote("   ")).toBeNull()
    expect(normalizeCorrectionNote("  done  ")).toBe("done")
  })

  it("keys each round separately, so a second round is never dropped as a duplicate", () => {
    const first = correctionNotificationEventKey("ORDER_RETURNED", 9, 1, "user-a")
    const second = correctionNotificationEventKey("ORDER_RETURNED", 9, 2, "user-a")
    expect(first).not.toBe(second)
    expect(first).toBe("ORDER_RETURNED:9:r1:user-a")
    // The once-per-order keys are `template:order:recipient`; a round key can never equal one.
    expect(first).not.toBe("ORDER_RETURNED:9:user-a")
  })
})

describe("the status label", () => {
  it("says the order is returned, while every filter still reads it as pending", () => {
    expect(getOrderDerivedStatus({ status: "PENDING", returnedForCorrectionAt: returnedAt }))
      .toEqual({ key: "returned_for_correction", label: "Returned for Correction" })
    expect(getOrderDerivedStatus({ status: "PENDING" })).toEqual({ key: "pending", label: "Pending Approval" })
    expect(getOrderDerivedStatus({ status: "REJECTED", returnedForCorrectionAt: returnedAt }).key).toBe("rejected")
  })
})
