export type RouteStop = {
  sequence: number
  assignmentId: number
  orderId: number
  orderTid: string
  customerName: string | null
  latitude: number
  longitude: number
  address: string | null
  status: string
  /** POD approved / fulfilment — show a delivered flag on the map. */
  delivered: boolean
  /** Assigned on a previous Karachi day and still undelivered. */
  overdue: boolean
}

export type RouteLatLng = { latitude: number; longitude: number }

export type RoutePayload = {
  depot: {
    name: string
    latitude: number
    longitude: number
    address: string | null
  } | null
  stops: RouteStop[]
  /**
   * Road polyline to draw now.
   * - `planned`: depot → remaining stops (initial / warehouse plan)
   * - `live`: rider GPS → remaining stops (travelled path dropped)
   */
  geometry: RouteLatLng[] | null
  geometryMode: "planned" | "live"
  /** Next undelivered stop the live polyline heads to (null if none left). */
  nextStop: RouteStop | null
  serviceDay: string
}

/**
 * Build a Google-Maps-ready route: depot first, then stops in delivery_sequence order.
 * Callers must pass stops already sorted by sequence ascending.
 */
export function buildRoutePayload(input: {
  depot: {
    name: string
    latitude: number
    longitude: number
    address: string | null
  } | null
  stops: RouteStop[]
  geometry?: RouteLatLng[] | null
  geometryMode?: "planned" | "live"
  nextStop?: RouteStop | null
  serviceDay: string
}): RoutePayload {
  const stops = [...input.stops].sort((a, b) => a.sequence - b.sequence)
  const nextStop =
    input.nextStop !== undefined
      ? input.nextStop
      : stops.find((stop) => !stop.delivered) ?? null
  return {
    depot: input.depot,
    stops,
    geometry: input.geometry ?? null,
    geometryMode: input.geometryMode ?? "planned",
    nextStop,
    serviceDay: input.serviceDay,
  }
}

/** Waypoints for OSRM: warehouse start then each stop — never a return leg. */
export function plannedRouteWaypoints(
  depot: RoutePayload["depot"],
  stops: Array<{ latitude: number; longitude: number }>,
): RouteLatLng[] {
  const ordered = [...stops]
  if (!depot) return ordered
  return [{ latitude: depot.latitude, longitude: depot.longitude }, ...ordered]
}

/**
 * Live nav waypoints: rider's current GPS, then remaining undelivered stops.
 * Drops the already-travelled depot→here segment so the app polyline shortens
 * as the rider moves.
 */
export function liveRouteWaypoints(
  current: RouteLatLng,
  remainingStops: Array<{ latitude: number; longitude: number }>,
): RouteLatLng[] {
  if (remainingStops.length === 0) return []
  return [current, ...remainingStops]
}
