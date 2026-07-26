#!/usr/bin/env tsx
/**
 * Safely imports authoritative, delivered K-Electric legacy orders.
 *
 * Default behavior is read-only:
 *   npx tsx scripts/import-ke-legacy-orders.ts
 *
 * A live import requires every printed confirmation value:
 *   npx tsx scripts/import-ke-legacy-orders.ts --commit \
 *     --actor-user-id=<active-super-admin-uuid> \
 *     --confirm-organization=10:0001:K-Electric \
 *     --confirm-manifest=<printed-sha256> \
 *     --expected-orders=<printed-ready-count> \
 *     --allow-new-products \
 *     --allow-historical-users
 *
 * This importer intentionally does not call the operational order API: doing so
 * would consume present-day stock/budgets, advance invoice sequences, and send
 * notifications for historical orders. It persists the same report-facing order
 * and item snapshots, while explicitly leaving those live ledgers unchanged.
 */

import { createHash, randomBytes } from "crypto"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"
import * as dotenv from "dotenv"
import {
  KE_ORGANIZATION,
  LEGACY_SOURCE,
  normalizeBranch,
  normalizeProductName,
  normalizeText,
  prepareKeLegacySource,
  rejectionCounts,
  type PreparedOrder,
} from "../lib/legacy-import/ke-electric"

dotenv.config({ path: ".env.local" })
dotenv.config()

interface Options {
  commit: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmManifest?: string
  expectedOrders?: number
  allowNewProducts: boolean
  allowHistoricalUsers: boolean
  outputPath?: string
  overridesPath?: string
}

interface DbBranch {
  id: number
  name: string
  organizationId: number
  groupId: number | null
  address: string | null
}

interface DbUser {
  id: string
  fullName: string | null
  firstName: string | null
  lastName: string | null
  organizationId: number | null
  branchId: number | null
  isActive: boolean
  roleName: string
  username: string | null
  deletedAt: Date | null
}

interface HistoricalUserPlan {
  key: string
  legacyOrderTakerId: number
  branchId: number
  branchName: string
  sourceName: string
  username: string
  email: string
  orderIds: number[]
}

interface ResolvedUserMappingPlan {
  key: string
  legacyOrderTakerId: number
  branchId: number
  sourceName: string
  userId: string
  kind: "OVERRIDE" | "EXACT"
}

interface ProductResolution {
  normalizedName: string
  sourceName: string
  sourceCodes: string[]
  latestPriceCents: number
  globalProductId?: number
  organizationInventoryId?: number
  existingProductCode?: string
  proposedProductCode?: string
  kind: "EXISTING_CODE" | "EXISTING_NAME" | "EXISTING_MAPPING" | "MANUAL_OVERRIDE" | "CREATE" | "CONFLICT"
  reason?: string
}

function getArg(name: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function options(): Options {
  const expected = getArg("--expected-orders")
  return {
    commit: process.argv.includes("--commit"),
    actorUserId: getArg("--actor-user-id"),
    confirmOrganization: getArg("--confirm-organization"),
    confirmManifest: getArg("--confirm-manifest"),
    expectedOrders: expected === undefined ? undefined : Number(expected),
    allowNewProducts: process.argv.includes("--allow-new-products"),
    allowHistoricalUsers: process.argv.includes("--allow-historical-users"),
    outputPath: getArg("--output"),
    overridesPath: getArg("--overrides"),
  }
}

function manifestDigest(manifest: Record<string, { sha256: string }>): string {
  const stable = Object.entries(manifest)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, file]) => `${name}:${file.sha256}`)
    .join("\n")
  return createHash("sha256").update(stable).digest("hex")
}

interface ImportOverrides {
  branchAliases: Record<string, string>
  usersByLegacyOrderTakerId: Record<string, string>
  productsByNormalizedName: Record<string, number>
}

function loadOverrides(path: string | undefined): {
  values: ImportOverrides
  source?: { path: string; sha256: string; bytes: number }
} {
  const empty: ImportOverrides = { branchAliases: {}, usersByLegacyOrderTakerId: {}, productsByNormalizedName: {} }
  if (!path) return { values: empty }
  const absolutePath = resolve(path)
  if (!existsSync(absolutePath)) throw new Error(`Overrides file not found: ${absolutePath}`)
  const buffer = readFileSync(absolutePath)
  const raw = JSON.parse(buffer.toString("utf8")) as Partial<ImportOverrides>
  const branchAliases = Object.fromEntries(Object.entries(raw.branchAliases ?? {}).map(([from, to]) => [normalizeBranch(from), normalizeBranch(to)]))
  const productsByNormalizedName = Object.fromEntries(Object.entries(raw.productsByNormalizedName ?? {}).map(([name, id]) => {
    if (!Number.isSafeInteger(Number(id)) || Number(id) <= 0) throw new Error(`Invalid product override ID for ${name}`)
    return [normalizeProductName(name), Number(id)]
  }))
  return {
    values: {
      branchAliases,
      usersByLegacyOrderTakerId: raw.usersByLegacyOrderTakerId ?? {},
      productsByNormalizedName,
    },
    source: {
      path: absolutePath,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      bytes: buffer.byteLength,
    },
  }
}

function canonicalKeProductCodeNumber(value: unknown): number | undefined {
  const match = /^prd--(\d+)$/i.exec(String(value ?? "").trim())
  if (!match) return undefined
  const number = Number(match[1])
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function uniqueBy<T>(rows: T[], key: (row: T) => string): T | undefined {
  const distinct = new Map(rows.map((row) => [key(row), row]))
  return distinct.size === 1 ? [...distinct.values()][0] : undefined
}

function chunksOf<T>(values: T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error("Chunk size must be a positive integer")
  const chunks: T[][] = []
  for (let index = 0; index < values.length; index += size) chunks.push(values.slice(index, index + size))
  return chunks
}

function buildReceipt(order: PreparedOrder, branch: DbBranch, productIds: Map<string, number>) {
  const items = order.lines.map((line) => ({
    id: productIds.get(line.normalizedName)!,
    description: line.sourceName,
    quantity: line.quantity,
    rate: line.priceCents / 100,
    tax: 0,
    total: line.lineTotalCents / 100,
    unit: "unit",
  }))
  return {
    invoiceNumber: `KE-LEGACY-${order.legacyOrderId}`,
    date: order.createdAt.toLocaleDateString("en-US", { month: "2-digit", day: "2-digit", year: "numeric" }),
    status: "FULFILLED",
    buyerName: branch.name,
    buyerAddress: branch.address ?? "",
    organizationName: KE_ORGANIZATION.name,
    items: [{
      mainCategoryName: "General",
      subCategories: [{ subCategoryName: "General", items, subtotal: order.subtotalCents / 100 }],
      total: order.subtotalCents / 100,
    }],
    subtotal: order.subtotalCents / 100,
    discount: 0,
    tax: order.taxCents / 100,
    deliveryCharges: 0,
    refund: 0,
    totalAmount: order.totalCents / 100,
  }
}

async function main() {
  const opts = options()
  const source = prepareKeLegacySource()
  const overrides = loadOverrides(opts.overridesPath)
  const confirmationManifest = overrides.source
    ? { ...source.manifest, overrides: overrides.source }
    : source.manifest
  const digest = manifestDigest(confirmationManifest)

  const { db, pool } = await import("../lib/db-cli")
  const schema = await import("../db/schema")
  const { and, eq, inArray, isNull, sql } = await import("drizzle-orm")

  const [organization] = await db.select({
    id: schema.organizations.id,
    code: schema.organizations.code,
    name: schema.organizations.name,
    status: schema.organizations.status,
  }).from(schema.organizations).where(eq(schema.organizations.id, KE_ORGANIZATION.id)).limit(1)

  if (!organization
    || organization.code !== KE_ORGANIZATION.code
    || normalizeText(organization.name) !== normalizeText(KE_ORGANIZATION.name)
    || normalizeText(organization.status) !== "active") {
    throw new Error(`Tenant safety gate failed for K-Electric id=${KE_ORGANIZATION.id}, code=${KE_ORGANIZATION.code}`)
  }

  const [dbBranches, dbUsers, allUsernames, dbProducts, dbOrgInventory, dbBranchInventory, dbGroups, dbLegacyTids, ledgerCheck] = await Promise.all([
    db.select({
      id: schema.branches.id,
      name: schema.branches.name,
      organizationId: schema.branches.organizationId,
      groupId: schema.branches.groupId,
      address: schema.branches.address,
    }).from(schema.branches).where(eq(schema.branches.organizationId, KE_ORGANIZATION.id)),
    db.select({
      id: schema.users.id,
      fullName: schema.users.fullName,
      firstName: schema.users.firstName,
      lastName: schema.users.lastName,
      organizationId: schema.users.organizationId,
      branchId: schema.users.branchId,
      isActive: schema.users.isActive,
      roleName: schema.roles.name,
      username: schema.users.username,
      deletedAt: schema.users.deletedAt,
    }).from(schema.users)
      .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
      .where(and(
      eq(schema.users.organizationId, KE_ORGANIZATION.id),
      eq(schema.roles.name, "ORDER_PORTAL"),
    )),
    db.select({
      id: schema.users.id,
      username: schema.users.username,
      organizationId: schema.users.organizationId,
    }).from(schema.users),
    db.select({
      id: schema.globalProducts.id,
      name: schema.globalProducts.name,
      productCode: schema.globalProducts.productCode,
    }).from(schema.globalProducts).where(isNull(schema.globalProducts.deletedAt)),
    db.select({
      id: schema.organizationInventory.id,
      globalProductId: schema.organizationInventory.globalProductId,
      organizationId: schema.organizationInventory.organizationId,
      deletedAt: schema.organizationInventory.deletedAt,
    }).from(schema.organizationInventory).where(and(
      eq(schema.organizationInventory.organizationId, KE_ORGANIZATION.id),
    )),
    db.select({
      branchId: schema.branchInventory.branchId,
      organizationInventoryId: schema.branchInventory.organizationInventoryId,
      deletedAt: schema.branchInventory.deletedAt,
    }).from(schema.branchInventory).where(eq(schema.branchInventory.organizationId, KE_ORGANIZATION.id)),
    db.select({ id: schema.groups.id, name: schema.groups.name }).from(schema.groups).where(and(
      eq(schema.groups.organizationId, KE_ORGANIZATION.id),
      sql`${schema.groups.status} <> 'deleted'`,
    )),
    db.select({ id: schema.orders.id, tid: schema.orders.tid, organizationId: schema.orders.organizationId })
      .from(schema.orders)
      .where(inArray(schema.orders.tid, source.prepared.map((order) => `KE-LEGACY-${order.legacyOrderId}`))),
    pool.query<{ ledger_present: boolean; user_ledger_present: boolean }>(
      "select to_regclass('public.legacy_import_batches') is not null as ledger_present, to_regclass('public.legacy_user_mappings') is not null as user_ledger_present",
    ),
  ])

  const ledgerInstalled = Boolean(ledgerCheck.rows[0]?.ledger_present)
  const userLedgerInstalled = Boolean(ledgerCheck.rows[0]?.user_ledger_present)
  let existingMappings: Array<{
    normalizedName: string
    globalProductId: number
    organizationInventoryId: number
  }> = []
  let existingImports: Array<{ legacyOrderId: number; sourceChecksum: string; orderId: number }> = []
  let existingUserMappings: Array<{
    legacyOrderTakerId: number
    branchId: number
    sourceName: string
    userId: string
    isSynthetic: boolean
  }> = []
  const mappingErrors: string[] = []
  if (ledgerInstalled) {
    existingMappings = await db.select({
      normalizedName: schema.legacyProductMappings.normalizedName,
      globalProductId: schema.legacyProductMappings.globalProductId,
      organizationInventoryId: schema.legacyProductMappings.organizationInventoryId,
    }).from(schema.legacyProductMappings).where(and(
      eq(schema.legacyProductMappings.organizationId, KE_ORGANIZATION.id),
      eq(schema.legacyProductMappings.sourceSystem, LEGACY_SOURCE),
    ))
    existingImports = await db.select({
      legacyOrderId: schema.legacyOrderImports.legacyOrderId,
      sourceChecksum: schema.legacyOrderImports.sourceChecksum,
      orderId: schema.legacyOrderImports.orderId,
    }).from(schema.legacyOrderImports).where(and(
      eq(schema.legacyOrderImports.organizationId, KE_ORGANIZATION.id),
      eq(schema.legacyOrderImports.sourceSystem, LEGACY_SOURCE),
    ))
    if (!userLedgerInstalled) {
      mappingErrors.push("legacy import ledger is partially installed: legacy_user_mappings is missing")
    } else {
      existingUserMappings = await db.select({
        legacyOrderTakerId: schema.legacyUserMappings.legacyOrderTakerId,
        branchId: schema.legacyUserMappings.branchId,
        sourceName: schema.legacyUserMappings.sourceName,
        userId: schema.legacyUserMappings.userId,
        isSynthetic: schema.legacyUserMappings.isSynthetic,
      }).from(schema.legacyUserMappings).where(and(
        eq(schema.legacyUserMappings.organizationId, KE_ORGANIZATION.id),
        eq(schema.legacyUserMappings.sourceSystem, LEGACY_SOURCE),
      ))
    }
  }

  const productById = new Map(dbProducts.map((row) => [row.id, row]))
  const anyOrgInventoryById = new Map(dbOrgInventory.map((row) => [row.id, row]))
  existingMappings = existingMappings.filter((mapping) => {
    const product = productById.get(mapping.globalProductId)
    const orgInventory = anyOrgInventoryById.get(mapping.organizationInventoryId)
    const valid = Boolean(
      product
      && orgInventory
      && orgInventory.organizationId === KE_ORGANIZATION.id
      && orgInventory.globalProductId === mapping.globalProductId
      && orgInventory.deletedAt === null,
    )
    if (!valid) mappingErrors.push(`${mapping.normalizedName}: ledger mapping references a missing, deleted, or cross-tenant assignment`)
    return valid
  })

  const branchesByName = new Map<string, DbBranch[]>()
  for (const branch of dbBranches) {
    const key = normalizeBranch(branch.name)
    branchesByName.set(key, [...(branchesByName.get(key) ?? []), branch])
  }

  const branchResolution = new Map<number, DbBranch>()
  const branchErrors: string[] = []
  for (const order of source.prepared) {
    const sourceBranchKey = normalizeBranch(order.branchName)
    const lookupKey = overrides.values.branchAliases[sourceBranchKey] ?? sourceBranchKey
    const candidates = branchesByName.get(lookupKey) ?? []
    const branch = uniqueBy(candidates, (row) => String(row.id))
    if (!branch) branchErrors.push(`order ${order.legacyOrderId}: branch "${order.branchName}" matched ${candidates.length}`)
    else if (branch.organizationId !== KE_ORGANIZATION.id) branchErrors.push(`order ${order.legacyOrderId}: cross-tenant branch ${branch.id}`)
    else branchResolution.set(order.legacyOrderId, branch)
  }

  const activeDbUsers = dbUsers.filter((user) => user.isActive && user.deletedAt === null)
  const dbUserById = new Map(dbUsers.map((user) => [user.id, user]))
  const userMappingKey = (legacyOrderTakerId: number, branchId: number) => `${legacyOrderTakerId}:${branchId}`
  const existingUserMappingByKey = new Map<string, typeof existingUserMappings[number]>()
  for (const mapping of existingUserMappings) {
    const user = dbUserById.get(mapping.userId)
    const branch = dbBranches.find((row) => row.id === mapping.branchId)
    if (!user
      || user.organizationId !== KE_ORGANIZATION.id
      || user.branchId !== mapping.branchId
      || user.roleName !== "ORDER_PORTAL"
      || user.deletedAt !== null
      || !branch
      || branch.organizationId !== KE_ORGANIZATION.id) {
      mappingErrors.push(`legacy user ${mapping.legacyOrderTakerId} / branch ${mapping.branchId}: mapping references a missing, deleted, wrong-role, or cross-tenant user`)
      continue
    }
    existingUserMappingByKey.set(userMappingKey(mapping.legacyOrderTakerId, mapping.branchId), mapping)
  }

  const usersByBranchAndName = new Map<string, DbUser[]>()
  for (const user of activeDbUsers) {
    const names = new Set([
      normalizeText(user.fullName),
      normalizeText(`${user.firstName ?? ""} ${user.lastName ?? ""}`),
      normalizeText(user.firstName),
    ].filter(Boolean))
    for (const name of names) {
      const key = `${user.branchId}|${name}`
      usersByBranchAndName.set(key, [...(usersByBranchAndName.get(key) ?? []), user])
    }
  }

  const userResolution = new Map<number, DbUser>()
  const userResolutionKind = new Map<number, "LEDGER" | "OVERRIDE" | "EXACT">()
  const historicalUserPlansByKey = new Map<string, HistoricalUserPlan>()
  const historicalUserPlanByOrderId = new Map<number, HistoricalUserPlan>()
  const userErrors: string[] = []
  for (const order of source.prepared) {
    const branch = branchResolution.get(order.legacyOrderId)
    if (!branch) continue
    const legacyOrderTakerId = Number(order.sourceHeader.OrderTakerID)
    const mappingKey = userMappingKey(legacyOrderTakerId, branch.id)
    const existingUserMapping = existingUserMappingByKey.get(mappingKey)
    const overrideUserId = overrides.values.usersByLegacyOrderTakerId[String(legacyOrderTakerId)]
    if (existingUserMapping) {
      if (overrideUserId && overrideUserId !== existingUserMapping.userId) {
        userErrors.push(`order ${order.legacyOrderId}: override user ${overrideUserId} conflicts with ledger user ${existingUserMapping.userId}`)
      } else {
        userResolution.set(order.legacyOrderId, dbUserById.get(existingUserMapping.userId)!)
        userResolutionKind.set(order.legacyOrderId, "LEDGER")
      }
      continue
    }
    if (overrideUserId) {
      const overrideUser = activeDbUsers.find((user) => user.id === overrideUserId)
      if (!overrideUser) {
        userErrors.push(`order ${order.legacyOrderId}: override user ${overrideUserId} is not an active K-Electric ORDER_PORTAL user`)
      } else if (overrideUser.branchId !== branch.id) {
        userErrors.push(`order ${order.legacyOrderId}: override user ${overrideUserId} belongs to branch ${overrideUser.branchId}, expected ${branch.id}`)
      } else {
        userResolution.set(order.legacyOrderId, overrideUser)
        userResolutionKind.set(order.legacyOrderId, "OVERRIDE")
      }
      continue
    }
    const candidates = usersByBranchAndName.get(`${branch.id}|${normalizeText(order.userName)}`) ?? []
    const user = uniqueBy(candidates, (row) => row.id)
    if (!user && opts.allowHistoricalUsers) {
      const username = `legacy_ke_${branch.id}_${legacyOrderTakerId}`
      const existingUsername = allUsernames.find((row) => normalizeText(row.username) === normalizeText(username))
      if (existingUsername) {
        userErrors.push(`order ${order.legacyOrderId}: proposed historical username ${username} already belongs to user ${existingUsername.id} in organization ${existingUsername.organizationId}`)
        continue
      }
      const sourceName = String(order.sourceHeader.UserDetails || order.userName).trim().replace(/\s+-\s*$/, "")
      const existingPlan = historicalUserPlansByKey.get(mappingKey)
      if (existingPlan && normalizeText(existingPlan.sourceName) !== normalizeText(sourceName)) {
        userErrors.push(`order ${order.legacyOrderId}: legacy user ${legacyOrderTakerId} has conflicting names "${existingPlan.sourceName}" and "${sourceName}" in ${branch.name}`)
        continue
      }
      const plan = existingPlan ?? {
        key: mappingKey,
        legacyOrderTakerId,
        branchId: branch.id,
        branchName: branch.name,
        sourceName,
        username,
        email: `${username}@historical.invalid`,
        orderIds: [],
      }
      plan.orderIds.push(order.legacyOrderId)
      historicalUserPlansByKey.set(mappingKey, plan)
      historicalUserPlanByOrderId.set(order.legacyOrderId, plan)
      continue
    }
    if (!user) userErrors.push(`order ${order.legacyOrderId}: user "${order.userName}" in ${branch.name} matched ${candidates.length}`)
    else if (user.organizationId !== KE_ORGANIZATION.id || user.branchId !== branch.id || !user.isActive) {
      userErrors.push(`order ${order.legacyOrderId}: user ${user.id} failed tenant/branch/active gate`)
    } else {
      userResolution.set(order.legacyOrderId, user)
      userResolutionKind.set(order.legacyOrderId, "EXACT")
    }
  }

  const resolvedUserMappingsByKey = new Map<string, ResolvedUserMappingPlan>()
  for (const order of source.prepared) {
    const user = userResolution.get(order.legacyOrderId)
    const kind = userResolutionKind.get(order.legacyOrderId)
    const branch = branchResolution.get(order.legacyOrderId)
    if (!user || !kind || kind === "LEDGER" || !branch) continue
    const legacyOrderTakerId = Number(order.sourceHeader.OrderTakerID)
    const key = userMappingKey(legacyOrderTakerId, branch.id)
    const candidate: ResolvedUserMappingPlan = {
      key,
      legacyOrderTakerId,
      branchId: branch.id,
      sourceName: String(order.sourceHeader.UserDetails || order.userName).trim().replace(/\s+-\s*$/, ""),
      userId: user.id,
      kind,
    }
    const existing = resolvedUserMappingsByKey.get(key)
    if (existing && existing.userId !== candidate.userId) {
      userErrors.push(`legacy user ${legacyOrderTakerId} / branch ${branch.id} resolves to conflicting users ${existing.userId} and ${candidate.userId}`)
    } else {
      resolvedUserMappingsByKey.set(key, candidate)
    }
  }
  for (const key of historicalUserPlansByKey.keys()) {
    if (resolvedUserMappingsByKey.has(key)) {
      userErrors.push(`legacy user mapping ${key} is split between an existing user and a proposed historical user`)
    }
  }

  const productFacts = new Map<string, { sourceName: string; codes: Set<string>; latestAt: Date; latestPriceCents: number }>()
  for (const order of source.prepared) {
    for (const line of order.lines) {
      const current = productFacts.get(line.normalizedName)
      if (!current || order.createdAt > current.latestAt) {
        productFacts.set(line.normalizedName, {
          sourceName: line.sourceName,
          codes: new Set([...(current?.codes ?? []), ...line.sourceCodes]),
          latestAt: order.createdAt,
          latestPriceCents: line.priceCents,
        })
      } else {
        line.sourceCodes.forEach((code) => current.codes.add(code))
      }
    }
  }

  const mappingByName = new Map(existingMappings.map((row) => [row.normalizedName, row]))
  const orgInventoryByProduct = new Map(dbOrgInventory.filter((row) => row.deletedAt === null).map((row) => [row.globalProductId, row.id]))
  const deletedOrgInventoryProducts = new Set(dbOrgInventory.filter((row) => row.deletedAt !== null).map((row) => row.globalProductId))
  const productsByName = new Map<string, typeof dbProducts>()
  const productsByCode = new Map<string, typeof dbProducts>()
  for (const product of dbProducts) {
    const name = normalizeProductName(product.name)
    const code = normalizeText(product.productCode)
    productsByName.set(name, [...(productsByName.get(name) ?? []), product])
    productsByCode.set(code, [...(productsByCode.get(code) ?? []), product])
  }
  let nextCanonicalProductCode = dbProducts.reduce((maximum, product) => {
    const number = canonicalKeProductCodeNumber(product.productCode)
    return number === undefined ? maximum : Math.max(maximum, number)
  }, 0) + 1
  const reserveCanonicalProductCode = (): string => {
    while (productsByCode.has(normalizeText(`PRD--${nextCanonicalProductCode}`))) {
      nextCanonicalProductCode += 1
    }
    const code = `PRD--${nextCanonicalProductCode}`
    nextCanonicalProductCode += 1
    productsByCode.set(normalizeText(code), [])
    return code
  }

  const productResolutions: ProductResolution[] = []
  for (const [normalizedName, fact] of productFacts) {
    const mapped = mappingByName.get(normalizedName)
    const overrideProductId = overrides.values.productsByNormalizedName[normalizedName]
    if (mapped) {
      if (overrideProductId && overrideProductId !== mapped.globalProductId) {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, kind: "CONFLICT", reason: `override product ${overrideProductId} conflicts with existing legacy mapping ${mapped.globalProductId}` })
      } else {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, globalProductId: mapped.globalProductId, organizationInventoryId: mapped.organizationInventoryId, existingProductCode: productById.get(mapped.globalProductId)?.productCode, kind: "EXISTING_MAPPING" })
      }
      continue
    }
    if (overrideProductId) {
      const product = productById.get(overrideProductId)
      if (!product) {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, kind: "CONFLICT", reason: `override product ${overrideProductId} is missing or soft-deleted` })
      } else if (deletedOrgInventoryProducts.has(product.id) && !orgInventoryByProduct.has(product.id)) {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, kind: "CONFLICT", reason: `override product ${product.id} has a soft-deleted K-Electric organization assignment` })
      } else {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, globalProductId: product.id, organizationInventoryId: orgInventoryByProduct.get(product.id), existingProductCode: product.productCode, kind: "MANUAL_OVERRIDE" })
      }
      continue
    }
    const codeMatches = [...fact.codes].flatMap((code) => productsByCode.get(normalizeText(code)) ?? [])
    const uniqueCode = uniqueBy(codeMatches, (row) => String(row.id))
    const nameMatches = productsByName.get(normalizedName) ?? []
    const uniqueName = uniqueBy(nameMatches, (row) => String(row.id))
    if (uniqueCode && uniqueName && uniqueCode.id !== uniqueName.id) {
      productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, kind: "CONFLICT", reason: `code resolves to ${uniqueCode.id}, name resolves to ${uniqueName.id}` })
    } else if (codeMatches.length > 0 && !uniqueCode) {
      productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, kind: "CONFLICT", reason: "source code matches multiple products" })
    } else if (nameMatches.length > 0 && !uniqueName) {
      productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, kind: "CONFLICT", reason: "normalized name matches multiple products" })
    } else if (uniqueCode || uniqueName) {
      const product = uniqueCode ?? uniqueName!
      if (deletedOrgInventoryProducts.has(product.id) && !orgInventoryByProduct.has(product.id)) {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, kind: "CONFLICT", reason: `product ${product.id} has a soft-deleted K-Electric organization assignment` })
      } else {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, globalProductId: product.id, organizationInventoryId: orgInventoryByProduct.get(product.id), existingProductCode: product.productCode, kind: uniqueCode ? "EXISTING_CODE" : "EXISTING_NAME" })
      }
    } else {
      const proposedProductCode = reserveCanonicalProductCode()
      if ((productsByCode.get(normalizeText(proposedProductCode)) ?? []).length > 0) {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, kind: "CONFLICT", reason: `generated product code ${proposedProductCode} already exists without a legacy mapping` })
      } else {
        productResolutions.push({ normalizedName, sourceName: fact.sourceName, sourceCodes: [...fact.codes], latestPriceCents: fact.latestPriceCents, proposedProductCode, kind: "CREATE" })
      }
    }
  }

  const groupByBranch = new Map<number, Set<string>>()
  for (const order of source.prepared) {
    const branch = branchResolution.get(order.legacyOrderId)
    if (!branch) continue
    const groups = groupByBranch.get(branch.id) ?? new Set<string>()
    groups.add(order.groupName.trim())
    groupByBranch.set(branch.id, groups)
  }
  const groupErrors: string[] = []
  const assignmentErrors: string[] = []
  const existingGroupByName = new Map(dbGroups.map((group) => [normalizeText(group.name), group]))
  for (const [branchId, sourceGroups] of groupByBranch) {
    if (sourceGroups.size !== 1) groupErrors.push(`branch ${branchId} has conflicting source groups: ${[...sourceGroups].join(", ")}`)
    const branch = dbBranches.find((row) => row.id === branchId)!
    const sourceGroupName = [...sourceGroups][0]
    const existingGroup = sourceGroupName ? existingGroupByName.get(normalizeText(sourceGroupName)) : undefined
    if (branch.groupId !== null && branch.groupId !== existingGroup?.id) {
      groupErrors.push(`branch ${branch.name} already belongs to a different group id=${branch.groupId}`)
    }
  }

  const resolutionByName = new Map(productResolutions.map((item) => [item.normalizedName, item]))
  const deletedBranchAssignments = new Set(dbBranchInventory
    .filter((row) => row.deletedAt !== null)
    .map((row) => `${row.branchId}:${row.organizationInventoryId}`))
  for (const order of source.prepared) {
    const branch = branchResolution.get(order.legacyOrderId)
    if (!branch) continue
    for (const line of order.lines) {
      const organizationInventoryId = resolutionByName.get(line.normalizedName)?.organizationInventoryId
      if (organizationInventoryId && deletedBranchAssignments.has(`${branch.id}:${organizationInventoryId}`)) {
        assignmentErrors.push(`${branch.name} / ${line.sourceName}: branch assignment is soft-deleted`)
      }
    }
  }

  const existingByLegacyId = new Map(existingImports.map((row) => [row.legacyOrderId, row]))
  const changedImports: string[] = []
  const tidErrors: string[] = []
  const alreadyImported = new Set<number>()
  for (const order of source.prepared) {
    const existing = existingByLegacyId.get(order.legacyOrderId)
    if (!existing) continue
    if (existing.sourceChecksum !== order.sourceChecksum) changedImports.push(`order ${order.legacyOrderId}: imported source checksum changed`)
    else alreadyImported.add(order.legacyOrderId)
  }
  const importedByOrderId = new Map(existingImports.map((row) => [row.orderId, row]))
  for (const existingOrder of dbLegacyTids) {
    const imported = importedByOrderId.get(existingOrder.id)
    if (!imported
      || existingOrder.organizationId !== KE_ORGANIZATION.id
      || existingOrder.tid !== `KE-LEGACY-${imported.legacyOrderId}`) {
      tidErrors.push(`${existingOrder.tid}: collides with order ${existingOrder.id} (organization ${existingOrder.organizationId}) outside this import ledger`)
    }
  }

  const productConflicts = productResolutions.filter((item) => item.kind === "CONFLICT")
  const newProducts = productResolutions.filter((item) => item.kind === "CREATE")
  const readyOrders = source.prepared.filter((order) =>
    branchResolution.has(order.legacyOrderId)
    && (userResolution.has(order.legacyOrderId) || historicalUserPlanByOrderId.has(order.legacyOrderId))
    && !alreadyImported.has(order.legacyOrderId),
  )
  const historicalUserPlans = [...historicalUserPlansByKey.values()].sort((a, b) => a.key.localeCompare(b.key))
  const blocked = branchErrors.length + userErrors.length + groupErrors.length + assignmentErrors.length + productConflicts.length + mappingErrors.length + changedImports.length + tidErrors.length

  console.log("\nK-Electric legacy import preflight")
  console.log("----------------------------------")
  console.log(`Mode                     : ${opts.commit ? "COMMIT REQUESTED" : "DRY RUN (read-only)"}`)
  console.log(`Organization verified    : ${organization.name} (id=${organization.id}, code=${organization.code})`)
  console.log(`Manifest confirmation    : ${digest}`)
  console.log(`Ledger migration present : ${ledgerInstalled}`)
  console.log(`User ledger present      : ${userLedgerInstalled}`)
  console.log(`Source counts            : ${JSON.stringify(source.sourceCounts)}`)
  console.log(`Financially safe orders  : ${source.prepared.length}`)
  console.log(`Source exclusions        : ${JSON.stringify(rejectionCounts(source.rejected))}`)
  console.log(`Branches/active users     : ${dbBranches.length}/${activeDbUsers.length}`)
  console.log(`Products                 : ${productResolutions.length}`)
  console.log(`Existing/new/conflicts   : ${productResolutions.length - newProducts.length - productConflicts.length}/${newProducts.length}/${productConflicts.length}`)
  console.log(`Historical users proposed: ${historicalUserPlans.length}`)
  console.log(`Already imported         : ${alreadyImported.size}`)
  console.log(`Ready this run           : ${readyOrders.length}`)
  console.log(`Blocking issues          : ${blocked}`)

  const printErrors = (label: string, errors: string[]) => {
    if (!errors.length) return
    console.log(`\n${label} (${errors.length}):`)
    errors.slice(0, 30).forEach((error) => console.log(`  - ${error}`))
    if (errors.length > 30) console.log(`  ... ${errors.length - 30} more`)
  }
  printErrors("Branch mapping errors", branchErrors)
  printErrors("User mapping errors", userErrors)
  printErrors("Group safety errors", groupErrors)
  printErrors("Assignment safety errors", [...new Set(assignmentErrors)])
  printErrors("Product conflicts", productConflicts.map((item) => `${item.sourceName}: ${item.reason}`))
  printErrors("Legacy mapping errors", mappingErrors)
  printErrors("Changed prior imports", changedImports)
  printErrors("Transaction ID collisions", tidErrors)
  if (historicalUserPlans.length > 0) {
    console.log(`\nInactive historical users proposed (${historicalUserPlans.length}):`)
    historicalUserPlans.forEach((plan) => console.log(`  - ${plan.sourceName} | ${plan.branchName} | legacy user ${plan.legacyOrderTakerId} | orders ${plan.orderIds.join(", ")}`))
  }

  if (opts.outputPath) {
    writeFileSync(opts.outputPath, JSON.stringify({
      generatedAt: new Date().toISOString(),
      mode: opts.commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      organization,
      manifestDigest: digest,
      manifest: confirmationManifest,
      sourceCounts: source.sourceCounts,
      financiallySafeOrders: source.prepared.length,
      exclusions: rejectionCounts(source.rejected),
      readyOrderIds: readyOrders.map((order) => order.legacyOrderId),
      historicalUsers: historicalUserPlans,
      products: productResolutions,
      errors: { branchErrors, userErrors, groupErrors, assignmentErrors: [...new Set(assignmentErrors)], mappingErrors, changedImports, tidErrors },
    }, null, 2))
    console.log(`Preflight report written : ${opts.outputPath}`)
  }

  if (!opts.commit) {
    console.log("\nNothing was written to the database.")
    console.log("Do not commit until Blocking issues is 0 and the migration has been reviewed/applied.")
    await pool.end()
    return
  }

  const expectedOrgConfirmation = `${KE_ORGANIZATION.id}:${KE_ORGANIZATION.code}:${KE_ORGANIZATION.name}`
  if (!ledgerInstalled) throw new Error("Legacy import ledger migration is not installed")
  if (!userLedgerInstalled) throw new Error("Legacy user mapping ledger migration is not installed")
  if (blocked !== 0) throw new Error(`Commit refused: ${blocked} blocking preflight issues`)
  if (!opts.actorUserId) throw new Error("Commit requires --actor-user-id")
  if (opts.confirmOrganization !== expectedOrgConfirmation) throw new Error(`Commit requires --confirm-organization=${expectedOrgConfirmation}`)
  if (opts.confirmManifest !== digest) throw new Error("Manifest confirmation does not match the current report files")
  if (opts.expectedOrders !== readyOrders.length) throw new Error(`Commit requires --expected-orders=${readyOrders.length}`)
  if (readyOrders.length === 0) throw new Error("Commit refused: there are no new orders to import")
  if (newProducts.length > 0 && !opts.allowNewProducts) throw new Error(`Commit would create ${newProducts.length} products; pass --allow-new-products after review`)
  if (historicalUserPlans.length > 0 && !opts.allowHistoricalUsers) {
    throw new Error(`Commit would create ${historicalUserPlans.length} inactive historical users; pass --allow-historical-users after review`)
  }

  const actor = await db.select({ id: schema.users.id, isActive: schema.users.isActive, roleName: schema.roles.name })
    .from(schema.users)
    .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
    .where(and(eq(schema.users.id, opts.actorUserId), eq(schema.users.isActive, true), isNull(schema.users.deletedAt)))
    .limit(1)
  if (!actor[0] || actor[0].roleName !== "SUPER_ADMIN") throw new Error("Actor must be an active SUPER_ADMIN")

  const [orderPortalRole] = await db.select({ id: schema.roles.id })
    .from(schema.roles)
    .where(eq(schema.roles.name, "ORDER_PORTAL"))
    .limit(1)
  if (!orderPortalRole) throw new Error("ORDER_PORTAL role is missing")

  const historicalPasswordHashes = new Map<string, string>()
  if (historicalUserPlans.length > 0) {
    const bcrypt = await import("bcryptjs")
    for (const plan of historicalUserPlans) {
      const randomUnrecoverablePassword = randomBytes(48).toString("base64url")
      historicalPasswordHashes.set(plan.key, await bcrypt.default.hash(randomUnrecoverablePassword, 12))
    }
  }

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(1263482710, ${KE_ORGANIZATION.id})`)

    // Hold shared locks during the historical insert. This prevents a current
    // order from changing an operational ledger between the before/after checks.
    const existingProductIds = [...new Set(productResolutions.flatMap((item) => item.globalProductId ? [item.globalProductId] : []))]
    const lockedBudgets = await tx.select({
      id: schema.budgets.id,
      allocated: schema.budgets.amountAllocatedCents,
      spent: schema.budgets.amountSpentCents,
      held: schema.budgets.amountHeldCents,
      credited: schema.budgets.amountCreditedCents,
    }).from(schema.budgets).where(eq(schema.budgets.organizationId, KE_ORGANIZATION.id)).orderBy(schema.budgets.id).for("share")
    const lockedQuantityBudgets = await tx.select({
      id: schema.productQuantityBudgets.id,
      allocated: schema.productQuantityBudgets.allocatedQuantity,
      held: schema.productQuantityBudgets.heldQuantity,
      used: schema.productQuantityBudgets.usedQuantity,
      credited: schema.productQuantityBudgets.creditedQuantity,
    }).from(schema.productQuantityBudgets).where(eq(schema.productQuantityBudgets.organizationId, KE_ORGANIZATION.id)).orderBy(schema.productQuantityBudgets.id).for("share")
    const lockedInvoiceSequence = await tx.select({
      organizationId: schema.invoiceSequences.organizationId,
      lastValue: schema.invoiceSequences.lastValue,
    }).from(schema.invoiceSequences).where(eq(schema.invoiceSequences.organizationId, KE_ORGANIZATION.id)).orderBy(schema.invoiceSequences.organizationId).for("share")
    const lockedStocks = existingProductIds.length > 0
      ? await tx.select({ id: schema.globalProducts.id, stock: schema.globalProducts.stockQuantity })
        .from(schema.globalProducts).where(inArray(schema.globalProducts.id, existingProductIds)).orderBy(schema.globalProducts.id).for("share")
      : []
    const operationalLedgerDigest = createHash("sha256").update(JSON.stringify({
      budgets: lockedBudgets,
      quantityBudgets: lockedQuantityBudgets,
      invoiceSequence: lockedInvoiceSequence,
      stocks: lockedStocks,
    })).digest("hex")

    const [batch] = await tx.insert(schema.legacyImportBatches).values({
      organizationId: KE_ORGANIZATION.id,
      sourceSystem: LEGACY_SOURCE,
      sourceManifest: { digest, files: confirmationManifest, operationalLedgerDigest },
      importedByUserId: opts.actorUserId!,
      status: "RUNNING",
      counts: {},
    }).returning({ id: schema.legacyImportBatches.id })

    const resolvedUserIdByOrder = new Map<number, string>()
    for (const order of readyOrders) {
      const resolved = userResolution.get(order.legacyOrderId)
      if (resolved) resolvedUserIdByOrder.set(order.legacyOrderId, resolved.id)
    }

    for (const plan of historicalUserPlans) {
      const [createdUser] = await tx.insert(schema.users).values({
        email: plan.email,
        username: plan.username,
        passwordHash: historicalPasswordHashes.get(plan.key)!,
        roleId: orderPortalRole.id,
        isActive: false,
        fullName: plan.sourceName,
        firstName: plan.sourceName,
        lastName: null,
        employeeId: `LEGACY-${plan.legacyOrderTakerId}-${plan.branchId}`,
        organizationId: KE_ORGANIZATION.id,
        branchId: plan.branchId,
        mfaEnabled: false,
        mustChangePassword: true,
        sessionVersion: 1,
      }).returning({
        id: schema.users.id,
        organizationId: schema.users.organizationId,
        branchId: schema.users.branchId,
        isActive: schema.users.isActive,
      })
      if (createdUser.organizationId !== KE_ORGANIZATION.id || createdUser.branchId !== plan.branchId || createdUser.isActive) {
        throw new Error(`Historical user tenant/branch/active validation failed for ${plan.key}`)
      }
      await tx.insert(schema.legacyUserMappings).values({
        organizationId: KE_ORGANIZATION.id,
        sourceSystem: LEGACY_SOURCE,
        legacyOrderTakerId: plan.legacyOrderTakerId,
        branchId: plan.branchId,
        sourceName: plan.sourceName,
        userId: createdUser.id,
        isSynthetic: true,
        createdByBatchId: batch.id,
      })
      for (const orderId of plan.orderIds) resolvedUserIdByOrder.set(orderId, createdUser.id)
    }

    const readyUserMappingKeys = new Set(readyOrders.map((order) => {
      const branch = branchResolution.get(order.legacyOrderId)!
      return userMappingKey(Number(order.sourceHeader.OrderTakerID), branch.id)
    }))
    const resolvedUserMappingValues = [...resolvedUserMappingsByKey.values()]
      .filter((mapping) => readyUserMappingKeys.has(mapping.key))
      .map((mapping) => ({
        organizationId: KE_ORGANIZATION.id,
        sourceSystem: LEGACY_SOURCE,
        legacyOrderTakerId: mapping.legacyOrderTakerId,
        branchId: mapping.branchId,
        sourceName: mapping.sourceName,
        userId: mapping.userId,
        isSynthetic: false,
        createdByBatchId: batch.id,
      }))
    for (const values of chunksOf(resolvedUserMappingValues, 250)) {
      await tx.insert(schema.legacyUserMappings).values(values)
    }

    const productIds = new Map<string, number>()
    const orgInventoryIds = new Map<string, number>()
    for (const resolution of productResolutions) {
      if (resolution.globalProductId) productIds.set(resolution.normalizedName, resolution.globalProductId)
      if (resolution.organizationInventoryId) orgInventoryIds.set(resolution.normalizedName, resolution.organizationInventoryId)
    }
    const newProductValues = productResolutions
      .filter((resolution) => !resolution.globalProductId)
      .map((resolution) => ({
        productCode: resolution.proposedProductCode!,
        name: resolution.sourceName,
        basePrice: resolution.latestPriceCents,
        unit: "unit",
        status: "inactive",
        stockQuantity: 0,
        allowDecimalQuantity: false,
        quantityStep: 1,
        createdByUserId: opts.actorUserId!,
        metadata: { legacySource: LEGACY_SOURCE, normalizedName: resolution.normalizedName, sourceCodes: resolution.sourceCodes, historicalOnly: true },
      }))
    for (const values of chunksOf(newProductValues, 250)) {
      const created = await tx.insert(schema.globalProducts).values(values).returning({
        id: schema.globalProducts.id,
        productCode: schema.globalProducts.productCode,
      })
      const byCode = new Map(created.map((row) => [row.productCode, row.id]))
      for (const resolution of productResolutions) {
        if (resolution.proposedProductCode && byCode.has(resolution.proposedProductCode)) {
          productIds.set(resolution.normalizedName, byCode.get(resolution.proposedProductCode)!)
        }
      }
    }
    if (productIds.size !== productResolutions.length) throw new Error("Bulk global-product creation validation failed")

    const missingOrgInventoryValues = productResolutions
      .filter((resolution) => !orgInventoryIds.has(resolution.normalizedName))
      .map((resolution) => ({
        organizationId: KE_ORGANIZATION.id,
        globalProductId: productIds.get(resolution.normalizedName)!,
        assignedByUserId: opts.actorUserId!,
        isActive: false,
        customPrice: resolution.latestPriceCents,
      }))
    for (const values of chunksOf(missingOrgInventoryValues, 250)) {
      const created = await tx.insert(schema.organizationInventory).values(values).returning({
        id: schema.organizationInventory.id,
        globalProductId: schema.organizationInventory.globalProductId,
      })
      const byProduct = new Map(created.map((row) => [row.globalProductId, row.id]))
      for (const resolution of productResolutions) {
        const globalProductId = productIds.get(resolution.normalizedName)!
        if (byProduct.has(globalProductId)) orgInventoryIds.set(resolution.normalizedName, byProduct.get(globalProductId)!)
      }
    }
    if (orgInventoryIds.size !== productResolutions.length) throw new Error("Bulk organization-inventory creation validation failed")

    const productMappingValues = productResolutions.map((resolution) => ({
        organizationId: KE_ORGANIZATION.id,
        sourceSystem: LEGACY_SOURCE,
        normalizedName: resolution.normalizedName,
        sourceName: resolution.sourceName,
        sourceCodes: resolution.sourceCodes,
        globalProductId: productIds.get(resolution.normalizedName)!,
        organizationInventoryId: orgInventoryIds.get(resolution.normalizedName)!,
      }))
    for (const values of chunksOf(productMappingValues, 250)) {
      await tx.insert(schema.legacyProductMappings).values(values).onConflictDoNothing()
    }

    const groupIds = new Map(existingGroupByName.entries())
    for (const sourceGroups of groupByBranch.values()) {
      const name = [...sourceGroups][0]
      const key = normalizeText(name)
      if (groupIds.has(key)) continue
      const [created] = await tx.insert(schema.groups).values({
        organizationId: KE_ORGANIZATION.id,
        name,
        description: "Imported from K-Electric legacy logistics reports",
        status: "active",
        createdByUserId: opts.actorUserId!,
      }).returning({ id: schema.groups.id, name: schema.groups.name })
      groupIds.set(key, created)
    }
    for (const [branchId, sourceGroups] of groupByBranch) {
      const group = groupIds.get(normalizeText([...sourceGroups][0]))!
      await tx.update(schema.branches).set({ groupId: group.id, updatedAt: new Date() }).where(and(
        eq(schema.branches.id, branchId),
        eq(schema.branches.organizationId, KE_ORGANIZATION.id),
        isNull(schema.branches.groupId),
      ))
    }

    const branchProductPairs = new Map<string, { branchId: number; organizationInventoryId: number }>()
    for (const order of readyOrders) {
      const branch = branchResolution.get(order.legacyOrderId)!
      for (const line of order.lines) {
        const organizationInventoryId = orgInventoryIds.get(line.normalizedName)!
        branchProductPairs.set(`${branch.id}:${organizationInventoryId}`, { branchId: branch.id, organizationInventoryId })
      }
    }
    const branchInventoryValues = [...branchProductPairs.values()].map((pair) => ({
        branchId: pair.branchId,
        organizationId: KE_ORGANIZATION.id,
        organizationInventoryId: pair.organizationInventoryId,
        assignedByUserId: opts.actorUserId!,
        isVisible: false,
        isActive: false,
      }))
    for (const values of chunksOf(branchInventoryValues, 400)) {
      await tx.insert(schema.branchInventory).values(values).onConflictDoNothing()
    }

    const orderValues = readyOrders.map((order) => {
      const branch = branchResolution.get(order.legacyOrderId)!
      const createdByUserId = resolvedUserIdByOrder.get(order.legacyOrderId)
      if (!createdByUserId) throw new Error(`No creator resolved for legacy order ${order.legacyOrderId}`)
      const tid = `KE-LEGACY-${order.legacyOrderId}`
      return {
        tid,
        organizationId: KE_ORGANIZATION.id,
        branchId: branch.id,
        status: "FULFILLED",
        fulfillmentStatus: "DELIVERED",
        paymentStatus: "UNPAID",
        subtotalCents: order.subtotalCents,
        taxCents: order.taxCents,
        totalCents: order.totalCents,
        notes: `Historical import from ${LEGACY_SOURCE}; legacy order ${order.legacyOrderId}`,
        createdByUserId,
        createdAt: order.createdAt,
        deliveredAt: order.fulfilledAt,
        fulfilledAt: order.fulfilledAt,
        updatedAt: order.fulfilledAt,
        receiptData: buildReceipt(order, branch, productIds) as any,
      }
    })
    const orderIdByLegacyId = new Map<number, number>()
    // Production may temporarily lag additive application columns such as
    // idempotency_key/request_fingerprint. Historical imports do not use those
    // fields, so name only the stable physical columns required by this
    // K-Electric transaction instead of asking Drizzle to emit every modeled
    // orders column with DEFAULT.
    for (const orderValue of orderValues) {
      const result = await tx.execute<{ id: number; tid: string }>(sql`
        insert into orders (
          tid, organization_id, branch_id, status, fulfillment_status,
          payment_status, subtotal_cents, tax_cents, total_cents, notes,
          created_by_user_id, created_at, fulfilled_at, updated_at, receipt_data
        ) values (
          ${orderValue.tid}, ${orderValue.organizationId}, ${orderValue.branchId},
          ${orderValue.status}, ${orderValue.fulfillmentStatus},
          ${orderValue.paymentStatus}, ${orderValue.subtotalCents},
          ${orderValue.taxCents}, ${orderValue.totalCents}, ${orderValue.notes},
          ${orderValue.createdByUserId}, ${orderValue.createdAt},
          ${orderValue.fulfilledAt}, ${orderValue.updatedAt},
          ${JSON.stringify(orderValue.receiptData)}::jsonb
        )
        returning id, tid
      `)
      const row = result.rows[0]
      const legacyOrderId = Number(row?.tid?.replace(/^KE-LEGACY-/, ""))
      if (!row || !Number.isSafeInteger(legacyOrderId)) {
        throw new Error(`Unexpected TID returned from historical order insert: ${row?.tid ?? "missing"}`)
      }
      orderIdByLegacyId.set(legacyOrderId, row.id)
    }
    if (orderIdByLegacyId.size !== readyOrders.length) throw new Error("Bulk order creation count validation failed")

    const productCodeByName = new Map(productResolutions.map((item) => [
      item.normalizedName,
      item.existingProductCode ?? item.proposedProductCode ?? null,
    ]))
    const orderItemValues = readyOrders.flatMap((order) => {
      const orderId = orderIdByLegacyId.get(order.legacyOrderId)!
      return order.lines.map((line) => ({
        organizationId: KE_ORGANIZATION.id,
        organizationInventoryId: orgInventoryIds.get(line.normalizedName)!,
        orderId,
        globalProductId: productIds.get(line.normalizedName)!,
        productName: line.sourceName,
        productCode: productCodeByName.get(line.normalizedName) ?? null,
        unit: "unit",
        quantity: line.quantity,
        priceCents: line.priceCents,
        createdAt: order.createdAt,
      }))
    })
    for (const values of chunksOf(orderItemValues, 400)) {
      await tx.insert(schema.orderItems).values(values)
    }

    const legacyOrderImportValues = readyOrders.map((order) => ({
        batchId: batch.id,
        organizationId: KE_ORGANIZATION.id,
        sourceSystem: LEGACY_SOURCE,
        legacyOrderId: order.legacyOrderId,
        orderId: orderIdByLegacyId.get(order.legacyOrderId)!,
        sourceChecksum: order.sourceChecksum,
        sourcePayload: { pricingMethod: order.pricingMethod, sourceHeader: order.sourceHeader },
      }))
    for (const values of chunksOf(legacyOrderImportValues, 250)) {
      await tx.insert(schema.legacyOrderImports).values(values)
    }

    const batchUserMappings = await tx.select({
      legacyOrderTakerId: schema.legacyUserMappings.legacyOrderTakerId,
      mappingBranchId: schema.legacyUserMappings.branchId,
      userId: schema.legacyUserMappings.userId,
      isSynthetic: schema.legacyUserMappings.isSynthetic,
      userOrganizationId: schema.users.organizationId,
      userBranchId: schema.users.branchId,
      userRole: schema.roles.name,
      userIsActive: schema.users.isActive,
      userDeletedAt: schema.users.deletedAt,
      branchOrganizationId: schema.branches.organizationId,
    }).from(schema.legacyUserMappings)
      .innerJoin(schema.users, eq(schema.legacyUserMappings.userId, schema.users.id))
      .innerJoin(schema.roles, eq(schema.users.roleId, schema.roles.id))
      .innerJoin(schema.branches, eq(schema.legacyUserMappings.branchId, schema.branches.id))
      .where(and(
        eq(schema.legacyUserMappings.createdByBatchId, batch.id),
        eq(schema.legacyUserMappings.organizationId, KE_ORGANIZATION.id),
        eq(schema.legacyUserMappings.sourceSystem, LEGACY_SOURCE),
      ))
    const expectedNewMappingCount = historicalUserPlans.length
      + [...resolvedUserMappingsByKey.values()].filter((mapping) => readyUserMappingKeys.has(mapping.key)).length
    if (batchUserMappings.length !== expectedNewMappingCount
      || batchUserMappings.filter((mapping) => mapping.isSynthetic).length !== historicalUserPlans.length
      || batchUserMappings.some((mapping) =>
        mapping.userOrganizationId !== KE_ORGANIZATION.id
        || mapping.branchOrganizationId !== KE_ORGANIZATION.id
        || mapping.userBranchId !== mapping.mappingBranchId
        || mapping.userRole !== "ORDER_PORTAL"
        || (mapping.isSynthetic && mapping.userIsActive)
        || mapping.userDeletedAt !== null)) {
      throw new Error("Post-insert historical user mapping validation failed; rolling back")
    }

    const persistedProductMappings = await tx.select({
      normalizedName: schema.legacyProductMappings.normalizedName,
      globalProductId: schema.legacyProductMappings.globalProductId,
      organizationInventoryId: schema.legacyProductMappings.organizationInventoryId,
    }).from(schema.legacyProductMappings).where(and(
      eq(schema.legacyProductMappings.organizationId, KE_ORGANIZATION.id),
      eq(schema.legacyProductMappings.sourceSystem, LEGACY_SOURCE),
    ))
    const persistedProductMappingByName = new Map(persistedProductMappings.map((mapping) => [mapping.normalizedName, mapping]))
    if (productResolutions.some((resolution) => {
      const persisted = persistedProductMappingByName.get(resolution.normalizedName)
      return !persisted
        || persisted.globalProductId !== productIds.get(resolution.normalizedName)
        || persisted.organizationInventoryId !== orgInventoryIds.get(resolution.normalizedName)
    })) {
      throw new Error("Post-insert product mapping validation failed; rolling back")
    }

    const persistedBranchAssignments = await tx.select({
      branchId: schema.branchInventory.branchId,
      organizationInventoryId: schema.branchInventory.organizationInventoryId,
      organizationId: schema.branchInventory.organizationId,
      deletedAt: schema.branchInventory.deletedAt,
    }).from(schema.branchInventory).where(eq(schema.branchInventory.organizationId, KE_ORGANIZATION.id))
    const persistedBranchAssignmentKeys = new Set(persistedBranchAssignments
      .filter((assignment) => assignment.organizationId === KE_ORGANIZATION.id && assignment.deletedAt === null)
      .map((assignment) => `${assignment.branchId}:${assignment.organizationInventoryId}`))
    if ([...branchProductPairs.keys()].some((key) => !persistedBranchAssignmentKeys.has(key))) {
      throw new Error("Post-insert branch product assignment validation failed; rolling back")
    }

    await tx.insert(schema.auditLogs).values({
      userId: opts.actorUserId!,
      organizationId: KE_ORGANIZATION.id,
      action: "LEGACY_ORDER_IMPORT",
      entity: "legacy_import_batch",
      entityId: batch.id,
      metadata: { source: LEGACY_SOURCE, digest, orderCount: readyOrders.length, newProducts: newProducts.length, newHistoricalUsers: historicalUserPlans.length, stockOrBudgetChanged: false },
    })
    await tx.update(schema.legacyImportBatches).set({
      status: "COMPLETED",
      completedAt: new Date(),
      counts: { orders: readyOrders.length, products: productResolutions.length, newProducts: newProducts.length, newHistoricalUsers: historicalUserPlans.length },
    }).where(eq(schema.legacyImportBatches.id, batch.id))

    const [validation] = await tx.select({
      orders: sql<number>`COUNT(*)::int`,
      totalCents: sql<number>`COALESCE(SUM(${schema.orders.totalCents}), 0)`.mapWith(Number),
    }).from(schema.legacyOrderImports)
      .innerJoin(schema.orders, eq(schema.legacyOrderImports.orderId, schema.orders.id))
      .where(and(
        eq(schema.legacyOrderImports.batchId, batch.id),
        eq(schema.legacyOrderImports.organizationId, KE_ORGANIZATION.id),
        eq(schema.orders.organizationId, KE_ORGANIZATION.id),
      ))
    const expectedTotalCents = readyOrders.reduce((sum, order) => sum + order.totalCents, 0)
    if (validation.orders !== readyOrders.length || validation.totalCents !== expectedTotalCents) {
      throw new Error("Post-insert order count/total validation failed; rolling back")
    }
    const [itemValidation] = await tx.select({
      items: sql<number>`COUNT(*)::int`,
      subtotalCents: sql<number>`COALESCE(SUM(ROUND(${schema.orderItems.quantity} * ${schema.orderItems.priceCents})), 0)`.mapWith(Number),
    }).from(schema.legacyOrderImports)
      .innerJoin(schema.orderItems, eq(schema.legacyOrderImports.orderId, schema.orderItems.orderId))
      .where(and(
        eq(schema.legacyOrderImports.batchId, batch.id),
        eq(schema.legacyOrderImports.organizationId, KE_ORGANIZATION.id),
        eq(schema.orderItems.organizationId, KE_ORGANIZATION.id),
      ))
    const expectedItemCount = readyOrders.reduce((sum, order) => sum + order.lines.length, 0)
    const expectedSubtotalCents = readyOrders.reduce((sum, order) => sum + order.subtotalCents, 0)
    if (itemValidation.items !== expectedItemCount || itemValidation.subtotalCents !== expectedSubtotalCents) {
      throw new Error("Post-insert order-item count/subtotal validation failed; rolling back")
    }

    const afterBudgets = await tx.select({
      id: schema.budgets.id,
      allocated: schema.budgets.amountAllocatedCents,
      spent: schema.budgets.amountSpentCents,
      held: schema.budgets.amountHeldCents,
      credited: schema.budgets.amountCreditedCents,
    }).from(schema.budgets).where(eq(schema.budgets.organizationId, KE_ORGANIZATION.id)).orderBy(schema.budgets.id)
    const afterQuantityBudgets = await tx.select({
      id: schema.productQuantityBudgets.id,
      allocated: schema.productQuantityBudgets.allocatedQuantity,
      held: schema.productQuantityBudgets.heldQuantity,
      used: schema.productQuantityBudgets.usedQuantity,
      credited: schema.productQuantityBudgets.creditedQuantity,
    }).from(schema.productQuantityBudgets).where(eq(schema.productQuantityBudgets.organizationId, KE_ORGANIZATION.id)).orderBy(schema.productQuantityBudgets.id)
    const afterInvoiceSequence = await tx.select({
      organizationId: schema.invoiceSequences.organizationId,
      lastValue: schema.invoiceSequences.lastValue,
    }).from(schema.invoiceSequences).where(eq(schema.invoiceSequences.organizationId, KE_ORGANIZATION.id)).orderBy(schema.invoiceSequences.organizationId)
    const afterStocks = existingProductIds.length > 0
      ? await tx.select({ id: schema.globalProducts.id, stock: schema.globalProducts.stockQuantity })
        .from(schema.globalProducts).where(inArray(schema.globalProducts.id, existingProductIds)).orderBy(schema.globalProducts.id)
      : []
    const afterLedgerDigest = createHash("sha256").update(JSON.stringify({
      budgets: afterBudgets,
      quantityBudgets: afterQuantityBudgets,
      invoiceSequence: afterInvoiceSequence,
      stocks: afterStocks,
    })).digest("hex")
    if (afterLedgerDigest !== operationalLedgerDigest) {
      throw new Error("Operational stock/budget/invoice ledger changed; rolling back")
    }
  })

  console.log(`\nCommitted ${readyOrders.length} K-Electric historical orders atomically.`)
  await pool.end()
}

function safeImportError(error: unknown): Record<string, unknown> {
  const top = error && typeof error === "object" ? error as Record<string, unknown> : {}
  const cause = top.cause && typeof top.cause === "object" ? top.cause as Record<string, unknown> : {}
  const safe = {
    message: cause.message ?? top.message ?? String(error),
    code: cause.code,
    detail: cause.detail,
    constraint: cause.constraint,
    table: cause.table,
    column: cause.column,
  }
  return Object.fromEntries(Object.entries(safe).filter(([, value]) => value !== undefined))
}

main().catch(async (error) => {
  console.error(`\nImport failed: ${JSON.stringify(safeImportError(error))}`)
  process.exitCode = 1
})
