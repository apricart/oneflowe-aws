import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { usePendingInvoiceGuard } from "./use-pending-invoice-guard"

const jsonResponse = (body: unknown, init?: ResponseInit) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { "Content-Type": "application/json" },
  ...init,
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("usePendingInvoiceGuard", () => {
  it("continues immediately when the user has no pending invoice", async () => {
    const onConfirmed = vi.fn()
    const onCheckFailed = vi.fn()
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      hasPendingInvoice: false,
      pendingInvoice: null,
    }))
    vi.stubGlobal("fetch", fetchMock)

    const { result } = renderHook(() => usePendingInvoiceGuard({ onConfirmed, onCheckFailed }))
    await act(async () => { await result.current.attempt() })

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/orders/pending-invoice", { cache: "no-store" })
    expect(onConfirmed).toHaveBeenCalledOnce()
    expect(result.current.pendingInvoice).toBeNull()
    expect(onCheckFailed).not.toHaveBeenCalled()
  })

  it("pauses submission and exposes the pending invoice for the notice", async () => {
    const onConfirmed = vi.fn()
    const onCheckFailed = vi.fn()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({
      hasPendingInvoice: true,
      pendingInvoice: { orderId: 9, invoiceNumber: "INV-9", orderReference: "TID-9" },
    })))

    const { result } = renderHook(() => usePendingInvoiceGuard({ onConfirmed, onCheckFailed }))
    await act(async () => { await result.current.attempt() })

    expect(onConfirmed).not.toHaveBeenCalled()
    expect(result.current.pendingInvoice).toEqual({
      orderId: 9,
      invoiceNumber: "INV-9",
      orderReference: "TID-9",
    })

    await act(async () => { await result.current.continueAfterNotice() })
    expect(onConfirmed).toHaveBeenCalledOnce()
    expect(result.current.pendingInvoice).toBeNull()
  })

  it("does not submit when the status check fails or is malformed", async () => {
    const onConfirmed = vi.fn()
    const onCheckFailed = vi.fn()
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ hasPendingInvoice: true })))

    const { result } = renderHook(() => usePendingInvoiceGuard({ onConfirmed, onCheckFailed }))
    await act(async () => { await result.current.attempt() })

    expect(onConfirmed).not.toHaveBeenCalled()
    expect(onCheckFailed).toHaveBeenCalledWith("Pending invoices could not be checked.")
  })
})
