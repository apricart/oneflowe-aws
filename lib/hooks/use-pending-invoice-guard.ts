"use client"

import { useCallback, useRef, useState } from "react"

import {
  parsePendingInvoiceStatus,
  type PendingInvoiceSummary,
} from "@/lib/pending-invoice"

const STATUS_URL = "/api/v1/orders/pending-invoice"

export function usePendingInvoiceGuard({
  onConfirmed,
  onCheckFailed,
}: Readonly<{
  onConfirmed: () => unknown
  onCheckFailed: (message: string) => void
}>) {
  const [pendingInvoice, setPendingInvoice] = useState<PendingInvoiceSummary | null>(null)
  const [checking, setChecking] = useState(false)
  const checkingRef = useRef(false)

  const attempt = useCallback(async () => {
    if (checkingRef.current) return
    checkingRef.current = true
    setChecking(true)

    try {
      const response = await fetch(STATUS_URL, { cache: "no-store" })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || "Pending invoices could not be checked.")
      }

      const status = parsePendingInvoiceStatus(payload)
      if (!status) throw new Error("Pending invoices could not be checked.")

      if (status.hasPendingInvoice && status.pendingInvoice) {
        setPendingInvoice(status.pendingInvoice)
        return
      }

      setPendingInvoice(null)
      await onConfirmed()
    } catch (error) {
      onCheckFailed(error instanceof Error ? error.message : "Pending invoices could not be checked.")
    } finally {
      checkingRef.current = false
      setChecking(false)
    }
  }, [onCheckFailed, onConfirmed])

  const continueAfterNotice = useCallback(async () => {
    setPendingInvoice(null)
    await onConfirmed()
  }, [onConfirmed])

  return {
    checking,
    pendingInvoice,
    attempt,
    dismiss: () => setPendingInvoice(null),
    continueAfterNotice,
  }
}
