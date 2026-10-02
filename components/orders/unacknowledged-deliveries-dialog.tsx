"use client"

import { PackageCheck } from "lucide-react"

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
import {
  UNACKNOWLEDGED_DELIVERIES_DIALOG_TITLE,
  unacknowledgedDeliveryCountLabel,
  type UnacknowledgedDeliveriesNotice,
} from "@/lib/unacknowledged-delivery-block"

/**
 * Shown when an order is refused — or is about to be — because the branch
 * holds delivered orders awaiting acknowledgement. There is nothing to
 * continue with the order; the only choices are to close it or, where the page
 * lists those orders, to go to them and acknowledge them.
 */
export function UnacknowledgedDeliveriesDialog({
  notice,
  onClose,
  onReview,
}: Readonly<{
  notice: UnacknowledgedDeliveriesNotice | null
  onClose: () => void
  /** Opens the page's list of delivered orders awaiting acknowledgement. */
  onReview?: () => void
}>) {
  return (
    <AlertDialog open={notice !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="mb-1 flex h-10 w-10 items-center justify-center rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300">
            <PackageCheck className="h-5 w-5" aria-hidden="true" />
          </div>
          <AlertDialogTitle>{UNACKNOWLEDGED_DELIVERIES_DIALOG_TITLE}</AlertDialogTitle>
          <AlertDialogDescription>{notice?.message}</AlertDialogDescription>
        </AlertDialogHeader>
        {notice && notice.branches.length > 0 && (
          <ul className="space-y-1 text-sm" aria-label="Locations with delivered orders awaiting acknowledgement">
            {notice.branches.map((branch) => (
              <li key={branch.branchId} className="flex justify-between gap-4 rounded-md border px-3 py-2">
                <span className="font-medium">{branch.branchName}</span>
                <span className="text-muted-foreground">{unacknowledgedDeliveryCountLabel(branch.unacknowledgedCount)}</span>
              </li>
            ))}
          </ul>
        )}
        <AlertDialogFooter>
          {onReview ? (
            <>
              <AlertDialogCancel onClick={onClose}>OK</AlertDialogCancel>
              <AlertDialogAction onClick={onReview}>View unacknowledged orders</AlertDialogAction>
            </>
          ) : (
            <AlertDialogAction onClick={onClose}>OK</AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
