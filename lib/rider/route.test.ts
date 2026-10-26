import { describe, expect, it } from "vitest"
import { liveRouteWaypoints, plannedRouteWaypoints } from "@/lib/rider/route"

describe("route waypoints", () => {
  const depot = { name: "W", latitude: 24.84, longitude: 67.09, address: null }
  const stops = [
    { latitude: 24.86, longitude: 67.0 },
    { latitude: 24.9, longitude: 67.08 },
  ]

  it("planned route starts at the warehouse, not a return leg", () => {
    expect(plannedRouteWaypoints(depot, stops)).toEqual([
      { latitude: 24.84, longitude: 67.09 },
      { latitude: 24.86, longitude: 67.0 },
      { latitude: 24.9, longitude: 67.08 },
    ])
  })

  it("live route starts at the rider GPS so the travelled path is dropped", () => {
    const here = { latitude: 24.85, longitude: 67.05 }
    expect(liveRouteWaypoints(here, stops)).toEqual([here, ...stops])
    expect(liveRouteWaypoints(here, [])).toEqual([])
  })
})
