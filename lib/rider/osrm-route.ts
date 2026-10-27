/**
 * Fetch a driving geometry between waypoints via the public OSRM demo.
 * Coordinates are [lat, lng] in; OSRM wants lng,lat. Falls back to null on
 * any failure so callers can draw a straight polyline instead.
 *
 * Prefer calling this from the server (`/api/v1/rider-ops/route-geometry`) so
 * browser CSP cannot block it. Direct browser use is kept for the rider app.
 */

export type LatLng = { latitude: number; longitude: number }

const OSRM_BASE = "https://router.project-osrm.org/route/v1/driving"

function nearlySame(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.latitude - b.latitude) < 1e-5 && Math.abs(a.longitude - b.longitude) < 1e-5
}

/** Drop consecutive duplicate pins — OSRM rejects zero-length legs. */
export function dedupeWaypoints(waypoints: LatLng[]): LatLng[] {
  const out: LatLng[] = []
  for (const point of waypoints) {
    if (out.length === 0 || !nearlySame(out[out.length - 1], point)) out.push(point)
  }
  return out
}

async function fetchOsrmPath(waypoints: LatLng[], signal?: AbortSignal): Promise<LatLng[] | null> {
  const path = waypoints.map((point) => `${point.longitude},${point.latitude}`).join(";")
  const url = `${OSRM_BASE}/${path}?overview=full&geometries=geojson`

  const response = await fetch(url, { signal, headers: { Accept: "application/json" } })
  if (!response.ok) return null
  const body = (await response.json()) as {
    code?: string
    routes?: Array<{ geometry?: { coordinates?: Array<[number, number]> } }>
  }
  if (body.code !== "Ok") return null
  const coords = body.routes?.[0]?.geometry?.coordinates
  if (!coords?.length) return null
  return coords.map(([lng, lat]) => ({ latitude: lat, longitude: lng }))
}

/**
 * Prefer a single multi-stop request; if that fails, stitch pairwise legs so
 * one bad segment does not blank the whole route.
 */
export async function fetchDrivingGeometry(
  waypoints: LatLng[],
  signal?: AbortSignal,
): Promise<LatLng[] | null> {
  const unique = dedupeWaypoints(waypoints)
  if (unique.length < 2) return null

  try {
    const whole = await fetchOsrmPath(unique, signal)
    if (whole?.length) return whole

    const stitched: LatLng[] = []
    for (let i = 0; i < unique.length - 1; i++) {
      if (signal?.aborted) return null
      const leg = await fetchOsrmPath([unique[i], unique[i + 1]], signal)
      if (!leg?.length) continue
      if (stitched.length === 0) stitched.push(...leg)
      else stitched.push(...leg.slice(1))
    }
    return stitched.length >= 2 ? stitched : null
  } catch {
    return null
  }
}

/** Browser helper — hits our warehouse proxy (avoids CSP blocks). */
export async function fetchDrivingGeometryViaProxy(
  waypoints: LatLng[],
  signal?: AbortSignal,
): Promise<LatLng[] | null> {
  const unique = dedupeWaypoints(waypoints)
  if (unique.length < 2) return null

  const points = unique.map((point) => `${point.latitude},${point.longitude}`).join(";")
  try {
    const response = await fetch(
      `/api/v1/rider-ops/route-geometry?points=${encodeURIComponent(points)}`,
      { signal, headers: { Accept: "application/json" } },
    )
    if (!response.ok) return null
    const body = (await response.json()) as {
      geometry?: LatLng[] | null
      mode?: string
      error?: string
    }
    return body.geometry?.length ? body.geometry : null
  } catch {
    return null
  }
}
