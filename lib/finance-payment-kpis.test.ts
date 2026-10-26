import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  PAYMENT_AGING_BUCKETS,
  collectionRatePct,
  isOverdueBucket,
  paymentAgingBucketFor,
  summarizePaymentKpis,
  type OrganizationPaymentRow,
} from "@/lib/finance-payment-kpis"

const figure = (count: number, amountCents: number) => ({ count, amountCents })

function organization(id: number, name: string, paid: number, unpaid: number, delivered = 0): OrganizationPaymentRow {
  return {
    organizationId: id,
    organizationName: name,
    paid: figure(paid > 0 ? 1 : 0, paid),
    unpaid: figure(unpaid > 0 ? 1 : 0, unpaid),
    unpaidDelivered: figure(delivered > 0 ? 1 : 0, delivered),
  }
}

describe("aging buckets", () => {
  it.each([
    [0, "0-30"], [30, "0-30"], [30.9, "0-30"], [31, "31-60"], [60, "31-60"],
    [61, "61-90"], [90, "61-90"], [91, "90+"], [5000, "90+"], [-3, "0-30"], [Number.NaN, "0-30"],
  ])("%s days is %s", (days, bucket) => {
    expect(paymentAgingBucketFor(days)).toBe(bucket)
  })

  it("calls everything past 30 days overdue", () => {
    expect(PAYMENT_AGING_BUCKETS.filter((bucket) => isOverdueBucket(bucket.key)).map((bucket) => bucket.key))
      .toEqual(["31-60", "61-90", "90+"])
  })

  it("has a SQL twin with the same boundaries", () => {
    const source = readFileSync(resolve(process.cwd(), "lib/server/finance-payment-kpis.ts"), "utf8")
    expect(source).toContain("<= 30 THEN '0-30'")
    expect(source).toContain("<= 60 THEN '31-60'")
    expect(source).toContain("<= 90 THEN '61-90'")
    expect(source).toContain("ELSE '90+'")
  })
})

describe("collection rate", () => {
  it("is the paid share of the amount, to one decimal", () => {
    expect(collectionRatePct(1, 2)).toBe(33.3)
    expect(collectionRatePct(100, 0)).toBe(100)
    expect(collectionRatePct(0, 100)).toBe(0)
  })

  it("is null when there is nothing to collect", () => {
    expect(collectionRatePct(0, 0)).toBeNull()
  })
})

describe("summarizePaymentKpis", () => {
  it("totals the organizations and the aging, and puts the most outstanding first", () => {
    const kpis = summarizePaymentKpis({
      organizations: [
        organization(1, "Alpha", 10_000, 5_000, 5_000),
        organization(2, "Beta", 0, 20_000),
      ],
      aging: [
        { bucket: "0-30", count: 1, amountCents: 5_000 },
        { bucket: "90+", count: 1, amountCents: 20_000 },
      ],
    })
    expect(kpis.paid).toEqual(figure(1, 10_000))
    expect(kpis.unpaid).toEqual(figure(2, 25_000))
    expect(kpis.unpaidDelivered).toEqual(figure(1, 5_000))
    expect(kpis.overdue).toEqual(figure(1, 20_000))
    expect(kpis.collectionRatePct).toBe(28.6)
    expect(kpis.organizations.map((row) => row.organizationName)).toEqual(["Beta", "Alpha"])
    expect(kpis.organizations[0].collectionRatePct).toBe(0)
  })

  it("lists every bucket, in order, even when empty, so the buckets add up to the unpaid total", () => {
    const kpis = summarizePaymentKpis({ organizations: [], aging: [] })
    expect(kpis.aging.map((row) => row.bucket)).toEqual(["0-30", "31-60", "61-90", "90+"])
    expect(kpis.aging.every((row) => row.count === 0 && row.amountCents === 0)).toBe(true)
    expect(kpis.collectionRatePct).toBeNull()
  })
})
