import { describe, expect, it } from "vitest"

import { BRANCH_REGIONS, branchRegionLabel, normalizeBranchRegion } from "@/lib/branch-region"
import {
  DELIVERY_ATTENTION_LIMIT,
  buildDeliveryDashboard,
  parseDeliveryDashboardQuery,
  type DeliveryDashboardFilters,
  type DeliveryOrderRow,
} from "@/lib/delivery-dashboard"

const HOUR = 60 * 60 * 1000
const now = new Date("2026-10-06T07:00:00.000Z") // 12:00 Karachi, 6 October

const parse = (query: string) => parseDeliveryDashboardQuery(new URLSearchParams(query), now)

describe("the dashboard query", () => {
  it("defaults to every client and the last 30 Karachi days of deliveries", () => {
    const parsed = parse("")
    expect(parsed).toEqual({
      ok: true,
      filters: {
        organizationId: null,
        branchId: null,
        region: null,
        city: null,
        fulfillmentStatus: null,
        view: "ALL",
        deliveredFrom: "2026-09-07",
        deliveredTo: "2026-10-06",
      },
    })
  })

  it("accepts every known filter", () => {
    const parsed = parse("organizationId=4&branchId=9&region=south&city=Lahore&fulfillmentStatus=out_for_delivery&view=overdue&deliveredFrom=2026-09-01&deliveredTo=2026-09-30")
    expect(parsed).toMatchObject({
      ok: true,
      filters: {
        organizationId: 4,
        branchId: 9,
        region: "SOUTH",
        city: "Lahore",
        fulfillmentStatus: "OUT_FOR_DELIVERY",
        view: "OVERDUE",
        deliveredFrom: "2026-09-01",
        deliveredTo: "2026-09-30",
      },
    })
    expect(parse("region=unknown")).toMatchObject({ ok: true, filters: { region: "UNKNOWN" } })
  })

  it.each([
    ["an unknown filter", "status=PENDING"],
    ["a non-numeric organization", "organizationId=abc"],
    ["a zero organization", "organizationId=0"],
    ["a branch without its organization", "branchId=3"],
    ["an unknown region", "region=EAST"],
    ["an unknown stage", "fulfillmentStatus=PACKING"],
    ["an unknown list", "view=EVERYTHING"],
    ["a malformed date", "deliveredFrom=06-10-2026"],
    ["an impossible date", "deliveredFrom=2026-02-30"],
    ["a reversed range", "deliveredFrom=2026-10-05&deliveredTo=2026-10-01"],
    ["a range over a year", "deliveredFrom=2025-01-01&deliveredTo=2026-10-01"],
    ["an over-long city", `city=${"x".repeat(101)}`],
  ])("refuses %s", (_label, query) => {
    expect(parse(query).ok).toBe(false)
  })
})

describe("branch regions", () => {
  it("is a fixed list, read case-insensitively, blank as Unknown", () => {
    expect(BRANCH_REGIONS).toEqual(["NORTH", "CENTRAL", "SOUTH"])
    expect(normalizeBranchRegion(" south ")).toBe("SOUTH")
    expect(normalizeBranchRegion("Sindh")).toBeNull()
    expect(branchRegionLabel("CENTRAL")).toBe("Central")
    expect(branchRegionLabel(null)).toBe("Unknown")
  })
})

describe("building the dashboard", () => {
  const filters = (overrides: Partial<DeliveryDashboardFilters> = {}): DeliveryDashboardFilters => ({
    organizationId: null,
    branchId: null,
    region: null,
    city: null,
    fulfillmentStatus: null,
    view: "ALL",
    deliveredFrom: "2026-09-07",
    deliveredTo: "2026-10-06",
    ...overrides,
  })

  let id = 0
  const order = (overrides: Partial<DeliveryOrderRow> & { approvedHoursAgo: number }): DeliveryOrderRow => {
    const { approvedHoursAgo, ...rest } = overrides
    id += 1
    return {
      id,
      tid: `T${id}`,
      organizationId: 1,
      organizationName: "KE",
      branchId: 10,
      branchName: "Clifton",
      branchCity: "Karachi",
      branchRegion: "SOUTH",
      deliveryAddressCity: null,
      status: "APPROVED",
      fulfillmentStatus: "IN_PROCESS",
      approvedAt: new Date(now.getTime() - approvedHoursAgo * HOUR),
      deliveredAt: null,
      ...rest,
    }
  }

  const rows = [
    order({ approvedHoursAgo: 99, fulfillmentStatus: "OUT_FOR_DELIVERY" }), // 27h overdue
    order({ approvedHoursAgo: 65, deliveryAddressCity: "Lahore", branchRegion: null }), // due soon, Lahore
    order({ approvedHoursAgo: 5, fulfillmentStatus: "NOT_STARTED", organizationId: 2, organizationName: "UBL", branchId: 20, branchName: "Gulberg", branchCity: "lahore", branchRegion: "CENTRAL" }),
    order({ approvedHoursAgo: 50, fulfillmentStatus: "DELIVERED", deliveredAt: new Date(now.getTime() - 2 * HOUR) }), // delivered today, on time
    order({ approvedHoursAgo: 200, status: "FULFILLED", fulfillmentStatus: "DELIVERED", deliveredAt: new Date(now.getTime() - 100 * HOUR) }), // late
    order({ approvedHoursAgo: 10, status: "PENDING" }), // not delivery work: ignored
  ]
  const build = (overrides: Partial<DeliveryDashboardFilters> = {}) => buildDeliveryDashboard({
    rows,
    filters: filters(overrides),
    now,
    truncated: false,
    organizations: [{ id: 1, name: "KE" }, { id: 2, name: "UBL" }],
    branches: [],
  })

  it("counts every health from the same assessment", () => {
    const dashboard = build()
    expect(dashboard.kpis).toMatchObject({
      open: 3,
      onTrack: 1,
      dueSoon: 1,
      overdue: 1,
      delivered: 2,
      deliveredOnTime: 1,
      deliveredLate: 1,
      deliveredToday: 1,
      onTimeRate: 50,
    })
    expect(dashboard.sla).toEqual({ hours: 72, dueSoonHours: 12, countsOrdersApprovedFrom: "2026-09-01" })
  })

  it("lists the most overdue first, and agrees with the cards", () => {
    const dashboard = build()
    expect(dashboard.orders.items[0]).toMatchObject({ tid: "T1", health: "OVERDUE", hoursOverdue: 27, stageLabel: "Out for Delivery" })
    expect(dashboard.orders.items[1]).toMatchObject({ tid: "T2", health: "DUE_SOON", city: "Lahore", region: "Unknown" })
    expect(dashboard.orders.total).toBe(5)
    expect(build({ view: "OVERDUE" }).orders.total).toBe(dashboard.kpis.overdue)
    expect(build({ view: "OPEN" }).orders.total).toBe(dashboard.kpis.open)
    expect(build({ view: "DELIVERED_TODAY" }).orders.total).toBe(dashboard.kpis.deliveredToday)
  })

  it("groups by destination city case-insensitively, and narrows by it", () => {
    const dashboard = build()
    expect(dashboard.byCity.map((group) => [group.label, group.open])).toEqual([
      ["Karachi", 1],
      ["Lahore", 2],
    ])
    expect(dashboard.options.cities).toEqual(["Karachi", "Lahore"])
    const lahore = build({ city: "LAHORE" })
    expect(lahore.kpis.open).toBe(2)
    expect(lahore.orders.items.map((item) => item.tid)).toEqual(["T2", "T3"])
    // The picker still offers every city while one is chosen.
    expect(lahore.options.cities).toEqual(["Karachi", "Lahore"])
  })

  it("groups by region, client and branch", () => {
    const dashboard = build()
    // Worst first: South holds the overdue order; the rest tie and sort by name.
    expect(dashboard.byRegion.map((group) => [group.key, group.open, group.overdue])).toEqual([
      ["SOUTH", 1, 1],
      ["CENTRAL", 1, 0],
      ["UNKNOWN", 1, 0],
    ])
    expect(dashboard.byOrganization.map((group) => [group.label, group.open])).toEqual([["KE", 2], ["UBL", 1]])
    expect(dashboard.byBranch.map((group) => group.label)).toEqual(["Clifton · KE", "Gulberg · UBL"])
  })

  it("carries no money and no people", () => {
    const serialized = JSON.stringify(build())
    expect(serialized).not.toMatch(/cents|price|total[A-Z]|email|phone|fullName|createdByUserId/i)
  })

  it("caps the list and reports the full count", () => {
    const many = Array.from({ length: DELIVERY_ATTENTION_LIMIT + 5 }, () => order({ approvedHoursAgo: 80 }))
    const dashboard = buildDeliveryDashboard({
      rows: many,
      filters: filters(),
      now,
      truncated: true,
      organizations: [],
      branches: [],
    })
    expect(dashboard.orders.items).toHaveLength(DELIVERY_ATTENTION_LIMIT)
    expect(dashboard.orders.total).toBe(DELIVERY_ATTENTION_LIMIT + 5)
    expect(dashboard.truncated).toBe(true)
  })
})
