import { mkdirSync, readFileSync, writeFileSync } from "fs"
import { dirname, relative, resolve } from "path"
import { pathToFileURL } from "url"

type JsonRow = Record<string, unknown>

interface Category {
  code: string
  title: string
  reason: string
  requiredEvidence: string
  legacyOrderIds: number[]
  details?: Record<string, unknown>
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T
}

function numericIds(rows: JsonRow[]): Set<number> {
  return new Set(rows.map((row) => Number(row.ID)).filter(Number.isSafeInteger))
}

function sorted(values: Iterable<number>): number[] {
  return [...values].sort((a, b) => a - b)
}

function intersect(values: Iterable<number>, allowed: Set<number>): number[] {
  return sorted([...values].filter((value) => allowed.has(value)))
}

function subtract(values: Iterable<number>, excluded: Set<number>): number[] {
  return sorted([...values].filter((value) => !excluded.has(value)))
}

function stableRow(row: JsonRow): string {
  return JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key]]))
}

function multisetDifference(left: JsonRow[], right: JsonRow[]): JsonRow[] {
  const counts = new Map<string, number>()
  for (const row of right) {
    const key = stableRow(row)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }

  return left.filter((row) => {
    const key = stableRow(row)
    const count = counts.get(key) ?? 0
    if (count === 0) return true
    counts.set(key, count - 1)
    return false
  })
}

function countBy<T>(values: T[], key: (value: T) => string): Record<string, number> {
  return Object.fromEntries(
    [...values.reduce((counts, value) => {
      const label = key(value)
      counts.set(label, (counts.get(label) ?? 0) + 1)
      return counts
    }, new Map<string, number>())].sort(([a], [b]) => a.localeCompare(b)),
  )
}

function formatIds(ids: number[]): string {
  return ids.join(", ")
}

async function main() {
const repoRoot = process.cwd()
const reportDate = "2026-07-23"
const updatedReports = resolve(repoRoot, "reports/updatedReports")
const investigationRoot = resolve(repoRoot, "tmp/ke-updated-investigation")
const normalizedReports = resolve(investigationRoot, "reports")
const batchDirectory = resolve(updatedReports, `ke-safe-import-${reportDate}`)
const outputJson = resolve(updatedReports, `ke-remaining-orders-report-${reportDate}.json`)
const outputMarkdown = resolve(updatedReports, `ke-remaining-orders-report-${reportDate}.md`)

const oldOrders = readJson<JsonRow[]>(resolve(repoRoot, "reports/order.json"))
const oldSales = readJson<JsonRow[]>(resolve(repoRoot, "reports/sales-report.json"))
const exclusionReport = readJson<{ exclusions: Array<{ legacyOrderId: number }> }>(
  resolve(repoRoot, "reports/ke-import-exclusion-report.json"),
)
const liveValidation = readJson<{
  generatedAt: string
  status: string
  candidateIds: number[]
  cumulative: {
    orders: number
    imports: number
    distinct_ids: number
    distinct_orders: number
  }
}>(resolve(batchDirectory, "post-import-validation.json"))
const updatedHeaders = readJson<JsonRow[]>(resolve(normalizedReports, "order.json"))
const updatedSales = readJson<JsonRow[]>(resolve(normalizedReports, "sales-report.json"))
const refundRows = readJson<JsonRow[]>(resolve(updatedReports, "refundReport.json"))
const productSummary = readJson<JsonRow[]>(resolve(updatedReports, "productSummery.json"))
const userProductSummary = readJson<JsonRow[]>(resolve(updatedReports, "UserProductSummary.json"))

const priorExcludedIds = new Set(exclusionReport.exclusions.map((row) => Number(row.legacyOrderId)))
const originalImportedIds = subtract(numericIds(oldOrders), priorExcludedIds)
const incrementalImportedIds = sorted(liveValidation.candidateIds.map(Number))
const importedIds = new Set([...originalImportedIds, ...incrementalImportedIds])
const knownLegacyIds = new Set([...numericIds(oldOrders), ...numericIds(oldSales)])
const remainingIds = subtract(knownLegacyIds, importedIds)
const remainingSet = new Set(remainingIds)

if (liveValidation.status !== "PASS") {
  throw new Error(`Live post-import validation is not PASS: ${liveValidation.status}`)
}
if (knownLegacyIds.size !== 811) {
  throw new Error(`Expected 811 known legacy order IDs, found ${knownLegacyIds.size}`)
}
if (importedIds.size !== 645 || liveValidation.cumulative.distinct_ids !== 645) {
  throw new Error(
    `Expected 645 imported IDs, calculated ${importedIds.size} and live validation reports ${liveValidation.cumulative.distinct_ids}`,
  )
}
if (remainingIds.length !== 166) {
  throw new Error(`Expected 166 remaining legacy order IDs, found ${remainingIds.length}`)
}

const previousCwd = process.cwd()
const sourcePreparation = await (async () => {
  process.chdir(investigationRoot)
  try {
    const legacyImportModule = await import(
      pathToFileURL(resolve(repoRoot, "lib/legacy-import/ke-electric.ts")).href
    )
    return legacyImportModule.prepareKeLegacySource()
  } finally {
    process.chdir(previousCwd)
  }
})()

const preparedRemainingIds = intersect(
  sourcePreparation.prepared.map((order: { legacyOrderId: number }) => order.legacyOrderId),
  remainingSet,
)
const zeroQuantityIds = intersect(
  sourcePreparation.prepared
    .filter((order: {
      legacyOrderId: number
      sourceLines: Array<{ ItemQuantity: number }>
    }) => order.sourceLines.some((line) => Number(line.ItemQuantity) <= 0))
    .map((order: { legacyOrderId: number }) => order.legacyOrderId),
  remainingSet,
)
if (
  zeroQuantityIds.length !== preparedRemainingIds.length
  || zeroQuantityIds.some((id, index) => id !== preparedRemainingIds[index])
) {
  throw new Error(
    `Remaining prepared orders do not exactly match zero-quantity cases: prepared=${preparedRemainingIds.join(",")}, zeroQuantity=${zeroQuantityIds.join(",")}`,
  )
}
const rejectionReasonById = new Map<number, string>(
  sourcePreparation.rejected.map((rejection: { legacyOrderId: number; reason: string }) => [
    rejection.legacyOrderId,
    rejection.reason,
  ]),
)
const updatedHeaderIds = numericIds(updatedHeaders)
const updatedSalesIds = numericIds(updatedSales)
const refundIds = new Set(intersect(numericIds(refundRows), remainingSet))

const statusById = new Map(
  updatedHeaders.map((row) => [
    Number(row.ID),
    `${Number(row.StatusID)}/${Number(row.DeliveryStatus)}`,
  ]),
)
const workflowIds = remainingIds.filter(
  (id) => rejectionReasonById.get(id) === "NOT_DELIVERED" && !refundIds.has(id),
)
const workflowStatusBreakdown = countBy(workflowIds, (id) => statusById.get(id) ?? "missing")

const categories: Category[] = [
  {
    code: "WORKFLOW_NOT_FINAL",
    title: "Final delivered status is not confirmed",
    reason:
      "The authoritative header is not in the only normal fulfilled state accepted by the importer (StatusID 2 and DeliveryStatus 507).",
    requiredEvidence:
      "A corrected authoritative order header proving the order reached final delivered status, or a separate migration policy for non-fulfilled orders.",
    legacyOrderIds: workflowIds,
    details: {
      statusIdDeliveryStatusBreakdown: workflowStatusBreakdown,
    },
  },
  {
    code: "HAS_REFUND_EVIDENCE",
    title: "Refund activity exists",
    reason:
      "The refund report identifies the order. Importing it as an ordinary fulfilled sale would overstate sales and lose the refund history.",
    requiredEvidence:
      "A refund-aware migration design with authoritative item, refund amount, timestamp, and final-state evidence.",
    legacyOrderIds: intersect(refundIds, remainingSet),
  },
  {
    code: "ITEM_SUBTOTAL_MISMATCH",
    title: "Item prices and quantities do not reconcile to the subtotal",
    reason:
      "The reconstructed sum of item price multiplied by quantity differs from the authoritative order subtotal.",
    requiredEvidence:
      "Corrected line-level quantity and unit-price evidence that reconciles exactly to the order subtotal.",
    legacyOrderIds: remainingIds.filter(
      (id) => rejectionReasonById.get(id) === "ITEM_SUBTOTAL_MISMATCH",
    ),
  },
  {
    code: "UNRESOLVED_ITEM_PRICE",
    title: "A trustworthy item price cannot be resolved",
    reason:
      "Available reports conflict or do not contain enough evidence to select an exact unit price without guessing.",
    requiredEvidence:
      "A consistent authoritative unit price for every item line, with totals that reconcile to the header.",
    legacyOrderIds: remainingIds.filter(
      (id) => rejectionReasonById.get(id) === "UNRESOLVED_ITEM_PRICE",
    ),
  },
  {
    code: "OMITTED_FROM_UPDATED_ORDER_EXPORT",
    title: "Previously known order is omitted from both updated order and sales exports",
    reason:
      "The legacy ID existed in the earlier reports but disappeared from the updated authoritative order and sales data.",
    requiredEvidence:
      "A synchronized export containing the authoritative header and item lines for the missing legacy ID.",
    legacyOrderIds: remainingIds.filter(
      (id) => !updatedHeaderIds.has(id) && !updatedSalesIds.has(id),
    ),
  },
  {
    code: "MISSING_AUTHORITATIVE_ORDER_HEADER",
    title: "Sales lines exist but the authoritative order header is missing",
    reason:
      "The sales export contains the legacy ID, but the updated order export has no matching header with final status, totals, refund state, and timestamps.",
    requiredEvidence:
      "The original authoritative order header matching the existing sales lines.",
    legacyOrderIds: remainingIds.filter(
      (id) => !updatedHeaderIds.has(id) && updatedSalesIds.has(id),
    ),
  },
  {
    code: "ZERO_QUANTITY_ITEM_LINES",
    title: "Order contains zero-quantity item lines",
    reason:
      "The reports otherwise reconcile, but importing a zero-quantity order line would create a misleading order record.",
    requiredEvidence:
      "A corrected line export with positive quantities, or explicit approval and a documented rule to remove zero-quantity artifacts before import.",
    legacyOrderIds: zeroQuantityIds,
  },
  {
    code: "NO_ITEM_LINES",
    title: "Authoritative header has no item lines",
    reason:
      "The order header exists, but no matching item detail is available to construct the order.",
    requiredEvidence:
      "The complete line-level sales report for the legacy order.",
    legacyOrderIds: remainingIds.filter(
      (id) => rejectionReasonById.get(id) === "NO_ITEM_LINES",
    ),
  },
]

for (const category of categories) category.legacyOrderIds = sorted(category.legacyOrderIds)

const classifiedIds = new Set<number>()
for (const category of categories) {
  for (const id of category.legacyOrderIds) {
    if (classifiedIds.has(id)) {
      throw new Error(`Legacy order ${id} appears in more than one category`)
    }
    classifiedIds.add(id)
  }
}
const unclassified = subtract(remainingIds, classifiedIds)
const unexpected = subtract(classifiedIds, remainingSet)
if (classifiedIds.size !== 166 || unclassified.length > 0 || unexpected.length > 0) {
  throw new Error(
    `Classification coverage failed: classified=${classifiedIds.size}, unclassified=${unclassified.join(",")}, unexpected=${unexpected.join(",")}`,
  )
}

const summaryOnlyRows = multisetDifference(productSummary, userProductSummary)
const summaryOnlyGroups = new Set(
  summaryOnlyRows.map((row) =>
    [
      row.Location,
      row.RegistrationNo,
      row.UserName,
      row.OrderCreatedDT,
      row.OrderStatus,
    ].join("|"),
  ),
)
const summaryOnlyDates = summaryOnlyRows.map((row) => String(row.OrderCreatedDT)).sort()
const summaryOnly = {
  rows: summaryOnlyRows.length,
  pseudoOrderGroups: summaryOnlyGroups.size,
  rowStatusBreakdown: countBy(summaryOnlyRows, (row) => String(row.OrderStatus)),
  groupStatusBreakdown: countBy([...summaryOnlyGroups], (group) => group.split("|").at(-1) ?? ""),
  dateRange: {
    from: summaryOnlyDates.at(0),
    to: summaryOnlyDates.at(-1),
  },
  includedInKnownRemainingOrderCount: false,
  reason:
    "These product-summary rows have no legacy order ID and no authoritative order header or complete order-level totals. A location/user/date/status grouping is not guaranteed to represent one order.",
}

if (
  summaryOnly.rows !== 213
  || summaryOnly.pseudoOrderGroups !== 16
  || summaryOnly.rowStatusBreakdown.Delivered !== 68
) {
  throw new Error(`Unexpected later summary-only activity: ${JSON.stringify(summaryOnly)}`)
}

const generatedAt = new Date().toISOString()
const report = {
  kind: "KE_ELECTRIC_REMAINING_LEGACY_ORDERS",
  generatedAt,
  reportDate,
  organization: {
    id: 10,
    code: "0001",
    name: "K-Electric",
  },
  evidence: {
    livePostImportValidation: relative(repoRoot, resolve(batchDirectory, "post-import-validation.json")),
    liveValidationGeneratedAt: liveValidation.generatedAt,
    normalizedUpdatedOrders: relative(repoRoot, resolve(normalizedReports, "order.json")),
    normalizedUpdatedSales: relative(repoRoot, resolve(normalizedReports, "sales-report.json")),
    refundReport: relative(repoRoot, resolve(updatedReports, "refundReport.json")),
  },
  counts: {
    knownLegacyOrderIds: knownLegacyIds.size,
    importedLegacyOrderIds: importedIds.size,
    importedBeforeIncrementalBatch: originalImportedIds.length,
    importedInIncrementalBatch: incrementalImportedIds.length,
    remainingNotSafeToImport: remainingIds.length,
  },
  categories: categories.map((category) => ({
    ...category,
    count: category.legacyOrderIds.length,
  })),
  laterSummaryOnlyActivity: summaryOnly,
  conclusion:
    "No ID in this report is safe to import as a normal fulfilled K-Electric order using the current evidence.",
}

const markdown = `# K-Electric remaining legacy orders report

Generated: ${generatedAt}

## Executive summary

The known legacy universe contains **${knownLegacyIds.size} unique order IDs**. The verified live K-Electric import ledger contains **${importedIds.size} unique IDs** (${originalImportedIds.length} from the original import plus ${incrementalImportedIds.length} from the safe incremental batch). Therefore, **${remainingIds.length} known legacy orders remain and are not safe to import with the current evidence**.

| Exclusive blocker | Orders |
|---|---:|
${categories.map((category) => `| ${category.title} | ${category.legacyOrderIds.length} |`).join("\n")}
| **Total** | **${remainingIds.length}** |

The categories are mutually exclusive: every one of the ${remainingIds.length} remaining legacy IDs appears exactly once.

## Reasons and exact legacy IDs

${categories.map((category) => `### ${category.title} — ${category.legacyOrderIds.length}

**Reason:** ${category.reason}

**Needed before import:** ${category.requiredEvidence}
${category.details ? `\n**Detail:** StatusID/DeliveryStatus breakdown: ${Object.entries(category.details.statusIdDeliveryStatusBreakdown as Record<string, number>).map(([status, count]) => `${status} = ${count}`).join(", ")}.\n` : ""}
**Legacy order IDs:** ${formatIds(category.legacyOrderIds)}
`).join("\n")}
## Later summary-only activity is not included in the 166-order count

\`productSummery.json\` contains ${summaryOnly.rows} rows dated ${summaryOnly.dateRange.from} through ${summaryOnly.dateRange.to} that are not present in \`UserProductSummary.json\`. They can be grouped into ${summaryOnly.pseudoOrderGroups} location/user/date/status combinations, but those are only analytical groupings—not authoritative orders.

- Row statuses: ${Object.entries(summaryOnly.rowStatusBreakdown).map(([status, count]) => `${status} ${count}`).join(", ")}.
- Group statuses: ${Object.entries(summaryOnly.groupStatusBreakdown).map(([status, count]) => `${status} ${count}`).join(", ")}.
- They have no legacy order ID, authoritative header, or complete order-level totals, so they cannot be counted or imported as exact orders.

## Conclusion

None of these ${remainingIds.length} identified legacy IDs should be imported as a normal fulfilled K-Electric order using the current evidence. The three zero-quantity cases are closest to importable, but they still require corrected quantities or an explicitly approved cleanup policy. Refund and non-final workflow records require a separate migration treatment rather than the normal fulfilled-order importer.

Evidence: \`${report.evidence.livePostImportValidation}\`, \`${report.evidence.normalizedUpdatedOrders}\`, \`${report.evidence.normalizedUpdatedSales}\`, and \`${report.evidence.refundReport}\`.
`

mkdirSync(dirname(outputJson), { recursive: true })
writeFileSync(outputJson, `${JSON.stringify(report, null, 2)}\n`, "utf8")
writeFileSync(outputMarkdown, markdown, "utf8")

console.log(JSON.stringify({
  outputJson,
  outputMarkdown,
  counts: report.counts,
  categories: report.categories.map(({ code, count }) => ({ code, count })),
  laterSummaryOnlyActivity: summaryOnly,
}, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
