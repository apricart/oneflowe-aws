import { stringifyPrimitive } from "../stringify-primitive"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

export const KE_ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" } as const
export const LEGACY_SOURCE = "KE_LOGISTICS"

export type JsonObject = Record<string, unknown>

export interface SourceFile {
  path: string
  sha256: string
  bytes: number
}

export interface LegacyOrder extends JsonObject {
  ID: number
  LocationID: number
  OrderTakerID: number
  StatusID: number
  DeliveryStatus: number
  GrandTotal: number
  RefundAmount?: number | null
  LocationName: string
  LocationGroup: string
  UserDetails: string
  CreatedOn: string
  LastUpdateDT: string
}

export interface LegacySaleLine extends JsonObject {
  ID: number
  StatusID: number
  DeliveryStatus: number
  Location: string
  LocationGroup: string
  RegistrationNo?: string
  UserDetails: string
  ItemDetails: string
  ItemQuantity: number
  UnitPrice: number
  AmountTotal: number
  AmountDiscount: number
  ServiceCharges: number
  Tax: number
  GrandTotal: number
  OrderCreatedDT: string
  LastUpdateDT: string
}

export interface LegacyProductSummary extends JsonObject {
  Group: string
  Name: string
  Item_Qty: number
  UnitPrice: number
  SaleRevenue: number
  Barcode?: string | number | null
  SKU?: string | number | null
  Location: string
  RegistrationNo?: string
  UserName?: string
  OrderCreatedDT: string
}

export interface LegacyPriceHistory extends JsonObject {
  Date: string
  ItemName: string
  Location: string
  LocationGroup: string
  Price: number
}

export interface PreparedLine {
  sourceName: string
  normalizedName: string
  quantity: number
  priceCents: number
  lineTotalCents: number
  sourceCodes: string[]
}

export interface PreparedOrder {
  legacyOrderId: number
  sourceChecksum: string
  sourceHeader: LegacyOrder
  sourceLines: LegacySaleLine[]
  branchName: string
  groupName: string
  userName: string
  createdAt: Date
  fulfilledAt: Date
  subtotalCents: number
  taxCents: number
  totalCents: number
  lines: PreparedLine[]
  pricingMethod: "DIRECT" | "SINGLE_RESIDUAL" | "RAW_EXACT"
}

export interface Rejection {
  legacyOrderId: number
  reason: string
}

export interface SourcePreparation {
  manifest: Record<string, SourceFile>
  prepared: PreparedOrder[]
  rejected: Rejection[]
  sourceCounts: Record<string, number>
}

const DEFAULT_REPORT_ROOT = "reports"

export function normalizeText(value: unknown): string {
  return stringifyPrimitive(value)
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
}

export function normalizeProductName(value: unknown): string {
  return normalizeText(value)
    .replaceAll(" (", "(")
    .replaceAll("( ", "(")
    .replaceAll("(", " (")
    .replaceAll(" )", ")")
    .replaceAll(") ", ")")
    .replaceAll(" -", "-")
    .replaceAll("- ", "-")
}

export function normalizeLegacyUser(value: unknown): string {
  const normalized = normalizeText(value)
  return normalized.endsWith(" -") ? normalized.slice(0, -2).trim() : normalized
}

export function normalizeBranch(value: unknown): string {
  const normalized = normalizeText(value)
  return normalized === "1. gso" ? "gso" : normalized
}

/**
 * Normalizes transport/whitespace differences while preserving capitalization.
 * Some K-Electric source locations intentionally differ only by letter case, so
 * normalizeBranch() must not be used as their primary identity.
 */
export function normalizeBranchExact(value: unknown): string {
  return stringifyPrimitive(value)
    .normalize("NFKC")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
}

export interface KeLegacyBranchCandidate {
  id: number
  name: string
  externalSource?: string | null
  externalId?: string | null
}

export type KeLegacyBranchResolutionKind =
  | "EXTERNAL_ID"
  | "EXACT_NAME"
  | "NORMALIZED_ALIAS"
  | "UNRESOLVED"

export function resolveKeLegacyBranch<T extends KeLegacyBranchCandidate>(
  branches: readonly T[],
  source: { locationId?: unknown; name: unknown },
  aliases: Readonly<Record<string, string>> = {},
): {
  branch: T | null
  kind: KeLegacyBranchResolutionKind
  matchCount: number
  lookupKey: string
} {
  const numericLocationId = Number(source.locationId)
  if (Number.isSafeInteger(numericLocationId) && numericLocationId > 0) {
    const externalId = String(numericLocationId)
    const externalMatches = branches.filter((branch) =>
      branch.externalSource === LEGACY_SOURCE && String(branch.externalId ?? "") === externalId,
    )
    if (externalMatches.length === 1) {
      return { branch: externalMatches[0], kind: "EXTERNAL_ID", matchCount: 1, lookupKey: externalId }
    }
    if (externalMatches.length > 1) {
      return { branch: null, kind: "UNRESOLVED", matchCount: externalMatches.length, lookupKey: externalId }
    }
  }

  const exactKey = normalizeBranchExact(source.name)
  const exactMatches = branches.filter((branch) => normalizeBranchExact(branch.name) === exactKey)
  if (exactMatches.length === 1) {
    return { branch: exactMatches[0], kind: "EXACT_NAME", matchCount: 1, lookupKey: exactKey }
  }
  if (exactMatches.length > 1) {
    return { branch: null, kind: "UNRESOLVED", matchCount: exactMatches.length, lookupKey: exactKey }
  }

  const normalizedSource = normalizeBranch(source.name)
  const hasExplicitAlias = Object.hasOwn(aliases, normalizedSource)
  const hasBuiltInAlias = normalizedSource !== normalizeText(source.name)
  const normalizedLookup = aliases[normalizedSource] ?? normalizedSource
  const normalizedMatches = branches.filter((branch) => normalizeBranch(branch.name) === normalizedLookup)
  // Never silently collapse a capitalization-only source branch. Normalized
  // fallback is allowed only for an explicit reviewed alias or a narrowly
  // encoded built-in alias such as "1. GSO" -> "GSO".
  if ((hasExplicitAlias || hasBuiltInAlias) && normalizedMatches.length === 1) {
    return {
      branch: normalizedMatches[0],
      kind: "NORMALIZED_ALIAS",
      matchCount: 1,
      lookupKey: normalizedLookup,
    }
  }
  return {
    branch: null,
    kind: "UNRESOLVED",
    matchCount: normalizedMatches.length,
    lookupKey: normalizedLookup,
  }
}

export function toCents(value: unknown): number {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) throw new Error(`Invalid monetary value: ${stringifyPrimitive(value)}`)
  return Math.round((number + Number.EPSILON) * 100)
}

function dateKey(value: unknown): string {
  const date = new Date(stringifyPrimitive(value))
  if (Number.isNaN(date.getTime())) return "INVALID_DATE"
  return date.toISOString().slice(0, 10)
}

function jsonFile<T>(path: string): { rows: T[]; source: SourceFile } {
  const buffer = readFileSync(path)
  const parsed = JSON.parse(buffer.toString("utf8"))
  if (!Array.isArray(parsed)) throw new Error(`${path} must contain a JSON array`)
  return {
    rows: parsed as T[],
    source: {
      path,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.byteLength,
    },
  }
}

function addCandidate(map: Map<string, Set<number>>, key: string, cents: number) {
  if (!Number.isSafeInteger(cents) || cents < 0) return
  const values = map.get(key) ?? new Set<number>()
  values.add(cents)
  map.set(key, values)
}

function uniqueCandidate(map: Map<string, Set<number>>, key: string): number | undefined {
  const values = map.get(key)
  if (values?.size !== 1) return undefined
  return [...values][0]
}

function isUsableProductCode(value: unknown): boolean {
  const code = stringifyPrimitive(value).trim()
  return code !== "" && code !== "0" && code.toLowerCase() !== "null" && code.toLowerCase() !== "undefined"
}

function orderChecksum(header: LegacyOrder, lines: LegacySaleLine[]): string {
  return createHash("sha256")
    .update(JSON.stringify({ header, lines }))
    .digest("hex")
}

export function prepareKeLegacySource(reportRoot = DEFAULT_REPORT_ROOT): SourcePreparation {
  const root = resolve(reportRoot)
  const ordersFile = jsonFile<LegacyOrder>(resolve(root, "order.json"))
  const salesFile = jsonFile<LegacySaleLine>(resolve(root, "sales-report.json"))
  const summaryFile = jsonFile<LegacyProductSummary>(resolve(root, "user-product-summary-report.json"))
  const historyFile = jsonFile<LegacyPriceHistory>(resolve(root, "item-price-history-report.json"))

  const headers = new Map(ordersFile.rows.map((row) => [Number(row.ID), row]))
  const linesByOrder = new Map<number, LegacySaleLine[]>()
  for (const line of salesFile.rows) {
    const id = Number(line.ID)
    const lines = linesByOrder.get(id) ?? []
    lines.push(line)
    linesByOrder.set(id, lines)
  }

  const summaryExact = new Map<string, Set<number>>()
  const summaryByDate = new Map<string, Set<number>>()
  const historyExact = new Map<string, Set<number>>()
  const historyByDate = new Map<string, Set<number>>()
  const historyGlobal = new Map<string, Set<number>>()
  const codesByName = new Map<string, Set<string>>()

  for (const row of summaryFile.rows) {
    const name = normalizeProductName(row.Name)
    const qty = Number(row.Item_Qty)
    const revenueCents = toCents(row.SaleRevenue)
    if (name && qty > 0 && revenueCents >= 0) {
      const effectivePrice = Math.round(revenueCents / qty)
      const day = dateKey(row.OrderCreatedDT)
      addCandidate(summaryExact, `${normalizeBranch(row.Location)}|${day}|${name}`, effectivePrice)
      addCandidate(summaryByDate, `${day}|${name}`, effectivePrice)
    }
    for (const rawCode of [row.SKU, row.Barcode]) {
      if (!name || !isUsableProductCode(rawCode)) continue
      const values = codesByName.get(name) ?? new Set<string>()
      values.add(String(rawCode).trim())
      codesByName.set(name, values)
    }
  }

  for (const row of historyFile.rows) {
    const name = normalizeProductName(row.ItemName)
    const cents = toCents(row.Price)
    const day = dateKey(row.Date)
    addCandidate(historyExact, `${normalizeBranch(row.Location)}|${day}|${name}`, cents)
    addCandidate(historyByDate, `${day}|${name}`, cents)
    addCandidate(historyGlobal, name, cents)
  }

  function directPrice(line: LegacySaleLine): number | undefined {
    const name = normalizeProductName(line.ItemDetails)
    const day = dateKey(line.OrderCreatedDT)
    const exactKey = `${normalizeBranch(line.Location)}|${day}|${name}`
    // Never choose one source by precedence when the legacy reports disagree.
    // A direct price is safe only when every applicable source collapses to the
    // same single value. Order-level residual reconciliation handles one gap.
    const candidates = new Set<number>()
    for (const [map, key] of [
      [summaryExact, exactKey],
      [historyExact, exactKey],
      [summaryByDate, `${day}|${name}`],
      [historyByDate, `${day}|${name}`],
      [historyGlobal, name],
    ] as Array<[Map<string, Set<number>>, string]>) {
      const value = uniqueCandidate(map, key)
      if (value !== undefined) candidates.add(value)
    }
    return candidates.size === 1 ? [...candidates][0] : undefined
  }

  const prepared: PreparedOrder[] = []
  const rejected: Rejection[] = []

  for (const [legacyOrderId, header] of headers) {
    const sourceLines = linesByOrder.get(legacyOrderId) ?? []
    const refundCents = toCents(header.RefundAmount ?? 0)

    if (Number(header.StatusID) !== 2 || Number(header.DeliveryStatus) !== 507) {
      rejected.push({ legacyOrderId, reason: "NOT_DELIVERED" })
      continue
    }
    if (refundCents !== 0) {
      rejected.push({ legacyOrderId, reason: "HAS_REFUND" })
      continue
    }
    if (sourceLines.length === 0) {
      rejected.push({ legacyOrderId, reason: "NO_ITEM_LINES" })
      continue
    }

    const first = sourceLines[0]
    const subtotalCents = toCents(first.AmountTotal)
    const discountCents = toCents(first.AmountDiscount)
    const serviceCents = toCents(first.ServiceCharges)
    const taxCents = toCents(first.Tax)
    const totalCents = toCents(first.GrandTotal)
    const headerTotalCents = toCents(header.GrandTotal)

    const headersAgree = sourceLines.every((line) =>
      toCents(line.AmountTotal) === subtotalCents
      && toCents(line.AmountDiscount) === discountCents
      && toCents(line.ServiceCharges) === serviceCents
      && toCents(line.Tax) === taxCents
      && toCents(line.GrandTotal) === totalCents
      && Number(line.StatusID) === 2
      && Number(line.DeliveryStatus) === 507,
    )
    if (!headersAgree || subtotalCents - discountCents + serviceCents + taxCents !== totalCents || totalCents !== headerTotalCents) {
      rejected.push({ legacyOrderId, reason: "HEADER_TOTAL_MISMATCH" })
      continue
    }
    if (discountCents !== 0 || serviceCents !== 0) {
      rejected.push({ legacyOrderId, reason: "UNSUPPORTED_DISCOUNT_OR_SERVICE_CHARGE" })
      continue
    }

    const prices = sourceLines.map(directPrice)
    let pricingMethod: PreparedOrder["pricingMethod"] = "DIRECT"
    const missing = prices.flatMap((price, index) => price === undefined ? [index] : [])

    if (missing.length === 1) {
      const knownTotal = prices.reduce<number>((sum, price, index) =>
        sum + (price === undefined ? 0 : Math.round(price * Number(sourceLines[index].ItemQuantity))), 0)
      const index = missing[0]
      const qty = Number(sourceLines[index].ItemQuantity)
      const residual = subtotalCents - knownTotal
      if (qty > 0 && residual >= 0 && residual % qty === 0) {
        prices[index] = residual / qty
        pricingMethod = "SINGLE_RESIDUAL"
      }
    } else if (missing.length > 1) {
      for (const index of missing) prices[index] = toCents(sourceLines[index].UnitPrice)
      pricingMethod = "RAW_EXACT"
    }

    if (prices.includes(undefined)) {
      rejected.push({ legacyOrderId, reason: "UNRESOLVED_ITEM_PRICE" })
      continue
    }

    const calculatedSubtotal = prices.reduce<number>((sum, price, index) =>
      sum + Math.round((price as number) * Number(sourceLines[index].ItemQuantity)), 0)
    if (calculatedSubtotal !== subtotalCents) {
      rejected.push({ legacyOrderId, reason: "ITEM_SUBTOTAL_MISMATCH" })
      continue
    }

    const createdAt = new Date(header.CreatedOn)
    const fulfilledAt = new Date(header.LastUpdateDT)
    if (Number.isNaN(createdAt.getTime()) || Number.isNaN(fulfilledAt.getTime())) {
      rejected.push({ legacyOrderId, reason: "INVALID_TIMESTAMP" })
      continue
    }

    prepared.push({
      legacyOrderId,
      sourceChecksum: orderChecksum(header, sourceLines),
      sourceHeader: header,
      sourceLines,
      branchName: header.LocationName || first.Location,
      groupName: header.LocationGroup || first.LocationGroup,
      userName: normalizeLegacyUser(header.UserDetails || first.UserDetails),
      createdAt,
      fulfilledAt,
      subtotalCents,
      taxCents,
      totalCents,
      lines: sourceLines.map((line, index) => {
        const normalizedName = normalizeProductName(line.ItemDetails)
        const priceCents = prices[index] as number
        const quantity = Number(line.ItemQuantity)
        return {
          sourceName: String(line.ItemDetails).trim(),
          normalizedName,
          quantity,
          priceCents,
          lineTotalCents: Math.round(priceCents * quantity),
          sourceCodes: [...(codesByName.get(normalizedName) ?? [])].sort((a, b) => a.localeCompare(b)),
        }
      }),
      pricingMethod,
    })
  }

  return {
    manifest: {
      orders: ordersFile.source,
      sales: salesFile.source,
      productSummary: summaryFile.source,
      priceHistory: historyFile.source,
    },
    prepared: prepared.toSorted((a, b) => a.legacyOrderId - b.legacyOrderId),
    rejected: rejected.toSorted((a, b) => a.legacyOrderId - b.legacyOrderId),
    sourceCounts: {
      orders: ordersFile.rows.length,
      salesLines: salesFile.rows.length,
      productSummaryRows: summaryFile.rows.length,
      priceHistoryRows: historyFile.rows.length,
    },
  }
}

export function rejectionCounts(rejections: Rejection[]): Record<string, number> {
  return rejections.reduce<Record<string, number>>((counts, rejection) => {
    counts[rejection.reason] = (counts[rejection.reason] ?? 0) + 1
    return counts
  }, {})
}
