import { readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import * as dotenv from "dotenv"
import {
  KE_ORGANIZATION,
  LEGACY_SOURCE,
  prepareKeLegacySource,
  rejectionCounts,
  toCents,
  type LegacyOrder,
  type LegacySaleLine,
} from "../lib/legacy-import/ke-electric"
import { createCsv } from "../lib/spreadsheet"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const OUTPUT_JSON = resolve("reports/ke-import-exclusion-report.json")
const OUTPUT_CSV = resolve("reports/ke-import-exclusions.csv")
const OUTPUT_MD = resolve("reports/ke-import-exclusion-report.md")

type ExclusionReason =
  | "NOT_DELIVERED"
  | "HAS_REFUND"
  | "ITEM_SUBTOTAL_MISMATCH"
  | "UNRESOLVED_ITEM_PRICE"
  | "MISSING_ORDER_HEADER"

interface ExclusionRow {
  legacyOrderId: number
  primaryReason: ExclusionReason
  statusLabel: string
  statusId: number | null
  deliveryStatus: number | null
  createdAt: string | null
  branch: string
  group: string
  user: string
  legacyOrderTakerId: number | null
  salesLineCount: number
  reportedSubtotalCents: number
  rawUnitSubtotalCents: number
  subtotalDifferenceCents: number
  taxCents: number
  grandTotalCents: number
  refundCents: number
  explanation: string
  requiredEvidence: string
}

function statusLabel(statusId: number | null, deliveryStatus: number | null): string {
  if (statusId === 4 && deliveryStatus === 508) return "Cancelled"
  if (statusId === 4) return "Refunded"
  if (statusId === 5) return "Cancelled"
  if ((statusId === 1 || statusId === 2) && deliveryStatus === 501) return "Order Placed"
  if (statusId === 2 && deliveryStatus === 503) return "In Process"
  if (statusId === 2 && deliveryStatus === 505) return "Partial Delivery"
  if (statusId === 2 && deliveryStatus === 506) return "Out For Delivery"
  if (statusId === 2 && deliveryStatus === 507) return "Delivered"
  if (statusId === 9) return "Unknown Legacy Status 9"
  return `Unknown (${statusId ?? "null"}/${deliveryStatus ?? "null"})`
}

function explanation(reason: ExclusionReason, status: string): { explanation: string; requiredEvidence: string } {
  if (reason === "HAS_REFUND") return {
    explanation: "The order is marked delivered but carries a refund amount. Refunds were explicitly excluded, and the legacy refund report contains no item-level refund data.",
    requiredEvidence: "An authoritative refund report identifying refunded products, quantities, amounts, approval status, and refund date.",
  }
  if (reason === "ITEM_SUBTOTAL_MISMATCH") return {
    explanation: "The defensible item quantities and historical prices do not add up to the order's reported subtotal. Importing it would make order and product revenue disagree.",
    requiredEvidence: "An authoritative invoice or item-level export showing the final charged unit price for every line.",
  }
  if (reason === "UNRESOLVED_ITEM_PRICE") return {
    explanation: "At least one item has no single defensible historical unit price; the available price reports are missing or conflicting, and the order residual cannot resolve it exactly.",
    requiredEvidence: "A reviewed, order-specific unit-price mapping or original invoice for the unresolved lines.",
  }
  if (reason === "MISSING_ORDER_HEADER") return {
    explanation: "Sales lines exist, but order.json has no authoritative order header. These records use unknown legacy StatusID 9 and cannot be assigned a trustworthy app order state.",
    requiredEvidence: "The original order header containing final status, branch, creator, timestamps, subtotal, tax, total, and refund state.",
  }
  if (status === "Partial Delivery") return {
    explanation: "The order was only partially delivered, but the exports do not identify the final delivered quantity per item. Treating all lines as fulfilled would overstate product quantities and revenue.",
    requiredEvidence: "Final delivered and undelivered quantity per item, plus the final charged total.",
  }
  if (status === "Refunded") return {
    explanation: "The order is in a refunded state. Refunds were intentionally excluded and the legacy refund report contains no usable detail.",
    requiredEvidence: "Complete original order items plus authoritative item-level refund records.",
  }
  if (status === "Cancelled") return {
    explanation: "The order was cancelled and generally has no reliable sale lines. Importing it as fulfilled would inflate orders, quantities, and revenue.",
    requiredEvidence: "Only needed if cancelled audit events must be migrated; they must remain non-revenue cancelled records in a supported app state.",
  }
  return {
    explanation: "The order was not in the final Delivered state at export time. Importing an active workflow order as historical fulfilled data would invent fulfillment and alter reporting semantics.",
    requiredEvidence: "A later authoritative export proving final status and final item-level quantities/prices.",
  }
}

function rupees(cents: number): string {
  return `Rs ${(cents / 100).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function percent(count: number, total: number): string {
  return `${((count / total) * 100).toFixed(2)}%`
}

async function main() {
  const source = prepareKeLegacySource()
  const orders = JSON.parse(readFileSync(resolve("reports/order.json"), "utf8")) as LegacyOrder[]
  const sales = JSON.parse(readFileSync(resolve("reports/sales-report.json"), "utf8")) as LegacySaleLine[]
  const productSummary = JSON.parse(readFileSync(resolve("reports/user-product-summary-report.json"), "utf8")) as Array<Record<string, unknown>>
  const ordersById = new Map(orders.map((order) => [Number(order.ID), order]))
  const salesById = new Map<number, LegacySaleLine[]>()
  for (const line of sales) {
    const id = Number(line.ID)
    salesById.set(id, [...(salesById.get(id) ?? []), line])
  }
  const rejectionById = new Map(source.rejected.map((rejection) => [rejection.legacyOrderId, rejection.reason as ExclusionReason]))

  const { pool } = await import("../lib/db-cli")
  const batchResult = await pool.query(`
    select id, source_manifest, counts, imported_by_user_id, created_at, completed_at
    from legacy_import_batches
    where organization_id = $1 and source_system = $2 and status = 'COMPLETED'
    order by completed_at desc
    limit 1
  `, [KE_ORGANIZATION.id, LEGACY_SOURCE])
  if (batchResult.rows.length !== 1) throw new Error("Completed K-Electric legacy import batch not found")
  const batch = batchResult.rows[0]
  const importedResult = await pool.query(`
    select legacy_order_id
    from legacy_order_imports
    where batch_id = $1 and organization_id = $2 and source_system = $3
    order by legacy_order_id
  `, [batch.id, KE_ORGANIZATION.id, LEGACY_SOURCE])
  await pool.end()
  const importedIds = new Set(importedResult.rows.map((row) => Number(row.legacy_order_id)))

  const unionIds = new Set([...ordersById.keys(), ...salesById.keys()])
  const exclusions: ExclusionRow[] = []
  for (const legacyOrderId of [...unionIds].sort((a, b) => a - b)) {
    if (importedIds.has(legacyOrderId)) continue
    const header = ordersById.get(legacyOrderId)
    const lines = salesById.get(legacyOrderId) ?? []
    const firstLine = lines[0]
    const reason = header ? rejectionById.get(legacyOrderId) : "MISSING_ORDER_HEADER"
    if (!reason) throw new Error(`Legacy order ${legacyOrderId} is neither imported nor classified`)
    const statusId = Number(header?.StatusID ?? firstLine?.StatusID)
    const deliveryStatus = Number(header?.DeliveryStatus ?? firstLine?.DeliveryStatus)
    const safeStatusId = Number.isFinite(statusId) ? statusId : null
    const safeDeliveryStatus = Number.isFinite(deliveryStatus) ? deliveryStatus : null
    const status = statusLabel(safeStatusId, safeDeliveryStatus)
    const reportedSubtotalCents = firstLine ? toCents(firstLine.AmountTotal) : 0
    const rawUnitSubtotalCents = lines.reduce((sum, line) => sum + Math.round(Number(line.ItemQuantity) * toCents(line.UnitPrice)), 0)
    const details = explanation(reason, status)
    exclusions.push({
      legacyOrderId,
      primaryReason: reason,
      statusLabel: status,
      statusId: safeStatusId,
      deliveryStatus: safeDeliveryStatus,
      createdAt: String(header?.CreatedOn ?? firstLine?.OrderCreatedDT ?? "") || null,
      branch: String(header?.LocationName ?? firstLine?.Location ?? ""),
      group: String(header?.LocationGroup ?? firstLine?.LocationGroup ?? ""),
      user: String(header?.UserDetails ?? firstLine?.UserDetails ?? "").trim(),
      legacyOrderTakerId: Number.isFinite(Number(header?.OrderTakerID ?? firstLine?.OrderTakerID)) ? Number(header?.OrderTakerID ?? firstLine?.OrderTakerID) : null,
      salesLineCount: lines.length,
      reportedSubtotalCents,
      rawUnitSubtotalCents,
      subtotalDifferenceCents: rawUnitSubtotalCents - reportedSubtotalCents,
      taxCents: firstLine ? toCents(firstLine.Tax) : 0,
      grandTotalCents: toCents(header?.GrandTotal ?? firstLine?.GrandTotal ?? 0),
      refundCents: toCents(header?.RefundAmount ?? 0),
      explanation: details.explanation,
      requiredEvidence: details.requiredEvidence,
    })
  }

  const expectedExcludedHeaders = orders.length - importedIds.size
  const orphanSalesOnly = exclusions.filter((row) => row.primaryReason === "MISSING_ORDER_HEADER")
  if (exclusions.length !== expectedExcludedHeaders + orphanSalesOnly.length) throw new Error("Exclusion accounting invariant failed")
  if (importedIds.size !== source.prepared.length) throw new Error("Imported count does not match safe source count")
  if (rejectionCounts(source.rejected).NOT_DELIVERED !== 164) throw new Error("Source exclusion snapshot changed")

  const reasonOrder: ExclusionReason[] = ["NOT_DELIVERED", "HAS_REFUND", "ITEM_SUBTOTAL_MISMATCH", "UNRESOLVED_ITEM_PRICE", "MISSING_ORDER_HEADER"]
  const reasonSummary = reasonOrder.map((reason) => {
    const rows = exclusions.filter((row) => row.primaryReason === reason)
    return {
      reason,
      count: rows.length,
      grandTotalCents: rows.reduce((sum, row) => sum + row.grandTotalCents, 0),
      refundCents: rows.reduce((sum, row) => sum + row.refundCents, 0),
      legacyOrderIds: rows.map((row) => row.legacyOrderId),
    }
  })
  const statusSummary = [...new Set(exclusions.map((row) => row.statusLabel))]
    .map((status) => {
      const rows = exclusions.filter((row) => row.statusLabel === status)
      return { status, count: rows.length, grandTotalCents: rows.reduce((sum, row) => sum + row.grandTotalCents, 0) }
    })
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status))

  const importedTotals = source.prepared.reduce((totals, order) => ({
    orders: totals.orders + 1,
    items: totals.items + order.lines.length,
    quantity: totals.quantity + order.lines.reduce((sum, line) => sum + line.quantity, 0),
    subtotalCents: totals.subtotalCents + order.subtotalCents,
    taxCents: totals.taxCents + order.taxCents,
    totalCents: totals.totalCents + order.totalCents,
  }), { orders: 0, items: 0, quantity: 0, subtotalCents: 0, taxCents: 0, totalCents: 0 })

  const report = {
    generatedAt: new Date().toISOString(),
    organization: KE_ORGANIZATION,
    batch: {
      id: batch.id,
      manifestDigest: batch.source_manifest?.digest,
      importedByUserId: batch.imported_by_user_id,
      createdAt: batch.created_at,
      completedAt: batch.completed_at,
    },
    accounting: {
      uniqueLegacyOrderIdsAcrossHeadersAndSales: unionIds.size,
      orderHeaders: orders.length,
      importedOrderHeaders: importedIds.size,
      excludedOrderHeaders: expectedExcludedHeaders,
      salesOnlyOrphanOrderIds: orphanSalesOnly.length,
      totalNotImportedUniqueIds: exclusions.length,
      everyLegacyIdAccountedFor: importedIds.size + exclusions.length === unionIds.size,
    },
    importedTotals,
    reasonSummary,
    statusSummary,
    otherSourceDataNotImported: {
      refundReport: "Empty; refunds intentionally skipped.",
      budgets: "Not imported because the export has no reliable allocation tenure and live budgets must remain unchanged.",
      stock: "Not imported because it is current operational state, not historical order evidence.",
      zeroQuantityProductSummaryArtifacts: productSummary.filter((row) => Number(row.Item_Qty ?? 0) <= 0).length,
      usersJsonBytes: readFileSync(resolve("reports/users.json")).byteLength,
    },
    exclusions,
  }
  writeFileSync(OUTPUT_JSON, `${JSON.stringify(report, null, 2)}\n`, "utf8")

  const csvHeaders = [
    "LegacyOrderId", "PrimaryReason", "Status", "StatusID", "DeliveryStatus", "CreatedAt", "Branch", "Group", "User",
    "LegacyOrderTakerId", "SalesLineCount", "ReportedSubtotalRs", "RawUnitSubtotalRs", "SubtotalDifferenceRs", "TaxRs",
    "GrandTotalRs", "RefundRs", "Explanation", "RequiredEvidence",
  ]
  const csvRows = exclusions.map((row) => [
    row.legacyOrderId, row.primaryReason, row.statusLabel, row.statusId, row.deliveryStatus, row.createdAt, row.branch, row.group, row.user,
    row.legacyOrderTakerId, row.salesLineCount, (row.reportedSubtotalCents / 100).toFixed(2), (row.rawUnitSubtotalCents / 100).toFixed(2),
    (row.subtotalDifferenceCents / 100).toFixed(2), (row.taxCents / 100).toFixed(2), (row.grandTotalCents / 100).toFixed(2),
    (row.refundCents / 100).toFixed(2), row.explanation, row.requiredEvidence,
  ])
  writeFileSync(OUTPUT_CSV, `${createCsv(csvHeaders, csvRows)}\r\n`, "utf8")

  const reasonDescriptions: Record<ExclusionReason, string> = {
    NOT_DELIVERED: "The header was not in final Delivered state. This includes active, partial, cancelled, and refunded workflow states.",
    HAS_REFUND: "The order was delivered but has a refund amount; item-level refund evidence is unavailable and refunds were explicitly skipped.",
    ITEM_SUBTOTAL_MISMATCH: "Defensible item-level values do not reconcile to the reported order subtotal.",
    UNRESOLVED_ITEM_PRICE: "One or more final charged unit prices cannot be established without guessing.",
    MISSING_ORDER_HEADER: "Sales rows exist without a matching authoritative order header.",
  }
  const md: string[] = [
    "# K-Electric Legacy Import - Excluded Data Report",
    "",
    `Generated: ${report.generatedAt}`,
    `Import batch: \`${batch.id}\`  `,
    `Source manifest: \`${batch.source_manifest?.digest}\``,
    "",
    "## Executive summary",
    "",
    `Across the two order-bearing exports there are **${unionIds.size} unique legacy order IDs**. **${importedIds.size} (${percent(importedIds.size, unionIds.size)})** were imported and **${exclusions.length} (${percent(exclusions.length, unionIds.size)})** were not imported. No legacy ID was silently dropped.`,
    "",
    `Of the ${orders.length} authoritative order headers, ${importedIds.size} were imported and ${expectedExcludedHeaders} were excluded. Another ${orphanSalesOnly.length} IDs occur only in sales-report.json and have no order header.`,
    "",
    "| Outcome | Orders | Notes |",
    "|---|---:|---|",
    `| Imported | ${importedIds.size} | Final delivered, no refund, exact item/order financial reconciliation |`,
    `| Excluded order headers | ${expectedExcludedHeaders} | Classified by the reasons below |`,
    `| Sales-only orphan IDs | ${orphanSalesOnly.length} | No authoritative order header; not part of the 805 headers |`,
    `| **Unique legacy IDs** | **${unionIds.size}** | Imported + all exclusions |`,
    "",
    "## Why records were excluded",
    "",
    "| Primary reason | Count | Share of all legacy IDs | Legacy reported total* | Explanation |",
    "|---|---:|---:|---:|---|",
    ...reasonSummary.map((summary) => `| ${summary.reason} | ${summary.count} | ${percent(summary.count, unionIds.size)} | ${rupees(summary.grandTotalCents)} | ${reasonDescriptions[summary.reason]} |`),
    "",
    "\* Excluded totals are informational legacy header values. They are not all valid sale revenue; for example, cancelled and refunded headers are included.",
    "",
    "## Excluded workflow-status breakdown",
    "",
    "| Legacy status interpretation | Count | Legacy reported total* |",
    "|---|---:|---:|",
    ...statusSummary.map((summary) => `| ${summary.status} | ${summary.count} | ${rupees(summary.grandTotalCents)} |`),
    "",
    "## Successfully imported baseline",
    "",
    `- Orders: ${importedTotals.orders}`,
    `- Order-item rows: ${importedTotals.items}`,
    `- Fulfilled quantity: ${importedTotals.quantity}`,
    `- Product subtotal: ${rupees(importedTotals.subtotalCents)}`,
    `- Tax: ${rupees(importedTotals.taxCents)}`,
    `- Grand total: ${rupees(importedTotals.totalCents)}`,
    "",
    "## Other source data intentionally not written",
    "",
    "- Refund report: empty. Refunds were excluded by request and cannot be reconstructed safely without item-level refund evidence.",
    "- Budget export: not imported because it does not provide reliable allocation tenure; current production budgets were deliberately left unchanged.",
    "- Stock export: not imported because current stock is operational state and historical orders must not alter it.",
    `- Product-summary zero-quantity artifacts: ${report.otherSourceDataNotImported.zeroQuantityProductSummaryArtifacts} rows were ignored as price evidence.`,
    `- users.json: ${report.otherSourceDataNotImported.usersJsonBytes} bytes, so it supplied no additional user data.`,
    "- Product categories: the exports do not contain a trustworthy category mapping; newly created historical products remain Uncategorized/inactive.",
    "",
    "## Row-level evidence",
    "",
    `The complete ${exclusions.length}-row evidence table is in [ke-import-exclusions.csv](./ke-import-exclusions.csv). The machine-readable report is [ke-import-exclusion-report.json](./ke-import-exclusion-report.json).`,
    "",
    "### Legacy IDs by primary reason",
    "",
    ...reasonSummary.flatMap((summary) => [
      `- **${summary.reason} (${summary.count})**: ${summary.legacyOrderIds.join(", ") || "None"}`,
      "",
    ]),
  ]
  writeFileSync(OUTPUT_MD, `${md.join("\n")}\n`, "utf8")

  console.log(JSON.stringify({
    batchId: batch.id,
    imported: importedIds.size,
    excludedHeaders: expectedExcludedHeaders,
    salesOnlyOrphans: orphanSalesOnly.length,
    exclusions: exclusions.length,
    unionIds: unionIds.size,
    reasonSummary,
    outputs: { markdown: OUTPUT_MD, csv: OUTPUT_CSV, json: OUTPUT_JSON },
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
