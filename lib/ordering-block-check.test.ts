import { describe, expect, it, vi } from "vitest"

import { checkOrderingBlock } from "@/lib/ordering-block-check"

const response = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response

const blockedView = { orderingAllowed: false, overdueCount: 2, threshold: 2, reason: "THRESHOLD_REACHED" }

describe("checkOrderingBlock", () => {
  it("asks for the named branch, uncached, and reports a block", async () => {
    const fetchImpl = vi.fn(async () => response(200, blockedView))
    const block = await checkOrderingBlock(42, fetchImpl as unknown as typeof fetch)

    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/payment-control?branchId=42", { cache: "no-store" })
    expect(block).toEqual({
      unpaidInvoiceCount: 2,
      threshold: 2,
      message: "You have 2 unpaid invoices. Please pay your dues before placing a new order.",
    })
  })

  it("asks for the session's own branch when none is named", async () => {
    const fetchImpl = vi.fn(async () => response(200, blockedView))
    await checkOrderingBlock(null, fetchImpl as unknown as typeof fetch)
    expect(fetchImpl).toHaveBeenCalledWith("/api/v1/payment-control", { cache: "no-store" })
  })

  it("reports nothing when ordering is allowed", async () => {
    const fetchImpl = vi.fn(async () => response(200, { ...blockedView, orderingAllowed: true }))
    expect(await checkOrderingBlock(1, fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  // The check is presentation only. The order route's gate refuses a blocked
  // branch whatever happens here, so a failed check must never stop an order.
  it.each([
    ["a 403", () => response(403, { error: "Forbidden" })],
    ["a 500", () => response(500, { error: "Unable to load payment control" })],
    ["an unreadable body", () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json") } }) as unknown as Response],
  ])("fails open on %s", async (_label, make) => {
    const fetchImpl = vi.fn(async () => make())
    expect(await checkOrderingBlock(1, fetchImpl as unknown as typeof fetch)).toBeNull()
  })

  it("fails open when the network is down", async () => {
    const fetchImpl = vi.fn(async () => { throw new TypeError("Failed to fetch") })
    expect(await checkOrderingBlock(1, fetchImpl as unknown as typeof fetch)).toBeNull()
  })
})
