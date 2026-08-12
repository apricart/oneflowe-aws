#!/usr/bin/env tsx
import { stringifyPrimitive } from "../lib/stringify-primitive"
/**
 * Import fully reconciled K-Electric historical orders that contain refunds.
 *
 * The default mode is read-only. Commit mode is guarded by the organization,
 * source-manifest digest, exact ready count, and an active SUPER_ADMIN actor.
 * This script never mutates operational stock, budget, quantity-budget,
 * invoice-sequence, notification, user, branch, or product records.
 */

import { createHash } from "node:crypto"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { PoolClient } from "pg"
import * as dotenv from "dotenv"

import { pool } from "../lib/db-cli"
import { buildRefundBreakdownCents } from "../lib/refund-breakdown"
import {
  KE_ORGANIZATION,
  LEGACY_SOURCE,
  normalizeProductName,
  normalizeText,
  resolveKeLegacyBranch,
  toCents,
} from "../lib/legacy-import/ke-electric"

dotenv.config({ path: ".env.local" })
dotenv.config()

type JsonRow = Record<string, any>

interface Options {
  commit: boolean
  rollbackTest: boolean
  sourceOnly: boolean
  actorUserId?: string
  confirmOrganization?: string
  confirmManifest?: string
  expectedOrders?: number
  approvedNonFinalLegacyOrderIds: Set<number>
  createMissingBranchAssignments: boolean
  refundReportPath: string
  refundAuditPath: string
  outputPath?: string
}

interface SourceFile {
  path: string
  sha256: string
  bytes: number
}

interface PreparedLine {
  sourceItemId: number
  sourceName: string
  normalizedName: string
  quantity: number
  remainingQuantity: number
  refundedQuantity: number
  unitPriceCents: number
  lineTotalCents: number
  refundTotalCents: number
}

interface PreparedRefundOrder {
  legacyOrderId: number
  sourceChecksum: string
  header: JsonRow
  detail: JsonRow
  modal: JsonRow
  branchName: string
  legacyOrderTakerId: number
  sourceUserName: string
  createdAt: Date
  refundedAt: Date
  subtotalCents: number
  taxCents: number
  totalCents: number
  itemRefundAmountCents: number
  taxRefundCents: number
  refundAmountCents: number
  lines: PreparedLine[]
  omittedZeroQuantityLines: number
}

interface ResolvedLine extends PreparedLine {
  globalProductId: number
  organizationInventoryId: number
  productCode: string | null
}

interface ReadyOrder extends PreparedRefundOrder {
  branchId: number
  branchAddress: string | null
  createdByUserId: string
  needsUserMapping: boolean
  lines: ResolvedLine[]
}

interface NewBranchAssignment {
  branchId: number
  organizationInventoryId: number
}

interface NewUserMapping {
  legacyOrderTakerId: number
  branchId: number
  sourceName: string
  userId: string
}

interface Reconciliation {
  organization: JsonRow | null
  configuredActorUserId: string | null
  configuredActorMatchCount: number
  activeSuperAdminUserIds: string[]
  latestLegacyImportActorUserId: string | null
  dbCounts: JsonRow
  ledgerIntegrity: JsonRow
  requiredSchemaErrors: string[]
  globalErrors: string[]
  readyOrders: ReadyOrder[]
  newBranchAssignments: NewBranchAssignment[]
  newUserMappings: NewUserMapping[]
  alreadyImported: Array<{ legacyOrderId: number; orderId: number }>
  orderBlocks: Array<{ legacyOrderId: number; reasons: string[] }>
}

const REQUIRED_COLUMNS: Record<string, string[]> = {
  orders: [
    "id", "tid", "organization_id", "branch_id", "status", "fulfillment_status",
    "payment_status", "subtotal_cents", "tax_cents", "total_cents", "notes",
    "created_by_user_id", "created_at", "delivered_at", "fulfilled_at", "updated_at",
    "refunded_at", "refunded_by_user_id", "status_at_refund", "refund_amount_cents",
    "refund_reason", "receipt_data",
  ],
  order_items: [
    "id", "organization_id", "organization_inventory_id", "order_id",
    "global_product_id", "product_name", "product_code", "unit", "quantity",
    "price_cents", "created_at",
  ],
  refunds: [
    "id", "organization_id", "order_id", "amount_cents", "tax_refund_cents", "reason", "status",
    "refund_number", "processed_by_user_id", "created_at", "updated_at",
  ],
  refund_items: ["id", "refund_id", "order_item_id", "quantity", "amount_cents", "created_at"],
  legacy_import_batches: [
    "id", "organization_id", "source_system", "source_manifest", "status", "counts",
    "imported_by_user_id", "created_at", "completed_at",
  ],
  legacy_order_imports: [
    "id", "batch_id", "organization_id", "source_system", "legacy_order_id",
    "order_id", "source_checksum", "source_payload", "created_at",
  ],
}

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function options(): Options {
  const expected = arg("--expected-orders")
  const approvedNonFinalLegacyOrderIds = new Set(
    String(arg("--approve-nonfinal-as-delivered") ?? "")
      .split(",")
      .map((value) => Number(value.trim()))
      .filter((value) => Number.isSafeInteger(value) && value > 0),
  )
  return {
    commit: process.argv.includes("--commit"),
    rollbackTest: process.argv.includes("--rollback-test"),
    sourceOnly: process.argv.includes("--source-only"),
    actorUserId: arg("--actor-user-id"),
    confirmOrganization: arg("--confirm-organization"),
    confirmManifest: arg("--confirm-manifest"),
    expectedOrders: expected === undefined ? undefined : Number(expected),
    approvedNonFinalLegacyOrderIds,
    createMissingBranchAssignments: !process.argv.includes("--skip-missing-branch-assignments"),
    refundReportPath: resolve(arg("--refund-report") ?? "updatedReports/refundReport.json"),
    refundAuditPath: resolve(arg("--refund-audit") ?? "updatedReports/ke-refund-detail-audit-2026-08-03.json"),
    outputPath: arg("--output"),
  }
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function readJsonFile<T>(path: string): { value: T; source: SourceFile } {
  if (!existsSync(path)) throw new Error(`Source file not found: ${path}`)
  const buffer = readFileSync(path)
  return {
    value: JSON.parse(buffer.toString("utf8")) as T,
    source: { path, sha256: sha256(buffer), bytes: buffer.byteLength },
  }
}

function uniqueBy<T>(values: T[], key: (value: T) => string): T | undefined {
  const distinct = new Map(values.map((value) => [key(value), value]))
  return distinct.size === 1 ? [...distinct.values()][0] : undefined
}

function validDate(value: unknown): Date | undefined {
  const date = new Date(stringifyPrimitive(value))
  return Number.isNaN(date.getTime()) ? undefined : date
}

function stableDigest(value: unknown): string {
  return sha256(JSON.stringify(value))
}

function prepareSource(opts: Options) {
  const reportFile = readJsonFile<JsonRow[]>(opts.refundReportPath)
  const auditFile = readJsonFile<JsonRow>(opts.refundAuditPath)
  if (!Array.isArray(reportFile.value)) throw new Error("Refund report must be a JSON array")

  const audit = auditFile.value
  const details = Array.isArray(audit.details) ? audit.details as JsonRow[] : []
  const modalEvidence = audit.refundModalEvidence ?? {}
  const responses = Array.isArray(modalEvidence.responses) ? modalEvidence.responses as JsonRow[] : []
  const evidenceRows = Array.isArray(modalEvidence.orderEvidence) ? modalEvidence.orderEvidence as JsonRow[] : []
  const detailById = new Map(details.map((row) => [Number(row.reportOrderId), row]))
  const modalById = new Map(responses.map((row) => [Number(row.reportOrderId), row]))
  const evidenceById = new Map(evidenceRows.map((row) => [Number(row.reportOrderId), row]))

  const prepared: PreparedRefundOrder[] = []
  const excluded: Array<{ legacyOrderId: number; reasons: string[] }> = []

  for (const header of reportFile.value) {
    const legacyOrderId = Number(header.ID)
    const reasons: string[] = []
    const detail = detailById.get(legacyOrderId)
    const modal = modalById.get(legacyOrderId)
    const evidence = evidenceById.get(legacyOrderId)

    if (!Number.isSafeInteger(legacyOrderId) || legacyOrderId <= 0) reasons.push("INVALID_LEGACY_ORDER_ID")
    // Status 2/507 is the legacy delivered partial-refund state and status 4 is
    // the full-refund state. Any other historical state must be approved by
    // exact legacy order ID; this prevents a broad status reinterpretation.
    const sourceStatusId = Number(header.StatusID)
    const hasExplicitNonFinalApproval = opts.approvedNonFinalLegacyOrderIds.has(legacyOrderId)
    const isExplicitlyApprovedNonFinal = hasExplicitNonFinalApproval
      && sourceStatusId === 9
      && Number(header.DeliveryStatus) === 506
    if (hasExplicitNonFinalApproval && !isExplicitlyApprovedNonFinal) reasons.push("EXPLICIT_APPROVAL_SOURCE_STATE_MISMATCH")
    if (![2, 4].includes(sourceStatusId) && !isExplicitlyApprovedNonFinal) reasons.push("NONFINAL_STATUS_NOT_EXPLICITLY_APPROVED")
    if (sourceStatusId === 2 && Number(header.DeliveryStatus) !== 507) reasons.push("PARTIAL_REFUND_NOT_DELIVERED")
    if (!detail?.ok || !modal?.ok || !evidence) reasons.push("MISSING_SUCCESSFUL_DETAIL_EVIDENCE")
    if (evidence && (!evidence.originalSubtotalComplete || !evidence.originalSubtotalReconciles)) reasons.push("ORIGINAL_SUBTOTAL_NOT_RECONCILED")
    if (evidence && (!evidence.refundPriceComplete || !evidence.unitPriceComplete || !evidence.refundPriceReconciles || !evidence.unitPriceReconciles)) reasons.push("REFUND_ITEMS_NOT_RECONCILED")
    if (evidence?.hasNegativeDetailPrice || evidence?.hasNegativeModalRefundQuantity) reasons.push("NEGATIVE_REFUND_STATE")

    const subtotalCents = toCents(header.AmountTotal)
    const taxCents = toCents(header.Tax)
    const totalCents = toCents(header.GrandTotal)
    const itemRefundAmountCents = toCents(header.RefundAmount)
    const taxRefundCents = toCents(header.TaxRefund)
    let refundAmountCents = -1
    try {
      refundAmountCents = buildRefundBreakdownCents(itemRefundAmountCents, taxRefundCents).grossRefundCents
    } catch {
      reasons.push("INVALID_REFUND_BREAKDOWN")
    }
    if (toCents(header.AmountDiscount) !== 0 || toCents(header.ServiceCharges) !== 0) reasons.push("UNSUPPORTED_DISCOUNT_OR_SERVICE_CHARGE")
    if (subtotalCents + taxCents !== totalCents
      || itemRefundAmountCents <= 0
      || taxRefundCents < 0
      || refundAmountCents > totalCents) reasons.push("INVALID_ORDER_TOTALS")

    const checkout = detail?.checkout ?? {}
    if (detail && (
      toCents(checkout.AmountTotal) !== subtotalCents
      || toCents(checkout.Tax) !== taxCents
      || toCents(checkout.GrandTotal) !== totalCents
      || toCents(checkout.RefundAmount) !== itemRefundAmountCents
      || toCents(checkout.TaxRefund) !== taxRefundCents
      || toCents(checkout.AmountDiscount) !== 0
      || toCents(checkout.ServiceCharges) !== 0
      || toCents(checkout.DeliveryCharges) !== 0
    )) reasons.push("DETAIL_HEADER_TOTAL_MISMATCH")

    const createdAt = validDate(header.CreatedOn)
    const refundedAt = validDate(header.LastUpdateDT)
    if (!createdAt || !refundedAt || refundedAt < createdAt) reasons.push("INVALID_TIMESTAMPS")

    const modalItems = Array.isArray(modal?.items) ? modal.items as JsonRow[] : []
    const lines: PreparedLine[] = []
    let omittedZeroQuantityLines = 0
    const sourceItemIds = new Set<number>()
    for (const item of modalItems) {
      const sourceItemId = Number(item.ItemId)
      const sourceName = String(item.Name ?? "").trim()
      const quantity = Number(item.Quantity)
      const remainingQuantity = Number(item.RefundQuantity ?? quantity)
      if (!Number.isSafeInteger(sourceItemId) || sourceItemId <= 0 || sourceItemIds.has(sourceItemId)) reasons.push("INVALID_OR_DUPLICATE_SOURCE_ITEM_ID")
      sourceItemIds.add(sourceItemId)
      if (!sourceName || sourceName.length > 255) reasons.push("INVALID_PRODUCT_NAME")
      if (quantity === 0) {
        const zeroState = remainingQuantity === 0
          && toCents(item.Price) === 0
          && toCents(item.RefundPrice) === 0
          && (item.UnitPrice == null || toCents(item.UnitPrice) === 0)
        if (!zeroState) reasons.push("UNSAFE_ZERO_QUANTITY_LINE")
        omittedZeroQuantityLines += 1
        continue
      }
      if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 1_000_000) reasons.push("INVALID_ITEM_QUANTITY")
      if (!Number.isFinite(remainingQuantity) || remainingQuantity < 0 || remainingQuantity > quantity) reasons.push("INVALID_REMAINING_QUANTITY")
      if (item.UnitPrice == null) {
        reasons.push("MISSING_UNIT_PRICE")
        continue
      }
      const unitPriceCents = toCents(item.UnitPrice)
      const refundedQuantity = quantity - remainingQuantity
      const lineTotalCents = Math.round(quantity * unitPriceCents)
      const refundTotalCents = Math.round(refundedQuantity * unitPriceCents)
      if (toCents(item.RefundPrice) !== refundTotalCents) reasons.push("ITEM_REFUND_PRICE_MISMATCH")
      lines.push({
        sourceItemId,
        sourceName,
        normalizedName: normalizeProductName(sourceName),
        quantity,
        remainingQuantity,
        refundedQuantity,
        unitPriceCents,
        lineTotalCents,
        refundTotalCents,
      })
    }

    if (lines.length === 0) reasons.push("NO_POSITIVE_QUANTITY_LINES")
    if (lines.reduce((sum, line) => sum + line.lineTotalCents, 0) !== subtotalCents) reasons.push("ORIGINAL_ITEM_TOTAL_MISMATCH")
    const refundedLines = lines.filter((line) => line.refundedQuantity > 0)
    if (refundedLines.length === 0 || refundedLines.reduce((sum, line) => sum + line.refundTotalCents, 0) !== itemRefundAmountCents) reasons.push("REFUND_ITEM_TOTAL_MISMATCH")
    if (sourceStatusId === 4
      && (refundAmountCents !== totalCents || lines.some((line) => line.refundedQuantity !== line.quantity))) {
      reasons.push("FULL_REFUND_STATUS_NOT_FULLY_RECONCILED")
    }

    const detailRefundItems = (Array.isArray(detail?.items) ? detail.items as JsonRow[] : [])
      .filter((item) => Number(item.RefundQuantity ?? 0) > 0)
    if (detailRefundItems.length !== refundedLines.length) reasons.push("REFUND_DETAIL_ITEM_COUNT_MISMATCH")
    for (const line of refundedLines) {
      const matches = detailRefundItems.filter((item) =>
        Number(item.ItemId) === line.sourceItemId
        && normalizeProductName(item.Name) === line.normalizedName
        && Number(item.RefundQuantity) === line.refundedQuantity,
      )
      if (matches.length !== 1) reasons.push("REFUND_DETAIL_ITEM_MISMATCH")
    }

    if (reasons.length > 0 || !createdAt || !refundedAt || !detail || !modal || !evidence) {
      excluded.push({ legacyOrderId, reasons: [...new Set(reasons)] })
      continue
    }

    prepared.push({
      legacyOrderId,
      sourceChecksum: stableDigest({ header, detail, modal, evidence }),
      header,
      detail,
      modal,
      branchName: String(header.Location ?? "").trim(),
      legacyOrderTakerId: Number(header.OrderTakerID),
      sourceUserName: String(header.LastUpdateBy ?? "").trim(),
      createdAt,
      refundedAt,
      subtotalCents,
      taxCents,
      totalCents,
      itemRefundAmountCents,
      taxRefundCents,
      refundAmountCents,
      lines,
      omittedZeroQuantityLines,
    })
  }

  const manifest = { refundReport: reportFile.source, refundAudit: auditFile.source }
  const approvedNonFinalLegacyOrderIds = [...opts.approvedNonFinalLegacyOrderIds].sort((a, b) => a - b)
  const manifestFiles = Object.entries(manifest)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, file]) => `${name}:${file.sha256}`)
  // Preserve the digest used by earlier tax-free imports. The explicit status
  // policy participates in the digest only when it is actually requested.
  const usesNonDefaultPolicy = approvedNonFinalLegacyOrderIds.length > 0 || !opts.createMissingBranchAssignments
  const manifestDigest = !usesNonDefaultPolicy
    ? stableDigest(manifestFiles)
    : stableDigest({
      files: manifestFiles,
      approvedNonFinalLegacyOrderIds,
      createMissingBranchAssignments: opts.createMissingBranchAssignments,
    })
  return {
    manifest,
    manifestDigest,
    approvedNonFinalLegacyOrderIds,
    createMissingBranchAssignments: opts.createMissingBranchAssignments,
    prepared: prepared.toSorted((a, b) => a.legacyOrderId - b.legacyOrderId),
    excluded: excluded.toSorted((a, b) => a.legacyOrderId - b.legacyOrderId),
    sourceCount: reportFile.value.length,
  }
}

async function rows<T extends JsonRow = JsonRow>(client: PoolClient, text: string, params: unknown[] = []): Promise<T[]> {
  return (await client.query(text, params)).rows as T[]
}

async function reconcile(
  client: PoolClient,
  prepared: PreparedRefundOrder[],
  createMissingBranchAssignments = true,
): Promise<Reconciliation> {
  const [organization] = await rows(client, "select id, code, name, status from organizations where id = $1", [KE_ORGANIZATION.id])
  const globalErrors: string[] = []
  if (organization?.code !== KE_ORGANIZATION.code
    || normalizeText(organization.name) !== normalizeText(KE_ORGANIZATION.name)
    || normalizeText(organization.status) !== "active") {
    globalErrors.push(`K-Electric tenant gate failed for id=${KE_ORGANIZATION.id}, code=${KE_ORGANIZATION.code}`)
  }
  const configuredActorRows = process.env.SUPER_ADMIN_EMAIL
    ? await rows(client, `
        select u.id from users u join roles r on r.id = u.role_id
        where lower(u.email) = lower($1) and u.is_active = true
          and u.deleted_at is null and r.name = 'SUPER_ADMIN'
      `, [process.env.SUPER_ADMIN_EMAIL])
    : []
  const activeSuperAdminRows = await rows(client, `
    select u.id from users u join roles r on r.id = u.role_id
    where u.is_active = true and u.deleted_at is null and r.name = 'SUPER_ADMIN'
    order by u.created_at, u.id
  `)
  const [latestLegacyImportActor] = await rows(client, `
    select imported_by_user_id from legacy_import_batches
    where organization_id = $1 and source_system = $2 and status = 'COMPLETED'
    order by completed_at desc nulls last, created_at desc limit 1
  `, [KE_ORGANIZATION.id, LEGACY_SOURCE])

  const requiredSchemaErrors: string[] = []
  const schemaColumns = await rows<{ table_name: string; column_name: string }>(client,
    "select table_name, column_name from information_schema.columns where table_schema = 'public' and table_name = any($1::text[])",
    [Object.keys(REQUIRED_COLUMNS)],
  )
  const availableColumns = new Map<string, Set<string>>()
  for (const column of schemaColumns) {
    const names = availableColumns.get(column.table_name) ?? new Set<string>()
    names.add(column.column_name)
    availableColumns.set(column.table_name, names)
  }
  for (const [table, columns] of Object.entries(REQUIRED_COLUMNS)) {
    for (const column of columns) {
      if (!availableColumns.get(table)?.has(column)) requiredSchemaErrors.push(`${table}.${column} is missing`)
    }
  }

  const dbCounts = (await rows(client, `
    select
      (select count(*)::int from branches where organization_id = $1) as branches,
      (select count(*)::int from users where organization_id = $1) as users,
      (select count(*)::int from orders where organization_id = $1) as orders,
      (select count(*)::int from order_items where organization_id = $1) as order_items,
      (select count(*)::int from refunds where organization_id = $1) as refunds,
      (select count(*)::int from legacy_order_imports where organization_id = $1 and source_system = $2) as legacy_imports,
      (select count(*)::int from legacy_import_batches where organization_id = $1 and source_system = $2) as legacy_batches
  `, [KE_ORGANIZATION.id, LEGACY_SOURCE]))[0] ?? {}

  const ledgerIntegrity = (await rows(client, `
    select
      count(*)::int as imports,
      count(*) filter (where o.id is null)::int as missing_orders,
      count(*) filter (where o.organization_id <> $1 or b.organization_id <> $1 or u.organization_id <> $1 or u.branch_id <> o.branch_id)::int as tenant_or_branch_mismatches,
      count(*) filter (where o.tid <> ('KE-LEGACY-' || loi.legacy_order_id::text))::int as tid_mismatches,
      count(*) filter (where o.status not in ('FULFILLED', 'REFUNDED'))::int as unexpected_statuses
    from legacy_order_imports loi
    left join orders o on o.id = loi.order_id
    left join branches b on b.id = o.branch_id
    left join users u on u.id = o.created_by_user_id
    where loi.organization_id = $1 and loi.source_system = $2
  `, [KE_ORGANIZATION.id, LEGACY_SOURCE]))[0] ?? {}
  if (Number(ledgerIntegrity.missing_orders) !== 0
    || Number(ledgerIntegrity.tenant_or_branch_mismatches) !== 0
    || Number(ledgerIntegrity.tid_mismatches) !== 0
    || Number(ledgerIntegrity.unexpected_statuses) !== 0) {
    globalErrors.push("Existing K-Electric legacy ledger integrity check failed")
  }

  const branches = await rows(client, `
    select id, organization_id, name, address, external_source, external_id
    from branches where organization_id = $1
  `, [KE_ORGANIZATION.id])

  const userMappings = await rows(client, `
    select lum.legacy_order_taker_id, lum.branch_id, lum.user_id,
           u.organization_id as user_organization_id, u.branch_id as user_branch_id,
           u.deleted_at, r.name as role_name
    from legacy_user_mappings lum
    join users u on u.id = lum.user_id
    join roles r on r.id = u.role_id
    where lum.organization_id = $1 and lum.source_system = $2
  `, [KE_ORGANIZATION.id, LEGACY_SOURCE])
  const userMappingByKey = new Map<string, JsonRow[]>()
  for (const mapping of userMappings) {
    const key = `${mapping.legacy_order_taker_id}:${mapping.branch_id}`
    userMappingByKey.set(key, [...(userMappingByKey.get(key) ?? []), mapping])
  }
  const orderPortalUsers = await rows(client, `
    select u.id, u.branch_id, u.organization_id, u.full_name, u.first_name, u.last_name,
           u.is_active, u.deleted_at
    from users u join roles r on r.id = u.role_id
    where u.organization_id = $1 and r.name = 'ORDER_PORTAL'
  `, [KE_ORGANIZATION.id])
  const activeUsersByBranchAndName = new Map<string, JsonRow[]>()
  for (const user of orderPortalUsers.filter((row) => row.is_active === true && row.deleted_at === null)) {
    const names = new Set([
      normalizeText(user.full_name),
      normalizeText(`${user.first_name ?? ""} ${user.last_name ?? ""}`),
      normalizeText(user.first_name),
    ].filter(Boolean))
    for (const name of names) {
      const key = `${user.branch_id}:${name}`
      activeUsersByBranchAndName.set(key, [...(activeUsersByBranchAndName.get(key) ?? []), user])
    }
  }

  const productMappings = await rows(client, `
    select lpm.normalized_name, lpm.global_product_id, lpm.organization_inventory_id,
           gp.product_code, gp.deleted_at as product_deleted_at,
           oi.organization_id as inventory_organization_id, oi.deleted_at as inventory_deleted_at
    from legacy_product_mappings lpm
    join global_products gp on gp.id = lpm.global_product_id
    join organization_inventory oi on oi.id = lpm.organization_inventory_id
    where lpm.organization_id = $1 and lpm.source_system = $2
  `, [KE_ORGANIZATION.id, LEGACY_SOURCE])
  const productMappingByName = new Map<string, JsonRow[]>()
  for (const mapping of productMappings) {
    const key = normalizeProductName(mapping.normalized_name)
    productMappingByName.set(key, [...(productMappingByName.get(key) ?? []), mapping])
  }

  const branchAssignments = await rows(client, `
    select branch_id, organization_inventory_id, organization_id, deleted_at
    from branch_inventory where organization_id = $1
  `, [KE_ORGANIZATION.id])
  const branchAssignmentByPair = new Map(branchAssignments.map((assignment) => [
    `${assignment.branch_id}:${assignment.organization_inventory_id}`,
    assignment,
  ]))

  const candidateIds = prepared.map((order) => order.legacyOrderId)
  const existingImports = candidateIds.length > 0 ? await rows(client, `
    select loi.legacy_order_id, loi.source_checksum, loi.order_id, o.organization_id, o.tid
    from legacy_order_imports loi
    join orders o on o.id = loi.order_id
    where loi.organization_id = $1 and loi.source_system = $2 and loi.legacy_order_id = any($3::int[])
  `, [KE_ORGANIZATION.id, LEGACY_SOURCE, candidateIds]) : []
  const existingImportByLegacyId = new Map(existingImports.map((row) => [Number(row.legacy_order_id), row]))

  const tids = candidateIds.map((id) => `KE-LEGACY-${id}`)
  const tidRows = tids.length > 0 ? await rows(client,
    "select id, tid, organization_id from orders where tid = any($1::text[])", [tids]) : []
  const tidByValue = new Map(tidRows.map((row) => [String(row.tid), row]))

  const refundNumbers = candidateIds.map((id) => `KE-R-${id}`)
  const refundNumberRows = refundNumbers.length > 0 ? await rows(client,
    "select id, order_id, organization_id, refund_number from refunds where refund_number = any($1::text[])", [refundNumbers]) : []
  const refundByNumber = new Map(refundNumberRows.map((row) => [String(row.refund_number), row]))

  const readyOrders: ReadyOrder[] = []
  const newBranchAssignmentByPair = new Map<string, NewBranchAssignment>()
  const newUserMappingByKey = new Map<string, NewUserMapping>()
  const alreadyImported: Array<{ legacyOrderId: number; orderId: number }> = []
  const orderBlocks: Array<{ legacyOrderId: number; reasons: string[] }> = []

  for (const order of prepared) {
    const reasons: string[] = []
    const existing = existingImportByLegacyId.get(order.legacyOrderId)
    if (existing) {
      if (existing.source_checksum === order.sourceChecksum
        && existing.organization_id === KE_ORGANIZATION.id
        && existing.tid === `KE-LEGACY-${order.legacyOrderId}`) {
        alreadyImported.push({ legacyOrderId: order.legacyOrderId, orderId: Number(existing.order_id) })
        continue
      }
      reasons.push("EXISTING_IMPORT_CHECKSUM_OR_TENANT_MISMATCH")
    }

    const branchResolution = resolveKeLegacyBranch(branches.map((branch) => ({
      id: Number(branch.id),
      name: String(branch.name),
      organization_id: branch.organization_id,
      address: branch.address,
      externalSource: branch.external_source,
      externalId: branch.external_id,
    })), {
      locationId: order.header.LocationID,
      name: order.branchName,
    })
    const branch = branchResolution.branch
    if (!branch) reasons.push(`BRANCH_MATCH_COUNT_${branchResolution.matchCount}`)

    const tidCollision = tidByValue.get(`KE-LEGACY-${order.legacyOrderId}`)
    if (tidCollision && !existing) reasons.push(`UNLEDGERED_TID_COLLISION_ORDER_${tidCollision.id}`)
    const refundCollision = refundByNumber.get(`KE-R-${order.legacyOrderId}`)
    if (refundCollision && !existing) reasons.push(`REFUND_NUMBER_COLLISION_${refundCollision.id}`)

    let userMapping: JsonRow | undefined
    let needsUserMapping = false
    if (branch) {
      const mappings = userMappingByKey.get(`${order.legacyOrderTakerId}:${branch.id}`) ?? []
      userMapping = uniqueBy(mappings, (row) => String(row.user_id))
      if (!userMapping) {
        const exactUsers = activeUsersByBranchAndName.get(`${branch.id}:${normalizeText(order.sourceUserName)}`) ?? []
        const exactUser = uniqueBy(exactUsers, (row) => String(row.id))
        if (exactUser) {
          userMapping = {
            user_id: exactUser.id,
            user_organization_id: exactUser.organization_id,
            user_branch_id: exactUser.branch_id,
            deleted_at: exactUser.deleted_at,
            role_name: "ORDER_PORTAL",
          }
          needsUserMapping = true
        } else {
          reasons.push(`INVALID_USER_MAPPING_AND_EXACT_MATCH_COUNT_${mappings.length}_${exactUsers.length}`)
        }
      }
      if (userMapping && (userMapping.user_organization_id !== KE_ORGANIZATION.id
        || userMapping.user_branch_id !== branch.id
        || userMapping.deleted_at !== null
        || userMapping.role_name !== "ORDER_PORTAL")) reasons.push("INVALID_USER_MAPPING_TENANT_ROLE_OR_BRANCH")
    }

    const resolvedLines: ResolvedLine[] = []
    for (const line of order.lines) {
      const mappings = productMappingByName.get(line.normalizedName) ?? []
      const mapping = uniqueBy(mappings, (row) => `${row.global_product_id}:${row.organization_inventory_id}`)
      if (mapping?.product_deleted_at !== null
        || mapping.inventory_deleted_at !== null
        || mapping.inventory_organization_id !== KE_ORGANIZATION.id) {
        reasons.push(`INVALID_PRODUCT_MAPPING:${line.sourceName}`)
        continue
      }
      if (branch) {
        const assignment = branchAssignmentByPair.get(`${branch.id}:${mapping.organization_inventory_id}`)
        if (assignment?.deleted_at !== null && assignment !== undefined) {
          reasons.push(`SOFT_DELETED_BRANCH_PRODUCT_ASSIGNMENT:${line.sourceName}`)
        }
      }
      resolvedLines.push({
        ...line,
        globalProductId: Number(mapping.global_product_id),
        organizationInventoryId: Number(mapping.organization_inventory_id),
        productCode: mapping.product_code == null ? null : String(mapping.product_code),
      })
    }

    if (reasons.length > 0 || !branch || !userMapping || resolvedLines.length !== order.lines.length) {
      orderBlocks.push({ legacyOrderId: order.legacyOrderId, reasons: [...new Set(reasons)] })
      continue
    }
    readyOrders.push({
      ...order,
      branchId: Number(branch.id),
      branchAddress: branch.address == null ? null : String(branch.address),
      createdByUserId: String(userMapping.user_id),
      needsUserMapping,
      lines: resolvedLines,
    })
    if (needsUserMapping) {
      const key = `${order.legacyOrderTakerId}:${branch.id}`
      newUserMappingByKey.set(key, {
        legacyOrderTakerId: order.legacyOrderTakerId,
        branchId: Number(branch.id),
        sourceName: order.sourceUserName,
        userId: String(userMapping.user_id),
      })
    }
    for (const line of resolvedLines) {
      const key = `${branch.id}:${line.organizationInventoryId}`
      if (createMissingBranchAssignments && !branchAssignmentByPair.has(key)) {
        newBranchAssignmentByPair.set(key, {
          branchId: Number(branch.id),
          organizationInventoryId: line.organizationInventoryId,
        })
      }
    }
  }

  return {
    organization: organization ?? null,
    configuredActorUserId: configuredActorRows.length === 1 ? String(configuredActorRows[0].id) : null,
    configuredActorMatchCount: configuredActorRows.length,
    activeSuperAdminUserIds: activeSuperAdminRows.map((row) => String(row.id)),
    latestLegacyImportActorUserId: latestLegacyImportActor?.imported_by_user_id == null
      ? null
      : String(latestLegacyImportActor.imported_by_user_id),
    dbCounts,
    ledgerIntegrity,
    requiredSchemaErrors,
    globalErrors,
    readyOrders,
    newBranchAssignments: [...newBranchAssignmentByPair.values()].sort((a, b) => a.branchId - b.branchId || a.organizationInventoryId - b.organizationInventoryId),
    newUserMappings: [...newUserMappingByKey.values()].sort((a, b) => a.branchId - b.branchId || a.legacyOrderTakerId - b.legacyOrderTakerId),
    alreadyImported,
    orderBlocks,
  }
}

async function operationalState(client: PoolClient, productIds: number[], lock: boolean) {
  const suffix = lock ? " for share" : ""
  const [budgets, quantityBudgets, invoiceSequences, stocks] = await Promise.all([
    rows(client, `select id, amount_allocated_cents, amount_spent_cents, amount_held_cents, amount_credited_cents from budgets where organization_id = $1 order by id${suffix}`, [KE_ORGANIZATION.id]),
    rows(client, `select id, allocated_quantity, held_quantity, used_quantity, credited_quantity, amount_allocated_cents, amount_credited_cents from product_quantity_budgets where organization_id = $1 order by id${suffix}`, [KE_ORGANIZATION.id]),
    rows(client, `select organization_id, last_value from invoice_sequences where organization_id = $1 order by organization_id${suffix}`, [KE_ORGANIZATION.id]),
    productIds.length > 0
      ? rows(client, `select id, stock_quantity from global_products where id = any($1::int[]) order by id${suffix}`, [productIds])
      : Promise.resolve([]),
  ])
  return { budgets, quantityBudgets, invoiceSequences, stocks }
}

function receipt(order: ReadyOrder) {
  const items = order.lines.map((line) => ({
    id: line.globalProductId,
    description: line.sourceName,
    quantity: line.quantity,
    rate: line.unitPriceCents / 100,
    tax: 0,
    total: line.lineTotalCents / 100,
    unit: "unit",
  }))
  return {
    invoiceNumber: `KE-LEGACY-${order.legacyOrderId}`,
    date: order.createdAt.toISOString(),
    buyerName: order.branchName,
    buyerAddress: order.branchAddress ?? "",
    organizationName: KE_ORGANIZATION.name,
    items: [{ categoryName: "General", items, subtotal: order.subtotalCents / 100 }],
    subtotal: order.subtotalCents / 100,
    discount: 0,
    tax: order.taxCents / 100,
    deliveryCharges: 0,
    refund: order.refundAmountCents / 100,
    totalAmount: order.totalCents / 100,
  }
}

async function commitOrders(
  client: PoolClient,
  source: ReturnType<typeof prepareSource>,
  opts: Options,
  persist: boolean,
) {
  await client.query("begin isolation level serializable")
  try {
    await client.query("select pg_advisory_xact_lock($1, $2)", [1263482710, KE_ORGANIZATION.id])
    const current = await reconcile(client, source.prepared, opts.createMissingBranchAssignments)
    const blockers = current.globalErrors.length + current.requiredSchemaErrors.length
    if (blockers !== 0) throw new Error(`Commit refused: ${blockers} reconciliation blockers appeared under lock`)
    if (current.readyOrders.length !== opts.expectedOrders) throw new Error(`Commit refused: ready count changed to ${current.readyOrders.length}`)

    const [actor] = await rows(client, `
      select u.id from users u join roles r on r.id = u.role_id
      where u.id = $1 and u.is_active = true and u.deleted_at is null and r.name = 'SUPER_ADMIN'
    `, [opts.actorUserId])
    if (!actor) throw new Error("Actor must be an active SUPER_ADMIN")

    const productIds = [...new Set(current.readyOrders.flatMap((order) => order.lines.map((line) => line.globalProductId)))].sort((a, b) => a - b)
    const beforeOperational = await operationalState(client, productIds, true)
    const operationalDigest = stableDigest(beforeOperational)

    const [batch] = await rows(client, `
      insert into legacy_import_batches (
        organization_id, source_system, source_manifest, status, counts, imported_by_user_id
      ) values ($1, $2, $3::jsonb, 'RUNNING', '{}'::jsonb, $4)
      returning id
    `, [
      KE_ORGANIZATION.id,
      LEGACY_SOURCE,
      JSON.stringify({
        digest: source.manifestDigest,
        files: source.manifest,
        kind: "REFUND_AWARE_WITH_TAX_BREAKDOWN",
        approvedNonFinalLegacyOrderIds: source.approvedNonFinalLegacyOrderIds,
        createMissingBranchAssignments: source.createMissingBranchAssignments,
        operationalDigest,
      }),
      opts.actorUserId,
    ])
    if (!batch?.id) throw new Error("Failed to create import batch")

    for (const mapping of current.newUserMappings) {
      await client.query(`
        insert into legacy_user_mappings (
          organization_id, source_system, legacy_order_taker_id, branch_id,
          source_name, user_id, is_synthetic, created_by_batch_id
        ) values ($1, $2, $3, $4, $5, $6, false, $7)
      `, [
        KE_ORGANIZATION.id,
        LEGACY_SOURCE,
        mapping.legacyOrderTakerId,
        mapping.branchId,
        mapping.sourceName,
        mapping.userId,
        batch.id,
      ])
    }

    for (const assignment of current.newBranchAssignments) {
      const insertedAssignment = await client.query(`
        insert into branch_inventory (
          branch_id, organization_id, organization_inventory_id,
          assigned_by_user_id, is_visible, is_active
        ) values ($1, $2, $3, $4, false, false)
        returning branch_id, organization_id, organization_inventory_id, is_visible, is_active, deleted_at
      `, [assignment.branchId, KE_ORGANIZATION.id, assignment.organizationInventoryId, opts.actorUserId])
      const row = insertedAssignment.rows[0]
      if (row?.organization_id !== KE_ORGANIZATION.id
        || row.branch_id !== assignment.branchId
        || row.organization_inventory_id !== assignment.organizationInventoryId
        || row.is_visible !== false
        || row.is_active !== false
        || row.deleted_at !== null) {
        throw new Error("Historical branch assignment tenant/status validation failed")
      }
    }

    for (const order of current.readyOrders) {
      const isFullRefund = order.refundAmountCents === order.totalCents
      const [createdOrder] = await rows(client, `
        insert into orders (
          tid, organization_id, branch_id, status, fulfillment_status, payment_status,
          subtotal_cents, tax_cents, total_cents, notes, created_by_user_id,
          created_at, delivered_at, fulfilled_at, updated_at, refunded_at,
          refunded_by_user_id, status_at_refund, refund_amount_cents, refund_reason,
          receipt_data
        ) values (
          $1, $2, $3, $4, 'DELIVERED', 'UNPAID', $5, $6, $7, $8, $9,
          $10, $11, $11, $11, $11, $12, 'FULFILLED', $13, $14, $15::jsonb
        ) returning id, organization_id, tid
      `, [
        `KE-LEGACY-${order.legacyOrderId}`,
        KE_ORGANIZATION.id,
        order.branchId,
        isFullRefund ? "REFUNDED" : "FULFILLED",
        order.subtotalCents,
        order.taxCents,
        order.totalCents,
        `Historical K-Electric legacy order with reconciled refund; operational ledgers unchanged. Source order ${order.legacyOrderId}.`,
        order.createdByUserId,
        order.createdAt,
        order.refundedAt,
        opts.actorUserId,
        order.refundAmountCents,
        "Historical refund imported from K-Electric legacy logistics source",
        JSON.stringify(receipt(order)),
      ])
      if (createdOrder?.organization_id !== KE_ORGANIZATION.id || createdOrder.tid !== `KE-LEGACY-${order.legacyOrderId}`) {
        throw new Error(`Order insert tenant/TID validation failed for ${order.legacyOrderId}`)
      }

      const orderItemIdBySourceItemId = new Map<number, number>()
      for (const line of order.lines) {
        const [createdItem] = await rows(client, `
          insert into order_items (
            organization_id, organization_inventory_id, order_id, global_product_id,
            product_name, product_code, unit, quantity, price_cents, created_at
          ) values ($1, $2, $3, $4, $5, $6, 'unit', $7, $8, $9)
          returning id, organization_id
        `, [
          KE_ORGANIZATION.id,
          line.organizationInventoryId,
          createdOrder.id,
          line.globalProductId,
          line.sourceName,
          line.productCode,
          line.quantity,
          line.unitPriceCents,
          order.createdAt,
        ])
        if (createdItem?.organization_id !== KE_ORGANIZATION.id) throw new Error(`Order item tenant validation failed for ${order.legacyOrderId}`)
        orderItemIdBySourceItemId.set(line.sourceItemId, Number(createdItem.id))
      }

      const [createdRefund] = await rows(client, `
        insert into refunds (
          organization_id, order_id, amount_cents, tax_refund_cents, reason, status, refund_number,
          processed_by_user_id, created_at, updated_at
        ) values ($1, $2, $3, $4, $5, 'APPROVED', $6, $7, $8, $8)
        returning id, organization_id, order_id
      `, [
        KE_ORGANIZATION.id,
        createdOrder.id,
        order.refundAmountCents,
        order.taxRefundCents,
        "Historical refund imported from K-Electric legacy logistics source",
        `KE-R-${order.legacyOrderId}`,
        opts.actorUserId,
        order.refundedAt,
      ])
      if (createdRefund?.organization_id !== KE_ORGANIZATION.id || createdRefund.order_id !== createdOrder.id) {
        throw new Error(`Refund tenant/order validation failed for ${order.legacyOrderId}`)
      }

      for (const line of order.lines.filter((item) => item.refundedQuantity > 0)) {
        const orderItemId = orderItemIdBySourceItemId.get(line.sourceItemId)
        if (!orderItemId) throw new Error(`Refund item order-line mapping failed for ${order.legacyOrderId}`)
        await client.query(`
          insert into refund_items (refund_id, order_item_id, quantity, amount_cents, created_at)
          values ($1, $2, $3, $4, $5)
        `, [createdRefund.id, orderItemId, line.refundedQuantity, line.refundTotalCents, order.refundedAt])
      }

      await client.query(`
        insert into legacy_order_imports (
          batch_id, organization_id, source_system, legacy_order_id, order_id,
          source_checksum, source_payload
        ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      `, [
        batch.id,
        KE_ORGANIZATION.id,
        LEGACY_SOURCE,
        order.legacyOrderId,
        createdOrder.id,
        order.sourceChecksum,
        JSON.stringify({
          kind: "REFUND_AWARE",
          refundBreakdown: {
            itemRefundCents: order.itemRefundAmountCents,
            taxRefundCents: order.taxRefundCents,
            grossRefundCents: order.refundAmountCents,
          },
          sourceStatusPolicy: opts.approvedNonFinalLegacyOrderIds.has(order.legacyOrderId)
            ? "EXPLICITLY_APPROVED_AS_DELIVERED"
            : "LEGACY_TERMINAL_REFUND_STATUS",
          header: order.header,
          detail: order.detail,
          modal: order.modal,
          omittedZeroQuantityLines: order.omittedZeroQuantityLines,
        }),
      ])
    }

    await client.query(`
      insert into audit_logs (user_id, organization_id, action, entity, entity_id, metadata)
      values ($1, $2, 'LEGACY_REFUNDED_ORDER_IMPORT', 'legacy_import_batch', $3, $4::jsonb)
    `, [
      opts.actorUserId,
      KE_ORGANIZATION.id,
      String(batch.id),
      JSON.stringify({
        source: LEGACY_SOURCE,
        digest: source.manifestDigest,
        orderCount: current.readyOrders.length,
        refundAware: true,
        taxRefundBreakdown: true,
        approvedNonFinalLegacyOrderIds: source.approvedNonFinalLegacyOrderIds,
        createMissingBranchAssignments: source.createMissingBranchAssignments,
        stockOrBudgetChanged: false,
      }),
    ])

    await client.query(`
      update legacy_import_batches
      set status = 'COMPLETED', completed_at = now(), counts = $2::jsonb
      where id = $1 and organization_id = $3
    `, [
      batch.id,
      JSON.stringify({
        orders: current.readyOrders.length,
        orderItems: current.readyOrders.reduce((sum, order) => sum + order.lines.length, 0),
        refunds: current.readyOrders.length,
        refundItems: current.readyOrders.reduce((sum, order) => sum + order.lines.filter((line) => line.refundedQuantity > 0).length, 0),
        newBranchAssignments: current.newBranchAssignments.length,
        newUserMappings: current.newUserMappings.length,
      }),
      KE_ORGANIZATION.id,
    ])

    const [validation] = await rows(client, `
      select
        count(*)::int as orders,
        count(r.id)::int as refunds,
        coalesce(sum(o.total_cents), 0)::bigint as total_cents,
        coalesce(sum(r.amount_cents), 0)::bigint as refund_cents,
        coalesce(sum(r.tax_refund_cents), 0)::bigint as tax_refund_cents,
        count(*) filter (where o.organization_id <> $2 or r.organization_id <> $2)::int
          + (select count(*)::int from order_items oi
             join legacy_order_imports item_loi on item_loi.order_id = oi.order_id
             where item_loi.batch_id = $1 and item_loi.organization_id = $2 and oi.organization_id <> $2)
          as tenant_mismatches
      from legacy_order_imports loi
      join orders o on o.id = loi.order_id
      join refunds r on r.order_id = o.id
      where loi.batch_id = $1 and loi.organization_id = $2
    `, [batch.id, KE_ORGANIZATION.id])
    const expectedTotalCents = current.readyOrders.reduce((sum, order) => sum + order.totalCents, 0)
    const expectedRefundCents = current.readyOrders.reduce((sum, order) => sum + order.refundAmountCents, 0)
    const expectedTaxRefundCents = current.readyOrders.reduce((sum, order) => sum + order.taxRefundCents, 0)
    if (Number(validation.orders) !== current.readyOrders.length
      || Number(validation.refunds) !== current.readyOrders.length
      || Number(validation.total_cents) !== expectedTotalCents
      || Number(validation.refund_cents) !== expectedRefundCents
      || Number(validation.tax_refund_cents) !== expectedTaxRefundCents
      || Number(validation.tenant_mismatches) !== 0) {
      throw new Error("Post-insert order/refund validation failed; rolling back")
    }

    const refundItemValidation = await rows(client, `
      select loi.legacy_order_id,
             coalesce(sum(ri.amount_cents), 0)::bigint as item_refund_cents,
             max(r.amount_cents)::bigint as refund_cents,
             max(r.tax_refund_cents)::bigint as tax_refund_cents,
             count(*) filter (where ri.quantity <= 0 or ri.quantity > oi.quantity)::int as invalid_quantities
      from legacy_order_imports loi
      join refunds r on r.order_id = loi.order_id
      join refund_items ri on ri.refund_id = r.id
      join order_items oi on oi.id = ri.order_item_id and oi.order_id = loi.order_id
      where loi.batch_id = $1 and loi.organization_id = $2
      group by loi.legacy_order_id
    `, [batch.id, KE_ORGANIZATION.id])
    if (refundItemValidation.length !== current.readyOrders.length
      || refundItemValidation.some((row) =>
        Number(row.item_refund_cents) + Number(row.tax_refund_cents) !== Number(row.refund_cents)
        || Number(row.invalid_quantities) !== 0)) {
      throw new Error("Post-insert refund-item validation failed; rolling back")
    }

    const [supportingMappingsValidation] = await rows(client, `
      select count(*)::int as user_mappings
      from legacy_user_mappings where organization_id = $1 and created_by_batch_id = $2
    `, [KE_ORGANIZATION.id, batch.id])
    if (Number(supportingMappingsValidation.user_mappings) !== current.newUserMappings.length) {
      throw new Error("Post-insert supporting mapping validation failed; rolling back")
    }

    const afterOperational = await operationalState(client, productIds, false)
    if (stableDigest(afterOperational) !== operationalDigest) throw new Error("Operational stock/budget/invoice ledger changed; rolling back")

    if (persist) await client.query("commit")
    else await client.query("rollback")
    return {
      batchId: String(batch.id),
      importedOrderIds: current.readyOrders.map((order) => order.legacyOrderId),
      persisted: persist,
    }
  } catch (error) {
    await client.query("rollback")
    throw error
  }
}

function writeReport(path: string | undefined, value: unknown) {
  if (!path) return
  const absolute = resolve(path)
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  console.log(`Report written             : ${absolute}`)
}

async function main() {
  const opts = options()
  const source = prepareSource(opts)
  if (opts.sourceOnly) {
    const sourceOnlyReport = {
      generatedAt: new Date().toISOString(),
      mode: "SOURCE_ONLY",
      manifestDigest: source.manifestDigest,
      manifest: source.manifest,
      approvedNonFinalLegacyOrderIds: source.approvedNonFinalLegacyOrderIds,
      createMissingBranchAssignments: source.createMissingBranchAssignments,
      sourceCount: source.sourceCount,
      eligibleOrderIds: source.prepared.map((order) => order.legacyOrderId),
      excluded: source.excluded,
      totals: {
        orderCents: source.prepared.reduce((sum, order) => sum + order.totalCents, 0),
        itemRefundCents: source.prepared.reduce((sum, order) => sum + order.itemRefundAmountCents, 0),
        taxRefundCents: source.prepared.reduce((sum, order) => sum + order.taxRefundCents, 0),
        grossRefundCents: source.prepared.reduce((sum, order) => sum + order.refundAmountCents, 0),
      },
    }
    console.log(JSON.stringify(sourceOnlyReport, null, 2))
    writeReport(opts.outputPath, sourceOnlyReport)
    return
  }
  const client = await pool.connect()
  try {
    await client.query("begin isolation level repeatable read read only")
    const reconciliation = await reconcile(client, source.prepared, opts.createMissingBranchAssignments)
    await client.query("commit")

    const blockingIssues = reconciliation.globalErrors.length
      + reconciliation.requiredSchemaErrors.length
    const totalReadyCents = reconciliation.readyOrders.reduce((sum, order) => sum + order.totalCents, 0)
    const totalReadyRefundCents = reconciliation.readyOrders.reduce((sum, order) => sum + order.refundAmountCents, 0)
    const totalReadyItemRefundCents = reconciliation.readyOrders.reduce((sum, order) => sum + order.itemRefundAmountCents, 0)
    const totalReadyTaxRefundCents = reconciliation.readyOrders.reduce((sum, order) => sum + order.taxRefundCents, 0)
    const report = {
      generatedAt: new Date().toISOString(),
      mode: (() => {
        if (opts.commit) {
          return "COMMIT_REQUESTED"
        }
        if (opts.rollbackTest) {
          return "ROLLBACK_TEST_REQUESTED"
        }
        return "DRY_RUN"
      })(),
      organization: reconciliation.organization,
      configuredActorUserId: reconciliation.configuredActorUserId,
      configuredActorMatchCount: reconciliation.configuredActorMatchCount,
      activeSuperAdminUserIds: reconciliation.activeSuperAdminUserIds,
      latestLegacyImportActorUserId: reconciliation.latestLegacyImportActorUserId,
      manifestDigest: source.manifestDigest,
      manifest: source.manifest,
      policy: {
        taxRefunds: "STORED_SEPARATELY_WHILE_AMOUNT_CENTS_REMAINS_GROSS",
        approvedNonFinalLegacyOrderIds: source.approvedNonFinalLegacyOrderIds,
        negativeOrUnreconciledRefundState: "EXCLUDED",
        zeroQuantityLines: "OMIT_ONLY_WHEN_PROVEN_ZERO_VALUE_AND_NOT_REFUNDED",
        createCatalogOrUsers: false,
        createInactiveBranchAssignmentsWhenMissing: source.createMissingBranchAssignments,
        createLedgerUserMappingsOnlyForUniqueExistingActiveUsers: true,
        operationalLedgers: "MUST_REMAIN_BYTE_EQUIVALENT",
      },
      sourceRefundOrders: source.sourceCount,
      sourceEligible: source.prepared.length,
      sourceExcluded: source.excluded,
      readyOrderIds: reconciliation.readyOrders.map((order) => order.legacyOrderId),
      newBranchAssignments: reconciliation.newBranchAssignments,
      newUserMappings: reconciliation.newUserMappings.map((mapping) => ({
        legacyOrderTakerId: mapping.legacyOrderTakerId,
        branchId: mapping.branchId,
        sourceName: mapping.sourceName,
      })),
      alreadyImported: reconciliation.alreadyImported,
      orderBlocks: reconciliation.orderBlocks,
      totals: {
        readyOrders: reconciliation.readyOrders.length,
        readyOrderItems: reconciliation.readyOrders.reduce((sum, order) => sum + order.lines.length, 0),
        readyRefundItems: reconciliation.readyOrders.reduce((sum, order) => sum + order.lines.filter((line) => line.refundedQuantity > 0).length, 0),
        readyGrossCents: totalReadyCents,
        readyRefundCents: totalReadyRefundCents,
        readyItemRefundCents: totalReadyItemRefundCents,
        readyTaxRefundCents: totalReadyTaxRefundCents,
      },
      dbCounts: reconciliation.dbCounts,
      ledgerIntegrity: reconciliation.ledgerIntegrity,
      requiredSchemaErrors: reconciliation.requiredSchemaErrors,
      globalErrors: reconciliation.globalErrors,
      blockingIssues,
    }

    console.log("\nK-Electric refund-aware legacy import preflight")
    console.log("-----------------------------------------------")
    console.log(`Mode                       : ${report.mode}`)
    console.log(`Organization verified      : ${reconciliation.organization?.name ?? "FAILED"} (id=${reconciliation.organization?.id ?? "missing"}, code=${reconciliation.organization?.code ?? "missing"})`)
    console.log(`Configured actor matches   : ${reconciliation.configuredActorMatchCount}`)
    console.log(`Active super-admin actors  : ${reconciliation.activeSuperAdminUserIds.length}`)
    console.log(`Prior migration actor valid: ${reconciliation.latestLegacyImportActorUserId != null && reconciliation.activeSuperAdminUserIds.includes(reconciliation.latestLegacyImportActorUserId)}`)
    console.log(`Manifest confirmation      : ${source.manifestDigest}`)
    console.log(`Refund rows audited        : ${source.sourceCount}`)
    console.log(`Source eligible/excluded   : ${source.prepared.length}/${source.excluded.length}`)
    console.log(`Already imported           : ${reconciliation.alreadyImported.length}`)
    console.log(`Ready this run             : ${reconciliation.readyOrders.length}`)
    console.log(`Ready gross/refund PKR     : ${(totalReadyCents / 100).toFixed(2)}/${(totalReadyRefundCents / 100).toFixed(2)}`)
    console.log(`Item/tax refund PKR        : ${(totalReadyItemRefundCents / 100).toFixed(2)}/${(totalReadyTaxRefundCents / 100).toFixed(2)}`)
    console.log(`Skipped target mapping     : ${reconciliation.orderBlocks.length}`)
    console.log(`Schema/global blockers     : ${reconciliation.requiredSchemaErrors.length}/${reconciliation.globalErrors.length}`)
    console.log(`New branch/user mappings   : ${reconciliation.newBranchAssignments.length}/${reconciliation.newUserMappings.length}`)
    console.log(`Existing legacy imports    : ${reconciliation.dbCounts.legacy_imports ?? "unknown"}`)
    if (source.excluded.length > 0) console.log(`Source exclusions          : ${JSON.stringify(source.excluded)}`)
    if (reconciliation.orderBlocks.length > 0) console.log(`Target mapping blocks      : ${JSON.stringify(reconciliation.orderBlocks)}`)
    if (reconciliation.requiredSchemaErrors.length > 0) console.log(`Schema blocks              : ${JSON.stringify(reconciliation.requiredSchemaErrors)}`)
    if (reconciliation.globalErrors.length > 0) console.log(`Global blocks              : ${JSON.stringify(reconciliation.globalErrors)}`)
    writeReport(opts.outputPath, report)

    if (!opts.commit && !opts.rollbackTest) {
      console.log("\nNothing was written to the database.")
      return
    }

    const expectedOrg = `${KE_ORGANIZATION.id}:${KE_ORGANIZATION.code}:${KE_ORGANIZATION.name}`
    if (blockingIssues !== 0) throw new Error(`Commit refused: ${blockingIssues} blocking issues`)
    if (!opts.actorUserId) throw new Error("Commit requires --actor-user-id")
    if (opts.confirmOrganization !== expectedOrg) throw new Error(`Commit requires --confirm-organization=${expectedOrg}`)
    if (opts.confirmManifest !== source.manifestDigest) throw new Error("Manifest confirmation does not match the current refund evidence")
    if (opts.expectedOrders !== reconciliation.readyOrders.length) throw new Error(`Commit requires --expected-orders=${reconciliation.readyOrders.length}`)
    if (reconciliation.readyOrders.length === 0) throw new Error("Commit refused: there are no new refund-aware orders to import")

    const committed = await commitOrders(client, source, opts, opts.commit)
    console.log(committed.persisted
      ? `\nCommitted ${committed.importedOrderIds.length} K-Electric refund-aware historical orders atomically.`
      : `\nRollback rehearsal passed for ${committed.importedOrderIds.length} K-Electric refund-aware historical orders; no data persisted.`)
    console.log(`Batch ID                   : ${committed.persisted ? committed.batchId : "rolled back"}`)
    console.log(`Legacy order IDs           : ${committed.importedOrderIds.join(", ")}`)
  } finally {
    client.release()
  }
}

function safeError(error: unknown) {
  const value = error && typeof error === "object" ? error as JsonRow : {}
  return Object.fromEntries(Object.entries({
    message: value.message ?? String(error),
    code: value.code,
    detail: value.detail,
    constraint: value.constraint,
    table: value.table,
  }).filter(([, item]) => item !== undefined))
}

main()
  .catch((error) => {
    console.error(`\nImport failed: ${JSON.stringify(safeError(error))}`)
    process.exitCode = 1
  })
  .finally(async () => {
    await pool.end().catch(() => undefined)
  })
