import { describe, expect, it, vi } from "vitest"

import { checkDeliveryAcknowledgementBlock, deliveryAcknowledgementUrl } from "@/lib/delivery-acknowledgement-check"

const response = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

const blockedView = { branchId: 42, enabled: true, orderingAllowed: false, unacknowledgedCount: 2, threshold: 2 }

describe("deliveryAcknowledgementUrl", () => {
  it("names a positive branch and omits anything else", () => {
    expect(deliveryAcknowledgementUrl(42)).toBe("/api/v1/orders/delivery-acknowledgement?branchId=42")
    for (const branchId of [null, undefined, 0, -3, 1.5, Number.NaN]) {
      expect(deliveryAcknowledgementUrl(branchId)).toBe("/api/v1/orders/delivery-acknowledgement")
    }
  })
})

describe("checkDeliveryAcknowledgementBlock", () => {
  it("asks for the named branch, uncached, and reports a block", async () => {
    const fetchImpl = vi.fn(async () => response(200, blockedView))
    const notice = await checkDeliveryAcknowledgementBlock(42, fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/orders/delivery-acknowledgement?branchId=42", { cache: "no-store" })
    expect(notice).toEqual({
      message: "Your branch has 2 delivered orders awaiting acknowledgement. Please acknowledge/fulfil your delivered orders to place a new order.",
      branches: [],
    })
  })

  it("asks for the session's own branch when none is named", async () => {
    const fetchImpl = vi.fn(async () => response(200, blockedView))
    await checkDeliveryAcknowledgementBlock(null, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/orders/delivery-acknowledgement", { cache: "no-store" })
  })

  it("reports nothing when ordering is allowed or the toggle is off", async () => {
    const allowed = vi.fn(async () => response(200, { ...blockedView, orderingAllowed: true, unacknowledgedCount: 1 }))
    expect(await checkDeliveryAcknowledgementBlock(1, allowed as unknown as typeof fetch)).toBeNull()
    const off = vi.fn(async () => response(200, { ...blockedView, enabled: false, orderingAllowed: true, unacknowledgedCount: 0 }))
    expect(await checkDeliveryAcknowledgementBlock(1, off as unknown as typeof fetch)).toBeNull()
  })

  // Presentation only. The order route's gate refuses a blocked branch
  // whatever happens here, so a failed check must never stop an order.
  it.each([
    ["a 400", () => response(400, { error: "branchId is required" })],
    ["a 403", () => response(403, { error: "Forbidden" })],
    ["a 404", () => response(404, { error: "Branch not found" })],
    ["a 500", () => response(500, { error: "Unable to load delivery acknowledgement status" })],
    ["an unreadable body", () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json") } }) as unknown as Response],
    ["a malformed body", () => response(200, { orderingAllowed: false })],
  ])("fails open on %s", async (_label, make) => {
    const fetchImpl = vi.fn(async () => make())
    expect(await checkDeliveryAcknowledgementBlock(1, fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it("fails open when the network is down", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch") })
    expect(await checkDeliveryAcknowledgementBlock(1, fetchImpl as unknown as typeof fetch)).toBeNull()
  })
})
