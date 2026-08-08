#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const LEGACY_ORDER_ID = 415
const AUDIT_PATH = resolve("updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")
const REVIEW_PATH = resolve("updatedReports/ke-current-missing-orders-excluding-cancelled-2026-08-03.xlsx")
const POLICY_PATH = resolve("deliverables/KE_Remaining_After_Delivered_Policy_2026-08-05.xlsx")
const OUTPUT_ROOT = resolve("updatedReports/ke-order-415-missing-values-zero-2026-08-05")
const REPORT_ROOT = resolve(OUTPUT_ROOT, "reports")

function cents(value: unknown): number {
  const result = Math.round((Number(value ?? 0) + Number.EPSILON) * 100)
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid money value: ${String(value)}`)
  return result
}

function sheetRows(path: string, sheetName: string): Row[] {
  const workbook = XLSX.readFile(path, { cellDates: false })
  const sheet = workbook.Sheets[sheetName]
  if (!sheet) throw new Error(`${path} is missing sheet ${sheetName}`)
  return XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true })
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
  const audit = JSON.parse(readFileSync(AUDIT_PATH, "utf8")) as Row
  if (Number(audit.organization?.id) !== 10 || audit.organization?.code !== "0001" || audit.organization?.name !== "K-Electric") {
    throw new Error("K-Electric audit identity gate failed")
  }
  if (Number(audit.safety?.productionDatabaseChanges) !== 0 || Number(audit.safety?.sourceMutationsIssued) !== 0) {
    throw new Error("Source audit safety declaration failed")
  }

  const order = (audit.orders as Row[]).find((candidate) => Number(candidate.legacyOrderId) === LEGACY_ORDER_ID)
  if (!order || !order.realDetail || !order.rawDetail) throw new Error("Order 415 live detail evidence is incomplete")
  if (Number(order.detailHeader?.ID) !== LEGACY_ORDER_ID || Number(order.detailHeader?.StatusID) !== 1 || Number(order.detailHeader?.DeliveryStatus) !== 507) {
    throw new Error("Order 415 original status evidence changed")
  }
  if (order.checkout !== null || Number(order.checkoutRows) !== 0 || order.refundEvidence) {
    throw new Error("Order 415 checkout/refund evidence changed")
  }
  if (!order.historyComplete || Number(order.itemRows) !== 2 || Number(order.positiveItemRows) !== 2) {
    throw new Error("Order 415 item/price-history gate failed")
  }

  const review = sheetRows(REVIEW_PATH, "Missing Orders").find((row) => Number(row["Legacy Order ID"]) === LEGACY_ORDER_ID)
  if (!review) throw new Error("Order 415 is missing from the reviewed non-cancelled scope")
  const policy = sheetRows(POLICY_PATH, "Remaining Orders").find((row) => Number(row["Legacy Order ID"]) === LEGACY_ORDER_ID)
  if (!policy || !String(policy["Reason Still Remaining"] ?? "").includes("approved old non-refund policy")) {
    throw new Error("Order 415 delivered-policy evidence is missing")
  }

  const items = order.itemEvidence as Row[]
  const expectedItemRowIds = [1761, 1762]
  if (JSON.stringify(items.map((item) => Number(item.ID)).sort((a, b) => a - b)) !== JSON.stringify(expectedItemRowIds)) {
    throw new Error("Order 415 exact item-row scope changed")
  }
  if (items.some((item) => Number(item.Quantity) <= 0 || Number(item.exactHistoryPriceCount) !== 1 || !item.historyMatchesDetail)) {
    throw new Error("Order 415 item price evidence failed")
  }

  const subtotalCents = items.reduce((sum, item) => sum + cents(item.Price), 0)
  if (subtotalCents !== 822_000 || Number(order.detailSubtotalCents) !== subtotalCents) {
    throw new Error(`Order 415 verified item subtotal changed: ${subtotalCents}`)
  }
  const detail = order.rawDetail as Row
  const orderHeader = {
    ID: LEGACY_ORDER_ID,
    LocationID: Number(order.locationId),
    OrderNo: Number(detail.OrderNo),
    TransactionNo: detail.TransactionNo,
    OrderTakerID: Number(detail.OrderTakerID),
    StatusID: 2,
    DeliveryStatus: 507,
    GrandTotal: subtotalCents / 100,
    RefundAmount: 0,
    LocationName: String(order.branch),
    LocationGroup: String(review["Location Group"]),
    UserDetails: String(review["User Details"]),
    CreatedOn: String(detail.OrderCreatedDT),
    LastUpdateDT: String(detail.LastUpdateDT ?? detail.OrderCreatedDT),
    OriginalStatusID: Number(detail.StatusID),
    OriginalDeliveryStatus: Number(detail.DeliveryStatus),
    MigrationStatusPolicy: "USER_APPROVED_OLD_NON_REFUND_AS_DELIVERED",
    FinancialValuesPolicy: "USER_APPROVED_MISSING_VALUES_AS_ZERO",
    DerivedSubtotalPolicy: "SUM_VERIFIED_ITEM_LINES",
    AssumedMissingValues: {
      AmountDiscount: 0,
      ServiceCharges: 0,
      DeliveryCharges: 0,
      Tax: 0,
      RefundAmount: 0,
      TaxRefund: 0,
    },
  }

  const sales = items.map((item) => {
    const quantity = Number(item.Quantity)
    const priceCents = Number(item.selectedHistoryUnitPriceCents)
    if (!Number.isSafeInteger(priceCents) || priceCents <= 0 || priceCents * quantity !== cents(item.Price)) {
      throw new Error(`Order 415 price calculation failed for legacy item row ${item.ID}`)
    }
    return {
      ID: LEGACY_ORDER_ID,
      StatusID: 2,
      DeliveryStatus: 507,
      LocationID: Number(order.locationId),
      Location: String(order.branch),
      LocationGroup: String(review["Location Group"]),
      RegistrationNo: String(review["Registration No(s)"] ?? ""),
      UserDetails: String(review["User Details"]),
      ItemDetails: String(item.Name),
      ItemQuantity: quantity,
      UnitPrice: priceCents / 100,
      AmountTotal: subtotalCents / 100,
      AmountDiscount: 0,
      ServiceCharges: 0,
      Tax: 0,
      GrandTotal: subtotalCents / 100,
      OrderCreatedDT: String(detail.OrderCreatedDT),
      LastUpdateDT: String(detail.LastUpdateDT ?? detail.OrderCreatedDT),
      ItemId: Number(item.ItemId),
      ItemCode: item.ItemCode ?? null,
      LegacyItemRowID: Number(item.ID),
    }
  })
  const history = sales.map((item) => ({
    Date: String(order.liveDate),
    ItemName: item.ItemDetails,
    Location: item.Location,
    LocationGroup: item.LocationGroup,
    Price: item.UnitPrice,
  }))
  const evidence = {
    legacyOrderId: LEGACY_ORDER_ID,
    approval: "User instructed that missing values may be taken as zero and the order should be added to its K-Electric branch.",
    deliveredPolicy: "Approved old non-refund order policy",
    financialPolicy: "Missing tax, discount, service charges, delivery charges, refund, and tax refund treated as zero.",
    originalStatus: { statusId: Number(detail.StatusID), deliveryStatus: Number(detail.DeliveryStatus) },
    sourceCheckoutRows: 0,
    derivedTotals: { subtotalCents, taxCents: 0, totalCents: subtotalCents },
    items: sales.map((item) => ({
      legacyItemRowId: item.LegacyItemRowID,
      name: item.ItemDetails,
      quantity: item.ItemQuantity,
      unitPriceCents: cents(item.UnitPrice),
      lineTotalCents: cents(item.UnitPrice) * item.ItemQuantity,
    })),
  }

  mkdirSync(REPORT_ROOT, { recursive: true })
  const files = {
    order: writeJson(resolve(REPORT_ROOT, "order.json"), [orderHeader]),
    sales: writeJson(resolve(REPORT_ROOT, "sales-report.json"), sales),
    summary: writeJson(resolve(REPORT_ROOT, "user-product-summary-report.json"), []),
    history: writeJson(resolve(REPORT_ROOT, "item-price-history-report.json"), history),
    evidence: writeJson(resolve(OUTPUT_ROOT, "candidate-evidence.json"), evidence),
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    organization: { id: 10, code: "0001", name: "K-Electric" },
    candidateLegacyOrderIds: [LEGACY_ORDER_ID],
    orders: 1,
    items: sales.length,
    sourceCheckoutRows: 0,
    derivedSubtotalCents: subtotalCents,
    assumedTaxCents: 0,
    derivedTotalCents: subtotalCents,
    sourceMutations: 0,
    productionDatabaseChanges: 0,
    provenance: { audit: AUDIT_PATH, review: REVIEW_PATH, policy: POLICY_PATH },
    policy: {
      status: orderHeader.MigrationStatusPolicy,
      finances: orderHeader.FinancialValuesPolicy,
      subtotal: orderHeader.DerivedSubtotalPolicy,
      assumedMissingValues: orderHeader.AssumedMissingValues,
    },
    files,
  }
  const manifestFile = writeJson(resolve(OUTPUT_ROOT, "candidate-manifest.json"), manifest)
  console.log(JSON.stringify({ outputRoot: OUTPUT_ROOT, reportRoot: REPORT_ROOT, ...manifest, manifestFile }, null, 2))
}

main()
