"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { ClipboardCheck, Loader2, MapPinned, Plus, Radio, RefreshCw, UserRound } from "lucide-react"

import { CreateRiderDialog } from "@/components/warehouse/create-rider-dialog"
import { WarehousePodReview } from "@/components/warehouse/warehouse-pod-review"
import { WarehouseRiderRoute } from "@/components/warehouse/warehouse-rider-route"
import { WarehouseRiderTrack } from "@/components/warehouse/warehouse-rider-track"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { fetcher } from "@/lib/fetcher"

type RiderRow = {
  userId: string
  email: string
  fullName: string
  isActive: boolean
  code: string
  phone: string | null
  vehicleNumber: string | null
  isOnDuty: boolean
  avatarUrl: string | null
  cityKey: string | null
  cityLabel: string | null
  createdAt: string
}

type RidersResponse = { items: RiderRow[] }

type AssignmentListItem = {
  assignment: {
    id: number
    riderUserId: string
    status: string
  }
}

type AssignmentsResponse = { items: AssignmentListItem[] }

const OPEN_STATUSES = new Set([
  "ASSIGNED",
  "OUT_FOR_DELIVERY",
  "POD_SUBMITTED",
  "POD_REJECTED",
  "POD_APPROVED",
  "FULFILLMENT_PENDING",
])

/**
 * Warehouse riders list + Create Rider + entry to the per-rider route planner.
 * Only this warehouse's riders appear (server-scoped).
 */
export function WarehouseRiders() {
  const { data, error, isLoading, isValidating, mutate } = useSWR<RidersResponse>(
    "/api/v1/rider-ops/riders",
    fetcher,
    { refreshInterval: 60_000 },
  )
  const { data: assignments } = useSWR<AssignmentsResponse>(
    "/api/v1/rider-ops/assignments?day=today",
    fetcher,
    { refreshInterval: 60_000 },
  )

  const openCountByRider = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of assignments?.items ?? []) {
      if (!OPEN_STATUSES.has(row.assignment.status)) continue
      map.set(row.assignment.riderUserId, (map.get(row.assignment.riderUserId) ?? 0) + 1)
    }
    return map
  }, [assignments])

  const [routeRider, setRouteRider] = useState<{ userId: string; label: string } | null>(null)
  const [trackRider, setTrackRider] = useState<{ userId: string; label: string } | null>(null)
  const [podReviewOpen, setPodReviewOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const podPendingCount = useMemo(() => {
    let count = 0
    for (const row of assignments?.items ?? []) {
      if (row.assignment.status === "POD_SUBMITTED") count += 1
    }
    return count
  }, [assignments])

  if (podReviewOpen) {
    return <WarehousePodReview onBack={() => setPodReviewOpen(false)} />
  }

  if (trackRider) {
    return (
      <WarehouseRiderTrack
        riderUserId={trackRider.userId}
        riderLabel={trackRider.label}
        onBack={() => setTrackRider(null)}
      />
    )
  }

  if (routeRider) {
    return (
      <WarehouseRiderRoute
        riderUserId={routeRider.userId}
        riderLabel={routeRider.label}
        onBack={() => setRouteRider(null)}
      />
    )
  }

  const items = data?.items ?? []

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Riders</h2>
          <p className="text-sm text-muted-foreground">
            Create riders with a city so they start from your warehouse pin. Assign from Orders,
            then plan the stop sequence here.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => { void mutate() }} disabled={isValidating}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isValidating ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => setPodReviewOpen(true)}>
            <ClipboardCheck className="mr-2 h-4 w-4" />
            POD review
            {podPendingCount > 0 && (
              <Badge className="ml-2 h-5 min-w-5 justify-center px-1.5" variant="destructive">
                {podPendingCount}
              </Badge>
            )}
          </Button>
          <Button type="button" size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Create rider
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="p-0">
          {error && (
            <p role="alert" className="p-6 text-sm text-destructive">Riders could not be loaded.</p>
          )}
          {isLoading && !data && (
            <p className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading…
            </p>
          )}
          {data && items.length === 0 && (
            <p className="p-6 text-center text-sm text-muted-foreground">
              No riders yet. Use Create rider and pick the city your warehouse serves (e.g. Karachi).
            </p>
          )}
          {items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[780px] text-sm">
                <thead className="bg-muted/50 text-left text-xs uppercase text-muted-foreground">
                  <tr>
                    <th className="px-3 py-2">Code</th>
                    <th className="px-3 py-2">Name</th>
                    <th className="px-3 py-2">City</th>
                    <th className="px-3 py-2">Phone</th>
                    <th className="px-3 py-2">Vehicle</th>
                    <th className="px-3 py-2">Duty</th>
                    <th className="px-3 py-2 text-right">Today</th>
                    <th className="px-3 py-2 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((rider) => {
                    const open = openCountByRider.get(rider.userId) ?? 0
                    const label = `${rider.code} · ${rider.fullName}`
                    return (
                      <tr key={rider.userId} className="border-t">
                        <td className="px-3 py-2 font-mono text-xs">{rider.code}</td>
                        <td className="px-3 py-2">
                          <div className="flex items-center gap-2">
                            <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden />
                            <span className="font-medium">{rider.fullName}</span>
                          </div>
                          {!rider.isActive && (
                            <Badge variant="outline" className="mt-1 text-[10px]">Inactive</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2">{rider.cityLabel || "—"}</td>
                        <td className="px-3 py-2">{rider.phone || "—"}</td>
                        <td className="px-3 py-2">{rider.vehicleNumber || "—"}</td>
                        <td className="px-3 py-2">
                          <Badge variant={rider.isOnDuty ? "default" : "secondary"}>
                            {rider.isOnDuty ? "On duty" : "Off duty"}
                          </Badge>
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums">{open}</td>
                        <td className="px-3 py-2">
                          <div className="flex flex-wrap justify-end gap-1.5">
                            <Button
                              type="button"
                              size="sm"
                              variant="outline"
                              disabled={!rider.isActive}
                              onClick={() => setRouteRider({ userId: rider.userId, label })}
                            >
                              <MapPinned className="mr-1 h-4 w-4" />
                              Plan
                            </Button>
                            <Button
                              type="button"
                              size="sm"
                              variant="secondary"
                              disabled={!rider.isActive}
                              onClick={() => setTrackRider({ userId: rider.userId, label })}
                            >
                              <Radio className="mr-1 h-4 w-4" />
                              Track
                            </Button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <CreateRiderDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={() => { void mutate() }}
      />
    </div>
  )
}
