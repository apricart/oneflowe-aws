import { describe, expect, it } from "vitest"
import {
  canApprovePod,
  canRejectPod,
  canSubmitPod,
  canVerifyFulfillmentToken,
  distanceMeters,
  isValidLatLng,
  riderMayStartDelivery,
} from "@/lib/rider/assignment-status"

describe("rider assignment status", () => {
  it("allows starting only from ASSIGNED", () => {
    expect(riderMayStartDelivery("ASSIGNED")).toBe(true)
    expect(riderMayStartDelivery("OUT_FOR_DELIVERY")).toBe(false)
  })

  it("allows POD submit from out-for-delivery or rejected", () => {
    expect(canSubmitPod("OUT_FOR_DELIVERY")).toBe(true)
    expect(canSubmitPod("POD_REJECTED")).toBe(true)
    expect(canSubmitPod("POD_APPROVED")).toBe(false)
  })

  it("gates approve/reject and token verify", () => {
    expect(canApprovePod("POD_SUBMITTED")).toBe(true)
    expect(canRejectPod("POD_SUBMITTED")).toBe(true)
    expect(canVerifyFulfillmentToken("POD_APPROVED")).toBe(true)
    expect(canVerifyFulfillmentToken("POD_SUBMITTED")).toBe(false)
  })

  it("validates coordinates and measures distance", () => {
    expect(isValidLatLng(24.86, 67.0)).toBe(true)
    expect(isValidLatLng(100, 0)).toBe(false)
    const d = distanceMeters(24.86, 67.0, 24.861, 67.001)
    expect(d).toBeGreaterThan(0)
    expect(d).toBeLessThan(500)
  })
})
