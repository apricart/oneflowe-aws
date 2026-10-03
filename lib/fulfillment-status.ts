export const FULFILLMENT_STATUSES = [
  "NOT_STARTED",
  "IN_PROCESS",
  "OUT_FOR_DELIVERY",
  "DELIVERED",
] as const

export type FulfillmentStatus = (typeof FULFILLMENT_STATUSES)[number]

export type FulfillmentStatusFilterParse =
  | { ok: true; filter: FulfillmentStatus | null }
  | { ok: false; message: string }

export const FULFILLMENT_STATUS_LABELS: Record<FulfillmentStatus, string> = {
  NOT_STARTED: "Not Started",
  IN_PROCESS: "In Process",
  OUT_FOR_DELIVERY: "Out for Delivery",
  DELIVERED: "Delivered",
}

export function normalizeFulfillmentStatus(status?: string | null): FulfillmentStatus {
  const normalized = String(status || "NOT_STARTED").trim().toUpperCase()
  return FULFILLMENT_STATUSES.includes(normalized as FulfillmentStatus)
    ? (normalized as FulfillmentStatus)
    : "NOT_STARTED"
}

/**
 * Whether an order's goods have arrived. No order may be fulfilled until this
 * is true, whichever role asks; `fulfillApprovedOrder` enforces the same rule
 * in its claim, this lets a caller refuse with a clear message first.
 */
export function isOrderDelivered(status?: string | null): boolean {
  return normalizeFulfillmentStatus(status) === "DELIVERED"
}

/**
 * Parses the Orders-page delivery-status filter without silently broadening an
 * invalid request. This is intentionally stricter than
 * `normalizeFulfillmentStatus`, whose fallback is useful for legacy rows but
 * would turn a misspelled query into "Not Started".
 */
export function parseFulfillmentStatusFilter(
  raw: string | null | undefined,
): FulfillmentStatusFilterParse {
  if (raw === null || raw === undefined || raw.trim() === "") {
    return { ok: true, filter: null }
  }

  const normalized = raw.trim().toUpperCase()
  return FULFILLMENT_STATUSES.includes(normalized as FulfillmentStatus)
    ? { ok: true, filter: normalized as FulfillmentStatus }
    : {
        ok: false,
        message: `fulfillmentStatus must be one of: ${FULFILLMENT_STATUSES.join(", ")}`,
      }
}

export function getNextFulfillmentStatus(status?: string | null): FulfillmentStatus | null {
  const current = normalizeFulfillmentStatus(status)
  const index = FULFILLMENT_STATUSES.indexOf(current)
  return index >= 0 && index < FULFILLMENT_STATUSES.length - 1
    ? FULFILLMENT_STATUSES[index + 1]
    : null
}
