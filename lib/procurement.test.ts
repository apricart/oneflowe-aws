import { describe, expect, it } from "vitest"

import {
  DEFAULT_OVER_DELIVERY_TOLERANCE_BPS,
  duplicateProductIds,
  isInvoiceableStatus,
  isReceivableStatus,
  lineMoney,
  maxReceivableMilli,
  outstandingQuantity,
  planGoodsReceipt,
  planSupplierInvoice,
  purchaseOrderActionRefusal,
  purchaseOrderReference,
  purchaseOrderStatusAfter,
  quantityRefusal,
  returnRestockLines,
  sumMoney,
  supplierInvoiceDecisionRefusal,
  toleranceBpsFromPercent,
  tolerancePercent,
} from "@/lib/procurement"

describe("purchase order states", () => {
  it("moves draft → awaiting approval → approved, and back to draft on withdraw", () => {
    expect(purchaseOrderActionRefusal("submit", "DRAFT")).toBeNull()
    expect(purchaseOrderStatusAfter("submit")).toBe("PENDING_APPROVAL")
    expect(purchaseOrderActionRefusal("approve", "PENDING_APPROVAL")).toBeNull()
    expect(purchaseOrderStatusAfter("approve")).toBe("APPROVED")
    expect(purchaseOrderActionRefusal("withdraw", "PENDING_APPROVAL")).toBeNull()
    expect(purchaseOrderStatusAfter("withdraw")).toBe("DRAFT")
  })

  it("edits only a draft, and never approves a draft or an approved order", () => {
    expect(purchaseOrderActionRefusal("update", "DRAFT")).toBeNull()
    for (const status of ["PENDING_APPROVAL", "APPROVED", "RECEIVED"]) {
      expect(purchaseOrderActionRefusal("update", status), status).toMatch(/cannot be edited/)
    }
    expect(purchaseOrderActionRefusal("approve", "DRAFT")).toMatch(/draft and cannot be approved/)
    expect(purchaseOrderActionRefusal("approve", "APPROVED")).not.toBeNull()
  })

  it("cancels before anything is received and closes short after", () => {
    for (const status of ["DRAFT", "PENDING_APPROVAL", "APPROVED"]) expect(purchaseOrderActionRefusal("cancel", status)).toBeNull()
    expect(purchaseOrderActionRefusal("cancel", "PARTIALLY_RECEIVED")).not.toBeNull()
    expect(purchaseOrderActionRefusal("close", "PARTIALLY_RECEIVED")).toBeNull()
    expect(purchaseOrderActionRefusal("close", "APPROVED")).not.toBeNull()
  })

  it("receives against approved, still-open orders, and invoices any approved one", () => {
    expect(isReceivableStatus("APPROVED")).toBe(true)
    expect(isReceivableStatus("PARTIALLY_RECEIVED")).toBe(true)
    expect(isReceivableStatus("RECEIVED")).toBe(false)
    expect(isReceivableStatus("PENDING_APPROVAL")).toBe(false)
    expect(isInvoiceableStatus("CLOSED")).toBe(true)
    expect(isInvoiceableStatus("DRAFT")).toBe(false)
  })

  it("names documents with a zero-padded reference", () => {
    expect(purchaseOrderReference(42)).toBe("PO-000042")
  })
})

describe("money", () => {
  it("rounds net and tax to the paisa, separately", () => {
    // 3 × 333.33 = 999.99; 18% of 999.99 = 179.9982 → 180.00
    expect(lineMoney({ quantity: 3, unitCostCents: 33_333, taxRateBps: 1_800 })).toEqual({ netCents: 99_999, taxCents: 18_000, totalCents: 117_999 })
    // 1.5 kg × 100.01 = 150.015 → 150.02
    expect(lineMoney({ quantity: 1.5, unitCostCents: 10_001, taxRateBps: 0 }).netCents).toBe(15_002)
  })

  it("sums lines into a header", () => {
    expect(sumMoney([
      { netCents: 100, taxCents: 17, totalCents: 117 },
      { netCents: 200, taxCents: 0, totalCents: 200 },
    ])).toEqual({ subtotalCents: 300, taxCents: 17, totalCents: 317 })
  })

  it("finds a product named twice", () => {
    expect(duplicateProductIds([{ globalProductId: 1 }, { globalProductId: 2 }, { globalProductId: 1 }])).toEqual([1])
  })
})

describe("quantities", () => {
  it("refuses zero, negatives and fractions of a whole-unit product", () => {
    expect(quantityRefusal(0, false, "Rice")).toMatch(/above zero/)
    expect(quantityRefusal(-1, false, "Rice")).toMatch(/above zero/)
    expect(quantityRefusal(1.5, false, "Rice")).toMatch(/whole units/)
    expect(quantityRefusal(1.5, true, "Rice")).toBeNull()
  })
})

describe("over-delivery tolerance", () => {
  it("defaults to 20% and converts between percent and basis points", () => {
    expect(DEFAULT_OVER_DELIVERY_TOLERANCE_BPS).toBe(2_000)
    expect(toleranceBpsFromPercent(12.5)).toBe(1_250)
    expect(tolerancePercent(1_250)).toBe(12.5)
  })

  it("caps a line at ordered × (1 + tolerance), never rounding up past it", () => {
    expect(maxReceivableMilli(10, 2_000)).toBe(12_000)
    expect(maxReceivableMilli(10, 0)).toBe(10_000)
    expect(maxReceivableMilli(3, 3_333)).toBe(3_999)
  })
})

describe("goods receipts", () => {
  const poLines = [
    { id: 1, globalProductId: 11, productName: "Rice", quantity: 10, receivedQuantity: 0, allowDecimalQuantity: false },
    { id: 2, globalProductId: 12, productName: "Oil", quantity: 5, receivedQuantity: 0, allowDecimalQuantity: false },
  ]

  it("receives in parts and reports the PO fully received only when every line has its quantity", () => {
    const partial = planGoodsReceipt({ poLines, toleranceBps: 2_000, receipt: [{ purchaseOrderLineId: 1, quantity: 10 }] })
    expect(partial).toMatchObject({ ok: true, fullyReceived: false })
    const full = planGoodsReceipt({
      poLines,
      toleranceBps: 2_000,
      receipt: [{ purchaseOrderLineId: 1, quantity: 10 }, { purchaseOrderLineId: 2, quantity: 5 }],
    })
    expect(full).toMatchObject({ ok: true, fullyReceived: true })
  })

  it("allows up to the tolerance over and refuses one unit more", () => {
    const received = [{ ...poLines[0], receivedQuantity: 6 }, poLines[1]]
    expect(planGoodsReceipt({ poLines: received, toleranceBps: 2_000, receipt: [{ purchaseOrderLineId: 1, quantity: 6 }] }).ok).toBe(true)
    const over = planGoodsReceipt({ poLines: received, toleranceBps: 2_000, receipt: [{ purchaseOrderLineId: 1, quantity: 7 }] })
    expect(over).toEqual({ ok: false, error: expect.stringContaining("at most 6 more") })
  })

  it("refuses a line not on the PO, a line twice, and an empty receipt", () => {
    expect(planGoodsReceipt({ poLines, toleranceBps: 0, receipt: [{ purchaseOrderLineId: 9, quantity: 1 }] }).ok).toBe(false)
    expect(planGoodsReceipt({
      poLines, toleranceBps: 0, receipt: [{ purchaseOrderLineId: 1, quantity: 1 }, { purchaseOrderLineId: 1, quantity: 1 }],
    }).ok).toBe(false)
    expect(planGoodsReceipt({ poLines, toleranceBps: 0, receipt: [] }).ok).toBe(false)
  })

  it("counts what is still on order, never below zero", () => {
    expect(outstandingQuantity({ quantity: 10, receivedQuantity: 4 })).toBe(6)
    expect(outstandingQuantity({ quantity: 10, receivedQuantity: 12 })).toBe(0)
  })
})

describe("three-way match", () => {
  const poLines = [{ id: 1, productName: "Rice", unitCostCents: 1_000, taxRateBps: 1_000, receivedQuantity: 8, allowDecimalQuantity: false }]

  it("matches an invoice within what was received, at the PO's price, taxing at the PO's rate", () => {
    const plan = planSupplierInvoice({ poLines, alreadyInvoicedByLine: new Map(), lines: [{ purchaseOrderLineId: 1, quantity: 8, unitCostCents: 1_000 }] })
    expect(plan).toMatchObject({ ok: true, matchStatus: "MATCHED", totals: { subtotalCents: 8_000, taxCents: 800, totalCents: 8_800 } })
  })

  it("counts earlier invoices against what was received", () => {
    const plan = planSupplierInvoice({ poLines, alreadyInvoicedByLine: new Map([[1, 8]]), lines: [{ purchaseOrderLineId: 1, quantity: 1, unitCostCents: 1_000 }] })
    expect(plan).toMatchObject({ ok: true, matchStatus: "EXCEPTION" })
  })

  it("flags a different unit cost", () => {
    const plan = planSupplierInvoice({ poLines, alreadyInvoicedByLine: new Map(), lines: [{ purchaseOrderLineId: 1, quantity: 1, unitCostCents: 1_001 }] })
    expect(plan.ok && plan.exceptions).toEqual([expect.stringContaining("unit cost differs")])
  })

  it("allows approve and reject only once, and pay only after approval", () => {
    expect(supplierInvoiceDecisionRefusal("approve", "RECORDED")).toBeNull()
    expect(supplierInvoiceDecisionRefusal("approve", "APPROVED")).not.toBeNull()
    expect(supplierInvoiceDecisionRefusal("reject", "PAID")).not.toBeNull()
    expect(supplierInvoiceDecisionRefusal("pay", "RECORDED")).not.toBeNull()
    expect(supplierInvoiceDecisionRefusal("pay", "APPROVED")).toBeNull()
  })
})

describe("customer returns", () => {
  it("puts back resaleable quantities only, summed per product", () => {
    expect(returnRestockLines([
      { globalProductId: 1, quantity: 2, condition: "RESALEABLE" },
      { globalProductId: 1, quantity: 1, condition: "DAMAGED" },
      { globalProductId: 2, quantity: 0.5, condition: "RESALEABLE" },
    ])).toEqual([{ globalProductId: 1, quantity: 2 }, { globalProductId: 2, quantity: 0.5 }])
  })
})
