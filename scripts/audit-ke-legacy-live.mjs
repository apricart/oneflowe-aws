import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const BASE_URL = "https://logistics.oneflowe.com/"
const USER_ID = 1
const RUN_DATE = new Date().toISOString().slice(0, 10)
const OUTPUT_DIR = path.resolve("updatedReports")
const MAX_CONCURRENCY = 5

const BLOCKED_PATH_PARTS = /\b(remove|delete|update|generate|refund|statusupdate|changestatus|receipt|verify|resend|add|create|save)\b/i

function urlFor(value) {
  return new URL(value, BASE_URL).toString()
}

function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en")
}

function asRows(value) {
  if (Array.isArray(value)) return value
  if (value == null) return []
  return [value]
}

async function requestJson(pathname, { method = "GET", allowAuthPost = false } = {}) {
  if (method === "GET" && BLOCKED_PATH_PARTS.test(pathname.replaceAll("/", " "))) {
    throw new Error(`Safety guard rejected potentially mutating GET route: ${pathname}`)
  }
  if (method !== "GET" && !allowAuthPost) throw new Error(`Safety guard rejected ${method} ${pathname}`)

  const startedAt = Date.now()
  const response = await fetch(urlFor(pathname), {
    method,
    redirect: "follow",
    headers: { Accept: "application/json, text/plain, */*" },
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  return {
    ok: response.ok,
    status: response.status,
    durationMs: Date.now() - startedAt,
    bytes: Buffer.byteLength(text),
    data,
    error: response.ok ? null : (typeof data === "string" ? data.slice(0, 240) : JSON.stringify(data).slice(0, 240)),
  }
}

function distribution(rows, key) {
  const counts = new Map()
  for (const row of rows) {
    const value = row?.[key]
    const label = value == null ? "<null>" : String(value).trim() || "<empty>"
    counts.set(label, (counts.get(label) || 0) + 1)
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
}

function duplicateSummary(rows, keySelector) {
  const counts = new Map()
  for (const row of rows) {
    const key = keySelector(row)
    if (!key) continue
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  const duplicates = [...counts.values()].filter((count) => count > 1)
  return {
    duplicateKeys: duplicates.length,
    affectedRows: duplicates.reduce((total, count) => total + count, 0),
    maximumMultiplicity: duplicates.length ? Math.max(...duplicates) : 0,
  }
}

function nonEmptyDistinctCount(rows, key) {
  return new Set(rows.map((row) => normalize(row?.[key])).filter(Boolean)).size
}

function relationAmbiguity(rows, leftKey, rightKey) {
  const leftToRight = new Map()
  for (const row of rows) {
    const left = normalize(row?.[leftKey])
    const right = normalize(row?.[rightKey])
    if (!left || !right) continue
    if (!leftToRight.has(left)) leftToRight.set(left, new Set())
    leftToRight.get(left).add(right)
  }
  const ambiguous = [...leftToRight.values()].filter((values) => values.size > 1)
  return {
    populatedLeftValues: leftToRight.size,
    leftValuesWithMultipleRightValues: ambiguous.length,
    maximumRightValuesForOneLeft: ambiguous.length ? Math.max(...ambiguous.map((values) => values.size)) : 0,
  }
}

function countRange(values) {
  return {
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    average: values.length ? Number((values.reduce((sum, value) => sum + value, 0) / values.length).toFixed(2)) : null,
  }
}

function numericSummary(rows, key) {
  const values = rows.map((row) => Number(row?.[key])).filter(Number.isFinite)
  return {
    populated: values.length,
    missing: rows.length - values.length,
    zero: values.filter((value) => value === 0).length,
    negative: values.filter((value) => value < 0).length,
    min: values.length ? Math.min(...values) : null,
    max: values.length ? Math.max(...values) : null,
    total: values.length ? Number(values.reduce((sum, value) => sum + value, 0).toFixed(4)) : null,
  }
}

function dateRange(rows, key) {
  const values = rows
    .map((row) => ({ raw: row?.[key], timestamp: Date.parse(row?.[key]) }))
    .filter((value) => Number.isFinite(value.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
  return {
    populated: values.length,
    invalidOrMissing: rows.length - values.length,
    earliest: values[0]?.raw ?? null,
    latest: values.at(-1)?.raw ?? null,
  }
}

function shape(rows) {
  const fields = new Map()
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)) continue
    for (const [key, value] of Object.entries(row)) {
      const type = value == null ? "null" : Array.isArray(value) ? "array" : typeof value
      if (!fields.has(key)) fields.set(key, { types: new Map(), present: 0, nulls: 0, emptyStrings: 0 })
      const profile = fields.get(key)
      profile.present += 1
      profile.types.set(type, (profile.types.get(type) || 0) + 1)
      if (value == null) profile.nulls += 1
      if (typeof value === "string" && value.trim() === "") profile.emptyStrings += 1
    }
  }
  return Object.fromEntries([...fields.entries()].map(([key, value]) => [key, {
    types: Object.fromEntries(value.types),
    present: value.present,
    missing: rows.length - value.present,
    nulls: value.nulls,
    emptyStrings: value.emptyStrings,
  }]))
}

function genericSummary(result) {
  if (!result.ok) {
    return {
      ok: false,
      status: result.status,
      durationMs: result.durationMs,
      bytes: result.bytes,
      rowCount: 0,
      fields: {},
      error: result.error,
    }
  }
  const rows = asRows(result.data)
  return {
    ok: result.ok,
    status: result.status,
    durationMs: result.durationMs,
    bytes: result.bytes,
    rowCount: Array.isArray(result.data) ? result.data.length : result.data == null ? 0 : 1,
    fields: rows.length ? shape(rows) : {},
    error: result.error,
  }
}

async function repairExistingReport() {
  const output = path.join(OUTPUT_DIR, `ke-legacy-source-live-audit-${RUN_DATE}.json`)
  const report = JSON.parse(await readFile(output, "utf8"))
  for (const summary of Object.values(report.globals || {})) {
    if (!summary.ok) {
      summary.rowCount = 0
      summary.fields = {}
    }
  }
  for (const module of Object.values(report.perLocationModules || {})) {
    for (const entry of module.countsByLocation || []) {
      if (!Number.isFinite(entry.status) || entry.status < 200 || entry.status >= 300 || entry.error) entry.rowCount = 0
    }
    module.errorLocations = (module.countsByLocation || []).filter((entry) => !Number.isFinite(entry.status) || entry.status < 200 || entry.status >= 300 || entry.error).length
    module.successfulLocations = module.queriedLocations - module.errorLocations
    module.nonEmptyLocations = (module.countsByLocation || []).filter((entry) => entry.rowCount > 0).length
    module.totalRowsAcrossLocations = (module.countsByLocation || []).reduce((sum, entry) => sum + (entry.rowCount || 0), 0)
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ repaired: output }, null, 2))
}

async function augmentGlobalAnalysis() {
  const output = path.join(OUTPUT_DIR, `ke-legacy-source-live-audit-${RUN_DATE}.json`)
  const report = JSON.parse(await readFile(output, "utf8"))
  const paths = {
    locations: `api/Location/GetLocation/${USER_ID}`,
    locationGroups: `api/LocationGroup/GetLocationGroups/${USER_ID}`,
    users: `api/SubUser/0/${USER_ID}`,
    categories: `api/Category/0/${USER_ID}`,
    subcategories: `api/SubCategory/getallsubcats/null/0/${USER_ID}`,
    items: `api/Item/0/null/${USER_ID}`,
  }
  const values = {}
  for (const [name, pathname] of Object.entries(paths)) values[name] = asRows((await getRequired(pathname)).data)

  const locationIds = new Set(values.locations.map((row) => String(row.ID)))
  const groupedLocationIds = values.locationGroups.flatMap((row) => Array.isArray(row.LocationIDs) ? row.LocationIDs.map(String) : [])
  const groupMembershipCounts = new Map()
  for (const id of groupedLocationIds) groupMembershipCounts.set(id, (groupMembershipCounts.get(id) || 0) + 1)
  const categoryLocation = new Map(values.categories.map((row) => [String(row.ID), String(row.LocationID)]))
  const itemLocationCounts = new Map()
  for (const item of values.items) {
    const id = categoryLocation.get(String(item.CategoryID))
    if (id) itemLocationCounts.set(id, (itemLocationCounts.get(id) || 0) + 1)
  }
  const categoryCounts = new Map()
  for (const row of values.categories) categoryCounts.set(String(row.LocationID), (categoryCounts.get(String(row.LocationID)) || 0) + 1)
  const duplicateLocationNames = new Map()
  for (const row of values.locations) {
    const key = normalize(row.Name)
    if (!duplicateLocationNames.has(key)) duplicateLocationNames.set(key, [])
    duplicateLocationNames.get(key).push({ id: row.ID, name: row.Name })
  }

  report.extendedGlobalAnalysis = {
    locations: {
      duplicateNameGroups: [...duplicateLocationNames.values()].filter((rows) => rows.length > 1),
      locationsNotInAnyGroup: values.locations.filter((row) => !groupMembershipCounts.has(String(row.ID))).map((row) => ({ id: row.ID, name: row.Name })),
      locationsInMultipleGroups: values.locations.filter((row) => (groupMembershipCounts.get(String(row.ID)) || 0) > 1).map((row) => ({ id: row.ID, name: row.Name, groups: groupMembershipCounts.get(String(row.ID)) })),
      unknownGroupLocationReferences: [...new Set(groupedLocationIds)].filter((id) => !locationIds.has(id)),
    },
    users: {
      distinctEmails: nonEmptyDistinctCount(values.users, "Email"),
      distinctFirstNames: nonEmptyDistinctCount(values.users, "FirstName"),
      usersWithLocationId: values.users.filter((row) => row.LocationID != null).length,
      usersWithNestedLocationMappings: values.users.filter((row) => Array.isArray(row.SubuserLocations) && row.SubuserLocations.length > 0).length,
      nestedLocationMappings: values.users.reduce((sum, row) => sum + (Array.isArray(row.SubuserLocations) ? row.SubuserLocations.length : 0), 0),
      passwordValuesReturned: values.users.filter((row) => row.Password != null && String(row.Password) !== "").length,
      passcodeValuesReturned: values.users.filter((row) => row.Passcode != null && String(row.Passcode) !== "").length,
      tokenValuesReturned: values.users.filter((row) => row.Token != null && String(row.Token) !== "").length,
    },
    categories: {
      distinctNormalizedNames: nonEmptyDistinctCount(values.categories, "Name"),
      locationsRepresented: new Set(values.categories.map((row) => String(row.LocationID))).size,
      locationsWithoutCategories: values.locations.filter((row) => !categoryCounts.has(String(row.ID))).map((row) => ({ id: row.ID, name: row.Name })),
      categoriesPerRepresentedLocation: countRange([...categoryCounts.values()]),
    },
    subcategories: {
      distinctNormalizedNames: nonEmptyDistinctCount(values.subcategories, "Name"),
      categoryNamesConsistentWithParent: values.subcategories.filter((row) => {
        const parent = values.categories.find((category) => String(category.ID) === String(row.CategoryID))
        return parent && normalize(parent.Name) === normalize(row.CategoryName)
      }).length,
    },
    items: {
      distinctNormalizedNames: nonEmptyDistinctCount(values.items, "Name"),
      distinctBarcodes: nonEmptyDistinctCount(values.items, "Barcode"),
      distinctSkus: nonEmptyDistinctCount(values.items, "SKU"),
      derivedLocationsRepresented: itemLocationCounts.size,
      locationsWithoutItems: values.locations.filter((row) => !itemLocationCounts.has(String(row.ID))).map((row) => ({ id: row.ID, name: row.Name })),
      itemsPerRepresentedLocation: countRange([...itemLocationCounts.values()]),
      duplicateNamesWithinDerivedLocation: duplicateSummary(values.items, (row) => `${categoryLocation.get(String(row.CategoryID))}|${normalize(row.Name)}`),
      nameToBarcodeAmbiguity: relationAmbiguity(values.items, "Name", "Barcode"),
      barcodeToNameAmbiguity: relationAmbiguity(values.items, "Barcode", "Name"),
      nameToSkuAmbiguity: relationAmbiguity(values.items, "Name", "SKU"),
      skuToNameAmbiguity: relationAmbiguity(values.items, "SKU", "Name"),
      nameToPriceAmbiguity: relationAmbiguity(values.items, "Name", "Price"),
    },
    authenticationBoundary: {
      note: "These organization datasets were retrieved in a fresh request flow without forwarding the login response, cookies, or a bearer token.",
      endpointsAcceptedUnauthenticatedReads: Object.values(paths),
    },
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ augmented: output, extendedGlobalAnalysis: report.extendedGlobalAnalysis }, null, 2))
}

async function mapConcurrent(values, worker, concurrency = MAX_CONCURRENCY) {
  const output = new Array(values.length)
  let next = 0
  async function run() {
    while (true) {
      const index = next
      next += 1
      if (index >= values.length) return
      output[index] = await worker(values[index], index)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, run))
  return output
}

async function authenticate() {
  const email = process.env.LEGACY_AUDIT_EMAIL
  const password = process.env.LEGACY_AUDIT_PASSWORD
  if (!email || !password) throw new Error("LEGACY_AUDIT_EMAIL and LEGACY_AUDIT_PASSWORD are required")
  const login = await requestJson(`api/Login/${encodeURIComponent(email)}/${encodeURIComponent(password)}`)
  if (!login.ok || !login.data?.Success) throw new Error(`Login failed (${login.status})`)
  const verify = await requestJson(`api/Login/VerifyUser/${encodeURIComponent(email)}/null`, { method: "POST", allowAuthPost: true })
  const row = asRows(verify.data)[0]
  if (!verify.ok || !row) throw new Error(`Login verification failed (${verify.status})`)
  return {
    success: true,
    accountId: row.ID,
    subUserId: row.SubUserID,
    firstName: row.FirstName,
    company: row.Company,
    userType: row.UserType,
    statusId: row.StatusID,
    isActive: row.IsActivate,
    responseFields: Object.keys(row),
    sensitiveFieldsReturned: Object.keys(row).filter((key) => /password|email|contact|address|token|passcode|key/i.test(key)),
  }
}

async function getRequired(pathname) {
  const result = await requestJson(pathname)
  if (!result.ok) throw new Error(`${pathname} returned ${result.status}: ${result.error}`)
  return result
}

async function readExistingExports() {
  const names = [
    "budgetReport.json",
    "groupWiseReport.json",
    "orderPurchaseReport.json",
    "productPriceHistory.json",
    "productSummery.json",
    "productswithLocation.json",
    "refundReport.json",
    "UserProductSummary.json",
  ]
  const output = {}
  for (const name of names) {
    try {
      const rows = JSON.parse(await readFile(path.join(OUTPUT_DIR, name), "utf8"))
      output[name] = {
        rows: rows.length,
        shape: shape(rows),
        dateRanges: Object.fromEntries(
          ["OrderDate", "OrderCreatedDT", "CreatedOn", "CheckoutDate", "Date", "TenureFrom", "TenureTo"]
            .filter((field) => rows.some((row) => Object.hasOwn(row, field)))
            .map((field) => [field, dateRange(rows, field)]),
        ),
      }
    } catch (error) {
      output[name] = { error: error.message }
    }
  }
  return output
}

async function main() {
  if (process.argv.includes("--repair")) {
    await repairExistingReport()
    return
  }
  if (process.argv.includes("--augment-globals")) {
    await augmentGlobalAnalysis()
    return
  }
  const auth = await authenticate()

  const globalPaths = {
    locations: `api/Location/GetLocation/${USER_ID}`,
    locationGroups: `api/LocationGroup/GetLocationGroups/${USER_ID}`,
    users: `api/SubUser/0/${USER_ID}`,
    categories: `api/Category/0/${USER_ID}`,
    subcategories: `api/SubCategory/getallsubcats/null/0/${USER_ID}`,
    items: `api/Item/0/null/${USER_ID}`,
    taxes: `api/Tax/all/${USER_ID}`,
    modifiers: `api/Modifier/${USER_ID}/null`,
    variants: `api/Variant/${USER_ID}/null`,
    purchaseOrders: `api/request/GetPOList/null/${USER_ID}`,
    transfers: `api/Transfer/list/null/${USER_ID}`,
    adjustments: "api/adjustment/GetAdjustmentlist/",
    quotations: `api/Quotation/${USER_ID}`,
    coupons: `api/Coupons/null/${USER_ID}`,
    deliveryBoys: "api/DeliveryBoy/GetDeliveryBoy",
    company: `api/Company/CompanyData/null/${USER_ID}`,
  }

  const globalResults = {}
  for (const [name, pathname] of Object.entries(globalPaths)) globalResults[name] = await requestJson(pathname)
  for (const required of ["locations", "locationGroups", "users", "categories", "subcategories", "items"]) {
    if (!globalResults[required].ok) {
      throw new Error(`${globalPaths[required]} returned ${globalResults[required].status}: ${globalResults[required].error}`)
    }
  }
  const globals = Object.fromEntries(Object.entries(globalResults).map(([name, result]) => [name, genericSummary(result)]))

  const locations = asRows(globalResults.locations.data)
  const locationGroups = asRows(globalResults.locationGroups.data)
  const users = asRows(globalResults.users.data)
  const categories = asRows(globalResults.categories.data)
  const subcategories = asRows(globalResults.subcategories.data)
  const items = asRows(globalResults.items.data)
  const categoryIds = new Set(categories.map((row) => String(row.ID)))
  const subcategoryIds = new Set(subcategories.map((row) => String(row.ID)))

  const perLocationSpecs = {
    inventories: (id) => `api/Inventory/GetAllInventory/null/${id}`,
    suppliers: (id) => `api/Supplier/GetSupplier/null/${id}`,
    stores: (id) => `api/Store/GetAllStores/null/${id}`,
    customers: (id) => `api/Customer/GetAllCustomers/null/${id}/${USER_ID}`,
    openOrders: (id) => `api/OrderController/GetOrders/${id}`,
    deliveryAreas: (id) => `api/DeliveryArea/GetDeliveryArea/${id}`,
    expenseTypes: (id) => `api/expensetype/Getexpensetype/${id}`,
    expenses: (id) => `api/Expense/expenses/${id}`,
    banners: (id) => `api/Banner/${id}`,
    blogCategories: (id) => `api/BlogCategory/${id}`,
    blogs: (id) => `api/Blog/${id}`,
    floors: (id) => `api/Floor/${id}`,
    tables: (id) => `api/Table/getalltables/null/${id}`,
    orderTypes: (id) => `api/OrderType/${id}`,
    reviews: (id) => `api/Reviews/Reviews/${id}`,
    deals: (id) => `api/Deal/GetAllDeals/${id}/null`,
    appSettings: (id) => `api/AppSetting/null/${id}`,
    webCustomizedSales: (id) => `api/WebCustomizedSale/${id}/null`,
    itemSettings: (id) => `api/GetItemSetting/${id}`,
    budgets: (id) => `api/Location/GetBudget/${id}`,
  }

  const locationRows = await mapConcurrent(locations, async (location) => {
    const modules = {}
    for (const [name, buildPath] of Object.entries(perLocationSpecs)) {
      try {
        const result = await requestJson(buildPath(location.ID))
        modules[name] = genericSummary(result)
      } catch (error) {
        modules[name] = { ok: false, status: null, rowCount: 0, fields: {}, error: error.message }
      }
    }
    return { id: location.ID, name: location.Name, statusId: location.StatusID, modules }
  })

  const perLocationModules = {}
  for (const name of Object.keys(perLocationSpecs)) {
    const entries = locationRows.map((location) => ({
      locationId: location.id,
      locationName: location.name,
      ...location.modules[name],
    }))
    const unionFields = new Set()
    for (const entry of entries) for (const field of Object.keys(entry.fields || {})) unionFields.add(field)
    perLocationModules[name] = {
      queriedLocations: entries.length,
      successfulLocations: entries.filter((entry) => entry.ok).length,
      errorLocations: entries.filter((entry) => !entry.ok).length,
      nonEmptyLocations: entries.filter((entry) => entry.rowCount > 0).length,
      totalRowsAcrossLocations: entries.reduce((sum, entry) => sum + (entry.rowCount || 0), 0),
      unionFields: [...unionFields].sort(),
      countsByLocation: entries.map(({ locationId, locationName, status, rowCount, error }) => ({ locationId, locationName, status, rowCount, error })),
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    source: BASE_URL,
    safety: {
      uiLoaded: false,
      methodsUsed: ["GET", "POST (login verification only)"],
      mutationRouteGuard: BLOCKED_PATH_PARTS.source,
      writeEndpointsCalled: 0,
      note: "Application pages were not loaded because startup code invokes a monthly-budget update POST. Every operational request was generated from an explicit read-only endpoint allowlist.",
    },
    auth,
    globals,
    domainAnalysis: {
      locations: {
        rows: locations.length,
        statusIds: distribution(locations, "StatusID"),
        duplicateNames: duplicateSummary(locations, (row) => normalize(row.Name)),
        duplicateCompanyCodes: duplicateSummary(locations, (row) => normalize(row.CompanyCode)),
        missingNames: locations.filter((row) => !normalize(row.Name)).length,
        missingCompanyCodes: locations.filter((row) => !normalize(row.CompanyCode)).length,
        monthlyBudget: numericSummary(locations, "MonthlyBudget"),
        totalBudget: numericSummary(locations, "TotalBudget"),
        createdOn: dateRange(locations, "CreatedOn"),
      },
      locationGroups: {
        rows: locationGroups.length,
        status: distribution(locationGroups, "IsActive"),
        duplicateNames: duplicateSummary(locationGroups, (row) => normalize(row.Name)),
        locationReferences: locationGroups.reduce((sum, row) => sum + (Array.isArray(row.LocationIDs) ? row.LocationIDs.length : 0), 0),
      },
      users: {
        rows: users.length,
        statusIds: distribution(users, "StatusID"),
        userTypes: distribution(users, "UserType"),
        groupIds: distribution(users, "GroupID"),
        duplicateUserNames: duplicateSummary(users, (row) => normalize(row.UserName)),
        duplicateEmails: duplicateSummary(users, (row) => normalize(row.Email)),
        missingUserNames: users.filter((row) => !normalize(row.UserName)).length,
        missingEmails: users.filter((row) => !normalize(row.Email)).length,
        createdOn: dateRange(users, "CreatedOn"),
        sensitiveFieldsReturned: Object.keys(users[0] || {}).filter((key) => /password|email|contact|address|token|passcode/i.test(key)),
      },
      categories: {
        rows: categories.length,
        uniqueIds: new Set(categories.map((row) => String(row.ID))).size,
        locationIds: new Set(categories.map((row) => String(row.LocationID))).size,
        statusIds: distribution(categories, "StatusID"),
        duplicateNamesWithinLocation: duplicateSummary(categories, (row) => `${row.LocationID}|${normalize(row.Name)}`),
        missingNames: categories.filter((row) => !normalize(row.Name)).length,
        createdOn: dateRange(categories, "CreatedOn"),
      },
      subcategories: {
        rows: subcategories.length,
        uniqueIds: new Set(subcategories.map((row) => String(row.ID))).size,
        statusIds: distribution(subcategories, "StatusID"),
        orphanCategoryReferences: subcategories.filter((row) => row.CategoryID != null && !categoryIds.has(String(row.CategoryID))).length,
        duplicateNamesWithinCategory: duplicateSummary(subcategories, (row) => `${row.CategoryID}|${normalize(row.Name)}`),
        missingNames: subcategories.filter((row) => !normalize(row.Name)).length,
        createdOn: dateRange(subcategories, "CreatedOn"),
      },
      items: {
        rows: items.length,
        uniqueIds: new Set(items.map((row) => String(row.ID))).size,
        statusIds: distribution(items, "StatusID"),
        itemTypes: distribution(items, "ItemType"),
        inventoryFlags: distribution(items, "isInventoryItem"),
        duplicateNames: duplicateSummary(items, (row) => normalize(row.Name)),
        duplicateBarcodes: duplicateSummary(items, (row) => normalize(row.Barcode)),
        duplicateSkus: duplicateSummary(items, (row) => normalize(row.SKU)),
        missingNames: items.filter((row) => !normalize(row.Name)).length,
        missingBarcodes: items.filter((row) => !normalize(row.Barcode)).length,
        missingSkus: items.filter((row) => !normalize(row.SKU)).length,
        orphanCategoryReferences: items.filter((row) => row.CategoryID != null && !categoryIds.has(String(row.CategoryID))).length,
        orphanSubcategoryReferences: items.filter((row) => row.SubCategoryID != null && !subcategoryIds.has(String(row.SubCategoryID))).length,
        price: numericSummary(items, "Price"),
        newPrice: numericSummary(items, "NewPrice"),
        cost: numericSummary(items, "Cost"),
        currentStockLevel: numericSummary(items, "CurrentStockLevel"),
        createdOn: dateRange(items, "CreatedOn"),
        nestedLinks: Object.fromEntries(
          ["Variants", "Modifiers", "itemVariants", "ItemImages", "Inventory"]
            .map((key) => [key, items.reduce((sum, row) => sum + (Array.isArray(row[key]) ? row[key].length : 0), 0)]),
        ),
      },
    },
    perLocationModules,
    existingDetailedExports: await readExistingExports(),
  }

  await mkdir(OUTPUT_DIR, { recursive: true })
  const output = path.join(OUTPUT_DIR, `ke-legacy-source-live-audit-${RUN_DATE}.json`)
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log({
    output,
    safety: report.safety,
    auth: { success: auth.success, accountId: auth.accountId, company: auth.company },
    globalCounts: Object.fromEntries(Object.entries(globals).map(([name, value]) => [name, value.rowCount])),
    perLocationCounts: Object.fromEntries(Object.entries(perLocationModules).map(([name, value]) => [name, {
      totalRows: value.totalRowsAcrossLocations,
      nonEmptyLocations: value.nonEmptyLocations,
      errors: value.errorLocations,
    }])),
  })
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
