"use client"

import { useState } from "react"
import { Banknote } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { isPaymentStatusUpdateEligible } from "@/lib/business-rules"
import { normalizePaymentStatus } from "@/lib/payment-status"
import { cn } from "@/lib/utils"

/**
 * Mark an approved order Paid or Unpaid. Rendered only for a caller that may
 * (`canUpdatePaymentStatus`) and only on an order the rule admits; the
 * payment-status route enforces both regardless.
 */
export function PaymentStatusToggle({
  orderId,
  orderStatus,
  fulfillmentStatus,
  paymentStatus,
  onUpdated,
  className,
}: Readonly<{
  orderId: number
  orderStatus: string | null | undefined
  fulfillmentStatus: string | null | undefined
  paymentStatus: string | null | undefined
  onUpdated: () => void | Promise<unknown>
  className?: string
}>) {
  const { toast } = useToast()
  const [isUpdating, setIsUpdating] = useState(false)
  if (!isPaymentStatusUpdateEligible(orderStatus, fulfillmentStatus)) return null

  const isPaid = normalizePaymentStatus(paymentStatus) === "PAID"
  const nextStatus = isPaid ? "UNPAID" : "PAID"

  const update = async () => {
    setIsUpdating(true)
    try {
      const response = await fetch(`/api/v1/orders/${orderId}/payment-status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paymentStatus: nextStatus }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || "Failed to update payment status")
      toast({ title: "Payment status updated", description: result.message })
      await onUpdated()
    } catch (updateError) {
      toast({
        title: "Payment update failed",
        description: updateError instanceof Error ? updateError.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setIsUpdating(false)
    }
  }

  let label = isPaid ? "Mark as Unpaid" : "Mark as Paid"
  if (isUpdating) label = "Updating..."

  return (
    <Button
      type="button"
      disabled={isUpdating}
      onClick={() => { void update() }}
      className={cn(
        "text-white font-semibold",
        isPaid ? "bg-amber-500 hover:bg-amber-600" : "bg-emerald-600 hover:bg-emerald-500",
        className,
      )}
    >
      <Banknote className={cn("mr-2 h-4 w-4", isUpdating && "animate-pulse")} aria-hidden="true" />
      {label}
    </Button>
  )
}
