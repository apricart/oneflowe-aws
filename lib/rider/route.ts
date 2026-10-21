export type RouteStop = {
  sequence: number
  assignmentId: number
  orderId: number
  orderTid: string
  latitude: number
  longitude: number
  address: string | null
  status: string
}

export type RoutePayload = {
  depot: {
    name: string
    latitude: number
    longitude: number
    address: string | null
  } | null
  stops: RouteStop[]
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
}): RoutePayload {
  const stops = [...input.stops].sort((a, b) => a.sequence - b.sequence)
  return { depot: input.depot, stops }
}
