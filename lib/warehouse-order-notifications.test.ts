import { describe, expect, it } from "vitest"

import {
  isWarehouseOrderTemplate,
  parseWarehouseOrderPayload,
  RECURRING_WAREHOUSE_ORDER_EVENTS,
  toWarehouseNotificationItem,
  WAREHOUSE_NOTIFICATION_TITLES,
  WAREHOUSE_ORDER_EVENTS,
  warehouseNotificationActionSchema,
  warehouseOrderCopy,
  warehouseOrderEventKey,
  warehouseOrderEventOf,
  warehouseOrderLink,
  warehouseOrderTemplate,
  type WarehouseOrderPayload,
} from "@/lib/warehouse-order-notifications"

/** plans/OF-WAREHOUSE-order-stage-notifications.md */

const payload: WarehouseOrderPayload = { orderId: 42, tid: "TID-42", organizationName: "KE", branchName: "Clifton" }

describe("which stages the warehouse is told about", () => {
  it("is every order stage from creation to fulfilment, refunds and cancellations included", () => {
    expect([...WAREHOUSE_ORDER_EVENTS]).toEqual([
      "CREATED", "EDITED", "RETURNED", "RESUBMITTED", "APPROVED", "REJECTED", "CANCELLED", "REFUNDED", "FULFILLED",
    ])
  })

  it("never includes a delivery stage, which the warehouse records itself", () => {
    for (const stage of ["NOT_STARTED", "IN_PROCESS", "OUT_FOR_DELIVERY", "DELIVERED"]) {
      expect(WAREHOUSE_ORDER_EVENTS as readonly string[]).not.toContain(stage)
      expect(isWarehouseOrderTemplate(`WAREHOUSE_ORDER_${stage}`)).toBe(false)
    }
  })
})

describe("templates", () => {
  it("round-trip every event and recognise nothing else", () => {
    for (const event of WAREHOUSE_ORDER_EVENTS) {
      const template = warehouseOrderTemplate(event)
      expect(isWarehouseOrderTemplate(template)).toBe(true)
      expect(warehouseOrderEventOf(template)).toBe(event)
    }
    for (const other of ["ORDER_CREATED", "WAREHOUSE_ORDER_", "WAREHOUSE_ORDER_created", "SUPPORT_THREAD_OPENED", null, 3]) {
      expect(isWarehouseOrderTemplate(other)).toBe(false)
    }
  })

  it("fit the 64-character type and template columns", () => {
    for (const event of WAREHOUSE_ORDER_EVENTS) expect(warehouseOrderTemplate(event).length).toBeLessThanOrEqual(64)
  })
})

describe("event keys", () => {
  const user = "0f8fad5b-d9cb-469f-a165-70867728950e"

  it("name one event, one order and one recipient", () => {
    expect(warehouseOrderEventKey({ event: "APPROVED", orderId: 42, recipientUserId: user }))
      .toBe(`WAREHOUSE_ORDER_APPROVED:42:${user}`)
  })

  it("name the occurrence of a recurring event, and refuse one without it", () => {
    expect([...RECURRING_WAREHOUSE_ORDER_EVENTS]).toEqual(["EDITED", "RETURNED", "RESUBMITTED", "REFUNDED"])
    expect(warehouseOrderEventKey({ event: "REFUNDED", orderId: 42, recipientUserId: user, occurrence: 7 }))
      .toBe(`WAREHOUSE_ORDER_REFUNDED:42:7:${user}`)
    for (const event of RECURRING_WAREHOUSE_ORDER_EVENTS) {
      expect(() => warehouseOrderEventKey({ event, orderId: 42, recipientUserId: user })).toThrow(/OCCURRENCE_REQUIRED/)
      expect(() => warehouseOrderEventKey({ event, orderId: 42, recipientUserId: user, occurrence: "" })).toThrow()
    }
  })

  it("ignore an occurrence on a one-time event, so a repeat cannot queue it twice", () => {
    expect(warehouseOrderEventKey({ event: "CREATED", orderId: 42, recipientUserId: user, occurrence: 9 }))
      .toBe(`WAREHOUSE_ORDER_CREATED:42:${user}`)
  })

  it("fit the 255-character key column at the widest", () => {
    const key = warehouseOrderEventKey({ event: "RESUBMITTED", orderId: Number.MAX_SAFE_INTEGER, recipientUserId: user, occurrence: Number.MAX_SAFE_INTEGER })
    expect(key.length).toBeLessThanOrEqual(255)
  })
})

describe("wording", () => {
  it("names the order, branch and organization for every event", () => {
    for (const event of WAREHOUSE_ORDER_EVENTS) {
      const copy = warehouseOrderCopy(event, payload)
      expect(copy.message, event).toContain("TID-42")
      expect(copy.message, event).toContain("Clifton")
      expect(copy.message, event).toContain("KE")
      expect(copy.subject, event).toContain("TID-42")
    }
  })

  it("tells pending from approved-at-creation on a new order", () => {
    expect(warehouseOrderCopy("CREATED", payload).message).toContain("awaiting approval")
    expect(warehouseOrderCopy("CREATED", { ...payload, approvedAtCreation: true }).message).toContain("approved at creation")
  })

  it("links to the order queue only for an order that is the warehouse's work", () => {
    const linked = WAREHOUSE_ORDER_EVENTS.filter((event) => warehouseOrderLink(event, payload) !== null)
    expect(linked).toEqual(["APPROVED", "FULFILLED"])
    expect(warehouseOrderLink("CREATED", { ...payload, approvedAtCreation: true })).toBe("/warehouse#orders")
  })

  it("has a bell heading for every event", () => {
    for (const event of WAREHOUSE_ORDER_EVENTS) expect(WAREHOUSE_NOTIFICATION_TITLES[event]).toBeTruthy()
  })
})

describe("payloads", () => {
  it("keep only the order, organization, branch and the approved-at-creation flag", () => {
    expect(parseWarehouseOrderPayload({ ...payload, totalCents: 500, requestedBy: "A Person", approvedAtCreation: true }))
      .toEqual({ ...payload, approvedAtCreation: true })
  })

  it.each([
    ["no object", null],
    ["no order id", { ...payload, orderId: 0 }],
    ["a fractional order id", { ...payload, orderId: 1.5 }],
    ["no tid", { ...payload, tid: "" }],
    ["no organization", { ...payload, organizationName: undefined }],
    ["no branch", { ...payload, branchName: 4 }],
  ])("refuse %s", (_label, value) => {
    expect(parseWarehouseOrderPayload(value)).toBeNull()
  })
})

describe("the notification list", () => {
  const row = { id: 1, type: "WAREHOUSE_ORDER_APPROVED", message: "m", createdAt: new Date("2026-10-13T05:00:00Z"), readAt: null }

  it("links an order still in the warehouse's queue", () => {
    expect(toWarehouseNotificationItem({ ...row, orderStatus: "APPROVED" })).toEqual({
      id: 1, event: "APPROVED", title: WAREHOUSE_NOTIFICATION_TITLES.APPROVED, message: "m", createdAt: "2026-10-13T05:00:00.000Z", read: false, href: "/warehouse#orders",
    })
    expect(toWarehouseNotificationItem({ ...row, orderStatus: "FULFILLED" })?.href).toBe("/warehouse#orders")
  })

  it("does not link an order that left the queue since, or never entered it", () => {
    for (const status of ["PENDING", "REJECTED", "CANCELLED", "REFUNDED", null]) {
      expect(toWarehouseNotificationItem({ ...row, orderStatus: status })?.href, String(status)).toBeNull()
    }
  })

  it("reports read notices and drops rows that are not warehouse notices", () => {
    expect(toWarehouseNotificationItem({ ...row, readAt: new Date(), orderStatus: null })?.read).toBe(true)
    expect(toWarehouseNotificationItem({ ...row, type: "ORDER_CREATED", orderStatus: null })).toBeNull()
  })

  it("accepts only mark-all-read, with no extra field", () => {
    expect(warehouseNotificationActionSchema.safeParse({ action: "mark-all-read" }).success).toBe(true)
    expect(warehouseNotificationActionSchema.safeParse({ action: "delete" }).success).toBe(false)
    expect(warehouseNotificationActionSchema.safeParse({ action: "mark-all-read", userId: "x" }).success).toBe(false)
    expect(warehouseNotificationActionSchema.safeParse(null).success).toBe(false)
  })
})
