"use client"

import { useEffect, useState } from "react"

import { Loader2 } from "lucide-react"

import type { DeliveryAddressListItem } from "@/components/delivery-addresses/delivery-address-row"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { formatDeliveryAddress, MAX_DELIVERY_ADDRESS_REASON } from "@/lib/delivery-address"
import { jsonFetcher } from "@/lib/fetcher"

/**
 * Head Office approving or rejecting one address.
 *
 * Approving is what makes the address selectable at checkout — there is no
 * other path from a request to a usable destination. The address itself is
 * shown read-only and deliberately cannot be edited here: an approver who could
 * rewrite it before approving would be approving something the branch never
 * asked for.
 */
export function DeliveryAddressDecisionDialog({
  address,
  onClose,
  onDecided,
}: Readonly<{
  address: DeliveryAddressListItem | null
  onClose: () => void
  onDecided: () => void
}>) {
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    setReason("")
    setFailure(null)
    setBusy(null)
  }, [address])

  const decide = async (decision: "approve" | "reject") => {
    if (!address) return
    setFailure(null)
    setBusy(decision)
    try {
      const body: Record<string, unknown> = { decision }
      if (reason.trim()) body.reason = reason.trim()

      await jsonFetcher(`/api/v1/delivery-addresses/${address.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
      onDecided()
      onClose()
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "The decision could not be recorded. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  if (!address) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open && busy === null) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{address.label}</DialogTitle>
          <DialogDescription>
            Approving this lets {address.branchName ?? "the branch"} send orders here. Rejecting it
            changes nothing.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
          <dt className="font-medium text-slate-500">Branch</dt>
          <dd className="text-slate-900 dark:text-slate-100">
            {address.branchName ?? `Branch ${address.branchId}`}
          </dd>
          <dt className="font-medium text-slate-500">Address</dt>
          <dd className="text-slate-900 dark:text-slate-100">
            {formatDeliveryAddress(address) || address.address}
          </dd>
          {address.contactPerson && (
            <>
              <dt className="font-medium text-slate-500">Contact</dt>
              <dd className="text-slate-900 dark:text-slate-100">{address.contactPerson}</dd>
            </>
          )}
          {address.contactPhone && (
            <>
              <dt className="font-medium text-slate-500">Phone</dt>
              <dd className="text-slate-900 dark:text-slate-100">{address.contactPhone}</dd>
            </>
          )}
          {address.requestedByName && (
            <>
              <dt className="font-medium text-slate-500">Requested by</dt>
              <dd className="text-slate-900 dark:text-slate-100">{address.requestedByName}</dd>
            </>
          )}
          {address.requestReason && (
            <>
              <dt className="font-medium text-slate-500">Reason</dt>
              <dd className="text-slate-900 dark:text-slate-100">{address.requestReason}</dd>
            </>
          )}
        </dl>

        <div className="space-y-2">
          <Label htmlFor="delivery-address-decision-reason">Note (optional)</Label>
          <Textarea
            id="delivery-address-decision-reason"
            value={reason}
            maxLength={MAX_DELIVERY_ADDRESS_REASON}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Recorded against the decision and shown to the branch."
            rows={3}
          />
        </div>

        {failure && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {failure}
          </p>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy !== null}
            onClick={() => decide("reject")}
          >
            {busy === "reject" && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Reject
          </Button>
          <Button type="button" disabled={busy !== null} onClick={() => decide("approve")}>
            {busy === "approve" && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Approve
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
