import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const ROOT = process.cwd()
const UPDATED = path.join(ROOT, "updatedReports")
const RUN_DATE = "2026-08-03"

async function json(relativePath) {
  return JSON.parse(await readFile(path.join(ROOT, relativePath), "utf8"))
}

function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en").replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim()
}

function distinct(rows, key) {
  return new Set(rows.map((row) => normalize(row[key])).filter(Boolean)).size
}

function distribution(rows, key) {
  const map = new Map()
  for (const row of rows) {
    const label = String(row[key] ?? "<null>").trim() || "<empty>"
    map.set(label, (map.get(label) || 0) + 1)
  }
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function dateRange(rows, key) {
  const values = rows.map((row) => row[key]).filter((value) => Number.isFinite(Date.parse(value))).sort()
  return { earliest: values[0] || null, latest: values.at(-1) || null }
}

function money(value) {
  return `Rs ${Number(value || 0).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function table(headers, rows) {
  return [
    `| ${headers.join(" | ")} |`,
    `|${headers.map(() => "---").join("|")}|`,
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n")
}

function uniqueOrderSummary(rows) {
  const groups = new Map()
  for (const row of rows) {
    const key = String(row.ID)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(row)
  }
  const orders = [...groups.values()].map((lines) => {
    const first = lines[0]
    const lineSubtotal = lines.reduce((sum, line) => sum + Number(line.ItemQuantity || 0) * Number(line.UnitPrice || 0), 0)
    return {
      ...first,
      lines: lines.length,
      lineSubtotal,
      hasZeroQuantity: lines.some((line) => Number(line.ItemQuantity) === 0),
      hasNegativeQuantity: lines.some((line) => Number(line.ItemQuantity) < 0),
    }
  })
  return {
    rows: rows.length,
    orders,
    uniqueIds: orders.length,
    locations: distinct(orders, "Location"),
    users: new Set(orders.map((row) => String(row.OrderTakerID)).filter(Boolean)).size,
    dates: dateRange(orders, "OrderCreatedDT"),
    status: distribution(orders.map((row) => ({ status: `${row.StatusID}/${row.DeliveryStatus}` })), "status"),
    subtotalMismatch: orders.filter((row) => Math.abs(row.lineSubtotal - Number(row.AmountTotal || 0)) > 0.01).length,
    taxGrandMismatch: orders.filter((row) => Math.abs(Number(row.AmountTotal || 0) + Number(row.Tax || 0) - Number(row.GrandTotal || 0)) > 0.01).length,
    zeroQuantityOrders: orders.filter((row) => row.hasZeroQuantity).length,
    negativeQuantityOrders: orders.filter((row) => row.hasNegativeQuantity).length,
    negativePriceLines: rows.filter((row) => Number(row.UnitPrice) < 0).length,
    zeroPriceLines: rows.filter((row) => Number(row.UnitPrice) === 0).length,
    amountTotal: orders.reduce((sum, row) => sum + Number(row.AmountTotal || 0), 0),
    taxTotal: orders.reduce((sum, row) => sum + Number(row.Tax || 0), 0),
    grandTotal: orders.reduce((sum, row) => sum + Number(row.GrandTotal || 0), 0),
  }
}

function summarizeGroupWise(rows) {
  return {
    rows: rows.length,
    dates: dateRange(rows, "OrderDate"),
    employees: distinct(rows, "Emp__"),
    emails: distinct(rows, "Email_Address"),
    groups: distinct(rows, "Group"),
    itemCodes: distinct(rows, "Item_Code"),
    itemNames: distinct(rows, "Item_Details"),
    categories: distinct(rows, "Item_Category"),
    missingEmployees: rows.filter((row) => !normalize(row.Emp__)).length,
    missingItemCodes: rows.filter((row) => !normalize(row.Item_Code)).length,
    blankUom: rows.filter((row) => !normalize(row.UOM)).length,
    zeroQuantity: rows.filter((row) => Number(row.Quantity_Ordered) === 0).length,
    negativeQuantity: rows.filter((row) => Number(row.Quantity_Ordered) < 0).length,
    deliveredQuantityMismatch: rows.filter((row) => Number(row.Quantity_Ordered) !== Number(row.Qty_Delivered)).length,
    valueMismatch: rows.filter((row) => Math.abs(Number(row.Unit_Rate) * Number(row.Qty_Delivered) - Number(row.Value_of_Qty_Delivered)) > 0.01).length,
  }
}

function summarizeProduct(rows) {
  return {
    rows: rows.length,
    productIds: new Set(rows.map((row) => String(row.productid))).size,
    names: distinct(rows, "Name"),
    locations: distinct(rows, "Location"),
    groups: distinct(rows, "Group"),
    users: distinct(rows, "UserName"),
    dates: dateRange(rows, "OrderCreatedDT"),
    statuses: distribution(rows, "OrderStatus"),
    zeroQuantity: rows.filter((row) => Number(row.Item_Qty) === 0).length,
    negativeQuantity: rows.filter((row) => Number(row.Item_Qty) < 0).length,
    zeroPrice: rows.filter((row) => Number(row.UnitPrice) === 0).length,
    negativePrice: rows.filter((row) => Number(row.UnitPrice) < 0).length,
    missingSku: rows.filter((row) => !normalize(row.SKU)).length,
  }
}

function compareBranches(live, snapshot) {
  const source = live.perLocationModules.budgets.countsByLocation.map((row) => ({ id: row.locationId, name: row.locationName, norm: normalize(row.locationName) }))
  const target = snapshot.branches.map((row) => ({ id: row.id, code: row.code, name: row.name, norm: normalize(row.name) }))
  return {
    sourceCount: source.length,
    targetSnapshotCount: target.length,
    sourceWithoutExactNormalizedTarget: source.filter((row) => !target.some((candidate) => candidate.norm === row.norm)),
    targetWithoutExactNormalizedSource: target.filter((row) => !source.some((candidate) => candidate.norm === row.norm)),
  }
}

async function main() {
  const [staticAudit, liveAudit, remaining, snapshot, orderRows, groupRows, budgetRows, refundRows, refundDetailAudit, priceRows, productRows, locationProductRows, userProductRows] = await Promise.all([
    json("updatedReports/ke-legacy-source-static-audit-2026-08-03.json"),
    json("updatedReports/ke-legacy-source-live-audit-2026-08-03.json"),
    json("updatedReports/ke-remaining-orders-report-2026-07-23.json"),
    json("backups/ke-import-state-2026-07-23-pre-incremental-51-orders.json"),
    json("updatedReports/orderPurchaseReport.json"),
    json("updatedReports/groupWiseReport.json"),
    json("updatedReports/budgetReport.json"),
    json("updatedReports/refundReport.json"),
    json("updatedReports/ke-refund-detail-audit-2026-08-03.json"),
    json("updatedReports/productPriceHistory.json"),
    json("updatedReports/productSummery.json"),
    json("updatedReports/productswithLocation.json"),
    json("updatedReports/UserProductSummary.json"),
  ])

  const orders = uniqueOrderSummary(orderRows)
  const groupWise = summarizeGroupWise(groupRows)
  const products = summarizeProduct(productRows)
  const productsWithLocation = summarizeProduct(locationProductRows)
  const userProducts = summarizeProduct(userProductRows)
  const branchComparison = compareBranches(liveAudit, snapshot)
  const budgetDates = { from: dateRange(budgetRows, "TenureFrom"), to: dateRange(budgetRows, "TenureTo") }
  const budgetKeys = new Set(budgetRows.map((row) => `${normalize(row.Location)}|${row.TenureFrom}|${row.TenureTo}`))
  const priceDates = dateRange(priceRows, "Date")

  const sourceSummary = {
    generatedAt: new Date().toISOString(),
    safety: liveAudit.safety,
    application: staticAudit.inventory.summary,
    tenant: liveAudit.auth,
    masterData: liveAudit.domainAnalysis,
    extendedMasterData: liveAudit.extendedGlobalAnalysis,
    perLocationModules: liveAudit.perLocationModules,
    exports: {
      orderPurchaseReport: orders,
      groupWiseReport: groupWise,
      budgetReport: {
        rows: budgetRows.length,
        uniqueLocationPeriods: budgetKeys.size,
        locations: distinct(budgetRows, "Location"),
        tenureFrom: budgetDates.from,
        tenureTo: budgetDates.to,
        zeroMonthlyBudget: budgetRows.filter((row) => Number(row.MonthlyBudget) === 0).length,
        negativeRemainingBudget: budgetRows.filter((row) => Number(row.RemainingBudget) < 0).length,
        accountingInvariantMismatch: budgetRows.filter((row) => Math.abs(Number(row.MonthlyBudget) + Number(row.AdditionalBudget) - Number(row.UsedBudget) - Number(row.RemainingBudget)) > 0.01).length,
        totals: {
          monthlyBudget: budgetRows.reduce((sum, row) => sum + Number(row.MonthlyBudget || 0), 0),
          additionalBudget: budgetRows.reduce((sum, row) => sum + Number(row.AdditionalBudget || 0), 0),
          usedBudget: budgetRows.reduce((sum, row) => sum + Number(row.UsedBudget || 0), 0),
          remainingBudget: budgetRows.reduce((sum, row) => sum + Number(row.RemainingBudget || 0), 0),
        },
      },
      refundReport: {
        rows: refundRows.length,
        uniqueOrders: new Set(refundRows.map((row) => String(row.ID))).size,
        locations: distinct(refundRows, "Location"),
        dates: dateRange(refundRows, "OrderCreatedDT"),
        refundAmount: refundRows.reduce((sum, row) => sum + Number(row.RefundAmount || 0), 0),
        taxRefund: refundRows.reduce((sum, row) => sum + Number(row.TaxRefund || 0), 0),
      },
      refundDetailAudit: {
        detailSummary: refundDetailAudit.summary,
        refundModalSummary: refundDetailAudit.refundModalEvidence.summary,
        anomalousOrderIds: refundDetailAudit.refundModalEvidence.summary.anomalousOrderIds,
      },
      productPriceHistory: {
        rows: priceRows.length,
        items: distinct(priceRows, "ItemName"),
        locations: distinct(priceRows, "Location"),
        groups: distinct(priceRows, "LocationGroup"),
        dates: priceDates,
        zeroPrices: priceRows.filter((row) => Number(row.Price) === 0).length,
        negativePrices: priceRows.filter((row) => Number(row.Price) < 0).length,
      },
      productSummary: products,
      productsWithLocation,
      userProductSummary: userProducts,
    },
    targetEvidence: {
      latestAvailableSnapshot: {
        generatedAt: snapshot.generatedAt,
        note: "Pre-incremental snapshot: 594 imported orders before the later 51-order batch.",
        branches: snapshot.branches.length,
        users: snapshot.users.length,
        globalProducts: snapshot.globalProducts.length,
        organizationInventory: snapshot.organizationInventory.length,
        branchInventory: snapshot.branchInventory.length,
        groups: snapshot.groups.length,
        orders: snapshot.orders.length,
        orderItems: snapshot.orderItems.length,
        legacyProductMappings: snapshot.legacyProductMappings.length,
        legacyUserMappings: snapshot.legacyUserMappings.length,
        legacyOrderImports: snapshot.legacyOrderImports.length,
        budgets: snapshot.budgets.length,
      },
      lastValidatedImportAccounting: remaining.counts,
      branchComparison,
      liveDatabaseCheckOnReportDate: "Unavailable: the SELECT-only target connection failed, so no current target count is asserted beyond the July 23 validated evidence.",
    },
  }

  const outputJson = path.join(UPDATED, `ke-comprehensive-source-investigation-${RUN_DATE}.json`)
  await writeFile(outputJson, `${JSON.stringify(sourceSummary, null, 2)}\n`, "utf8")

  const globals = liveAudit.globals
  const moduleRows = Object.entries(liveAudit.perLocationModules).map(([name, value]) => [
    name,
    String(value.totalRowsAcrossLocations),
    String(value.nonEmptyLocations),
    `${value.successfulLocations}/${value.queriedLocations}`,
    String(value.errorLocations),
  ])
  const exportRows = [
    ["orderPurchaseReport.json", orders.rows, `${orders.uniqueIds} order IDs`, `${orders.dates.earliest.slice(0, 10)} to ${orders.dates.latest.slice(0, 10)}`],
    ["groupWiseReport.json", groupWise.rows, `${groupWise.itemNames} item names`, `${groupWise.dates.earliest.slice(0, 10)} to ${groupWise.dates.latest.slice(0, 10)}`],
    ["budgetReport.json", budgetRows.length, `${distinct(budgetRows, "Location")} locations / ${budgetKeys.size} location-period keys`, `${budgetDates.from.earliest.slice(0, 10)} to ${budgetDates.to.latest.slice(0, 10)}`],
    ["refundReport.json", refundRows.length, `${new Set(refundRows.map((row) => row.ID)).size} refunded orders`, `${dateRange(refundRows, "OrderCreatedDT").earliest.slice(0, 10)} to ${dateRange(refundRows, "OrderCreatedDT").latest.slice(0, 10)}`],
    ["productPriceHistory.json", priceRows.length, `${distinct(priceRows, "ItemName")} items / ${distinct(priceRows, "Location")} locations`, `${priceDates.earliest.slice(0, 10)} to ${priceDates.latest.slice(0, 10)}`],
    ["productSummery.json", productRows.length, `${products.names} names / ${products.locations} locations`, `${products.dates.earliest.slice(0, 10)} to ${products.dates.latest.slice(0, 10)}`],
    ["productswithLocation.json", locationProductRows.length, `${productsWithLocation.names} names / ${productsWithLocation.locations} locations`, `${productsWithLocation.dates.earliest.slice(0, 10)} to ${productsWithLocation.dates.latest.slice(0, 10)}`],
    ["UserProductSummary.json", userProductRows.length, `${userProducts.names} names / ${userProducts.users} users`, `${userProducts.dates.earliest.slice(0, 10)} to ${userProducts.dates.latest.slice(0, 10)}`],
  ]

  const statusRows = Object.entries(products.statuses).map(([status, count]) => [status, String(count)])
  const remainingRows = remaining.categories.map((category) => [category.title, String(category.count), category.requiredEvidence])
  const unmatchedSource = branchComparison.sourceWithoutExactNormalizedTarget.map((row) => `${row.id}: ${row.name}`).join("; ")
  const unmatchedTarget = branchComparison.targetWithoutExactNormalizedSource.map((row) => `${row.id}: ${row.name}`).join("; ")

  const md = `# K-Electric legacy logistics source — comprehensive investigation

Generated: ${sourceSummary.generatedAt}

## Executive conclusion

The source is the **Karachi Electric** tenant (legacy account ID 1) and contains only K-Electric organizational data. The detailed APIs expose materially more migration information than the spreadsheet-style reports: 134 locations, 4 groups, 145 users with 191 user-location mappings, 797 location-scoped categories, 796 subcategories, and 11,176 location-scoped item rows. Category and subcategory relationships are internally complete: no item has an orphan category/subcategory reference.

This data is **not safe for a blind bulk import**. The target already has 645 of the 811 known legacy order IDs according to the last validated import evidence. The prior review quarantined 166 IDs; this follow-up found enough item-level evidence to make 22 of the 25 refund IDs candidates for a dedicated refund-aware dry run, while 3 refund IDs remain internally inconsistent. The source catalog still contains identifier and price ambiguities, and the source API has critical authentication defects. The recommended next step is a reviewed, idempotent migration plan—not direct use of the operational UI or ordinary create-order APIs.

No source or target business data was changed during this investigation.

## Scope and method

- Inspected 105 first-party scripts, 160 client states, 118 concrete page routes, 110 page templates, and 369 HTTP call sites (268 GET, 101 POST).
- Authenticated only to verify tenant identity. The normal UI was not loaded because its startup code invokes a monthly-budget update POST.
- Queried only an explicit read-only API allowlist, including both refund detail endpoints for all 25 refund rows. No operational refund, status, removal, receipt, generation, or other write endpoint was called.
- Inspected the eight detailed JSON exports already in the workspace and reconciled them with prior K-Electric import evidence.
- Attempted a SELECT-only target database check; the connection failed, so current target counts beyond the last validated July 23 evidence are not asserted.
- The per-location crawl reached IIS/WAF HTTP 403 responses after sustained requests. Counts for affected per-location modules are coverage-limited and must not be interpreted as complete zeroes.

## Critical security findings

| Severity | Finding | Evidence / impact |
|---|---|---|
| Critical | Organization master APIs accept unauthenticated reads | Fresh requests without cookie or bearer token returned locations, groups, users, categories, subcategories, and items. |
| Critical | User API exposes credential material | The unauthenticated user response returned non-empty Password and numeric Passcode values for all 145 users. Password lengths are 5–9 characters and do not resemble bcrypt or common hexadecimal hashes. Values were not copied into this report. |
| Critical | Login credentials are placed in the URL path | The client calls \`GET /api/Login/{email}/{password}\`, exposing credentials to server/proxy/browser logs and histories. |
| High | Destructive behavior is implemented through GET routes | Public client code contains GET calls for remove/delete, refund, and order-status operations. These were not invoked. |
| High | Login/OTP contract is inconsistent | Login reported “OTP sent successfully” while \`isMultifactor=false\`; the response contained no token even though client code expects one. |
| High | UI startup performs a write | Loading the normal app can call \`POST api/Location/UpdateMonthlyBudget/{userId}\`; this is why UI crawling was deliberately avoided. |

Immediate security action: rotate the supplied administrator password, invalidate all legacy sessions/passcodes, stop returning Password/Passcode fields, require authorization on every API, move login credentials into a TLS-protected POST body, and convert all mutating GET routes to authorized non-GET operations with CSRF protection and audit logging.

## Page and domain inventory

The application covers authentication/signup, dashboard, organizations and branches, location groups, users, catalog (categories, subcategories, items, modifiers, variants, tax), customers and suppliers, stores and inventory, purchase requests/receipts/transfers/reconciliation, POS/admin orders and refunds, budgets, expenses and quotations, delivery configuration, banners/blogs/reviews/coupons/deals, web-sale customization, notifications, and extensive sales/product/user/stock/credit/refund/budget reports.

### Organization-wide JSON collections

${table(["Collection", "Rows", "Important fields / notes"], [
  ["Locations", String(globals.locations.rowCount), "ID, Name, StatusID, tax, current/monthly/total budget, group and operational settings"],
  ["Location groups", String(globals.locationGroups.rowCount), "ID, Name, IsActive, LocationIDs"],
  ["Users", String(globals.users.rowCount), "Identity, role/type, branch/location mappings, contact fields; credential fields are improperly included"],
  ["Categories", String(globals.categories.rowCount), "ID, LocationID, Name, StatusID"],
  ["Subcategories", String(globals.subcategories.rowCount), "ID, CategoryID, CategoryName, Name, StatusID"],
  ["Items", String(globals.items.rowCount), "ID, CategoryID, SubCategoryID, name, barcode, SKU, price, unit, status"],
  ["Modifiers / variants / taxes", `${globals.modifiers.rowCount} / ${globals.variants.rowCount} / ${globals.taxes.rowCount}`, "One modifier; no variants or taxes returned"],
  ["Purchase orders / transfers / adjustments / quotations", `${globals.purchaseOrders.rowCount} / ${globals.transfers.rowCount} / ${globals.adjustments.rowCount} / ${globals.quotations.rowCount}`, "Very small or empty operational collections"],
])}

### Per-location API coverage

Rows below are only from successful responses. HTTP 403/404/405 responses are errors, not empty datasets.

${table(["Module", "Rows observed", "Non-empty locations", "Successful/queried", "Errors"], moduleRows)}

The successful subset showed 2 suppliers (KE HOUSE and IT DEPARTMENT), 1 store (KE HOUSE), 1 currently listed/open order (GSMP North), and no inventory rows. The WAF blocked later requests, so those figures are not asserted as complete tenant totals.

## Organizational structure and branch mapping

- 134/134 source locations are active; all 134 have blank \`CompanyCode\`.
- Two case-insensitive duplicate-name pairs exist: \`DISTRIBUTION STRATEGY\` vs \`Distribution Strategy\`, and \`society cluster\` vs \`Society Cluster\`.
- The four groups reference 133 locations with no overlap and no unknown IDs. \`MEGA CENTER\` (source ID 102) is not assigned to any group.
- \`Health And Wellbeing\` (source ID 167) has no categories or items.
- The latest available target snapshot has 127 branches. Exact-normalized comparison leaves these source names unmatched: ${unmatchedSource}.
- Target-only exact-normalized names are: ${unmatchedTarget}. Likely aliases include \`lyari I\` → \`liyari I\`, \`BALDIA IBC\` → \`BALDIA\`, and \`Johar Technical\` → \`Technical\`; these require explicit approval, not automatic fuzzy matching.

## Users

- 145 active source users: 140 type 2, 3 type 3, and 2 with null type.
- 133 distinct populated email values; 1 user has no email. Four duplicate-email keys affect 15 rows, with one value reused 9 times.
- 145 users carry 191 nested location mappings, so the source supports multi-location users. The target user model has one \`branchId\`; migration must either create per-branch historical identities or add a proper many-to-many assignment model.
- Every user record returned a non-empty password and numeric passcode. These must never be imported. Target credentials must be freshly generated and hashed; historical-only identities should remain inactive.

## Catalog, categories, and products

- 797 categories across 133 locations but only 10 distinct normalized category names.
- 796 subcategories with 10 distinct normalized names; all 796 \`CategoryName\` values agree with their referenced parent.
- 7 duplicate category-name/location keys and 6 duplicate subcategory-name/category keys require deduplication rules.
- 11,176 active item rows represent 155 normalized product names across 133 locations (37–137 items per represented location, average 84.03).
- 22 duplicate product-name/location keys affect 44 rows; IDs cannot be treated as globally canonical.
- 3,978 item rows have no SKU. The source has 97 populated distinct SKUs and 446 distinct barcodes.
- 131 of 155 product names map to multiple barcodes; 6 barcodes map to multiple product names. Five SKUs map to multiple names. Barcode/SKU matching alone is unsafe.
- 10 product names have more than one source price; one name has at most two price values. A reviewed product/price rule is required.
- 33 item records have zero price. Cost, NewPrice, and CurrentStockLevel are zero for every item; every item is flagged \`isInventoryItem=false\`. The standalone inventory API returned no rows in the successful subset.
- The item/category/subcategory relationships are complete (zero orphan references), so the detailed API can support category migration that earlier flat reports could not.

Target implication: collapse location-specific item rows into reviewed canonical global products, then create K-Electric organization and branch assignments. Preserve original source item/category/location IDs in migration metadata. Do not overwrite global products in other organizations. The current target schema has organization-level custom price but no branch-specific price field, so location price differences need either a schema extension or an approved canonical-price policy.

## Detailed export audit

${table(["File", "Rows", "Coverage", "Date range"], exportRows.map((row) => row.map(String)))}

### Orders and line evidence

- \`orderPurchaseReport.json\` has 6,385 line rows but only 706 distinct order IDs, across 105 locations and 111 order takers. Date range: 2025-01-06 to 2026-07-10.
- Distinct-order status pairs: ${Object.entries(orders.status).map(([key, value]) => `${key}=${value}`).join(", ")}.
- All 706 use payment mode 1 in this export.
- 385/706 order groups do not reconcile when current \`UnitPrice × ItemQuantity\` is compared with \`AmountTotal\`. This proves the export’s line price is not consistently authoritative for historical financial reconstruction.
- 35 order IDs contain zero-quantity lines; 3 lines have zero price and 1 line has a negative price. Tax plus subtotal reconciles to grand total for all 706 headers.
- Distinct-header totals for this 706-order subset: subtotal ${money(orders.amountTotal)}, tax ${money(orders.taxTotal)}, grand total ${money(orders.grandTotal)}. These are source evidence, not an import recommendation.
- \`groupWiseReport.json\` has 6,386 rows. It contains 43 zero-quantity rows, 1 negative-quantity row, 29 ordered-vs-delivered quantity differences, 2,741 blank item codes, and 1,889 blank UOMs. Its delivered-value arithmetic itself reconciles on all rows.

### Known import accounting

The last validated evidence identifies **811** known legacy order IDs. **645** are already imported (594 original + 51 incremental). The earlier review placed **166** outside the normal fulfilled-order importer.

${table(["Exclusive blocker", "Orders", "Evidence required"], remainingRows)}

The 166 historical categories are mutually exclusive. The individual refund-detail investigation below supersedes the earlier “missing refund item evidence” conclusion for 22 of the 25 refund IDs, but those 22 still require a separate refund-aware importer and live-target dry run. In addition, 213 later product-summary rows (16 analytical groupings) have no authoritative order ID/header and cannot be converted into exact orders.

### Product-summary status distribution

${table(["Status", "Rows"], statusRows)}

The three product-oriented exports disagree in coverage: product summary has 6,954 rows through July 23; user-product summary has 6,741 rows through July 11; products-with-location has 5,768 rows through July 20. They are reporting views, not independent authoritative order sources.

### Refunds

- 25 refunded order IDs across 19 locations, dated 2025-01-06 through 2026-06-15.
- Reported refund amount: ${money(refundRows.reduce((sum, row) => sum + Number(row.RefundAmount || 0), 0))}; tax-refund field total: ${money(refundRows.reduce((sum, row) => sum + Number(row.TaxRefund || 0), 0))}.
- The list response is order-level, but the report-detail endpoint \`OrderDetailController/{LocationID}/{ID}\` returned all 25 orders successfully: 208 original item rows and 52 explicitly refunded item rows. All 52 have an item ID, name, and refund quantity; total refunded quantity is 285.
- The companion read endpoint \`RefundModal/{LocationID}/{TransactionNo}\` uniquely matched all 52 refunded rows and preserved \`UnitPrice\` and \`RefundPrice\` for every one. All 25 original order subtotals reconcile exactly from item quantity × unit price.
- For 22/25 refund orders, refunded quantity × unit price also reconciles exactly to checkout \`RefundAmount\`. These 22 are candidates for a guarded refund-aware dry run, not an automatic commit.
- Three orders—legacy IDs **173, 174, and 177**—contain negative post-refund price/quantity state and do not reconcile to their checkout refund totals. They remain blocked pending corrected history or an approved anomaly policy.
- One zero-quantity item with no unit price occurs in order 616; it contributes zero and the order subtotal still reconciles. A target import must explicitly exclude or quarantine that artifact because target order items require positive quantity.
- One order separately reports tax refund (${money(refundRows.reduce((sum, row) => sum + Number(row.TaxRefund || 0), 0))}). The target has one refund amount field, so review must decide whether the imported refund amount is source \`RefundAmount\` alone or \`RefundAmount + TaxRefund\`; the receipt/report behavior should use the same rule.

### Budgets

- 1,428 rows, 1,428 unique location-period keys, 130 locations, 13 monthly periods from July 2025 through July 2026.
- The arithmetic \`MonthlyBudget + AdditionalBudget - UsedBudget = RemainingBudget\` holds on all rows.
- 74 rows have zero monthly budget; 40 have negative remaining budget. Those 40 conflict with the target’s non-negative budget constraint and cannot be copied directly.
- Historical budget facts should go into a separate migration/reporting path. Ordinary target budget writes would change live availability and are outside the safe historical-order import.

### Price history

- 2,214 rows for 152 item names across 66 locations and all 4 groups, dated 2025-01-06 through 2026-08-03.
- 47 rows have zero price and 1 has a negative price. Price selection must be date- and order-aware; “latest price wins” is not defensible for historical orders.

## Source-to-target mapping

${table(["Source", "Target", "Rule / blocker"], [
  ["Company/account ID 1", "Organization 10 / code 0001 / K-Electric", "Fixed tenant guard; never infer another organization"],
  ["Location", "branches", "Explicit source-location ledger; resolve duplicates and eight non-exact names before writes"],
  ["LocationGroup + LocationIDs", "groups + branches.group_id", "Four groups; MEGA CENTER needs an explicit group decision"],
  ["SubUser + SubuserLocations", "users + branch assignment / legacy_user_mappings", "Never reuse source passwords/passcodes; preserve multi-location semantics"],
  ["Category/SubCategory", "categories + parent_id", "Normalize 10 canonical names; review duplicate location-scoped keys"],
  ["Item", "global_products + organization_inventory + branch_inventory", "Canonicalize 155 names; store source IDs; do not trust barcode/SKU alone"],
  ["Item.Price + price history", "base/custom price or new branch-price model", "Ten names vary; historical orders require order-date price evidence"],
  ["Order header/lines", "orders + order_items + import ledger", "645 already imported; prior 166 exclusions must be reclassified using the new refund evidence"],
  ["Refund list + two detail APIs", "orders + order_items + refunds + refund_items", "22 refund orders reconcile and are dry-run candidates; IDs 173, 174, and 177 remain blocked"],
  ["Budget report", "budgets or separate legacy-budget history", "Blocked for direct operational import: 40 negative balances and live-side effects"],
  ["Suppliers/stores/PO/transfers", "suppliers and future procurement structures", "Low volume observed, but 403-limited coverage must be completed at a lower request rate/export"],
])}

## Target baseline and duplicate prevention

- Pre-incremental snapshot (${snapshot.generatedAt}): 127 branches, 272 users, 167 global products, 145 K-Electric organization-inventory assignments, 1,892 branch-inventory assignments, 4 groups, 594 orders, 5,236 order items, and 594 legacy order ledger entries.
- The later validated evidence records 51 additional imported orders, bringing the ledger to 645.
- The current target database could not be reached by the SELECT-only checker during this audit. Before any future import, rerun the live preflight and require ledger-based idempotency, exact tenant identity, an immutable source manifest, and zero blockers.

## Recommended staged migration plan

1. **Security containment first:** rotate credentials/passcodes, protect every source API, and preserve server logs for incident review without circulating exposed values.
2. **Freeze and hash a new source snapshot:** export locations, groups, users (without credentials), categories, subcategories, items, item-location assignments, complete order headers/lines, refunds, budgets, and price history at one cutoff time.
3. **Create reviewed mapping ledgers:** source location→branch, user/location→target identity, category/subcategory→target category, and source item/location→canonical product/assignment.
4. **Resolve catalog blockers:** duplicate branch/category/item names, barcode/SKU conflicts, ten price-varying products, 33 zero prices, and the four currently unmatched/new source branches.
5. **Re-run order/refund reconciliation:** deduplicate against all 645 ledger IDs; send the 22 reconciled refund orders through a dedicated refund-aware dry run; keep IDs 173, 174, and 177 plus all other unresolved workflow/financial cases quarantined.
6. **Keep side effects isolated:** historical imports must not consume stock, alter current budgets, send notifications, advance invoice sequences, or create active credentials.
7. **Dry-run against the live target:** require exact counts, totals, mapping checksums, tenant guard, and zero blockers; back up before any approved commit.
8. **Commit atomically with audit ledger and rollback:** only after explicit review and approval. This investigation did not authorize or perform that step.

## Evidence artifacts

- \`ke-legacy-source-static-audit-2026-08-03.json\` — routes, templates, scripts, and HTTP call inventory.
- \`ke-legacy-source-live-audit-2026-08-03.json\` — sanitized live API schemas, counts, quality statistics, and coverage/errors.
- \`ke-comprehensive-source-investigation-2026-08-03.json\` — machine-readable aggregate behind this report.
- \`ke-refund-detail-audit-2026-08-03.json\` — all 25 read-only refund detail responses, item joins, price checks, and reconciliation results.
- \`ke-remaining-orders-report-2026-07-23.json/.md\` — validated imported/remaining order accounting.
- \`ke-import-state-2026-07-23-pre-incremental-51-orders.json\` — target safety snapshot before the 51-order batch.

## Final decision

Do not run a general-purpose “import all” job. The APIs now provide enough structure to design a much better catalog/category/branch/user mapping and a dedicated refund migration. Existing order-ledger IDs must be preserved; the 22 reconciled refunds require a separate dry run, the 3 anomalous refunds remain quarantined, and budgets must be isolated from live operational balances. Security remediation of the legacy source should be treated as urgent.
`

  const outputMd = path.join(UPDATED, `ke-comprehensive-source-investigation-${RUN_DATE}.md`)
  await writeFile(outputMd, md, "utf8")

  const modalEvidenceById = new Map(refundDetailAudit.refundModalEvidence.orderEvidence.map((row) => [String(row.reportOrderId), row]))
  const detailById = new Map(refundDetailAudit.details.filter((row) => row.ok).map((row) => [String(row.reportOrderId), row]))
  const refundAuditRows = refundRows.map((row) => {
    const evidence = modalEvidenceById.get(String(row.ID))
    const detail = detailById.get(String(row.ID))
    const refundedItems = detail?.items.filter((item) => Number(item.RefundQuantity || 0) > 0) || []
    return [
      String(row.ID),
      row.Location,
      String(row.OrderNo),
      String(row.TransactionNo),
      String(row.OrderCreatedDT).slice(0, 10),
      String(detail?.items.length || 0),
      String(refundedItems.length),
      String(refundedItems.reduce((sum, item) => sum + Number(item.RefundQuantity || 0), 0)),
      Number(row.RefundAmount || 0).toFixed(2),
      Number(row.TaxRefund || 0).toFixed(2),
      evidence?.unitPriceReconciles && evidence?.originalSubtotalReconciles ? "Refund-aware dry-run candidate" : "Blocked: inconsistent refund state",
    ]
  })
  const refundCandidates = refundDetailAudit.refundModalEvidence.orderEvidence.filter((row) => row.unitPriceReconciles && row.originalSubtotalReconciles).map((row) => row.reportOrderId)
  const refundBlocked = refundDetailAudit.refundModalEvidence.orderEvidence.filter((row) => !row.unitPriceReconciles || !row.originalSubtotalReconciles).map((row) => row.reportOrderId)
  const refundMd = `# K-Electric individual refund-detail investigation

Generated: ${sourceSummary.generatedAt}

## Result

Both read-only detail APIs were checked for all 25 refund-report rows:

- \`GET api/OrderDetailController/{LocationID}/{refundReport.ID}\` identifies the original items and refunded quantities.
- \`GET api/RefundModal/{LocationID}/{TransactionNo}\` preserves original unit/refund prices.

All 25 requests succeeded on both endpoints. Together they returned 208 original item rows and 52 refunded item rows with a total refunded quantity of 285. All 25 original order subtotals reconcile from item quantity × unit price.

For **22 orders**, refunded quantity × unit price also matches checkout \`RefundAmount\`; these are candidates for a dedicated, ledger-protected refund dry run. Candidate legacy IDs: **${refundCandidates.join(", ")}**.

Three orders remain blocked: **${refundBlocked.join(", ")}**. They contain negative post-refund quantity/price state and their item refund totals do not match checkout \`RefundAmount\`.

No refund or status action was called, and no source data was changed.

## Per-order result

${table(["Legacy ID", "Location", "Order", "Trans", "Date", "All items", "Refunded items", "Refund qty", "Refund amount", "Tax refund", "Assessment"], refundAuditRows)}

## Migration implications

- Reconstruct the original order and all positive-quantity order items first.
- Create refund items by joining the 52 detail rows to the reconstructed order items through the guarded source-item mapping.
- Treat source \`RefundPrice\` as an extended line refund value and \`UnitPrice\` as the per-unit value; both reconcile for the 22 candidates.
- Decide explicitly whether the target refund amount includes \`TaxRefund\`. Only one source order has a non-zero tax refund.
- Exclude or quarantine the zero-quantity artifact on legacy order 616.
- Keep legacy IDs 173, 174, and 177 quarantined until corrected refund history or a reviewed anomaly rule is supplied.

Machine-readable evidence: \`ke-refund-detail-audit-2026-08-03.json\`.
`
  const refundOutputMd = path.join(UPDATED, `ke-refund-detail-investigation-${RUN_DATE}.md`)
  await writeFile(refundOutputMd, refundMd, "utf8")

  console.log(JSON.stringify({ outputMd, outputJson, refundOutputMd, headline: {
    locations: liveAudit.domainAnalysis.locations.rows,
    users: liveAudit.domainAnalysis.users.rows,
    itemRows: liveAudit.domainAnalysis.items.rows,
    canonicalNames: liveAudit.extendedGlobalAnalysis.items.distinctNormalizedNames,
    knownOrders: remaining.counts.knownLegacyOrderIds,
    importedOrders: remaining.counts.importedLegacyOrderIds,
    remainingOrders: remaining.counts.remainingNotSafeToImport,
  } }, null, 2))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
