"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { Loader2 } from "lucide-react"

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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"

type RiderRow = {
  userId: string
  code: string
  fullName: string
  isOnDuty: boolean
  isActive: boolean
}

type RidersResponse = { items: RiderRow[] }

type Props = {
  open: boolean
  orderId: number
  orderTid: string
  /** Optional text stored until the pin is set on Plan route. */
  destination?: string
  onClose: () => void
  onAssigned: () => void
}

/**
 * Assign one OUT_FOR_DELIVERY order to a rider. Only the rider is chosen here;
 * drop pins are set later on Plan route.
 */
export function AssignRiderDialog({
  open,
  orderId,
  orderTid,
  destination = "",
  onClose,
  onAssigned,
}: Props) {
  const { data, isLoading } = useSWR<RidersResponse>(
    open ? "/api/v1/rider-ops/riders" : null,
    fetcher,
  )
  const riders = useMemo(
    () => (data?.items ?? []).filter((rider) => rider.isActive),
    [data],
  )

  const [riderId, setRiderId] = useState("")
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setRiderId("")
  }, [open, orderId])

  const submit = async () => {
    if (!riderId) {
      toast({ title: "Pick a rider", variant: "destructive" })
      return
    }
    setSubmitting(true)
    try {
      const address = destination.trim()
      const response = await fetch("/api/v1/rider-ops/assignments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          riderId,
          orders: [
            {
              orderId: Number(orderId),
              ...(address ? { deliveryAddressText: address } : {}),
            },
          ],
        }),
      })
      const body = (await response.json().catch(() => ({}))) as { error?: string }
      if (!response.ok) {
        toast({
          title: "Could not assign",
          description: body.error ?? `HTTP ${response.status}`,
          variant: "destructive",
        })
        return
      }
      toast({
        title: "Assigned",
        description: `${orderTid} → rider. Set the drop pin on Plan route.`,
      })
      onAssigned()
      onClose()
    } catch {
      toast({ title: "Could not assign", variant: "destructive" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Assign rider</DialogTitle>
          <DialogDescription>
            Order <span className="font-mono">{orderTid}</span>. Pick who delivers it —
            set the map pin later under Riders → Plan route.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 py-1">
          <div className="space-y-1">
            <Label htmlFor="assign-rider">Rider</Label>
            {isLoading ? (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading riders…
              </p>
            ) : riders.length === 0 ? (
              <p className="text-sm text-muted-foreground">No active riders yet.</p>
            ) : (
              <Select value={riderId} onValueChange={setRiderId}>
                <SelectTrigger id="assign-rider"><SelectValue placeholder="Select rider" /></SelectTrigger>
                <SelectContent>
                  {riders.map((rider) => (
                    <SelectItem key={rider.userId} value={rider.userId}>
                      {rider.code} — {rider.fullName}
                      {rider.isOnDuty ? " (on duty)" : ""}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => { void submit() }} disabled={submitting || !riderId}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Assign
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
