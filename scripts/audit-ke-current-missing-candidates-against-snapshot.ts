#!/usr/bin/env tsx

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

type Row = Record<string, any>

const SNAPSHOT = resolve("backups/ke-import-state-2026-08-03-post-live-resolved-13-orders.json")
const LIVE_AUDIT = resolve("updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")
const NORMAL_SOURCE = resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04/reports")
const OUTPUT = resolve("updatedReports/ke-current-missing-safe-candidates-2026-08-04/target-snapshot-assessment.json")
const NORMAL_IDS = [250, 765, 1164, 1165, 1177, 1187]
const REFUND_IDS = [520]

function normalize(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/[\u2018\u2019]/g, "'").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim().toLowerCase()
}

function normalizeProduct(value: unknown): string {
  return normalize(value).replace(/\s*\(\s*/g, " (").replace(/\s*\)\s*/g, ")").replace(/\s*-\s*/g, "-")
}

function normalizeBranch(value: unknown): string {
  const result = normalize(value)
  return result === "1. gso" ? "gso" : result
}

function main() {
  const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8")) as Row
  const live = JSON.parse(readFileSync(LIVE_AUDIT, "utf8")) as Row
  const normalHeaders = JSON.parse(readFileSync(resolve(NORMAL_SOURCE, "order.json"), "utf8")) as Row[]
  const normalLines = JSON.parse(readFileSync(resolve(NORMAL_SOURCE, "sales-report.json"), "utf8")) as Row[]
  const liveById = new Map((live.orders as Row[]).map((row) => [Number(row.legacyOrderId), row]))
  const branchByName = new Map<string, Row[]>()
  for (const branch of snapshot.branches as Row[]) {
    const key = normalizeBranch(branch.name)
    branchByName.set(key, [...(branchByName.get(key) ?? []), branch])
  }
  const productMappings = new Map((snapshot.legacyProductMappings as Row[])
    .filter((row) => row.organization_id === 10 && row.source_system === "KE_LOGISTICS")
    .map((row) => [String(row.normalized_name), row]))
  const productsByName = new Map<string, Row[]>()
  for (const product of (snapshot.globalProducts as Row[]).filter((row) => row.deleted_at == null)) {
    const key = normalizeProduct(product.name)
    productsByName.set(key, [...(productsByName.get(key) ?? []), product])
  }
  const orgInventoryByProduct = new Map((snapshot.organizationInventory as Row[])
    .filter((row) => row.organization_id === 10 && row.deleted_at == null)
    .map((row) => [Number(row.global_product_id), row]))
  const importById = new Map((snapshot.legacyOrderImports as Row[]).map((row) => [Number(row.legacy_order_id), row]))
  const orderByTid = new Map((snapshot.orders as Row[]).map((row) => [String(row.tid), row]))
  const userById = new Map((snapshot.users as Row[]).map((row) => [String(row.id), row]))
  const groupById = new Map((snapshot.groups as Row[]).map((row) => [Number(row.id), row]))

  function resolveBranch(name: string): { branch: Row | null; error: string | null } {
    const matches = branchByName.get(normalizeBranch(name)) ?? []
    return matches.length === 1 ? { branch: matches[0], error: null } : { branch: null, error: `BRANCH_MATCH_COUNT_${matches.length}` }
  }

  function resolveUser(legacyOrderTakerId: number, branch: Row, sourceName: string): Row {
    const mappings = (snapshot.legacyUserMappings as Row[]).filter((row) => row.organization_id === 10
      && row.source_system === "KE_LOGISTICS"
      && Number(row.legacy_order_taker_id) === legacyOrderTakerId
      && Number(row.branch_id) === Number(branch.id))
    if (mappings.length === 1) {
      const user = userById.get(String(mappings[0].user_id))
      const valid = user && user.organization_id === 10 && Number(user.branch_id) === Number(branch.id) && user.role_name === "ORDER_PORTAL" && user.deleted_at == null
      return { kind: valid ? "EXISTING_LEDGER_MAPPING" : "INVALID_LEDGER_MAPPING", mapping: mappings[0], user: user ?? null, valid: Boolean(valid) }
    }
    const exact = (snapshot.users as Row[]).filter((user) => user.organization_id === 10 && Number(user.branch_id) === Number(branch.id)
      && user.role_name === "ORDER_PORTAL" && user.deleted_at == null && user.is_active === true && normalize(user.full_name) === normalize(sourceName))
    if (exact.length === 1) return { kind: "EXACT_ACTIVE_USER", user: exact[0], valid: true }
    return { kind: "HISTORICAL_USER_REQUIRED", exactMatchCount: exact.length, valid: true }
  }

  function resolveProduct(name: string, branch: Row, allowCreate: boolean): Row {
    const key = normalizeProduct(name)
    const mapping = productMappings.get(key)
    let product: Row | undefined
    let organizationInventory: Row | undefined
    let kind: string
    if (mapping) {
      product = (snapshot.globalProducts as Row[]).find((row) => Number(row.id) === Number(mapping.global_product_id) && row.deleted_at == null)
      organizationInventory = (snapshot.organizationInventory as Row[]).find((row) => Number(row.id) === Number(mapping.organization_inventory_id)
        && row.organization_id === 10 && row.deleted_at == null && Number(row.global_product_id) === Number(mapping.global_product_id))
      kind = "EXISTING_LEDGER_MAPPING"
    } else {
      const matches = productsByName.get(key) ?? []
      if (matches.length === 1) {
        product = matches[0]
        organizationInventory = orgInventoryByProduct.get(Number(product.id))
        kind = "EXACT_PRODUCT_NAME"
      } else {
        kind = allowCreate && matches.length === 0 ? "NEW_PRODUCT_REQUIRED" : `INVALID_PRODUCT_MATCH_COUNT_${matches.length}`
      }
    }
    const valid = Boolean(product && organizationInventory) || kind === "NEW_PRODUCT_REQUIRED"
    const branchAssignments = organizationInventory ? (snapshot.branchInventory as Row[]).filter((row) => Number(row.branch_id) === Number(branch.id)
      && row.organization_id === 10 && Number(row.organization_inventory_id) === Number(organizationInventory.id)) : []
    const liveAssignment = branchAssignments.find((row) => row.deleted_at == null)
    const onlyDeletedAssignment = branchAssignments.length > 0 && !liveAssignment
    return {
      itemName: name,
      normalizedName: key,
      kind,
      globalProductId: product?.id ?? null,
      organizationInventoryId: organizationInventory?.id ?? null,
      valid: valid && !onlyDeletedAssignment,
      branchAssignment: liveAssignment ? "EXISTING" : (onlyDeletedAssignment ? "SOFT_DELETED_BLOCKER" : "NEW_INACTIVE_ASSIGNMENT_REQUIRED"),
    }
  }

  const assessments: Row[] = []
  for (const header of normalHeaders) {
    const id = Number(header.ID)
    const branchResult = resolveBranch(String(header.LocationName))
    const branch = branchResult.branch
    const products = branch ? normalLines.filter((line) => Number(line.ID) === id).map((line) => resolveProduct(String(line.ItemDetails), branch, true)) : []
    const user = branch ? resolveUser(Number(header.OrderTakerID), branch, String(header.UserDetails)) : null
    const group = branch ? groupById.get(Number(branch.group_id)) : null
    const reasons = [branchResult.error, !user?.valid ? "INVALID_USER" : null, products.some((row) => !row.valid) ? "INVALID_PRODUCT_OR_ASSIGNMENT" : null,
      importById.has(id) ? "ALREADY_IMPORTED" : null, orderByTid.has(`KE-LEGACY-${id}`) ? "TID_COLLISION" : null].filter(Boolean)
    assessments.push({
      legacyOrderId: id,
      importPath: "NORMAL_HISTORICAL_IMPORT",
      branch: branch ?? null,
      sourceGroup: header.LocationGroup,
      targetGroup: group ?? null,
      user,
      products,
      newProductsRequired: products.filter((row) => row.kind === "NEW_PRODUCT_REQUIRED").length,
      newBranchAssignmentsRequired: products.filter((row) => row.branchAssignment === "NEW_INACTIVE_ASSIGNMENT_REQUIRED").length,
      snapshotReady: reasons.length === 0,
      reasons,
    })
  }

  for (const id of REFUND_IDS) {
    const order = liveById.get(id)
    if (!order) throw new Error(`Missing live refund order ${id}`)
    const branchResult = resolveBranch(String(order.branch))
    const branch = branchResult.branch
    const products = branch ? (order.refundModal?.itemRows as Row[] ?? []).map((line) => resolveProduct(String(line.Name), branch, false)) : []
    const user = branch ? resolveUser(Number(order.rawDetail.OrderTakerID), branch, String(order.rawDetail.LastUpdatedBy ?? "")) : null
    const refundTotalCents = products.length ? (order.refundModal.itemRows as Row[]).reduce((sum, line) => sum + Math.round(Number(line.RefundPrice ?? 0) * 100), 0) : 0
    const reasons = [branchResult.error, !user?.valid ? "INVALID_USER" : null, products.some((row) => !row.valid) ? "INVALID_PRODUCT_OR_ASSIGNMENT" : null,
      refundTotalCents !== Math.round(Number(order.checkout.RefundAmount) * 100) ? "REFUND_TOTAL_MISMATCH" : null,
      importById.has(id) ? "ALREADY_IMPORTED" : null, orderByTid.has(`KE-LEGACY-${id}`) ? "TID_COLLISION" : null].filter(Boolean)
    assessments.push({
      legacyOrderId: id,
      importPath: "REFUND_AWARE_HISTORICAL_IMPORT",
      branch: branch ?? null,
      user,
      products,
      refundAmount: order.checkout.RefundAmount,
      refundItemAmount: refundTotalCents / 100,
      newBranchAssignmentsRequired: products.filter((row) => row.branchAssignment === "NEW_INACTIVE_ASSIGNMENT_REQUIRED").length,
      snapshotReady: reasons.length === 0,
      reasons,
    })
  }

  const result = {
    generatedAt: new Date().toISOString(),
    mode: "OFFLINE_READ_ONLY_SNAPSHOT_ASSESSMENT",
    warning: "This is not a current production preflight. The configured database connections did not contain K-Electric organization ID 10 on 2026-08-04, so the tenant safety gate correctly stopped the live dry-run.",
    snapshot: { path: SNAPSHOT, generatedAt: snapshot.generatedAt, organization: snapshot.organization?.[0] ?? null },
    organizationScope: { id: 10, code: "0001", name: "K-Electric" },
    candidateLegacyOrderIds: [...NORMAL_IDS, ...REFUND_IDS].sort((a, b) => a - b),
    summary: {
      candidates: assessments.length,
      snapshotReady: assessments.filter((row) => row.snapshotReady).length,
      snapshotBlocked: assessments.filter((row) => !row.snapshotReady).length,
      newProductsRequired: assessments.reduce((sum, row) => sum + Number(row.newProductsRequired ?? 0), 0),
      newBranchAssignmentsRequired: assessments.reduce((sum, row) => sum + Number(row.newBranchAssignmentsRequired ?? 0), 0),
      currentProductionPreflightCompleted: false,
      productionDatabaseChanges: 0,
    },
    assessments,
  }
  const text = `${JSON.stringify(result, null, 2)}\n`
  writeFileSync(OUTPUT, text, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, sha256: createHash("sha256").update(text).digest("hex"), summary: result.summary }, null, 2))
}

main()
