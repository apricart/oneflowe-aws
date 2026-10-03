"use client"

import { ReceiptText } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  UNPAID_INVOICES_DIALOG_TITLE,
  unpaidInvoiceCountLabel,
  type UnpaidInvoicesNotice,
} from "@/lib/unpaid-invoice-block"

/**
 * Shown when an order is refused — or is about to be — because the branch
 * holds unpaid invoices. There is nothing to continue with, so the only
 * choice is to close it.
 */
export function UnpaidInvoicesDialog({
  notice,
  onClose,
}: Readonly<{
  notice: UnpaidInvoicesNotice | null
  onClose: () => void
}>) {
  return (
    <AlertDialog open={notice !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300">
            <ReceiptText className="h-5 w-5" aria-hidden="true" />
          </div>
          <AlertDialogTitle>{UNPAID_INVOICES_DIALOG_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{notice?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        {notice && notice.branches.length > 0 && (
          <ul className="space-y-1 text-sm" aria-label="Locations with unpaid invoices">
            {notice.branches.map((branch) => (
              <li key={branch.branchId} className="flex justify-between gap-4 rounded-md border px-3 py-2">
                <span className="font-medium">{branch.branchName}</span>
                <span className="text-muted-foreground">{unpaidInvoiceCountLabel(branch.unpaidInvoiceCount)}</span>
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          <AlertDialogAction onClick={onClose}>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
