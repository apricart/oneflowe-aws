import type { RiderAssignmentStatus } from "@/db/schema"

const RIDER_START: ReadonlySet<RiderAssignmentStatus> = new Set(["ASSIGNED"])

/** Rider may only advance ASSIGNED → OUT_FOR_DELIVERY. */
export function riderMayStartDelivery(from: string): from is "ASSIGNED" {
  return RIDER_START.has(from as RiderAssignmentStatus)
}

export function canSubmitPod(status: string): boolean {
  return (
    status === "OUT_FOR_DELIVERY" ||
    status === "POD_REJECTED" ||
    status === "ASSIGNED"
  )
}

export function canApprovePod(status: string): boolean {
  return status === "POD_SUBMITTED"
}

export function canRejectPod(status: string): boolean {
  return status === "POD_SUBMITTED"
}

export function canVerifyFulfillmentToken(status: string): boolean {
  return status === "POD_APPROVED" || status === "FULFILLMENT_PENDING"
}

export function isOpenAssignmentStatus(status: string): boolean {
  return status !== "FULFILLMENT_COMPLETED"
}

/** Haversine distance in metres. */
export function distanceMeters(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const toRad = (d: number) => (d * Math.PI) / 180
  const R = 6371000
  const dLat = toRad(lat2 - lat1)
  const dLng = toRad(lng2 - lng1)
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(a))
}

export function isValidLatLng(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  )
}
