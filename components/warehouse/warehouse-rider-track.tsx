"use client"

import dynamic from "next/dynamic"
import useSWR from "swr"
import { ArrowLeft, Loader2, Radio } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { fetcher } from "@/lib/fetcher"

const WarehouseRouteMap = dynamic(
  () => import("@/components/warehouse/warehouse-route-map").then((mod) => mod.WarehouseRouteMap),
  {
    ssr: false,
    loading: () => (
      <div className="flex min-h-[420px] items-center justify-center rounded-lg border text-sm text-muted-foreground">
        Loading map…
      </div>
    ),
  },
)

type TrackStop = {
  assignmentId: number
  sequence: number
  orderTid: string
  customerName: string
  branchName: string
  latitude: number
  longitude: number
  address: string | null
  status: string
  delivered: boolean
  overdue: boolean
}

type TrackItem = {
  riderId: string
  code: string
  fullName: string
  isOnDuty: boolean
  location: {
    latitude: number
    longitude: number
    recordedAt: string
    updatedAt: string
  } | null
  stops: TrackStop[]
}

type LocationsResponse = { items: TrackItem[] }

type DepotResponse = {
  depot: {
    name: string
    latitude: number
    longitude: number
    address: string | null
  } | null
}

type Props = {
  riderUserId: string
  riderLabel: string
  onBack: () => void
}

/**
 * Live track for one rider: GPS from the mobile app + today's planned stops
 * (green = delivered, orange = overdue). Warehouse role only.
 */
export function WarehouseRiderTrack({ riderUserId, riderLabel, onBack }: Props) {
  const locationsKey = `/api/v1/rider-ops/riders/locations?riderId=${encodeURIComponent(riderUserId)}`
  const { data, isLoading, isValidating } = useSWR<LocationsResponse>(locationsKey, fetcher, {
    refreshInterval: 4_000,
  })
  const { data: depotData } = useSWR<DepotResponse>(
    `/api/v1/rider-ops/depot?riderId=${encodeURIComponent(riderUserId)}`,
    fetcher,
  )

  const item = data?.items?.[0] ?? null
  const stops = (item?.stops ?? []).map((stop) => ({
    id: stop.assignmentId,
    sequence: stop.sequence,
    label: stop.customerName || stop.orderTid,
    latitude: stop.latitude,
    longitude: stop.longitude,
    address: stop.address ?? `${stop.branchName}`,
    delivered: stop.delivered,
    overdue: stop.overdue,
  }))

  const live = item?.location
    ? {
        latitude: item.location.latitude,
        longitude: item.location.longitude,
        label: `${item.code} · live`,
      }
    : null

  const overdueCount = stops.filter((s) => s.overdue).length
  const deliveredCount = stops.filter((s) => s.delivered).length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Riders
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
            Track — {riderLabel}
          </h2>
          <p className="text-sm text-muted-foreground">
            Live GPS · road line recalculates from rider → next stops (travelled path drops) · green =
            delivered
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {item?.isOnDuty ? (
            <Badge className="bg-violet-600 hover:bg-violet-600">
              <Radio className="mr-1 h-3 w-3" /> On duty
            </Badge>
          ) : (
            <Badge variant="secondary">Off duty</Badge>
          )}
          {live ? (
            <Badge variant="outline">GPS live</Badge>
          ) : (
            <Badge variant="outline">No GPS (wait for ping)</Badge>
          )}
          {isValidating && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
        </div>
      </div>

      <div className="grid gap-3 lg:grid-cols-[280px_minmax(0,1fr)]">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Today&apos;s stops</CardTitle>
            <p className="text-xs text-muted-foreground">
              {deliveredCount} delivered · {overdueCount} overdue · {stops.length} total
            </p>
          </CardHeader>
          <CardContent className="max-h-[70vh] space-y-1.5 overflow-y-auto">
            {isLoading && !item && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading…
              </p>
            )}
            {!isLoading && stops.length === 0 && (
              <p className="text-sm text-muted-foreground">No stops for today.</p>
            )}
            {stops.map((stop) => (
              <div key={stop.id} className="rounded-md border px-2 py-1.5 text-sm">
                <div className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[10px] font-bold text-white">
                    {stop.delivered ? "✓" : stop.sequence}
                  </span>
                  <span className="min-w-0 truncate font-medium">{stop.label}</span>
                </div>
                <div className="mt-0.5 flex flex-wrap gap-1 pl-7">
                  {stop.delivered && (
                    <Badge className="h-4 bg-green-600 px-1 text-[9px] hover:bg-green-600">Delivered</Badge>
                  )}
                  {stop.overdue && (
                    <Badge variant="destructive" className="h-4 px-1 text-[9px]">Overdue</Badge>
                  )}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card className="overflow-hidden p-0">
          <WarehouseRouteMap
            key={riderUserId}
            className="h-[min(78vh,720px)] w-full"
            stops={stops}
            depot={
              depotData?.depot
                ? {
                    name: depotData.depot.name,
                    latitude: depotData.depot.latitude,
                    longitude: depotData.depot.longitude,
                  }
                : null
            }
            liveRider={live}
            readOnly
          />
        </Card>
      </div>
    </div>
  )
}
