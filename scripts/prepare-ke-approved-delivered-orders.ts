#!/usr/bin/env tsx
import { stringifyPrimitive } from "../lib/stringify-primitive"

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const EXPECTED_IDS = [41, 51, 53, 87, 1155]
const EXPECTED_STATUS = new Map<number, { statusId: number; deliveryStatus: number }>([
  [41, { statusId: 9, deliveryStatus: 506 }],
  [51, { statusId: 9, deliveryStatus: 506 }],
  [53, { statusId: 9, deliveryStatus: 506 }],
  [87, { statusId: 9, deliveryStatus: 506 }],
  [1155, { statusId: 2, deliveryStatus: 503 }],
])
const AUDIT_PATH = resolve("updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")
const REVIEW_PATH = resolve("updatedReports/ke-current-missing-orders-excluding-cancelled-2026-08-03.xlsx")
const PRE_POLICY_PATH = resolve("updatedReports/ke-remaining-non-cancelled-orders-21-2026-08-04.xlsx")
const POST_POLICY_PATH = resolve("deliverables/KE_Remaining_After_Delivered_Policy_2026-08-05.xlsx")
const OUTPUT_ROOT = resolve("updatedReports/ke-approved-delivered-orders-41-51-53-87-1155-2026-08-05")
const REPORT_ROOT = resolve(OUTPUT_ROOT, "reports")

function cents(value: unknown): number {
  const result = Math.round((Number(value ?? 0) + Number.EPSILON) * 100)
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid money value: ${stringifyPrimitive(value)}`)
  return result
}

function normalize(value: unknown): string {
  return stringifyPrimitive(value).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase()
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
  if (Number(audit.organization?.id) !== 10
    || audit.organization?.code !== "0001"
    || audit.organization?.name !== "K-Electric") {
    throw new Error("K-Electric audit identity gate failed")
  }
  if (Number(audit.safety?.productionDatabaseChanges) !== 0
    || Number(audit.safety?.sourceMutationsIssued) !== 0) {
    throw new Error("Source audit safety declaration failed")
  }

  const reviewRows = sheetRows(REVIEW_PATH, "Missing Orders")
  const reviewById = new Map(reviewRows.map((row) => [Number(row["Legacy Order ID"]), row]))
  const prePolicyIds = sheetRows(PRE_POLICY_PATH, "Remaining Orders").map((row) => Number(row["Legacy Order ID"]))
  const postPolicyIds = new Set(sheetRows(POST_POLICY_PATH, "Remaining Orders").map((row) => Number(row["Legacy Order ID"])))
  const clearedByPolicy = prePolicyIds.filter((id) => !postPolicyIds.has(id)).sort((a, b) => a - b)
  if (JSON.stringify(clearedByPolicy) !== JSON.stringify(EXPECTED_IDS)) {
    throw new Error(`Delivered-policy scope changed: ${clearedByPolicy.join(", ")}`)
  }

  const auditById = new Map((audit.orders as Row[]).map((row) => [Number(row.legacyOrderId), row]))
  const headers: Row[] = []
  const sales: Row[] = []
  const history: Row[] = []
  const evidence: Row[] = []

  for (const legacyOrderId of EXPECTED_IDS) {
    const order = auditById.get(legacyOrderId)
    const review = reviewById.get(legacyOrderId)
    const expectedStatus = EXPECTED_STATUS.get(legacyOrderId)!
    if (!order || !review || !order.realDetail || !order.rawDetail || !order.checkout) {
      throw new Error(`Order ${legacyOrderId} source evidence is incomplete`)
    }
    if (Number(order.detailHeader?.ID) !== legacyOrderId
      || Number(order.detailHeader?.StatusID) !== expectedStatus.statusId
      || Number(order.detailHeader?.DeliveryStatus) !== expectedStatus.deliveryStatus
      || Number(order.rawDetail.StatusID) !== expectedStatus.statusId
      || Number(order.rawDetail.DeliveryStatus) !== expectedStatus.deliveryStatus) {
      throw new Error(`Order ${legacyOrderId} original status evidence changed`)
    }
    if (order.refundEvidence
      || Number(order.checkoutRows) !== 1
      || !order.subtotalReconciles
      || !order.historyComplete) {
      throw new Error(`Order ${legacyOrderId} financial/refund evidence gate failed`)
    }

    const checkout = order.checkout as Row
    if (cents(checkout.AmountDiscount) !== 0
      || cents(checkout.ServiceCharges) !== 0
      || cents(checkout.DeliveryCharges) !== 0
      || cents(checkout.RefundAmount) !== 0
      || cents(checkout.TaxRefund) !== 0
      || cents(checkout.AmountTotal) + cents(checkout.Tax) !== cents(checkout.GrandTotal)) {
      throw new Error(`Order ${legacyOrderId} checkout arithmetic/policy failed`)
    }

    const items = order.itemEvidence as Row[]
    if (!items.length
      || items.length !== Number(order.itemRows)
      || items.some((item) => Number(item.Quantity) <= 0
        || cents(item.Price) <= 0
        || Number(item.exactHistoryPriceCount) !== 1
        || item.historyMatchesDetail !== true)) {
      throw new Error(`Order ${legacyOrderId} item/price-history gate failed`)
    }
    const itemSubtotalCents = items.reduce((sum, item) => sum + cents(item.Price), 0)
    if (itemSubtotalCents !== cents(checkout.AmountTotal)
      || itemSubtotalCents !== Number(order.detailSubtotalCents)
      || itemSubtotalCents !== Number(order.checkoutSubtotalCents)) {
      throw new Error(`Order ${legacyOrderId} item subtotal changed`)
    }

    const detail = order.rawDetail as Row
    const sourceUser = String(review["User Details"] ?? detail.LastUpdatedBy ?? "").trim()
    if (!sourceUser) throw new Error(`Order ${legacyOrderId} user evidence is missing`)
    const policy = legacyOrderId === 1155
      ? "USER_APPROVED_IN_PROCESS_AS_DELIVERED"
      : "USER_APPROVED_OUT_FOR_DELIVERY_AS_DELIVERED"
    const header = {
      ID: legacyOrderId,
      LocationID: Number(order.locationId),
      OrderNo: Number(detail.OrderNo),
      TransactionNo: detail.TransactionNo,
      OrderTakerID: Number(detail.OrderTakerID),
      StatusID: 2,
      DeliveryStatus: 507,
      GrandTotal: Number(checkout.GrandTotal),
      RefundAmount: 0,
      LocationName: String(order.branch),
      LocationGroup: String(review["Location Group"] ?? ""),
      UserDetails: sourceUser,
      CreatedOn: String(detail.OrderCreatedDT),
      LastUpdateDT: String(detail.LastUpdateDT ?? detail.OrderCreatedDT),
      OriginalStatusID: expectedStatus.statusId,
      OriginalDeliveryStatus: expectedStatus.deliveryStatus,
      MigrationStatusPolicy: policy,
      DeliveredPolicyApproval: "USER_EXPLICITLY_APPROVED_IMPORT_ON_2026-08-05",
    }
    headers.push(header)

    const preparedLines = items.map((item) => {
      const quantity = Number(item.Quantity)
      const unitPriceCents = Number(item.selectedHistoryUnitPriceCents)
      if (!Number.isSafeInteger(unitPriceCents)
        || unitPriceCents <= 0
        || unitPriceCents * quantity !== cents(item.Price)) {
        throw new Error(`Order ${legacyOrderId} item ${item.ID} unit-price reconciliation failed`)
      }
      return {
        ID: legacyOrderId,
        StatusID: 2,
        DeliveryStatus: 507,
        LocationID: Number(order.locationId),
        Location: String(order.branch),
        LocationGroup: String(review["Location Group"] ?? ""),
        RegistrationNo: String(review["Registration No(s)"] ?? ""),
        UserDetails: sourceUser,
        ItemDetails: String(item.Name),
        ItemQuantity: quantity,
        UnitPrice: unitPriceCents / 100,
        AmountTotal: Number(checkout.AmountTotal),
        AmountDiscount: 0,
        ServiceCharges: 0,
        Tax: Number(checkout.Tax),
        GrandTotal: Number(checkout.GrandTotal),
        OrderCreatedDT: String(detail.OrderCreatedDT),
        LastUpdateDT: String(detail.LastUpdateDT ?? detail.OrderCreatedDT),
        ItemId: Number(item.ItemId),
        ItemCode: item.ItemCode ?? null,
        LegacyItemRowID: Number(item.ID),
      }
    })
    sales.push(...preparedLines)
    history.push(...preparedLines.map((line) => ({
      Date: String(order.liveDate),
      ItemName: line.ItemDetails,
      Location: line.Location,
      LocationGroup: line.LocationGroup,
      Price: line.UnitPrice,
    })))
    evidence.push({
      legacyOrderId,
      approval: "User explicitly instructed that this safe/ready order be imported under the approved delivered policy.",
      migrationStatusPolicy: policy,
      originalStatus: { statusId: expectedStatus.statusId, deliveryStatus: expectedStatus.deliveryStatus },
      targetStatus: { status: "FULFILLED", fulfillmentStatus: "DELIVERED", paymentStatus: "UNPAID" },
      checkout: {
        subtotalCents: cents(checkout.AmountTotal),
        taxCents: cents(checkout.Tax),
        totalCents: cents(checkout.GrandTotal),
        refundCents: 0,
      },
      items: preparedLines.map((line) => ({
        legacyItemRowId: line.LegacyItemRowID,
        legacyItemId: line.ItemId,
        name: line.ItemDetails,
        quantity: line.ItemQuantity,
        unitPriceCents: cents(line.UnitPrice),
        lineTotalCents: cents(line.UnitPrice) * line.ItemQuantity,
      })),
    })
  }

  const uniqueHistory = [...new Map(history.map((row) => [
    `${row.Date}|${normalize(row.Location)}|${normalize(row.ItemName)}|${row.Price}`,
    row,
  ])).values()]
  const preparedIds = headers.map((row) => Number(row.ID)).sort((a, b) => a - b)
  if (JSON.stringify(preparedIds) !== JSON.stringify(EXPECTED_IDS)
    || sales.some((row) => !EXPECTED_IDS.includes(Number(row.ID)))) {
    throw new Error("Prepared order scope changed")
  }

  mkdirSync(REPORT_ROOT, { recursive: true })
  const files = {
    order: writeJson(resolve(REPORT_ROOT, "order.json"), headers),
    sales: writeJson(resolve(REPORT_ROOT, "sales-report.json"), sales),
    summary: writeJson(resolve(REPORT_ROOT, "user-product-summary-report.json"), []),
    history: writeJson(resolve(REPORT_ROOT, "item-price-history-report.json"), uniqueHistory),
    evidence: writeJson(resolve(OUTPUT_ROOT, "candidate-evidence.json"), evidence),
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    organization: { id: 10, code: "0001", name: "K-Electric" },
    candidateLegacyOrderIds: EXPECTED_IDS,
    explicitlyExcludedLegacyOrderIds: [173, 174, 177, 192, 1168, 1169, 1170, 1171, 1172, 1173, 1184],
    orders: headers.length,
    items: sales.length,
    subtotalCents: sales.reduce((sum, row) => sum + cents(row.UnitPrice) * Number(row.ItemQuantity), 0),
    taxCents: headers.reduce((sum, header) => {
      const line = sales.find((candidate) => Number(candidate.ID) === Number(header.ID))
      return sum + cents(line?.Tax)
    }, 0),
    totalCents: headers.reduce((sum, header) => sum + cents(header.GrandTotal), 0),
    policy: "USER_APPROVED_NONFINAL_NONREFUND_ORDERS_AS_FULFILLED_DELIVERED",
    sourceMutations: 0,
    productionDatabaseChanges: 0,
    provenance: {
      audit: AUDIT_PATH,
      review: REVIEW_PATH,
      prePolicyRemaining: PRE_POLICY_PATH,
      postPolicyRemaining: POST_POLICY_PATH,
    },
    files,
  }
  const manifestFile = writeJson(resolve(OUTPUT_ROOT, "candidate-manifest.json"), manifest)
  console.log(JSON.stringify({ outputRoot: OUTPUT_ROOT, reportRoot: REPORT_ROOT, ...manifest, manifestFile }, null, 2))
}

main()
