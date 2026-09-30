"use client"

import { AlertTriangle } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import type { PendingInvoiceSummary } from "@/lib/pending-invoice"

export function PendingInvoiceAlert({
  invoice,
  continuing,
  onCancel,
  onContinue,
}: Readonly<{
  invoice: PendingInvoiceSummary | null
  continuing: boolean
  onCancel: () => void
  onContinue: () => void
}>) {
  return (
    <AlertDialog open={invoice !== null} onOpenChange={(open) => { if (!open) onCancel() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <AlertTriangle className="h-5 w-5" aria-hidden="true" />
          </div>
          <AlertDialogTitle>Pending invoice</AlertDialogTitle>
          <AlertDialogDescription>
            Invoice <span className="font-semibold text-foreground">{invoice?.invoiceNumber}</span> is still pending.
            You can continue with this order, but please arrange payment for the pending invoice.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={continuing}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={continuing} onClick={onContinue}>
            {continuing ? "Placing order…" : "Continue with order"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
