"use client"

import dynamic from "next/dynamic"
import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { ArrowDown, ArrowLeft, ArrowUp, Loader2, MapPin, Save, Search } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"

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

type AssignmentListItem = {
  assignment: {
    id: number
    orderId: number
    riderUserId: string
    deliverySequence: number
    deliveryLat: number
    deliveryLng: number
    deliveryAddressText: string | null
    status: string
  }
  orderTid: string
  orderStatus: string
  fulfillmentStatus: string
  riderCode: string
  /** Tenant / customer company name. */
  customerName: string
  branchName: string
  placerName: string | null
  overdue?: boolean
  delivered?: boolean
}

type LocalStop = AssignmentListItem & {
  draftLat: number
  draftLng: number
  draftAddress: string | null
}

/** Prefer the placer's name; fall back to customer org · branch (never the TID). */
function stopDisplayName(row: AssignmentListItem): string {
  const placer = row.placerName?.trim()
  if (placer) return placer
  const org = row.customerName?.trim()
  const branch = row.branchName?.trim()
  if (org && branch) return `${org} · ${branch}`
  return org || branch || row.orderTid
}

function stopSubtitle(row: LocalStop): string {
  const parts: string[] = []
  if (row.placerName?.trim() && row.customerName) {
    parts.push(row.branchName ? `${row.customerName} · ${row.branchName}` : row.customerName)
  } else if (row.branchName && row.placerName?.trim()) {
    parts.push(row.branchName)
  }
  if (row.draftAddress) parts.push(row.draftAddress)
  else parts.push("Set pin on map")
  return parts.join(" · ")
}

type AssignmentsResponse = { items: AssignmentListItem[] }

type DepotResponse = {
  depot: {
    name: string
    latitude: number
    longitude: number
    address: string | null
  } | null
}

type GeocodeHit = { label: string; latitude: number; longitude: number }

type Props = {
  riderUserId: string
  riderLabel: string
  onBack: () => void
}

/** Today's open legs + overdue; keep delivered-today for map checkmarks. */
const ROUTE_STATUSES = new Set([
  "ASSIGNED",
  "OUT_FOR_DELIVERY",
  "POD_SUBMITTED",
  "POD_REJECTED",
  "POD_APPROVED",
  "FULFILLMENT_PENDING",
  "FULFILLMENT_COMPLETED",
])

/**
 * Plan today's stop order: compact stop list + large map.
 * Search places, click/drag pins, reorder, save.
 */
export function WarehouseRiderRoute({ riderUserId, riderLabel, onBack }: Props) {
  const assignmentsKey = `/api/v1/rider-ops/assignments?riderId=${encodeURIComponent(riderUserId)}&day=today`
  const { data, isLoading, mutate } = useSWR<AssignmentsResponse>(assignmentsKey, fetcher)
  const depotKey = `/api/v1/rider-ops/depot?riderId=${encodeURIComponent(riderUserId)}`
  const { data: depotData } = useSWR<DepotResponse>(depotKey, fetcher)

  const serverOpen = useMemo(() => {
    return (data?.items ?? [])
      .filter((row) => ROUTE_STATUSES.has(row.assignment.status))
      .sort((a, b) => a.assignment.deliverySequence - b.assignment.deliverySequence)
  }, [data])

  const [stops, setStops] = useState<LocalStop[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [baselineKey, setBaselineKey] = useState("")
  const [searchQuery, setSearchQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const [searchHits, setSearchHits] = useState<GeocodeHit[]>([])
  const [focusLatLng, setFocusLatLng] = useState<{ latitude: number; longitude: number } | null>(null)

  useEffect(() => {
    const key = serverOpen
      .map((row) => `${row.assignment.id}:${row.assignment.deliverySequence}:${row.assignment.deliveryLat}:${row.assignment.deliveryLng}`)
      .join("|")
    if (key === baselineKey) return
    setBaselineKey(key)
    setStops(
      serverOpen.map((row) => ({
        ...row,
        draftLat: row.assignment.deliveryLat,
        draftLng: row.assignment.deliveryLng,
        draftAddress: row.assignment.deliveryAddressText,
      })),
    )
    setSelectedId((current) =>
      current != null && serverOpen.some((row) => row.assignment.id === current)
        ? current
        : serverOpen[0]?.assignment.id ?? null,
    )
  }, [serverOpen, baselineKey])

  const sequenceDirty =
    stops.length !== serverOpen.length ||
    stops.some((row, index) => row.assignment.id !== serverOpen[index]?.assignment.id)

  const pinsDirty = stops.some(
    (row) =>
      row.draftLat !== row.assignment.deliveryLat ||
      row.draftLng !== row.assignment.deliveryLng ||
      row.draftAddress !== row.assignment.deliveryAddressText,
  )
  const dirty = sequenceDirty || pinsDirty

  const selectedStop = stops.find((row) => row.assignment.id === selectedId) ?? null

  const move = (index: number, direction: -1 | 1) => {
    const nextIndex = index + direction
    if (nextIndex < 0 || nextIndex >= stops.length) return
    const next = [...stops]
    const [item] = next.splice(index, 1)
    next.splice(nextIndex, 0, item)
    setStops(next)
  }

  const movePin = (stopId: number, latitude: number, longitude: number, address?: string | null) => {
    setStops((current) =>
      current.map((row) =>
        row.assignment.id === stopId
          ? {
              ...row,
              draftLat: latitude,
              draftLng: longitude,
              ...(address !== undefined ? { draftAddress: address } : {}),
            }
          : row,
      ),
    )
    setSelectedId(stopId)
  }

  const runSearch = async () => {
    const q = searchQuery.trim()
    if (q.length < 2) {
      toast({ title: "Type a place name", variant: "destructive" })
      return
    }
    if (!selectedId) {
      toast({ title: "Select a stop first", variant: "destructive" })
      return
    }
    setSearching(true)
    setSearchHits([])
    try {
      const response = await fetch(`/api/v1/rider-ops/geocode?q=${encodeURIComponent(q)}`)
      const body = (await response.json().catch(() => ({}))) as {
        items?: GeocodeHit[]
        error?: string
      }
      if (!response.ok) {
        toast({
          title: "Search failed",
          description: body.error ?? `HTTP ${response.status}`,
          variant: "destructive",
        })
        return
      }
      const items = body.items ?? []
      setSearchHits(items)
      if (items.length === 0) toast({ title: "No places found" })
    } catch {
      toast({ title: "Search failed", variant: "destructive" })
    } finally {
      setSearching(false)
    }
  }

  const applyHit = (hit: GeocodeHit) => {
    if (!selectedId) return
    movePin(selectedId, hit.latitude, hit.longitude, hit.label)
    setFocusLatLng({ latitude: hit.latitude, longitude: hit.longitude })
    setSearchHits([])
    setSearchQuery(hit.label.split(",")[0] ?? hit.label)
  }

  const save = async () => {
    if (!dirty) return
    setSaving(true)
    try {
      if (sequenceDirty) {
        const response = await fetch("/api/v1/rider-ops/assignments/sequence", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            riderId: riderUserId,
            orderedAssignmentIds: stops.map((row) => row.assignment.id),
          }),
        })
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok) {
          toast({
            title: "Could not save sequence",
            description: body.error ?? `HTTP ${response.status}`,
            variant: "destructive",
          })
          return
        }
      }

      const pinUpdates = stops.filter(
        (row) =>
          row.draftLat !== row.assignment.deliveryLat ||
          row.draftLng !== row.assignment.deliveryLng ||
          row.draftAddress !== row.assignment.deliveryAddressText,
      )
      for (const row of pinUpdates) {
        const response = await fetch(`/api/v1/rider-ops/assignments/${row.assignment.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            deliveryLat: row.draftLat,
            deliveryLng: row.draftLng,
            deliveryAddressText: row.draftAddress,
          }),
        })
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        if (!response.ok) {
          toast({
            title: `Could not save pin for ${stopDisplayName(row)}`,
            description: body.error ?? `HTTP ${response.status}`,
            variant: "destructive",
          })
          return
        }
      }

      toast({ title: "Route saved", description: "Sequence and pins updated for the rider app." })
      setBaselineKey("")
      await mutate()
    } catch {
      toast({ title: "Could not save route", variant: "destructive" })
    } finally {
      setSaving(false)
    }
  }

  const mapStops = stops.map((row, index) => ({
    id: row.assignment.id,
    sequence: index + 1,
    label: stopDisplayName(row),
    latitude: row.draftLat,
    longitude: row.draftLng,
    address: row.draftAddress,
    delivered: Boolean(row.delivered),
    overdue: Boolean(row.overdue),
  }))

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ArrowLeft className="mr-1 h-4 w-4" /> Riders
        </Button>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-white">Plan route — {riderLabel}</h2>
          <p className="text-sm text-muted-foreground">
            Select a stop → search or click map → reorder → save.
          </p>
        </div>
        <Button type="button" className="ml-auto" onClick={() => { void save() }} disabled={!dirty || saving}>
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save route
        </Button>
      </div>

      {isLoading && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading assignments…
        </p>
      )}

      {!isLoading && stops.length === 0 && (
        <Card>
          <CardContent className="p-6 text-sm text-muted-foreground">
            No open assignments for this rider. Assign Out-for-delivery orders from the Orders queue first.
          </CardContent>
        </Card>
      )}

      {stops.length > 0 && (
        <div className="grid gap-3 lg:grid-cols-[minmax(240px,280px)_minmax(0,1fr)] lg:items-stretch">
          <Card className="flex max-h-[min(78vh,720px)] flex-col">
            <CardHeader className="space-y-2 py-3 pb-2">
              <CardTitle className="text-sm">Stops ({stops.length})</CardTitle>
              <div className="space-y-1.5">
                <p className="text-[11px] text-muted-foreground">
                  {selectedStop
                    ? `Pin for ${stopDisplayName(selectedStop)}`
                    : "Select a stop to search / place pin"}
                </p>
                <div className="flex gap-1.5">
                  <Input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault()
                        void runSearch()
                      }
                    }}
                    placeholder="Search area, street…"
                    className="h-8 text-sm"
                    disabled={!selectedId || searching}
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="h-8 shrink-0 px-2"
                    disabled={!selectedId || searching}
                    onClick={() => { void runSearch() }}
                  >
                    {searching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  </Button>
                </div>
                {searchHits.length > 0 && (
                  <ul className="max-h-36 overflow-y-auto rounded-md border bg-white text-xs dark:bg-slate-950">
                    {searchHits.map((hit) => (
                      <li key={`${hit.latitude},${hit.longitude},${hit.label}`}>
                        <button
                          type="button"
                          className="flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-muted"
                          onClick={() => applyHit(hit)}
                        >
                          <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-blue-600" />
                          <span className="line-clamp-2">{hit.label}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex-1 space-y-1.5 overflow-y-auto px-3 pb-3 pt-0">
              {stops.map((row, index) => {
                const selected = row.assignment.id === selectedId
                const pinMoved =
                  row.draftLat !== row.assignment.deliveryLat ||
                  row.draftLng !== row.assignment.deliveryLng
                return (
                  <div
                    key={row.assignment.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(row.assignment.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault()
                        setSelectedId(row.assignment.id)
                      }
                    }}
                    className={cn(
                      "flex cursor-pointer items-center gap-1.5 rounded-md border bg-white px-2 py-1.5 dark:bg-slate-950",
                      selected && "border-blue-600 ring-2 ring-blue-600/30",
                    )}
                  >
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-blue-600 text-[11px] font-bold text-white">
                      {index + 1}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{stopDisplayName(row)}</div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        {stopSubtitle(row)}
                      </div>
                      <div className="mt-0.5 flex flex-wrap gap-1">
                        {row.delivered && (
                          <Badge className="h-4 bg-green-600 px-1 text-[9px] hover:bg-green-600">Delivered</Badge>
                        )}
                        {row.overdue && (
                          <Badge variant="destructive" className="h-4 px-1 text-[9px]">Overdue</Badge>
                        )}
                        {pinMoved && (
                          <Badge variant="outline" className="h-4 px-1 text-[9px]">Moved</Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex flex-col gap-0.5" onClick={(event) => event.stopPropagation()}>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        disabled={index === 0}
                        onClick={() => move(index, -1)}
                        aria-label="Move up"
                      >
                        <ArrowUp className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-6 w-6"
                        disabled={index === stops.length - 1}
                        onClick={() => move(index, 1)}
                        aria-label="Move down"
                      >
                        <ArrowDown className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                )
              })}
            </CardContent>
          </Card>

          <Card className="overflow-hidden p-0">
            <WarehouseRouteMap
              key={riderUserId}
              className="h-[min(78vh,720px)] w-full"
              stops={mapStops}
              selectedStopId={selectedId}
              onSelectStop={setSelectedId}
              onMoveStop={movePin}
              focusLatLng={focusLatLng}
              depot={
                depotData?.depot
                  ? {
                      name: depotData.depot.name,
                      latitude: depotData.depot.latitude,
                      longitude: depotData.depot.longitude,
                    }
                  : null
              }
            />
          </Card>
        </div>
      )}
    </div>
  )
}
