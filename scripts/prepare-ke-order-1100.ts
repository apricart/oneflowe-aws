#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const LEGACY_ORDER_ID = 1100
const EXCLUDED_ORDER_ID = 192
const SOURCE_PRODUCT = "Millac Tea Whitener 850gm"
const TARGET_PRODUCT = "Milac Instant Tea whitener (850gm)"
const SOURCE_ITEM_ID = 12780
const TARGET_GLOBAL_PRODUCT_ID = 238
const TARGET_ORGANIZATION_INVENTORY_ID = 248
const REPORT_SOURCE = resolve("updatedReports/refundReport.json")
const AUDIT_SOURCE = resolve("updatedReports/ke-refund-detail-audit-2026-08-03.json")
const CURRENT_AUDIT_SOURCE = resolve("updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")
const OUTPUT_ROOT = resolve("updatedReports/ke-order-1100-millac-mapping-2026-08-05")
const REPORT_PATH = resolve(OUTPUT_ROOT, "source.json")
const EVIDENCE_PATH = resolve(OUTPUT_ROOT, "evidence.json")

function cents(value: unknown): number {
  const result = Math.round((Number(value ?? 0) + Number.EPSILON) * 100)
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid money value: ${String(value)}`)
  return result
}

function one<T>(values: T[], label: string): T {
  if (values.length !== 1) throw new Error(`${label}: expected exactly one row, received ${values.length}`)
  return values[0]
}

function writeJson(path: string, value: unknown) {
  const buffer = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8")
  writeFileSync(path, buffer, { flag: "wx" })
  return {
    path,
    bytes: buffer.byteLength,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  }
}

function main() {
  const report = JSON.parse(readFileSync(REPORT_SOURCE, "utf8")) as Row[]
  const audit = JSON.parse(readFileSync(AUDIT_SOURCE, "utf8")) as Row
  const currentAudit = JSON.parse(readFileSync(CURRENT_AUDIT_SOURCE, "utf8")) as Row

  if (!Array.isArray(report)) throw new Error("Refund report is not an array")
  if (Number(currentAudit.organization?.id) !== 10
    || currentAudit.organization?.code !== "0001"
    || currentAudit.organization?.name !== "K-Electric") {
    throw new Error("K-Electric tenant evidence changed")
  }
  if (Number(currentAudit.safety?.productionDatabaseChanges) !== 0
    || Number(currentAudit.safety?.sourceMutationsIssued) !== 0
    || audit.safety?.method !== "GET"
    || Number(audit.safety?.refundOrStatusActionsCalled) !== 0
    || audit.safety?.sourceBusinessDataChanged !== false) {
    throw new Error("Read-only source evidence safety gate failed")
  }

  const header = one(report.filter((row) => Number(row.ID) === LEGACY_ORDER_ID), "order 1100 report header")
  const detail = one((audit.details as Row[]).filter((row) => Number(row.reportOrderId) === LEGACY_ORDER_ID), "order 1100 detail")
  const modal = one((audit.refundModalEvidence?.responses as Row[]).filter((row) => Number(row.reportOrderId) === LEGACY_ORDER_ID), "order 1100 refund modal")
  const reconciliation = one((audit.refundModalEvidence?.orderEvidence as Row[]).filter((row) => Number(row.reportOrderId) === LEGACY_ORDER_ID), "order 1100 refund reconciliation")
  const current = one((currentAudit.orders as Row[]).filter((row) => Number(row.legacyOrderId) === LEGACY_ORDER_ID), "order 1100 current audit")

  if (Number(header.ID) !== LEGACY_ORDER_ID
    || Number(header.LocationID) !== 124
    || String(header.Location) !== "IBC Malir"
    || Number(header.OrderTakerID) !== 138
    || Number(header.StatusID) !== 2
    || Number(header.DeliveryStatus) !== 507) {
    throw new Error("Order 1100 identity/status evidence changed")
  }
  if (!detail.ok || !modal.ok || !current.realDetail || !current.refundEvidence) {
    throw new Error("Order 1100 live detail/refund evidence is incomplete")
  }
  if (Number(detail.detailHeader?.ID) !== LEGACY_ORDER_ID
    || Number(detail.detailHeader?.LocationID) !== 124
    || Number(detail.detailHeader?.StatusID) !== 2
    || Number(detail.detailHeader?.DeliveryStatus) !== 507) {
    throw new Error("Order 1100 detail identity/status evidence changed")
  }

  const expectedMoney = {
    AmountTotal: 3_719_000,
    Tax: 0,
    GrandTotal: 3_719_000,
    RefundAmount: 170_000,
    TaxRefund: 0,
    AmountDiscount: 0,
    ServiceCharges: 0,
    DeliveryCharges: 0,
  }
  for (const [field, expected] of Object.entries(expectedMoney)) {
    if (cents(header[field]) !== expected && field !== "DeliveryCharges") {
      throw new Error(`Order 1100 report ${field} changed`)
    }
    if (cents(detail.checkout?.[field]) !== expected) {
      throw new Error(`Order 1100 checkout ${field} changed`)
    }
  }

  if (!reconciliation.originalSubtotalComplete
    || !reconciliation.originalSubtotalReconciles
    || !reconciliation.refundPriceComplete
    || !reconciliation.unitPriceComplete
    || !reconciliation.refundPriceReconciles
    || !reconciliation.unitPriceReconciles
    || reconciliation.hasNegativeDetailPrice
    || reconciliation.hasNegativeModalRefundQuantity) {
    throw new Error("Order 1100 refund reconciliation evidence changed")
  }

  const originalModalItems = modal.items as Row[]
  const detailItems = detail.items as Row[]
  if (originalModalItems.length !== 16 || detailItems.length !== 16) {
    throw new Error("Order 1100 exact 16-item scope changed")
  }
  const sourceLine = one(originalModalItems.filter((item) => Number(item.ItemId) === SOURCE_ITEM_ID), "approved Millac source line")
  if (String(sourceLine.Name) !== SOURCE_PRODUCT
    || Number(sourceLine.Quantity) !== 2
    || Number(sourceLine.RefundQuantity) !== 2
    || cents(sourceLine.UnitPrice) !== 159_000
    || cents(sourceLine.Price) !== 318_000
    || cents(sourceLine.RefundPrice) !== 0) {
    throw new Error("Approved Millac source line changed")
  }
  const currentSourceLine = one((current.itemEvidence as Row[]).filter((item) => Number(item.ItemId) === SOURCE_ITEM_ID), "current Millac source evidence")
  if (String(currentSourceLine.Name) !== SOURCE_PRODUCT
    || Number(currentSourceLine.selectedHistoryUnitPriceCents) !== 159_000
    || Number(currentSourceLine.selectedHistoryLineTotalCents) !== 318_000
    || currentSourceLine.historyMatchesDetail !== true) {
    throw new Error("Millac price-history evidence changed")
  }

  const refundLine = one(originalModalItems.filter((item) => Number(item.ItemId) === 12765), "refunded Nestle Kashmiri line")
  if (String(refundLine.Name) !== "Nestle Kashmiri Tea (500 GM)"
    || Number(refundLine.Quantity) !== 1
    || Number(refundLine.RefundQuantity) !== 0
    || cents(refundLine.UnitPrice) !== 170_000
    || cents(refundLine.RefundPrice) !== 170_000) {
    throw new Error("Order 1100 refunded-item evidence changed")
  }

  const originalSubtotalCents = originalModalItems.reduce((sum, item) => sum + Number(item.Quantity) * cents(item.UnitPrice), 0)
  const refundCents = originalModalItems.reduce((sum, item) => sum + cents(item.RefundPrice), 0)
  const remainingDetailCents = detailItems.reduce((sum, item) => sum + cents(item.Price), 0)
  if (originalSubtotalCents !== 3_719_000 || refundCents !== 170_000 || remainingDetailCents !== 3_549_000
    || originalSubtotalCents - refundCents !== remainingDetailCents) {
    throw new Error("Order 1100 item/refund totals no longer reconcile")
  }

  const approvedMapping = {
    sourceProduct: SOURCE_PRODUCT,
    sourceItemId: SOURCE_ITEM_ID,
    quantity: 2,
    unitPriceCents: 159_000,
    targetProduct: TARGET_PRODUCT,
    targetGlobalProductId: TARGET_GLOBAL_PRODUCT_ID,
    targetOrganizationInventoryId: TARGET_ORGANIZATION_INVENTORY_ID,
    approval: "USER_APPROVED_EXACT_TARGET_MAPPING",
  }
  const transformedModalItems = originalModalItems.map((item) => Number(item.ItemId) === SOURCE_ITEM_ID
    ? { ...item, Name: TARGET_PRODUCT, SourceName: SOURCE_PRODUCT, ApprovedProductMapping: approvedMapping }
    : { ...item })

  const scopedHeader: Row = {
    ...header,
    ProductMappingPolicy: "USER_APPROVED_EXACT_TARGET_MAPPING",
    ApprovedProductMappings: [approvedMapping],
    ExplicitlyExcludedLegacyOrderIds: [EXCLUDED_ORDER_ID],
  }
  const scopedDetail: Row = {
    ...detail,
    sourceProductEvidencePreserved: true,
    approvedProductMappings: [approvedMapping],
  }
  const scopedModal: Row = {
    ...modal,
    items: transformedModalItems,
    approvedProductMappings: [approvedMapping],
  }
  const scopedReconciliation: Row = {
    ...reconciliation,
    approvedProductMappings: [approvedMapping],
    originalSourceProductName: SOURCE_PRODUCT,
    transformedTargetProductName: TARGET_PRODUCT,
  }

  const outputReport = [scopedHeader]
  const outputEvidence = {
    generatedAt: new Date().toISOString(),
    organization: { id: 10, code: "0001", name: "K-Electric" },
    scope: {
      includedLegacyOrderIds: [LEGACY_ORDER_ID],
      explicitlyExcludedLegacyOrderIds: [EXCLUDED_ORDER_ID],
    },
    approval: {
      instruction: "Import order 1100 using the approved Millac-to-Milac target mapping; do not import order 192.",
      productMapping: approvedMapping,
    },
    safety: {
      sourceMutations: 0,
      productionDatabaseChanges: 0,
      sourceEvidenceReadOnly: true,
    },
    provenance: {
      reportSource: REPORT_SOURCE,
      refundAuditSource: AUDIT_SOURCE,
      currentAuditSource: CURRENT_AUDIT_SOURCE,
    },
    details: [scopedDetail],
    refundModalEvidence: {
      responses: [scopedModal],
      orderEvidence: [scopedReconciliation],
    },
  }

  if (outputReport.some((row) => Number(row.ID) === EXCLUDED_ORDER_ID)
    || outputEvidence.details.some((row) => Number(row.reportOrderId) === EXCLUDED_ORDER_ID)
    || outputEvidence.refundModalEvidence.responses.some((row) => Number(row.reportOrderId) === EXCLUDED_ORDER_ID)) {
    throw new Error("Order 192 entered the scoped import source")
  }

  mkdirSync(OUTPUT_ROOT, { recursive: true })
  const reportFile = writeJson(REPORT_PATH, outputReport)
  const evidenceFile = writeJson(EVIDENCE_PATH, outputEvidence)
  const manifest = writeJson(resolve(OUTPUT_ROOT, "candidate-manifest.json"), {
    generatedAt: new Date().toISOString(),
    organization: outputEvidence.organization,
    includedLegacyOrderIds: [LEGACY_ORDER_ID],
    explicitlyExcludedLegacyOrderIds: [EXCLUDED_ORDER_ID],
    orders: 1,
    orderItems: 16,
    itemRefunds: 1,
    totals: { subtotalCents: originalSubtotalCents, refundCents, remainingDetailCents },
    approvedMapping,
    files: { reportFile, evidenceFile },
    sourceMutations: 0,
    productionDatabaseChanges: 0,
  })

  console.log(JSON.stringify({
    outputRoot: OUTPUT_ROOT,
    includedLegacyOrderIds: [LEGACY_ORDER_ID],
    explicitlyExcludedLegacyOrderIds: [EXCLUDED_ORDER_ID],
    approvedMapping,
    totals: { subtotalCents: originalSubtotalCents, refundCents, remainingDetailCents },
    files: { reportFile, evidenceFile, manifest },
  }, null, 2))
}

main()
