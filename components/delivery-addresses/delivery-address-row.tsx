"use client"

import { Clock, MapPin, Phone, User } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatDeliveryAddress, type DeliveryAddressStatus } from "@/lib/delivery-address"

/**
 * One delivery address, as the queue and the branch's own list both show it.
 *
 * The shape is exactly what `GET /api/v1/delivery-addresses` returns. `label`
 * is what a person picks the address by at checkout, so it leads; the address
 * line beneath it is formatted by the same helper the invoice uses, so the two
 * cannot read differently.
 */
export type DeliveryAddressListItem = {
  id: number
  branchId: number
  branchName: string | null
  label: string
  address: string
  city: string | null
  province: string | null
  contactPerson: string | null
  contactPhone: string | null
  status: DeliveryAddressStatus
  requestReason: string | null
  requestedByName: string | null
  decisionReason: string | null
  decidedAt: string | null
  createdAt: string
}

const STATUS_STYLES: Record<DeliveryAddressStatus, string> = {
  pending: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  approved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  rejected: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

const STATUS_LABELS: Record<DeliveryAddressStatus, string> = {
  pending: "Awaiting Head Office",
  approved: "Approved",
  rejected: "Rejected",
}

function formatWhen(value: string | null): string {
  if (!value) return "—"
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? "—" : parsed.toLocaleString()
}

export function DeliveryAddressListRow({
  address,
  canDecide,
  onReview,
}: Readonly<{
  address: DeliveryAddressListItem
  canDecide: boolean
  onReview: (address: DeliveryAddressListItem) => void
}>) {
  const line = formatDeliveryAddress(address)

  return (
    <li className="flex flex-col gap-3 border-b border-slate-100 p-4 last:border-b-0 sm:flex-row sm:items-start sm:justify-between dark:border-slate-800">
      <div className="min-w-0 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-semibold text-slate-900 dark:text-slate-100">{address.label}</p>
          <Badge className={STATUS_STYLES[address.status]} variant="secondary">
            {STATUS_LABELS[address.status]}
          </Badge>
        </div>
        <p className="text-sm text-slate-600 dark:text-slate-400">{line || address.address}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
          <span className="inline-flex items-center gap-1">
            <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
            {address.branchName ?? `Branch ${address.branchId}`}
          </span>
          {address.contactPerson && (
            <span className="inline-flex items-center gap-1">
              <User className="h-3.5 w-3.5" aria-hidden="true" />
              {address.contactPerson}
            </span>
          )}
          {address.contactPhone && (
            <span className="inline-flex items-center gap-1">
              <Phone className="h-3.5 w-3.5" aria-hidden="true" />
              {address.contactPhone}
            </span>
          )}
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3.5 w-3.5" aria-hidden="true" />
            {formatWhen(address.createdAt)}
          </span>
        </div>
        {address.requestedByName && (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Requested by {address.requestedByName}
          </p>
        )}
        {address.requestReason && (
          <p className="text-xs italic text-slate-500 dark:text-slate-400">
            Reason: {address.requestReason}
          </p>
        )}
        {address.status !== "pending" && address.decisionReason && (
          <p className="text-xs italic text-slate-500 dark:text-slate-400">
            Note: {address.decisionReason}
          </p>
        )}
      </div>

      {canDecide && address.status === "pending" ? (
        <Button type="button" size="sm" onClick={() => onReview(address)} className="sm:shrink-0">
          Review
        </Button>
      ) : (
        <p className="text-xs text-slate-400 sm:shrink-0">
          {address.status === "pending" ? "Waiting" : formatWhen(address.decidedAt)}
        </p>
      )}
    </li>
  )
}
