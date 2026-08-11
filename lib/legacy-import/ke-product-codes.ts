import { createHash } from "node:crypto"

export const KE_PRODUCT_CODE_MIGRATION = {
  version: 1,
  organization: { id: 10, code: "0001", name: "K-Electric" },
  ublOrganization: { id: 6, code: "UBL_123A", name: "UBL" },
  sourceSystem: "KE_LOGISTICS",
  importBatchId: "62a41a10-aa85-4fb0-92c0-968c64abccba",
  importManifestDigest: "9d899a39e3a6adc2df236fc3ec629d69b981a837c2b54e588c783e29c9de58ba",
  firstProductId: 165,
  lastProductId: 308,
  productCount: 144,
  firstCodeNumber: 20,
  lastCodeNumber: 163,
  importedOrderCount: 594,
  importedItemCount: 5_236,
  renamedItemCount: 5_171,
  renamedItemQuantity: 40_730,
  renamedItemRevenueCents: 4_106_097_400,
  reusedProduct: { id: 7, code: "PRD-007", name: "Sugar", importedItemCount: 65 },
  ublAssignment: { id: 320, organizationId: 6, globalProductId: 203 },
  confirmation: "RENUMBER:KE-LEGACY:144:PRD--20:PRD--163:UNASSIGN-UBL-320",
  normalizedUniqueIndex: "global_products_code_active_normalized_uq",
} as const

export type KeProductCodeState = "PENDING" | "APPLIED" | "MIXED"

export interface KeImportedProductCodeRow {
  id: number
  name: string
  productCode: string
}

export interface KeProductCodeMapping {
  globalProductId: number
  productName: string
  oldCode: string
  newCode: string
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function expectedKeProductCode(globalProductId: number): string {
  const config = KE_PRODUCT_CODE_MIGRATION
  assert(
    Number.isSafeInteger(globalProductId)
      && globalProductId >= config.firstProductId
      && globalProductId <= config.lastProductId,
    `Unexpected K-Electric imported product ID: ${globalProductId}`,
  )
  return `PRD--${config.firstCodeNumber + globalProductId - config.firstProductId}`
}

export function classifyKeProductCodeState(rows: KeImportedProductCodeRow[]): KeProductCodeState {
  const ordered = [...rows].sort((a, b) => a.id - b.id)
  assertExpectedKeProductRows(ordered)
  const pending = ordered.every((row) => /^LEG-KE-[A-F0-9]{16}$/.test(row.productCode))
  const applied = ordered.every((row) => row.productCode === expectedKeProductCode(row.id))
  return (() => {
    if (pending) {
      return "PENDING"
    }
    if (applied) {
      return "APPLIED"
    }
    return "MIXED"
  })()
}

export function buildKeProductCodeMappings(rows: KeImportedProductCodeRow[]): KeProductCodeMapping[] {
  const ordered = [...rows].sort((a, b) => a.id - b.id)
  assertExpectedKeProductRows(ordered)
  assert(
    ordered.every((row) => /^LEG-KE-[A-F0-9]{16}$/.test(row.productCode)),
    "K-Electric product-code mapping can only be built from the complete LEG-KE placeholder state",
  )

  const mappings = ordered.map((row) => ({
    globalProductId: row.id,
    productName: row.name,
    oldCode: row.productCode,
    newCode: expectedKeProductCode(row.id),
  }))
  assert(new Set(mappings.map((row) => row.oldCode)).size === mappings.length, "Duplicate legacy product codes found")
  assert(new Set(mappings.map((row) => row.newCode)).size === mappings.length, "Duplicate target product codes generated")
  return mappings
}

export function assertExpectedKeProductRows(rows: KeImportedProductCodeRow[]): void {
  const config = KE_PRODUCT_CODE_MIGRATION
  assert(rows.length === config.productCount, `Expected ${config.productCount} imported products, found ${rows.length}`)
  const ids = rows.map((row) => row.id)
  assert(new Set(ids).size === ids.length, "Duplicate imported product IDs found")
  for (let index = 0; index < rows.length; index += 1) {
    const expectedId = config.firstProductId + index
    assert(rows[index].id === expectedId, `Expected imported product ID ${expectedId}, found ${rows[index].id}`)
  }
  assert(expectedKeProductCode(config.lastProductId) === `PRD--${config.lastCodeNumber}`, "Product-code range configuration is inconsistent")
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

export function buildKeProductCodeMappingPayload(
  mappings: KeProductCodeMapping[],
  ublAssignment: Record<string, unknown>,
): Record<string, unknown> {
  return structuredClone({
    version: KE_PRODUCT_CODE_MIGRATION.version,
    organization: KE_PRODUCT_CODE_MIGRATION.organization,
    sourceSystem: KE_PRODUCT_CODE_MIGRATION.sourceSystem,
    importBatchId: KE_PRODUCT_CODE_MIGRATION.importBatchId,
    importManifestDigest: KE_PRODUCT_CODE_MIGRATION.importManifestDigest,
    expected: {
      productCount: KE_PRODUCT_CODE_MIGRATION.productCount,
      firstProductId: KE_PRODUCT_CODE_MIGRATION.firstProductId,
      lastProductId: KE_PRODUCT_CODE_MIGRATION.lastProductId,
      firstCode: `PRD--${KE_PRODUCT_CODE_MIGRATION.firstCodeNumber}`,
      lastCode: `PRD--${KE_PRODUCT_CODE_MIGRATION.lastCodeNumber}`,
      importedItemCount: KE_PRODUCT_CODE_MIGRATION.importedItemCount,
      renamedItemCount: KE_PRODUCT_CODE_MIGRATION.renamedItemCount,
    },
    ublAssignment,
    mappings,
  })
}
