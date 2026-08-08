#!/usr/bin/env tsx

/**
 * Convert the independently captured current-missing-order audit into the
 * narrow source contract used by the guarded K-Electric refund importer.
 *
 * This script is intentionally pinned to legacy orders 43 and 44. It refuses
 * to emit source files unless item prices, item refunds, tax refunds, totals,
 * statuses, and timestamps all reconcile exactly.
 */

import { createHash } from "crypto"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { resolve } from "path"

import { KE_ORGANIZATION, toCents } from "../lib/legacy-import/ke-electric"
import { buildRefundBreakdownCents } from "../lib/refund-breakdown"

type JsonRow = Record<string, any>

const REQUIRED_ORDER_IDS = [43, 44] as const
const EXPECTED_SOURCE_STATE: Record<number, { statusId: number; deliveryStatus: number }> = {
  43: { statusId: 4, deliveryStatus: 507 },
  44: { statusId: 9, deliveryStatus: 506 },
}

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex")
}

function validDate(value: unknown): boolean {
  return !Number.isNaN(new Date(String(value ?? "")).getTime())
}

function main() {
  const inputPath = resolve(arg("--input") ?? "updatedReports/ke-current-missing-orders-live-detail-audit-2026-08-04.json")
  const reportPath = resolve(arg("--report-output") ?? "updatedReports/ke-tax-refund-orders-43-44-source.json")
  const auditPath = resolve(arg("--audit-output") ?? "updatedReports/ke-tax-refund-orders-43-44-evidence.json")
  if (!existsSync(inputPath)) throw new Error(`Audit source not found: ${inputPath}`)

  const inputBuffer = readFileSync(inputPath)
  const source = JSON.parse(inputBuffer.toString("utf8")) as JsonRow
  if (Number(source.organization?.id) !== KE_ORGANIZATION.id
    || String(source.organization?.code) !== KE_ORGANIZATION.code
    || String(source.organization?.name) !== KE_ORGANIZATION.name) {
    throw new Error(`Expected the audited K-Electric organization (id=${KE_ORGANIZATION.id}, code=${KE_ORGANIZATION.code})`)
  }

  const sourceOrders = Array.isArray(source.orders) ? source.orders as JsonRow[] : []
  const report: JsonRow[] = []
  const details: JsonRow[] = []
  const responses: JsonRow[] = []
  const orderEvidence: JsonRow[] = []
  const reconciliation: JsonRow[] = []

  for (const legacyOrderId of REQUIRED_ORDER_IDS) {
    const matches = sourceOrders.filter((order) => Number(order.legacyOrderId) === legacyOrderId)
    if (matches.length !== 1) throw new Error(`Expected one audited source row for order ${legacyOrderId}; found ${matches.length}`)

    const order = matches[0]
    const detail = order.rawDetail as JsonRow
    const modal = order.refundModal?.raw as JsonRow
    const checkout = order.checkout as JsonRow
    const expectedState = EXPECTED_SOURCE_STATE[legacyOrderId]
    if (!order.realDetail || !order.refundModal?.ok || !detail || !modal || !checkout) {
      throw new Error(`Order ${legacyOrderId} is missing successful detail or refund-modal evidence`)
    }
    if (Number(detail.ID) !== legacyOrderId || Number(modal.ID) !== legacyOrderId) {
      throw new Error(`Order ${legacyOrderId} detail/modal identity mismatch`)
    }
    if (Number(detail.StatusID) !== expectedState.statusId || Number(detail.DeliveryStatus) !== expectedState.deliveryStatus) {
      throw new Error(`Order ${legacyOrderId} source status changed from the reviewed state`)
    }
    if (!validDate(detail.OrderCreatedDT) || !validDate(detail.LastUpdateDT)
      || new Date(detail.LastUpdateDT).getTime() < new Date(detail.OrderCreatedDT).getTime()) {
      throw new Error(`Order ${legacyOrderId} has invalid timestamps`)
    }

    const subtotalCents = toCents(checkout.AmountTotal)
    const taxCents = toCents(checkout.Tax)
    const totalCents = toCents(checkout.GrandTotal)
    const itemRefundCents = toCents(checkout.RefundAmount)
    const taxRefundCents = toCents(checkout.TaxRefund)
    const grossRefundCents = buildRefundBreakdownCents(itemRefundCents, taxRefundCents).grossRefundCents
    if (subtotalCents <= 0 || taxCents < 0 || subtotalCents + taxCents !== totalCents
      || itemRefundCents <= 0 || taxRefundCents <= 0 || grossRefundCents > totalCents) {
      throw new Error(`Order ${legacyOrderId} financial totals do not reconcile`)
    }
    if (taxRefundCents * subtotalCents !== itemRefundCents * taxCents) {
      throw new Error(`Order ${legacyOrderId} tax refund is not proportional to the item refund`)
    }
    if (toCents(checkout.AmountDiscount) !== 0 || toCents(checkout.ServiceCharges) !== 0 || toCents(checkout.DeliveryCharges) !== 0) {
      throw new Error(`Order ${legacyOrderId} has an unsupported discount or charge`)
    }

    const modalItems = Array.isArray(order.refundModal?.itemRows) ? order.refundModal.itemRows as JsonRow[] : []
    const detailItems = Array.isArray(detail.OrderDetailsList) ? detail.OrderDetailsList as JsonRow[] : []
    const historyEvidence = Array.isArray(order.itemEvidence) ? order.itemEvidence as JsonRow[] : []
    if (modalItems.length === 0 || modalItems.length !== detailItems.length) {
      throw new Error(`Order ${legacyOrderId} item evidence is incomplete`)
    }

    let calculatedSubtotalCents = 0
    let calculatedItemRefundCents = 0
    let refundedLineCount = 0
    for (const item of modalItems) {
      const sourceItemId = Number(item.ItemId)
      const quantity = Number(item.Quantity)
      const remainingQuantity = Number(item.RefundQuantity ?? quantity)
      const unitPriceCents = toCents(item.UnitPrice)
      const refundPriceCents = toCents(item.RefundPrice)
      const detailMatches = detailItems.filter((candidate) => Number(candidate.ItemId) === sourceItemId)
      const historyMatches = historyEvidence.filter((candidate) => Number(candidate.ItemId) === sourceItemId)
      if (!Number.isSafeInteger(sourceItemId) || sourceItemId <= 0 || detailMatches.length !== 1 || historyMatches.length !== 1) {
        throw new Error(`Order ${legacyOrderId} item ${sourceItemId} identity evidence is ambiguous`)
      }
      if (!Number.isFinite(quantity) || quantity <= 0 || !Number.isFinite(remainingQuantity)
        || remainingQuantity < 0 || remainingQuantity > quantity || unitPriceCents < 0) {
        throw new Error(`Order ${legacyOrderId} item ${sourceItemId} has an invalid quantity or price`)
      }
      if (Number(historyMatches[0].selectedHistoryUnitPriceCents) !== unitPriceCents) {
        throw new Error(`Order ${legacyOrderId} item ${sourceItemId} modal/history price mismatch`)
      }
      const refundedQuantity = quantity - remainingQuantity
      const expectedRefundCents = Math.round(refundedQuantity * unitPriceCents)
      if (refundPriceCents !== expectedRefundCents
        || Number(detailMatches[0].RefundQuantity ?? 0) !== refundedQuantity) {
        throw new Error(`Order ${legacyOrderId} item ${sourceItemId} refund evidence mismatch`)
      }
      calculatedSubtotalCents += Math.round(quantity * unitPriceCents)
      calculatedItemRefundCents += expectedRefundCents
      if (refundedQuantity > 0) refundedLineCount += 1
    }
    if (calculatedSubtotalCents !== subtotalCents || calculatedItemRefundCents !== itemRefundCents || refundedLineCount === 0) {
      throw new Error(`Order ${legacyOrderId} item totals do not reconcile to checkout`)
    }
    if (legacyOrderId === 43 && grossRefundCents !== totalCents) {
      throw new Error("Order 43 must remain a fully reconciled gross refund")
    }
    if (legacyOrderId === 44 && grossRefundCents >= totalCents) {
      throw new Error("Order 44 must remain a partial refund")
    }

    report.push({
      ID: legacyOrderId,
      Location: String(order.branch),
      LocationID: Number(order.locationId),
      OrderTakerID: Number(detail.OrderTakerID),
      LastUpdateBy: String(detail.LastUpdatedBy),
      CreatedOn: detail.OrderCreatedDT,
      LastUpdateDT: detail.LastUpdateDT,
      StatusID: Number(detail.StatusID),
      DeliveryStatus: Number(detail.DeliveryStatus),
      AmountTotal: Number(checkout.AmountTotal),
      Tax: Number(checkout.Tax),
      GrandTotal: Number(checkout.GrandTotal),
      RefundAmount: Number(checkout.RefundAmount),
      TaxRefund: Number(checkout.TaxRefund),
      AmountDiscount: Number(checkout.AmountDiscount ?? 0),
      ServiceCharges: Number(checkout.ServiceCharges ?? 0),
    })
    details.push({ reportOrderId: legacyOrderId, ok: true, checkout, items: detailItems, raw: detail })
    responses.push({ reportOrderId: legacyOrderId, ok: true, items: modalItems, raw: modal })
    orderEvidence.push({
      reportOrderId: legacyOrderId,
      originalSubtotalComplete: true,
      originalSubtotalReconciles: calculatedSubtotalCents === subtotalCents,
      refundPriceComplete: modalItems.every((item) => item.RefundPrice != null),
      unitPriceComplete: modalItems.every((item) => item.UnitPrice != null),
      refundPriceReconciles: calculatedItemRefundCents === itemRefundCents,
      unitPriceReconciles: calculatedSubtotalCents === subtotalCents,
      hasNegativeDetailPrice: detailItems.some((item) => Number(item.Price ?? 0) < 0),
      hasNegativeModalRefundQuantity: modalItems.some((item) => Number(item.RefundQuantity ?? item.Quantity) < 0),
    })
    reconciliation.push({
      legacyOrderId,
      subtotalCents,
      taxCents,
      totalCents,
      itemRefundCents,
      taxRefundCents,
      grossRefundCents,
      sourceStatusId: Number(detail.StatusID),
      sourceDeliveryStatus: Number(detail.DeliveryStatus),
    })
  }

  const audit = {
    generatedAt: new Date().toISOString(),
    kind: "KE_TAX_REFUND_IMPORT_EVIDENCE",
    organization: source.organization,
    source: { path: inputPath, sha256: sha256(inputBuffer), bytes: inputBuffer.byteLength },
    policy: {
      exactLegacyOrderIds: REQUIRED_ORDER_IDS,
      order44NonFinalStatus: "REQUIRES_EXPLICIT_IMPORT_FLAG",
      grossRefund: "RefundAmount + TaxRefund",
    },
    reconciliation,
    details,
    refundModalEvidence: { responses, orderEvidence },
  }

  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  writeFileSync(auditPath, `${JSON.stringify(audit, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
  console.log(JSON.stringify({
    input: { path: inputPath, sha256: sha256(inputBuffer) },
    report: { path: reportPath, sha256: sha256(readFileSync(reportPath)), orders: report.length },
    audit: { path: auditPath, sha256: sha256(readFileSync(auditPath)) },
    reconciliation,
  }, null, 2))
}

main()
