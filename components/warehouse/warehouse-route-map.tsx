"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import L from "leaflet"
import "leaflet/dist/leaflet.css"

import { fetchDrivingGeometryViaProxy, type LatLng } from "@/lib/rider/osrm-route"

export type RouteMapStop = {
  id: number
  sequence: number
  label: string
  latitude: number
  longitude: number
  address?: string | null
  delivered?: boolean
  overdue?: boolean
}

type Props = {
  stops: RouteMapStop[]
  depot?: { name: string; latitude: number; longitude: number } | null
  /** Live GPS from the rider app (Track screen). */
  liveRider?: { latitude: number; longitude: number; label?: string } | null
  className?: string
  selectedStopId?: number | null
  onSelectStop?: (stopId: number) => void
  onMoveStop?: (stopId: number, latitude: number, longitude: number) => void
  focusLatLng?: { latitude: number; longitude: number } | null
  /** When true, pins are not draggable (Track view). */
  readOnly?: boolean
}

function numberedIcon(
  sequence: number,
  selected: boolean,
  opts?: { delivered?: boolean; overdue?: boolean },
) {
  const bg = opts?.delivered
    ? "#16a34a"
    : opts?.overdue
      ? "#ea580c"
      : selected
        ? "#dc2626"
        : "#2563eb"
  const glyph = opts?.delivered ? "✓" : String(sequence)
  return L.divIcon({
    className: "warehouse-route-marker",
    html: `<div style="
      width:28px;height:28px;border-radius:9999px;
      background:${bg};color:#fff;font:700 12px/28px system-ui,sans-serif;
      text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);
      cursor:grab;
    ">${glyph}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  })
}

const depotIcon = L.divIcon({
  className: "warehouse-route-depot",
  html: `<div style="
    width:28px;height:28px;border-radius:6px;
    background:#65a30d;color:#fff;font:700 11px/28px system-ui,sans-serif;
    text-align:center;border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.35);
  ">W</div>`,
  iconSize: [28, 28],
  iconAnchor: [14, 14],
})

const liveRiderIcon = L.divIcon({
  className: "warehouse-route-live",
  html: `<div style="
    width:32px;height:32px;border-radius:9999px;
    background:#7c3aed;color:#fff;font:700 10px/32px system-ui,sans-serif;
    text-align:center;border:3px solid #fff;box-shadow:0 0 0 4px rgba(124,58,237,.35);
  ">GPS</div>`,
  iconSize: [32, 32],
  iconAnchor: [16, 16],
})

/**
 * Road waypoints for OSRM:
 * - With live GPS (Track): rider → remaining undelivered stops (travelled path dropped).
 * - Otherwise (Plan): warehouse → remaining stops.
 * Never a return leg to the warehouse.
 */
function routeWaypoints(
  stops: RouteMapStop[],
  depot: Props["depot"],
  liveRider: Props["liveRider"],
): LatLng[] {
  const remaining = [...stops]
    .filter((stop) => !stop.delivered)
    .sort((a, b) => a.sequence - b.sequence)
    .map((stop) => ({ latitude: stop.latitude, longitude: stop.longitude }))
  if (liveRider) {
    return remaining.length > 0
      ? [{ latitude: liveRider.latitude, longitude: liveRider.longitude }, ...remaining]
      : []
  }
  if (!depot) return remaining
  return [{ latitude: depot.latitude, longitude: depot.longitude }, ...remaining]
}

/**
 * Imperative Leaflet map with road geometry via our OSRM proxy.
 * Select a stop, then search / click / drag to set its pin.
 */
export function WarehouseRouteMap({
  stops,
  depot,
  liveRider = null,
  className,
  selectedStopId = null,
  onSelectStop,
  onMoveStop,
  focusLatLng = null,
  readOnly = false,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<L.Map | null>(null)
  const markerLayerRef = useRef<L.LayerGroup | null>(null)
  const routeLayerRef = useRef<L.LayerGroup | null>(null)
  const selectedRef = useRef(selectedStopId)
  const onMoveRef = useRef(onMoveStop)
  const onSelectRef = useRef(onSelectStop)
  const [mapReady, setMapReady] = useState(false)
  const [roadHint, setRoadHint] = useState<"road" | "straight" | "loading" | null>(null)
  const fitOnceRef = useRef(true)
  /** Round live GPS so tiny jitter does not spam OSRM; ~11 m at the equator. */
  const liveKey = liveRider
    ? `${liveRider.latitude.toFixed(4)},${liveRider.longitude.toFixed(4)}`
    : ""

  selectedRef.current = selectedStopId
  onMoveRef.current = onMoveStop
  onSelectRef.current = onSelectStop

  const waypointKey = useMemo(() => {
    const points = routeWaypoints(stops, depot, liveRider)
    return points.map((point) => `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`).join("|")
    // liveKey buckets GPS so the road line refreshes as the rider moves
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stops, depot, liveKey])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const el = document.createElement("div")
    el.style.height = "100%"
    el.style.width = "100%"
    host.replaceChildren(el)

    const map = L.map(el, { scrollWheelZoom: true }).setView([24.8607, 67.0011], 12)
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
    }).addTo(map)

    const routeLayer = L.layerGroup().addTo(map)
    const markerLayer = L.layerGroup().addTo(map)
    mapRef.current = map
    routeLayerRef.current = routeLayer
    markerLayerRef.current = markerLayer
    setMapReady(true)

    const onClick = (event: L.LeafletMouseEvent) => {
      const id = selectedRef.current
      if (id == null || !onMoveRef.current) return
      onMoveRef.current(id, event.latlng.lat, event.latlng.lng)
    }
    map.on("click", onClick)

    requestAnimationFrame(() => map.invalidateSize())

    return () => {
      map.off("click", onClick)
      setMapReady(false)
      map.remove()
      mapRef.current = null
      routeLayerRef.current = null
      markerLayerRef.current = null
      host.replaceChildren()
    }
  }, [])

  useEffect(() => {
    if (!mapReady || !focusLatLng || !mapRef.current) return
    mapRef.current.flyTo([focusLatLng.latitude, focusLatLng.longitude], 15, { duration: 0.6 })
  }, [mapReady, focusLatLng])

  // Markers only
  useEffect(() => {
    if (!mapReady) return
    const map = mapRef.current
    const markers = markerLayerRef.current
    if (!map || !markers) return

    markers.clearLayers()
    const ordered = [...stops].sort((a, b) => a.sequence - b.sequence)
    const pinPoints: L.LatLngExpression[] = []

    if (depot) {
      pinPoints.push([depot.latitude, depot.longitude])
      L.marker([depot.latitude, depot.longitude], { icon: depotIcon })
        .bindPopup(`${depot.name}<br/><span style="opacity:.7">Route start</span>`)
        .addTo(markers)
    }

    if (liveRider) {
      pinPoints.push([liveRider.latitude, liveRider.longitude])
      L.marker([liveRider.latitude, liveRider.longitude], { icon: liveRiderIcon })
        .bindPopup(liveRider.label ?? "Rider live location")
        .addTo(markers)
    }

    for (const stop of ordered) {
      pinPoints.push([stop.latitude, stop.longitude])
      const selected = stop.id === selectedStopId
      const flags = [
        stop.delivered ? "Delivered" : null,
        stop.overdue ? "Overdue (not delivered same day)" : null,
      ]
        .filter(Boolean)
        .join(" · ")
      const popup = `<div style="font:500 13px/1.3 system-ui,sans-serif">
        <div><strong>#${stop.sequence} ${stop.label}</strong></div>
        ${flags ? `<div style="color:${stop.delivered ? "#16a34a" : "#ea580c"};font-size:11px">${flags}</div>` : ""}
        ${stop.address ? `<div style="opacity:.7">${stop.address}</div>` : ""}
      </div>`
      const marker = L.marker([stop.latitude, stop.longitude], {
        icon: numberedIcon(stop.sequence, selected, {
          delivered: stop.delivered,
          overdue: stop.overdue,
        }),
        draggable: !readOnly && !stop.delivered,
        autoPan: true,
      })
        .bindPopup(popup)
        .addTo(markers)

      marker.on("click", (event) => {
        L.DomEvent.stopPropagation(event)
        onSelectRef.current?.(stop.id)
      })
      marker.on("dragend", () => {
        const pos = marker.getLatLng()
        onSelectRef.current?.(stop.id)
        onMoveRef.current?.(stop.id, pos.lat, pos.lng)
      })
    }

    if (fitOnceRef.current && pinPoints.length > 0) {
      fitOnceRef.current = false
      if (pinPoints.length === 1) map.setView(pinPoints[0], 14)
      else map.fitBounds(L.latLngBounds(pinPoints), { padding: [48, 48] })
    }

    requestAnimationFrame(() => map.invalidateSize())
  }, [mapReady, stops, depot, liveRider, selectedStopId, readOnly])

  // Road geometry via server proxy (not aborted by pin selection changes)
  useEffect(() => {
    if (!mapReady) return
    const routeLayer = routeLayerRef.current
    if (!routeLayer) return

    const waypoints = routeWaypoints(stops, depot, liveRider)
    const abort = new AbortController()
    let cancelled = false
    const trackingLive = Boolean(liveRider)

    const draw = async () => {
      setRoadHint("loading")
      routeLayer.clearLayers()

      if (waypoints.length < 2) {
        setRoadHint(null)
        return
      }

      const road = await fetchDrivingGeometryViaProxy(waypoints, abort.signal)
      if (cancelled) return

      const map = mapRef.current

      if (road?.length) {
        const latlngs = road.map((point) => [point.latitude, point.longitude] as L.LatLngExpression)
        // Underlay + bold stroke so the multi-stop path reads clearly on OSM tiles.
        L.polyline(latlngs, { color: "#1e3a8a", weight: 9, opacity: 0.25, lineCap: "round", lineJoin: "round" }).addTo(
          routeLayer,
        )
        L.polyline(latlngs, { color: "#2563eb", weight: 5, opacity: 0.95, lineCap: "round", lineJoin: "round" }).addTo(
          routeLayer,
        )
        for (let i = 0; i < waypoints.length - 1; i++) {
          const a = waypoints[i]
          const b = waypoints[i + 1]
          const mid: L.LatLngExpression = [(a.latitude + b.latitude) / 2, (a.longitude + b.longitude) / 2]
          L.circleMarker(mid, {
            radius: 4,
            color: "#fff",
            weight: 2,
            fillColor: "#1d4ed8",
            fillOpacity: 1,
          }).addTo(routeLayer)
        }
        if (map && !trackingLive) {
          map.fitBounds(L.latLngBounds(latlngs), { padding: [56, 56], maxZoom: 13 })
        } else if (map && trackingLive && liveRider) {
          // Keep the rider in view without resetting zoom on every GPS tick.
          map.panTo([liveRider.latitude, liveRider.longitude], { animate: true })
        }
        setRoadHint("road")
        return
      }

      // Fallback straight segments — open route, no return to warehouse.
      const straight = waypoints.map((point) => [point.latitude, point.longitude] as L.LatLngExpression)
      L.polyline(straight, {
        color: "#ea580c",
        weight: 4,
        opacity: 0.85,
        dashArray: "8 10",
        lineCap: "round",
      }).addTo(routeLayer)
      if (map && !trackingLive) {
        map.fitBounds(L.latLngBounds(straight), { padding: [56, 56], maxZoom: 13 })
      } else if (map && trackingLive && liveRider) {
        map.panTo([liveRider.latitude, liveRider.longitude], { animate: true })
      }
      setRoadHint("straight")
    }

    void draw()
    return () => {
      cancelled = true
      abort.abort()
    }
    // waypointKey includes live GPS buckets while tracking
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, waypointKey])

  return (
    <div className="relative h-full w-full min-h-[420px]">
      <div
        ref={hostRef}
        className={className ?? "h-full min-h-[420px] w-full overflow-hidden rounded-lg border"}
      />
      {selectedStopId != null && (
        <p className="pointer-events-none absolute top-2 left-2 right-2 rounded bg-black/70 px-2 py-1 text-center text-[11px] text-white">
          Search a place, click the map, or drag the red pin
        </p>
      )}
      {roadHint === "loading" && (
        <p className="pointer-events-none absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-[11px] text-white">
          Loading road route…
        </p>
      )}
      {roadHint === "straight" && (
        <p className="pointer-events-none absolute bottom-2 left-2 rounded bg-amber-700/90 px-2 py-1 text-[11px] text-white">
          Road route unavailable — dashed straight line
        </p>
      )}
    </div>
  )
}
