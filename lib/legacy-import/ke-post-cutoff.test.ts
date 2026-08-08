import { describe, expect, it } from "vitest"
import {
  mapLegacyStatus,
  normalizeLegacyProduct,
  validateBudgetRows,
  type LegacyBudgetRow,
} from "./ke-post-cutoff"

describe("K-Electric post-cutoff migration policy", () => {
  it("maps operational delivery progression separately from order status", () => {
    expect(mapLegacyStatus({ ID: 1, StatusID: 2, DeliveryStatus: 501 })).toMatchObject({ status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })
    expect(mapLegacyStatus({ ID: 2, StatusID: 2, DeliveryStatus: 503 })).toMatchObject({ status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })
    expect(mapLegacyStatus({ ID: 3, StatusID: 2, DeliveryStatus: 506 })).toMatchObject({ status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })
  })

  it("maps Delivered and Partial to fulfilled/delivered", () => {
    expect(mapLegacyStatus({ ID: 4, StatusID: 2, DeliveryStatus: 507 })).toMatchObject({ status: "FULFILLED", fulfillmentStatus: "DELIVERED" })
    expect(mapLegacyStatus({ ID: 5, StatusID: 2, DeliveryStatus: 505 })).toMatchObject({ status: "FULFILLED", fulfillmentStatus: "DELIVERED" })
  })

  it("applies the explicit order 1327 override", () => {
    expect(mapLegacyStatus({ ID: 1327, StatusID: 1, DeliveryStatus: 501 })).toMatchObject({ status: "FULFILLED", fulfillmentStatus: "DELIVERED" })
    expect(() => mapLegacyStatus({ ID: 1326, StatusID: 1, DeliveryStatus: 501 })).toThrow(/unsupported legacy StatusID/)
  })

  it("skips cancelled orders", () => {
    expect(mapLegacyStatus({ ID: 6, StatusID: 5, DeliveryStatus: 508 })).toEqual({ skip: true, sourceStatus: "Cancelled" })
  })

  it("normalizes the legacy Millac spelling deterministically", () => {
    expect(normalizeLegacyProduct("Millac Tea Whitener 850gm")).toBe("millac tea whitener 850gm")
  })

  it("requires budget rows to reconcile", () => {
    const valid: LegacyBudgetRow = {
      Location: "Johar Technical",
      TenureFrom: "2026-07-01T00:00:00",
      TenureTo: "2026-07-31T00:00:00",
      MonthlyBudget: 35000,
      RemainingBudget: 175,
      UsedBudget: 34825,
      AdditionalBudget: 0,
    }
    expect(() => validateBudgetRows(Array.from({ length: 36 }, (_, index) => ({
      ...valid,
      Location: `Branch ${index}`,
    })))).not.toThrow()
    expect(() => validateBudgetRows(Array.from({ length: 36 }, (_, index) => ({
      ...valid,
      Location: `Branch ${index}`,
      RemainingBudget: index === 0 ? 176 : 175,
    })))).toThrow(/does not reconcile/)
  })
})
