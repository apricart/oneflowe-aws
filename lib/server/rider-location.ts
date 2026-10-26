import "server-only"

import { redis } from "@/lib/redis"
import { isValidLatLng } from "@/lib/rider/assignment-status"

/** Keep the last ping long enough for Track polls + brief radio gaps. */
const LOCATION_TTL_SECONDS = 300
const MIN_INTERVAL_SECONDS = 3

export type RiderLocationPoint = {
  riderUserId: string
  latitude: number
  longitude: number
  accuracyMeters: number | null
  heading: number | null
  speedMps: number | null
  recordedAt: string
  isOnDuty: boolean
  updatedAt: string
}

function key(riderUserId: string) {
  return `rider:loc:${riderUserId}`
}

function rateKey(riderUserId: string) {
  return `rider:loc:rate:${riderUserId}`
}

export type UpsertLocationResult =
  | { kind: "accepted"; point: RiderLocationPoint }
  | { kind: "rejected"; reason: "off_duty" | "invalid" | "stale" | "rate_limited" }

export async function upsertRiderLocation(input: {
  riderUserId: string
  isOnDuty: boolean
  latitude: number
  longitude: number
  accuracyMeters?: number | null
  heading?: number | null
  speedMps?: number | null
  recordedAt: string
}): Promise<UpsertLocationResult> {
  if (!input.isOnDuty) return { kind: "rejected", reason: "off_duty" }
  if (!isValidLatLng(input.latitude, input.longitude)) {
    return { kind: "rejected", reason: "invalid" }
  }

  const recordedMs = Date.parse(input.recordedAt)
  if (!Number.isFinite(recordedMs)) return { kind: "rejected", reason: "invalid" }

  const existing = await getRiderLocation(input.riderUserId)
  if (existing && Date.parse(existing.recordedAt) > recordedMs) {
    return { kind: "rejected", reason: "stale" }
  }

  const count = await redis.incr(rateKey(input.riderUserId))
  if (count === 1) {
    await redis.expire(rateKey(input.riderUserId), MIN_INTERVAL_SECONDS)
  } else if (count > 1) {
    return { kind: "rejected", reason: "rate_limited" }
  }

  const point: RiderLocationPoint = {
    riderUserId: input.riderUserId,
    latitude: input.latitude,
    longitude: input.longitude,
    accuracyMeters: input.accuracyMeters ?? null,
    heading: input.heading ?? null,
    speedMps: input.speedMps ?? null,
    recordedAt: new Date(recordedMs).toISOString(),
    isOnDuty: true,
    updatedAt: new Date().toISOString(),
  }

  await redis.setex(key(input.riderUserId), LOCATION_TTL_SECONDS, JSON.stringify(point))
  return { kind: "accepted", point }
}

export async function getRiderLocation(
  riderUserId: string,
): Promise<RiderLocationPoint | null> {
  const raw = await redis.get<string>(key(riderUserId))
  if (!raw) return null
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw
    return parsed as RiderLocationPoint
  } catch {
    return null
  }
}

export async function getRiderLocations(
  riderUserIds: string[],
): Promise<RiderLocationPoint[]> {
  const points: RiderLocationPoint[] = []
  for (const id of riderUserIds) {
    const point = await getRiderLocation(id)
    if (point) points.push(point)
  }
  return points
}
