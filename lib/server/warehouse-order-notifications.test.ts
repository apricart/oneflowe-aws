import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import { RECURRING_WAREHOUSE_ORDER_EVENTS, type WarehouseOrderEvent } from "@/lib/warehouse-order-notifications"

/**
 * Every path that moves an order through a stage the warehouse is told about
 * queues the warehouse's notice, and the delivery-stage path queues none.
 * See plans/OF-WAREHOUSE-order-stage-notifications.md.
 *
 * This list is the control: a new path that creates, edits, returns,
 * resubmits, decides, cancels, refunds or fulfils an order goes on it, or the
 * warehouse is silently not told.
 */

const read = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

const HOOKS: ReadonlyArray<{ path: string; events: WarehouseOrderEvent[] }> = [
  { path: "app/api/v1/orders/route.ts", events: ["CREATED"] },
  { path: "lib/server/group-order-creation.ts", events: ["CREATED"] },
  { path: "app/api/v1/orders/[id]/route.ts", events: ["EDITED"] },
  { path: "lib/server/order-desk-edit.ts", events: ["EDITED"] },
  { path: "lib/server/order-correction.ts", events: ["RETURNED", "RESUBMITTED"] },
  { path: "lib/server/order-desk-orders.ts", events: ["CANCELLED", "RESUBMITTED"] },
  { path: "lib/server/order-decision-service.ts", events: ["APPROVED", "REJECTED"] },
  { path: "lib/server/group-order-cancel.ts", events: ["CANCELLED"] },
  { path: "app/api/v1/orders/[id]/refunds/route.ts", events: ["REFUNDED"] },
  { path: "app/api/v1/admin/refunds/route.ts", events: ["REFUNDED"] },
  { path: "lib/server/order-fulfillment.ts", events: ["FULFILLED"] },
  { path: "app/api/v1/orders/cron/auto-fulfill/route.ts", events: ["FULFILLED"] },
  { path: "lib/server/order-warehouse-transfer.ts", events: ["TRANSFERRED_OUT", "TRANSFERRED_IN"] },
]

describe("warehouse notifications are queued on every order path", () => {
  it.each(HOOKS)("$path queues $events", ({ path, events }) => {
    const source = read(path)
    expect(source).toContain('from "@/lib/server/warehouse-order-notifications"')
    for (const event of events) {
      expect(source, `${path} ${event}`).toMatch(new RegExp(`queueWarehouseOrderNotifications\\([\\s\\S]{0,400}?event: "${event}"`))
    }
  })

  it("covers every event at least once", () => {
    const covered = new Set(HOOKS.flatMap((hook) => hook.events))
    expect([...covered].sort()).toEqual(
      ["APPROVED", "CANCELLED", "CREATED", "EDITED", "FULFILLED", "REFUNDED", "REJECTED", "RESUBMITTED", "RETURNED", "TRANSFERRED_IN", "TRANSFERRED_OUT"],
    )
  })

  it("names the occurrence of every recurring event, so a second one is not swallowed", () => {
    for (const { path, events } of HOOKS) {
      const source = read(path)
      for (const event of events.filter((name) => RECURRING_WAREHOUSE_ORDER_EVENTS.includes(name))) {
        expect(source, `${path} ${event}`).toMatch(new RegExp(`event: "${event}",?\\s*occurrence:`))
      }
    }
  })

  it("queues inside the transaction that moves the order", () => {
    // Called with the transaction client, never the pool, so a rollback takes
    // the notice with it. The auto-fulfil sweep and every service use `tx`.
    for (const { path } of HOOKS) {
      const calls = read(path).match(/queueWarehouseOrderNotifications\((\w+)/g) ?? []
      expect(calls.length, path).toBeGreaterThan(0)
      for (const call of calls) expect(call, path).toBe("queueWarehouseOrderNotifications(tx")
    }
  })

  it("never tells the warehouse about a delivery stage", () => {
    for (const path of [
      "lib/server/order-fulfillment-progress.ts",
      "app/api/v1/warehouse/orders/[id]/progress/route.ts",
      "app/api/v1/orders/[id]/fulfillment-status/route.ts",
    ]) {
      expect(read(path), path).not.toContain("queueWarehouseOrderNotifications")
    }
  })
})

describe("delivery and reading", () => {
  it("sends warehouse rows down their own path, which re-checks the reach", () => {
    const dispatcher = read("lib/server/order-notifications.ts")
    expect(dispatcher).toContain("if (isWarehouseEmailTemplate(row.template)) return deliverClaimedWarehouseEmail(row)")
    const deliverer = read("lib/server/warehouse-order-notifications.ts")
    // Order by order, so a transferred order is judged by its warehouse, not its branch.
    expect(deliverer).toContain("isOrderInWarehouseReach(row.recipientUserId, row.orderId)")
  })

  it("tells the operators of a transferred order's warehouse, not the branch's accounts", () => {
    const source = read("lib/server/warehouse-order-notifications.ts")
    expect(source).toContain("if (fulfillmentWarehouseId !== null) {")
    expect(source).toContain('eq(apricartWarehouseMemberships.responsibility, "WAREHOUSE_OPERATOR")')
  })

  it("lists notices through the warehouse's own endpoint, fenced to the current reach", () => {
    const route = read("app/api/v1/warehouse/notifications/route.ts")
    expect(route).toContain('requireApiRole(["WAREHOUSE"])')
    expect(route).toContain("loadWarehouseOrderReach(db, user.id)")
    expect(route).toContain("inArray(notifications.branchId, [...reach.branchIds])")
    expect(route).toContain("inArray(orders.fulfillmentWarehouseId, [...reach.warehouseIds])")
    expect(route).toContain("eq(notifications.userId, userId)")
    // The shared notification route still knows nothing of the role.
    expect(read("app/api/v1/notifications/route.ts")).not.toContain("WAREHOUSE")
  })
})
