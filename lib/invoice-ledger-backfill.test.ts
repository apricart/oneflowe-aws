import { describe, expect, it } from "vitest"

import {
  backfillDigestInput,
  legacyCreditedTaxCents,
  planLegacyInvoice,
  summarizeLegacyBackfill,
  type LegacyInvoiceSource,
} from "./invoice-ledger-backfill"

const source = (overrides: Partial<LegacyInvoiceSource> = {}): LegacyInvoiceSource => ({
  orderId: 1778,
  tid: "TID-1778",
  organizationId: 11,
  branchId: 5,
  status: "FULFILLED",
  fulfillmentStatus: "DELIVERED",
  statusAtRefund: null,
  refundAmountCents: null,
  subtotalCents: 14_352_119,
  taxCents: 2_583_381,
  totalCents: 16_935_500,
  receiptData: { invoiceNumber: "APR-000030", date: "08/24/2026", buyerName: "Compliance", buyerAddress: "Karachi" },
  createdAt: new Date("2026-08-24T05:00:00Z"),
  deliveredAt: new Date("2026-08-26T05:00:00Z"),
  fulfilledAt: null,
  organizationName: "UBL",
  organizationCode: "UBL",
  organizationNtn: "0801164-8",
  organizationStrn: null,
  branchName: "Compliance",
  branchCostCenterId: "CC-1",
  approvedRefunds: [],
  ...overrides,
})

describe("planLegacyInvoice", () => {
  it("keeps the invoice's own number, printed date and figures", () => {
    const plan = planLegacyInvoice(source())
    expect(plan).toMatchObject({
      kind: "insert",
      row: {
        orderId: 1778,
        organizationId: 11,
        number: "APR-000030",
        issueDate: "2026-08-24",
        issuedAt: "2026-08-26T05:00:00.000Z",
        origin: "LEGACY_SNAPSHOT",
        status: "ISSUED",
        netCents: 14_352_119,
        taxCents: 2_583_381,
        totalCents: 16_935_500,
        creditedTotalCents: 0,
      },
    })
  })

  it("records refunds as credited totals, with their tax, and the status they imply", () => {
    const partial = planLegacyInvoice(source({
      refundAmountCents: 590,
      approvedRefunds: [{ amountCents: 590, taxRefundCents: 90, lines: [] }],
    }))
    expect(partial).toMatchObject({ row: { status: "PARTIALLY_CREDITED", creditedTotalCents: 590, creditedTaxCents: 90, creditedNetCents: 500 } })
    const full = planLegacyInvoice(source({ status: "REFUNDED", statusAtRefund: "FULFILLED", refundAmountCents: 99_999_999 }))
    expect(full).toMatchObject({ row: { status: "CREDITED", creditedTotalCents: 16_935_500 } })
  })

  it("marks K-Electric imports and falls back to the Karachi supply date for an unreadable printed date", () => {
    const plan = planLegacyInvoice(source({
      receiptData: { invoiceNumber: "KE-LEGACY-415", date: "Tuesday" },
      deliveredAt: new Date("2026-08-31T20:00:00Z"),
    }))
    expect(plan).toMatchObject({ row: { origin: "LEGACY_IMPORT", issueDate: "2026-09-01" } })
  })

  it("skips what has no tax invoice to copy", () => {
    expect(planLegacyInvoice(source({ status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })))
      .toEqual({ kind: "skip", orderId: 1778, reason: "NOT_SUPPLIED" })
    expect(planLegacyInvoice(source({ organizationId: null })))
      .toEqual({ kind: "skip", orderId: 1778, reason: "NO_ORGANIZATION" })
    expect(planLegacyInvoice(source({ receiptData: { date: "08/24/2026" } })))
      .toEqual({ kind: "skip", orderId: 1778, reason: "NO_INVOICE_NUMBER" })
  })
})

describe("legacyCreditedTaxCents", () => {
  const order = { taxCents: 450, totalCents: 2_950 }

  it("keeps a refund's recorded tax", () => {
    expect(legacyCreditedTaxCents({ ...order, approvedRefunds: [{ amountCents: 1_180, taxRefundCents: 180, lines: [] }] })).toBe(180)
  })

  it("works out the tax of a refund that recorded none, line by line at each rate", () => {
    expect(legacyCreditedTaxCents({
      ...order,
      approvedRefunds: [{ amountCents: 1_180, taxRefundCents: 0, lines: [{ grossCents: 1_180, taxRateBp: 1_800 }] }],
    })).toBe(180)
  })

  it("splits an un-itemised refund in the order's own proportion, and adds up several refunds", () => {
    expect(legacyCreditedTaxCents({
      ...order,
      approvedRefunds: [
        { amountCents: 590, taxRefundCents: 0, lines: [] },
        { amountCents: 1_180, taxRefundCents: 0, lines: [{ grossCents: 1_180, taxRateBp: 1_800 }] },
      ],
    })).toBe(90 + 180)
  })

  it("is zero for an order without tax", () => {
    expect(legacyCreditedTaxCents({ taxCents: 0, totalCents: 1_000, approvedRefunds: [{ amountCents: 500, taxRefundCents: 0, lines: [] }] })).toBe(0)
  })

  it("never records more tax than a refund's own amount", () => {
    expect(legacyCreditedTaxCents({ ...order, approvedRefunds: [{ amountCents: 100, taxRefundCents: 999, lines: [] }] })).toBe(100)
  })
})

describe("summary and digest", () => {
  const plans = [
    planLegacyInvoice(source()),
    planLegacyInvoice(source({ orderId: 2, refundAmountCents: 100 })),
    planLegacyInvoice(source({ orderId: 3, status: "PENDING", fulfillmentStatus: "NOT_STARTED" })),
  ]

  it("counts rows per organization and skips by reason", () => {
    expect(summarizeLegacyBackfill(plans)).toMatchObject({
      toInsert: 2,
      byOrganization: { "11": 2 },
      skipped: { NOT_SUPPLIED: 1, NO_ORGANIZATION: 0, NO_INVOICE_NUMBER: 0 },
      creditedTotalCents: 100,
    })
  })

  it("digests exactly the rows that would be written", () => {
    expect(backfillDigestInput(plans)).toHaveLength(2)
    expect(backfillDigestInput(plans)[0]).toEqual([1778, 11, "APR-000030", "2026-08-24", 16_935_500, 0, 0, "ISSUED"])
  })
})
