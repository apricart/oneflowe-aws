import { describe, expect, it } from "vitest"

import {
  EMPTY_WAREHOUSE_ORDER_REACH,
  canTransferOrderWarehouse,
  isEmptyWarehouseOrderReach,
  isOrderInWarehouseOrderReach,
  orderWarehouseTransferRefusal,
} from "@/lib/order-warehouse-transfer"

describe("who may transfer an order between warehouses", () => {
  it("is Super Admin alone", () => {
    expect(canTransferOrderWarehouse("SUPER_ADMIN")).toBe(true)
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "WAREHOUSE", "APRICART_EXECUTIVE", "ORDER_DESK", "APRICART_SUPPORT", "VIEWER", "", null, undefined]) {
      expect(canTransferOrderWarehouse(role), String(role)).toBe(false)
    }
  })
})

describe("when an order may change warehouse", () => {
  it("allows a pending order and an approved one not yet out for delivery", () => {
    expect(orderWarehouseTransferRefusal({ status: "PENDING", fulfillmentStatus: null })).toBeNull()
    expect(orderWarehouseTransferRefusal({ status: "approved", fulfillmentStatus: "NOT_STARTED" })).toBeNull()
    expect(orderWarehouseTransferRefusal({ status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })).toBeNull()
  })

  it("refuses once the goods have left the warehouse", () => {
    expect(orderWarehouseTransferRefusal({ status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })).toBe("out-for-delivery")
    expect(orderWarehouseTransferRefusal({ status: "APPROVED", fulfillmentStatus: "DELIVERED" })).toBe("out-for-delivery")
  })

  it("refuses an order with nothing left to fulfil", () => {
    for (const status of ["REJECTED", "CANCELLED", "REFUNDED", "FULFILLED", "PARTIALLY_REFUNDED", "", null]) {
      expect(orderWarehouseTransferRefusal({ status, fulfillmentStatus: "NOT_STARTED" }), String(status)).toBe("not-open")
    }
  })
})

describe("whose work an order is", () => {
  const reach = { branchIds: [10, 11], warehouseIds: [3] }

  it("an untransferred order belongs to whoever serves its branch", () => {
    expect(isOrderInWarehouseOrderReach({ branchId: 10, fulfillmentWarehouseId: null }, reach)).toBe(true)
    expect(isOrderInWarehouseOrderReach({ branchId: 12, fulfillmentWarehouseId: null }, reach)).toBe(false)
  })

  it("a transferred order belongs to its warehouse's operators only, wherever its branch is", () => {
    expect(isOrderInWarehouseOrderReach({ branchId: 99, fulfillmentWarehouseId: 3 }, reach)).toBe(true)
    // Its branch is served, but it was moved to a warehouse this account does not operate.
    expect(isOrderInWarehouseOrderReach({ branchId: 10, fulfillmentWarehouseId: 4 }, reach)).toBe(false)
  })

  it("an empty reach works nothing", () => {
    expect(isEmptyWarehouseOrderReach(EMPTY_WAREHOUSE_ORDER_REACH)).toBe(true)
    expect(isEmptyWarehouseOrderReach({ branchIds: [], warehouseIds: [1] })).toBe(false)
    expect(isOrderInWarehouseOrderReach({ branchId: 10, fulfillmentWarehouseId: null }, EMPTY_WAREHOUSE_ORDER_REACH)).toBe(false)
    expect(isOrderInWarehouseOrderReach({ branchId: 10, fulfillmentWarehouseId: 3 }, EMPTY_WAREHOUSE_ORDER_REACH)).toBe(false)
  })
})
