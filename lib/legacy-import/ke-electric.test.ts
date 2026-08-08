import { existsSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import {
  normalizeBranch,
  normalizeBranchExact,
  normalizeLegacyUser,
  normalizeProductName,
  prepareKeLegacySource,
  rejectionCounts,
  resolveKeLegacyBranch,
  toCents,
} from "./ke-electric"

const legacyReportsAvailable = [
  "order.json",
  "sales-report.json",
  "user-product-summary-report.json",
  "item-price-history-report.json",
].every((file) => existsSync(resolve("reports", file)))

describe("K-Electric legacy source normalization", () => {
  it("normalizes the known GSO branch alias without broad fuzzy matching", () => {
    expect(normalizeBranch("1. GSO")).toBe("gso")
    expect(normalizeBranch("GSO")).toBe("gso")
  })

  it("preserves capitalization for exact external branch identity", () => {
    expect(normalizeBranchExact(" DISTRIBUTION   STRATEGY ")).toBe("DISTRIBUTION STRATEGY")
    expect(normalizeBranchExact("Distribution Strategy")).toBe("Distribution Strategy")
  })

  it("resolves capitalization-only branches by stable source location ID", () => {
    const branches = [
      { id: 184, name: "DISTRIBUTION STRATEGY", externalSource: "KE_LOGISTICS", externalId: "85" },
      { id: 260, name: "Distribution Strategy", externalSource: "KE_LOGISTICS", externalId: "86" },
      { id: 226, name: "society cluster", externalSource: "KE_LOGISTICS", externalId: "128" },
      { id: 261, name: "Society Cluster", externalSource: "KE_LOGISTICS", externalId: "132" },
    ]

    expect(resolveKeLegacyBranch(branches, { locationId: 85, name: "DISTRIBUTION STRATEGY" })).toMatchObject({
      branch: { id: 184 },
      kind: "EXTERNAL_ID",
    })
    expect(resolveKeLegacyBranch(branches, { locationId: 86, name: "Distribution Strategy" })).toMatchObject({
      branch: { id: 260 },
      kind: "EXTERNAL_ID",
    })
    expect(resolveKeLegacyBranch(branches, { locationId: 128, name: "society cluster" })).toMatchObject({
      branch: { id: 226 },
      kind: "EXTERNAL_ID",
    })
    expect(resolveKeLegacyBranch(branches, { locationId: 132, name: "Society Cluster" })).toMatchObject({
      branch: { id: 261 },
      kind: "EXTERNAL_ID",
    })
  })

  it("uses exact capitalization before normalized aliases and rejects ambiguity", () => {
    const branches = [
      { id: 1, name: "society cluster" },
      { id: 2, name: "Society Cluster" },
    ]
    expect(resolveKeLegacyBranch(branches, { name: "Society Cluster" })).toMatchObject({
      branch: { id: 2 },
      kind: "EXACT_NAME",
    })
    expect(resolveKeLegacyBranch(branches, { name: "SOCIETY CLUSTER" })).toMatchObject({
      branch: null,
      kind: "UNRESOLVED",
      matchCount: 2,
    })
    expect(resolveKeLegacyBranch([{ id: 1, name: "society cluster" }], { name: "Society Cluster" })).toMatchObject({
      branch: null,
      kind: "UNRESOLVED",
      matchCount: 1,
    })
  })

  it("removes only the legacy trailing user separator", () => {
    expect(normalizeLegacyUser("Muhammad Javeed -")).toBe("muhammad javeed")
    expect(normalizeLegacyUser("Cell - Toshiba")).toBe("cell - toshiba")
  })

  it("normalizes harmless product whitespace but retains product wording", () => {
    expect(normalizeProductName(" Bakery Biscuits\tSnack Pack ( Lu ) "))
      .toBe("bakery biscuits snack pack (lu)")
  })

  it("converts source rupees to integer cents", () => {
    expect(toCents(139.24)).toBe(13924)
    expect(toCents(null)).toBe(0)
  })
})

describe.skipIf(!legacyReportsAvailable)("K-Electric legacy report reconciliation", () => {
  it("selects only fully delivered, non-refunded, exactly balanced orders", () => {
    const source = prepareKeLegacySource()
    expect(source.sourceCounts).toEqual({
      orders: 805,
      salesLines: 6395,
      productSummaryRows: 5554,
      priceHistoryRows: 2753,
    })
    expect(source.prepared).toHaveLength(594)
    expect(rejectionCounts(source.rejected)).toEqual({
      NOT_DELIVERED: 164,
      ITEM_SUBTOTAL_MISMATCH: 20,
      UNRESOLVED_ITEM_PRICE: 12,
      HAS_REFUND: 15,
    })

    for (const order of source.prepared) {
      expect(order.sourceHeader.StatusID).toBe(2)
      expect(order.sourceHeader.DeliveryStatus).toBe(507)
      expect(toCents(order.sourceHeader.RefundAmount ?? 0)).toBe(0)
      expect(order.lines.reduce((sum, line) => sum + line.lineTotalCents, 0)).toBe(order.subtotalCents)
      expect(order.subtotalCents + order.taxCents).toBe(order.totalCents)
    }
  })
})
