import { describe, expect, it } from "vitest"

import {
  DELIVERY_DASHBOARD_CUTOFF_AT,
  DELIVERY_SLA_HOURS,
  DUE_SOON_HOURS,
  assessDelivery,
  compareByAttention,
  countDeliveredOn,
  countDeliveries,
  deliveryAlerts,
  destinationCity,
  groupDeliveries,
  isInDeliveryDateRange,
  karachiDay,
  matchesDeliveryListView,
  overdueAgeBuckets,
  pipelineCounts,
  placeKey,
  promisedDeliveryAt,
  shiftKarachiDay,
  type DeliveryAssessment,
} from "@/lib/delivery-sla"

const HOUR = 60 * 60 * 1000
const approvedAt = new Date("2026-10-01T05:00:00.000Z") // 10:00 Karachi
const promised = new Date(approvedAt.getTime() + 72 * HOUR)
const at = (hoursAfterApproval: number) => new Date(approvedAt.getTime() + hoursAfterApproval * HOUR)

const open = (stage = "IN_PROCESS") => ({ status: "APPROVED", fulfillmentStatus: stage, approvedAt, deliveredAt: null })
const delivered = (hoursAfterApproval: number | null, status = "APPROVED") => ({
  status,
  fulfillmentStatus: "DELIVERED",
  approvedAt,
  deliveredAt: hoursAfterApproval === null ? null : at(hoursAfterApproval),
})

function assess(order: Parameters<typeof assessDelivery>[0], now: Date): DeliveryAssessment {
  const result = assessDelivery(order, now)
  if (!result) throw new Error("expected an assessment")
  return result
}

describe("the delivery promise", () => {
  it("is the agreed rule: 72 hours from approval, due soon in the last 12, from 1 September Karachi", () => {
    expect(DELIVERY_SLA_HOURS).toBe(72)
    expect(DUE_SOON_HOURS).toBe(12)
    expect(DELIVERY_DASHBOARD_CUTOFF_AT.toISOString()).toBe("2026-08-31T19:00:00.000Z")
    expect(promisedDeliveryAt(approvedAt)).toEqual(promised)
  })
})

describe("an open order", () => {
  it("is on track with more than 12 hours to go", () => {
    const result = assess(open(), at(10))
    expect(result).toMatchObject({ health: "ON_TRACK", isOpen: true, hoursRemaining: 62, hoursOverdue: null, stage: "IN_PROCESS" })
    expect(result.promisedAt).toEqual(promised)
  })

  it("is due soon from exactly 12 hours before the deadline", () => {
    expect(assess(open(), at(59.9)).health).toBe("ON_TRACK")
    expect(assess(open(), at(60)).health).toBe("DUE_SOON")
    expect(assess(open(), at(72)).health).toBe("DUE_SOON")
  })

  it("is overdue the moment the deadline passes, by how long", () => {
    const result = assess(open(), at(99))
    expect(result).toMatchObject({ health: "OVERDUE", hoursOverdue: 27, hoursRemaining: null })
  })

  it("keeps its stage, defaulting a missing one to Not Started", () => {
    expect(assess(open("OUT_FOR_DELIVERY"), at(1)).stage).toBe("OUT_FOR_DELIVERY")
    expect(assess({ ...open(), fulfillmentStatus: null }, at(1)).stage).toBe("NOT_STARTED")
  })
})

describe("a delivered order", () => {
  it("is on time when delivered at or before the deadline, and never ages after", () => {
    const result = assess(delivered(72), at(500))
    expect(result).toMatchObject({ health: "DELIVERED_ON_TIME", isOpen: false, deliveryHours: 72, hoursOverdue: null })
  })

  it("is late when delivered after the deadline, by how long", () => {
    expect(assess(delivered(80), at(500))).toMatchObject({ health: "DELIVERED_LATE", hoursOverdue: 8, deliveryHours: 80 })
  })

  it("counts as delivered once settled, whatever the progress column says", () => {
    expect(assess({ ...delivered(10, "FULFILLED"), fulfillmentStatus: "IN_PROCESS" }, at(500)).isOpen).toBe(false)
  })

  it("is acknowledged only once settled as fulfilled", () => {
    expect(assess(delivered(10), at(500)).acknowledged).toBe(false)
    expect(assess(delivered(10, "FULFILLED"), at(500)).acknowledged).toBe(true)
    expect(assess(delivered(null, "PARTIALLY_FULFILLED"), at(500)).acknowledged).toBe(true)
    expect(assess(open(), at(1)).acknowledged).toBe(false)
  })

  it("is never guessed when its delivery time was not recorded", () => {
    expect(assess(delivered(null), at(500))).toMatchObject({ health: "DELIVERED_UNTIMED", deliveryHours: null })
  })
})

describe("orders that are not delivery work", () => {
  it.each(["PENDING", "REJECTED", "CANCELLED", "REFUNDED", ""])("leaves out a %s order", (status) => {
    expect(assessDelivery({ ...open(), status }, at(1))).toBeNull()
  })

  it("leaves out an approved order with no approval time", () => {
    expect(assessDelivery({ ...open(), approvedAt: null }, at(1))).toBeNull()
    expect(assessDelivery({ ...open(), approvedAt: "not a date" }, at(1))).toBeNull()
  })
})

describe("Karachi days", () => {
  it("names the Karachi day, not the UTC one", () => {
    expect(karachiDay(new Date("2026-10-01T19:30:00.000Z"))).toBe("2026-10-02")
    expect(karachiDay(new Date("2026-10-01T18:59:59.000Z"))).toBe("2026-10-01")
  })

  it("steps across month ends", () => {
    expect(shiftKarachiDay("2026-10-01", -1)).toBe("2026-09-30")
    expect(shiftKarachiDay("2026-10-05", -29)).toBe("2026-09-06")
  })
})

describe("the summaries", () => {
  const now = at(100)
  const assessments = [
    assess(open("NOT_STARTED"), at(1)), // on track at its own clock
    assess(open("IN_PROCESS"), at(65)), // due soon
    assess(open("OUT_FOR_DELIVERY"), now), // 28h overdue
    assess(delivered(50), now), // on time
    assess(delivered(90), now), // 18h late
    assess(delivered(null), now), // untimed
  ]

  it("counts each health once, and averages only timed deliveries", () => {
    expect(countDeliveries(assessments)).toEqual({
      open: 3,
      onTrack: 1,
      dueSoon: 1,
      overdue: 1,
      delivered: 3,
      deliveredOnTime: 1,
      deliveredLate: 1,
      deliveredUntimed: 1,
      notStarted: 1,
      inProcess: 1,
      outForDelivery: 1,
      awaitingAcknowledgement: 3,
      acknowledged: 0,
      onTimeRate: 50,
      averageDeliveryHours: 70,
    })
    expect(countDeliveries([])).toMatchObject({ onTimeRate: null, averageDeliveryHours: null })
  })

  it("splits open orders by stage and delivered ones by acknowledgement, each adding up", () => {
    const counts = countDeliveries([...assessments, assess(delivered(40, "FULFILLED"), now)])
    expect(counts).toMatchObject({ awaitingAcknowledgement: 3, acknowledged: 1, delivered: 4 })
    expect(counts.notStarted + counts.inProcess + counts.outForDelivery).toBe(counts.open)
    expect(counts.awaitingAcknowledgement + counts.acknowledged).toBe(counts.delivered)
  })

  it("counts deliveries on one Karachi day", () => {
    expect(countDeliveredOn(assessments, karachiDay(at(50)))).toBe(1)
  })

  it("places every overdue order in exactly one age bucket", () => {
    const ages = [0.5, 12, 23.9, 24, 48, 72, 200].map((hours) => assess(open(), at(72 + hours)))
    expect(overdueAgeBuckets(ages).map((bucket) => bucket.count)).toEqual([1, 2, 1, 1, 2])
    expect(overdueAgeBuckets(ages).reduce((sum, bucket) => sum + bucket.count, 0)).toBe(ages.length)
  })

  it("puts open orders in the pipeline by stage, and delivered ones nowhere", () => {
    expect(pipelineCounts(assessments).map((entry) => [entry.stage, entry.count])).toEqual([
      ["NOT_STARTED", 1],
      ["IN_PROCESS", 1],
      ["OUT_FOR_DELIVERY", 1],
    ])
  })

  it("raises the alerts", () => {
    const late = [24, 80].map((hours) => assess(open(), at(72 + hours)))
    expect(deliveryAlerts([...late, assess(open(), at(65))])).toEqual({
      overdue: 2,
      overdueOver24Hours: 2,
      overdueOver72Hours: 1,
      dueSoon: 1,
    })
  })
})

describe("the attention order", () => {
  const row = (id: number, assessment: DeliveryAssessment) => ({ id, assessment })

  it("puts the most overdue first, then the nearest deadline, then delivered newest first", () => {
    const rows = [
      row(1, assess(delivered(10), at(200))),
      row(2, assess(open(), at(60))), // due soon, 12h left
      row(3, assess(open(), at(80))), // 8h overdue
      row(4, assess(open(), at(100))), // 28h overdue
      row(5, assess(open(), at(10))), // on track
      row(6, assess(delivered(90), at(200))), // delivered late
    ]
    expect([...rows].sort(compareByAttention).map((entry) => entry.id)).toEqual([4, 3, 2, 5, 6, 1])
  })

  it("is stable for identical orders", () => {
    const a = row(9, assess(open(), at(1)))
    const b = row(3, assess(open(), at(1)))
    expect([a, b].sort(compareByAttention).map((entry) => entry.id)).toEqual([3, 9])
  })
})

describe("places", () => {
  it("prefers the delivery address's city, then the branch's", () => {
    expect(destinationCity({ deliveryAddressCity: " Lahore ", branchCity: "Karachi" })).toBe("Lahore")
    expect(destinationCity({ deliveryAddressCity: "  ", branchCity: "Karachi" })).toBe("Karachi")
    expect(destinationCity({ deliveryAddressCity: null, branchCity: null })).toBeNull()
  })

  it("groups a city however it was typed, and blanks as Unknown", () => {
    expect(placeKey("  Karachi ")).toEqual({ key: "karachi", label: "Karachi" })
    expect(placeKey("KARACHI").key).toBe(placeKey("karachi").key)
    expect(placeKey(null)).toEqual({ key: "unknown", label: "Unknown" })
  })

  it("orders groups worst first", () => {
    const rows = [
      { city: "Karachi", assessment: assess(open(), at(10)) },
      { city: "Lahore", assessment: assess(open(), at(100)) },
      { city: "karachi", assessment: assess(open(), at(20)) },
    ]
    const groups = groupDeliveries(rows, (entry) => placeKey(entry.city))
    expect(groups.map((group) => [group.label, group.open, group.overdue])).toEqual([
      ["Lahore", 1, 1],
      ["Karachi", 2, 0],
    ])
  })
})

describe("the list views", () => {
  const now = at(100)
  it("narrows by card", () => {
    const overdue = assess(open(), now)
    const deliveredToday = assess(delivered(99), now)
    const today = karachiDay(now)
    expect(matchesDeliveryListView(overdue, "OPEN", today)).toBe(true)
    expect(matchesDeliveryListView(overdue, "OVERDUE", today)).toBe(true)
    expect(matchesDeliveryListView(overdue, "DUE_SOON", today)).toBe(false)
    expect(matchesDeliveryListView(deliveredToday, "DELIVERED_TODAY", today)).toBe(true)
    expect(matchesDeliveryListView(deliveredToday, "DELIVERED_LATE", today)).toBe(true)
    expect(matchesDeliveryListView(deliveredToday, "OPEN", today)).toBe(false)
    expect(matchesDeliveryListView(deliveredToday, "ALL", today)).toBe(true)
  })

  it("narrows by stage and by acknowledgement", () => {
    const today = karachiDay(now)
    const outForDelivery = assess(open("OUT_FOR_DELIVERY"), now)
    const awaiting = assess(delivered(50), now)
    const fulfilled = assess(delivered(50, "FULFILLED"), now)
    expect(matchesDeliveryListView(outForDelivery, "OUT_FOR_DELIVERY", today)).toBe(true)
    expect(matchesDeliveryListView(outForDelivery, "IN_PROCESS", today)).toBe(false)
    // A delivered order is never counted at an open stage, whatever its column says.
    expect(matchesDeliveryListView({ ...awaiting, stage: "NOT_STARTED" }, "NOT_STARTED", today)).toBe(false)
    expect(matchesDeliveryListView(awaiting, "AWAITING_ACKNOWLEDGEMENT", today)).toBe(true)
    expect(matchesDeliveryListView(awaiting, "ACKNOWLEDGED", today)).toBe(false)
    expect(matchesDeliveryListView(fulfilled, "ACKNOWLEDGED", today)).toBe(true)
    expect(matchesDeliveryListView(fulfilled, "AWAITING_ACKNOWLEDGEMENT", today)).toBe(false)
  })
})

describe("the date range", () => {
  // approvedAt is 1 October, 10:00 Karachi.
  it("places an open order by the Karachi day it was approved", () => {
    const order = assess(open(), at(100))
    expect(isInDeliveryDateRange(order, "2026-10-01", "2026-10-01")).toBe(true)
    expect(isInDeliveryDateRange(order, "2026-10-02", "2026-10-31")).toBe(false)
    expect(isInDeliveryDateRange(order, "2026-09-01", "2026-09-30")).toBe(false)
  })

  it("places a delivered order by the Karachi day it was delivered, inclusive at both ends", () => {
    const order = assess(delivered(50), at(100)) // 3 October, 12:00 Karachi
    expect(isInDeliveryDateRange(order, "2026-10-03", "2026-10-03")).toBe(true)
    expect(isInDeliveryDateRange(order, "2026-10-01", "2026-10-02")).toBe(false)
  })

  it("never places a delivery whose time was not recorded", () => {
    expect(isInDeliveryDateRange(assess(delivered(null), at(100)), "2026-01-01", "2026-12-31")).toBe(false)
  })
})
