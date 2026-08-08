#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const LEGACY_ORDER_ID = 60
const OMITTED_ITEM_ROW_ID = 110
const AUDIT_PATH = resolve("updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")
const REVIEW_PATH = resolve("updatedReports/ke-current-missing-orders-excluding-cancelled-2026-08-03.xlsx")
const POLICY_PATH = resolve("deliverables/KE_Remaining_After_Delivered_Policy_2026-08-05.xlsx")
const OUTPUT_ROOT = resolve("updatedReports/ke-order-60-omit-zero-value-2026-08-05")
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
  if (!order || !order.realDetail || !order.rawDetail || !order.checkout) throw new Error("Order 60 live detail evidence is incomplete")
  if (Number(order.detailHeader?.ID) !== LEGACY_ORDER_ID || Number(order.detailHeader?.StatusID) !== 9 || Number(order.detailHeader?.DeliveryStatus) !== 506) {
    throw new Error("Order 60 original status evidence changed")
  }
  if (order.refundEvidence || !order.subtotalReconciles || Number(order.checkoutRows) !== 1) {
    throw new Error("Order 60 financial/refund evidence gate failed")
  }

  const review = sheetRows(REVIEW_PATH, "Missing Orders").find((row) => Number(row["Legacy Order ID"]) === LEGACY_ORDER_ID)
  if (!review) throw new Error("Order 60 is missing from the reviewed non-cancelled scope")
  const policy = sheetRows(POLICY_PATH, "Remaining Orders").find((row) => Number(row["Legacy Order ID"]) === LEGACY_ORDER_ID)
  if (!policy || !String(policy["Reason Still Remaining"] ?? "").includes("approved old non-refund policy")) {
    throw new Error("Order 60 delivered-policy evidence is missing")
  }

  const allItems = order.itemEvidence as Row[]
  const zeroValuePositiveQuantityItems = allItems.filter((item) => Number(item.Quantity) > 0 && cents(item.Price) === 0)
  if (zeroValuePositiveQuantityItems.length !== 1
    || Number(zeroValuePositiveQuantityItems[0].ID) !== OMITTED_ITEM_ROW_ID
    || String(zeroValuePositiveQuantityItems[0].Name) !== "Tapal Danedar Teabags (600 PCS)") {
    throw new Error("The exact user-approved zero-value item row was not found")
  }
  const includedItems = allItems.filter((item) => Number(item.ID) !== OMITTED_ITEM_ROW_ID)
  if (includedItems.length !== 5 || includedItems.some((item) => Number(item.Quantity) <= 0 || cents(item.Price) <= 0)) {
    throw new Error("Included item gate failed")
  }

  const checkout = order.checkout as Row
  const importedSubtotalCents = includedItems.reduce((sum, item) => sum + cents(item.Price), 0)
  if (importedSubtotalCents !== cents(checkout.AmountTotal)) throw new Error("Included items do not reconcile to checkout subtotal")
  if (cents(checkout.AmountTotal) - cents(checkout.AmountDiscount) + cents(checkout.ServiceCharges) + cents(checkout.Tax) !== cents(checkout.GrandTotal)) {
    throw new Error("Checkout arithmetic failed")
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
    GrandTotal: Number(checkout.GrandTotal),
    RefundAmount: 0,
    LocationName: String(order.branch),
    LocationGroup: String(review["Location Group"]),
    UserDetails: String(review["User Details"]),
    CreatedOn: String(detail.OrderCreatedDT),
    LastUpdateDT: String(detail.LastUpdateDT ?? detail.OrderCreatedDT),
    OriginalStatusID: Number(detail.StatusID),
    OriginalDeliveryStatus: Number(detail.DeliveryStatus),
    MigrationStatusPolicy: "USER_APPROVED_OLD_NON_REFUND_AS_DELIVERED",
    ItemTreatmentPolicy: "USER_APPROVED_OMIT_POSITIVE_QUANTITY_ZERO_VALUE_ITEM",
    OmittedLegacyItemRowIds: [OMITTED_ITEM_ROW_ID],
  }

  const sales = includedItems.map((item) => {
    const quantity = Number(item.Quantity)
    const lineTotalCents = cents(item.Price)
    if (lineTotalCents % quantity !== 0) throw new Error(`Non-integral unit price for item row ${item.ID}`)
    return {
      ID: LEGACY_ORDER_ID,
      StatusID: 2,
      DeliveryStatus: 507,
      LocationID: Number(order.locationId),
      Location: String(order.branch),
      LocationGroup: String(review["Location Group"]),
      RegistrationNo: String(review["Registration No(s)"]),
      UserDetails: String(review["User Details"]),
      ItemDetails: String(item.Name),
      ItemQuantity: quantity,
      UnitPrice: lineTotalCents / quantity / 100,
      AmountTotal: Number(checkout.AmountTotal),
      AmountDiscount: Number(checkout.AmountDiscount ?? 0),
      ServiceCharges: Number(checkout.ServiceCharges ?? 0),
      Tax: Number(checkout.Tax ?? 0),
      GrandTotal: Number(checkout.GrandTotal),
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
    approval: "User instructed that the zero-value item must not be counted and the remaining order should be added.",
    deliveredPolicy: "Approved old non-refund order policy",
    originalStatus: { statusId: Number(detail.StatusID), deliveryStatus: Number(detail.DeliveryStatus) },
    checkout: {
      subtotalCents: cents(checkout.AmountTotal),
      taxCents: cents(checkout.Tax),
      totalCents: cents(checkout.GrandTotal),
    },
    includedLegacyItemRows: sales.map((item) => ({
      legacyItemRowId: item.LegacyItemRowID,
      name: item.ItemDetails,
      quantity: item.ItemQuantity,
      unitPriceCents: cents(item.UnitPrice),
      lineTotalCents: cents(item.UnitPrice) * item.ItemQuantity,
    })),
    excludedLegacyItemRows: zeroValuePositiveQuantityItems.map((item) => ({
      legacyItemRowId: Number(item.ID),
      legacyItemId: Number(item.ItemId),
      name: String(item.Name),
      quantity: Number(item.Quantity),
      lineTotalCents: cents(item.Price),
      treatment: "EXCLUDED_BY_EXPLICIT_USER_INSTRUCTION",
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
    includedItems: sales.length,
    excludedZeroValueItems: zeroValuePositiveQuantityItems.length,
    sourceMutations: 0,
    productionDatabaseChanges: 0,
    provenance: { audit: AUDIT_PATH, review: REVIEW_PATH, policy: POLICY_PATH },
    policy: {
      status: orderHeader.MigrationStatusPolicy,
      items: orderHeader.ItemTreatmentPolicy,
      omittedLegacyItemRowIds: orderHeader.OmittedLegacyItemRowIds,
    },
    files,
  }
  const manifestFile = writeJson(resolve(OUTPUT_ROOT, "candidate-manifest.json"), manifest)
  console.log(JSON.stringify({ outputRoot: OUTPUT_ROOT, reportRoot: REPORT_ROOT, ...manifest, manifestFile }, null, 2))
}

main()
