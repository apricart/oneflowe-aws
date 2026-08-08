import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"

const BASE_URL = "https://logistics.oneflowe.com/"
const INPUT = path.resolve("updatedReports/refundReport.json")
const OUTPUT = path.resolve("updatedReports/ke-refund-detail-audit-2026-08-03.json")
const ORDER_LINES = path.resolve("updatedReports/orderPurchaseReport.json")
const PRICE_HISTORY = path.resolve("updatedReports/productPriceHistory.json")

function numberOrNull(value) {
  if (value == null || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function closeEnough(left, right, tolerance = 0.01) {
  return left != null && right != null && Math.abs(left - right) <= tolerance
}

function normalize(value) {
  return String(value ?? "").trim().toLocaleLowerCase("en").replace(/\s+/g, " ")
}

function distinctPositive(values) {
  return [...new Set(values.map(Number).filter((value) => Number.isFinite(value) && value > 0))]
}

async function reconcileExistingAudit() {
  const [audit, refundRows, orderLines, priceHistory] = await Promise.all([
    readFile(OUTPUT, "utf8").then(JSON.parse),
    readFile(INPUT, "utf8").then(JSON.parse),
    readFile(ORDER_LINES, "utf8").then(JSON.parse),
    readFile(PRICE_HISTORY, "utf8").then(JSON.parse),
  ])
  const refundById = new Map(refundRows.map((row) => [String(row.ID), row]))
  const itemEvidence = []
  const orderEvidence = []

  for (const detail of audit.details.filter((row) => row.ok)) {
    const reportRow = refundById.get(String(detail.reportOrderId))
    const refundedItems = detail.items.filter((item) => Number(item.RefundQuantity || 0) > 0)
    const rowsForOrder = orderLines.filter((row) => String(row.ID) === String(detail.reportOrderId) && String(row.LocationID) === String(detail.reportLocationId))
    const orderDate = Date.parse(detail.detailHeader.OrderCreatedDT || reportRow?.OrderCreatedDT)
    const locationName = normalize(reportRow?.Location)
    const resolved = []

    for (const item of refundedItems) {
      const name = normalize(item.Name)
      const exactOrderLines = rowsForOrder.filter((row) => normalize(row.ItemDetails) === name)
      const orderLinePrices = distinctPositive(exactOrderLines.map((row) => row.UnitPrice))
      const histories = priceHistory.filter((row) => normalize(row.ItemName) === name && normalize(row.Location) === locationName && Number.isFinite(Date.parse(row.Date)) && Date.parse(row.Date) <= orderDate)
      const sameDayPrices = distinctPositive(histories.filter((row) => new Date(row.Date).toISOString().slice(0, 10) === new Date(orderDate).toISOString().slice(0, 10)).map((row) => row.Price))
      const latestTimestamp = histories.length ? Math.max(...histories.map((row) => Date.parse(row.Date))) : null
      const latestPriorPrices = latestTimestamp == null ? [] : distinctPositive(histories.filter((row) => Date.parse(row.Date) === latestTimestamp).map((row) => row.Price))

      let selectedPrice = null
      let selectedEvidence = null
      if (refundedItems.length === 1 && detail.checkout?.RefundAmount != null && Number(item.RefundQuantity) > 0) {
        selectedPrice = Number(detail.checkout.RefundAmount) / Number(item.RefundQuantity)
        selectedEvidence = "single-refunded-item checkout allocation"
      } else if (orderLinePrices.length === 1) {
        selectedPrice = orderLinePrices[0]
        selectedEvidence = "exact order/location/item line"
      } else if (sameDayPrices.length === 1) {
        selectedPrice = sameDayPrices[0]
        selectedEvidence = "same-day item/location price history"
      } else if (latestPriorPrices.length === 1) {
        selectedPrice = latestPriorPrices[0]
        selectedEvidence = "latest prior item/location price history"
      }
      const row = {
        reportOrderId: detail.reportOrderId,
        reportLocationId: detail.reportLocationId,
        itemId: item.ItemId,
        itemName: item.Name,
        quantity: item.Quantity,
        refundQuantity: item.RefundQuantity,
        exactOrderLineMatches: exactOrderLines.length,
        orderLinePrices,
        sameDayPrices,
        latestPriorPrices,
        selectedPrice: selectedPrice == null ? null : Number(selectedPrice.toFixed(4)),
        selectedEvidence,
        allocatedRefundAmount: selectedPrice == null ? null : Number((selectedPrice * Number(item.RefundQuantity)).toFixed(4)),
      }
      itemEvidence.push(row)
      resolved.push(row)
    }

    const allocated = resolved.filter((row) => row.allocatedRefundAmount != null)
    const allocatedTotal = allocated.reduce((sum, row) => sum + row.allocatedRefundAmount, 0)
    orderEvidence.push({
      reportOrderId: detail.reportOrderId,
      refundItemRows: resolved.length,
      resolvedItemRows: allocated.length,
      checkoutRefundAmount: detail.checkout?.RefundAmount ?? null,
      allocatedRefundAmount: Number(allocatedTotal.toFixed(4)),
      fullyResolved: resolved.length > 0 && allocated.length === resolved.length,
      reconcilesToCheckoutRefundAmount: resolved.length > 0 && allocated.length === resolved.length && closeEnough(allocatedTotal, detail.checkout?.RefundAmount),
      allOrderItemsRefunded: refundedItems.length === detail.items.length,
    })
  }

  audit.crossExportReconciliation = {
    method: "Resolve sole refunded item directly from checkout RefundAmount/RefundQuantity; otherwise require one exact order-line price, one same-day location price, or one latest-prior location price. An order is migration-ready only if all refund items resolve and their allocated total equals checkout RefundAmount.",
    summary: {
      refundItemRows: itemEvidence.length,
      itemsResolvedBySingleItemAllocation: itemEvidence.filter((row) => row.selectedEvidence === "single-refunded-item checkout allocation").length,
      itemsResolvedByExactOrderLine: itemEvidence.filter((row) => row.selectedEvidence === "exact order/location/item line").length,
      itemsResolvedBySameDayPriceHistory: itemEvidence.filter((row) => row.selectedEvidence === "same-day item/location price history").length,
      itemsResolvedByLatestPriorPriceHistory: itemEvidence.filter((row) => row.selectedEvidence === "latest prior item/location price history").length,
      unresolvedItemRows: itemEvidence.filter((row) => row.selectedPrice == null).length,
      fullyResolvedOrders: orderEvidence.filter((row) => row.fullyResolved).length,
      ordersReconcilingToCheckoutRefundAmount: orderEvidence.filter((row) => row.reconcilesToCheckoutRefundAmount).length,
      ordersRequiringFurtherEvidence: orderEvidence.filter((row) => !row.reconcilesToCheckoutRefundAmount).length,
      allOrderItemsRefundedOrders: orderEvidence.filter((row) => row.allOrderItemsRefunded).length,
    },
    orderEvidence,
    itemEvidence,
  }
  await writeFile(OUTPUT, `${JSON.stringify(audit, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, crossExportReconciliation: audit.crossExportReconciliation.summary }, null, 2))
}

async function fetchDetail(row) {
  const pathname = `api/OrderDetailController/${encodeURIComponent(row.LocationID)}/${encodeURIComponent(row.ID)}`
  const startedAt = Date.now()
  const response = await fetch(new URL(pathname, BASE_URL), {
    method: "GET",
    headers: { Accept: "application/json, text/plain, */*" },
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!response.ok || !data || typeof data !== "object") {
    return {
      reportOrderId: row.ID,
      locationId: row.LocationID,
      ok: false,
      status: response.status,
      durationMs: Date.now() - startedAt,
      error: typeof data === "string" ? data.slice(0, 240) : JSON.stringify(data).slice(0, 240),
    }
  }

  const checkout = Array.isArray(data.OrderCheckoutList) ? data.OrderCheckoutList[0] : null
  const items = Array.isArray(data.OrderDetailsList) ? data.OrderDetailsList : []
  return {
    reportOrderId: row.ID,
    reportLocationId: row.LocationID,
    reportTransactionNo: row.TransactionNo,
    ok: true,
    status: response.status,
    durationMs: Date.now() - startedAt,
    detailHeader: {
      ID: data.ID,
      LocationID: data.LocationID,
      TransactionNo: data.TransactionNo,
      OrderNo: data.OrderNo,
      StatusID: data.StatusID,
      DeliveryStatus: data.DeliveryStatus,
      OrderCreatedDT: data.OrderCreatedDT,
      OrderType: data.OrderType,
    },
    checkout: checkout ? {
      ID: checkout.ID,
      OrderID: checkout.OrderID,
      LocationID: checkout.LocationID,
      TransactionNo: checkout.TransactionNo,
      OrderNo: checkout.OrderNo,
      PaymentMode: checkout.PaymentMode,
      AmountTotal: numberOrNull(checkout.AmountTotal),
      AmountDiscount: numberOrNull(checkout.AmountDiscount),
      ItemDiscountAmount: numberOrNull(checkout.ItemDiscountAmount),
      Tax: numberOrNull(checkout.Tax),
      GrandTotal: numberOrNull(checkout.GrandTotal),
      RefundAmount: numberOrNull(checkout.RefundAmount),
      TaxRefund: numberOrNull(checkout.TaxRefund),
      ServiceCharges: numberOrNull(checkout.ServiceCharges),
      DeliveryCharges: numberOrNull(checkout.DeliveryCharges),
      CheckoutDate: checkout.CheckoutDate,
      OrderStatus: checkout.OrderStatus,
    } : null,
    items: items.map((item) => ({
      ID: item.ID,
      OrderID: item.OrderID,
      ItemId: item.ItemId,
      Name: item.Name,
      Quantity: numberOrNull(item.Quantity),
      RefundQuantity: numberOrNull(item.RefundQuantity),
      Price: numberOrNull(item.Price),
      UnitPrice: numberOrNull(item.UnitPrice),
      RefundPrice: numberOrNull(item.RefundPrice),
      DiscountPrice: numberOrNull(item.DiscountPrice),
      RefundDiscountPrice: numberOrNull(item.RefundDiscountPrice),
      PriceWithVAT: numberOrNull(item.PriceWithVAT),
      ItemCode: item.ItemCode,
      StatusID: item.StatusID,
      ItemType: item.ItemType,
      CategoryName: item.CategoryName,
      modifierCount: Array.isArray(item.Modifiers) ? item.Modifiers.length : 0,
      variantCount: Array.isArray(item.Variants) ? item.Variants.length : 0,
    })),
  }
}

async function fetchRefundModal(row) {
  const pathname = `api/RefundModal/${encodeURIComponent(row.LocationID)}/${encodeURIComponent(row.TransactionNo)}`
  const response = await fetch(new URL(pathname, BASE_URL), {
    method: "GET",
    headers: { Accept: "application/json, text/plain, */*" },
  })
  const text = await response.text()
  let data = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = text
  }
  if (!response.ok || !data || typeof data !== "object") {
    return { reportOrderId: row.ID, ok: false, status: response.status, error: typeof data === "string" ? data.slice(0, 240) : JSON.stringify(data).slice(0, 240) }
  }
  return {
    reportOrderId: row.ID,
    reportLocationId: row.LocationID,
    reportTransactionNo: row.TransactionNo,
    ok: true,
    status: response.status,
    items: (Array.isArray(data.OrderDetailsList) ? data.OrderDetailsList : []).map((item) => ({
      ID: item.ID,
      OrderID: item.OrderID,
      ItemId: item.ItemId,
      Name: item.Name,
      Quantity: numberOrNull(item.Quantity),
      RefundQuantity: numberOrNull(item.RefundQuantity),
      Price: numberOrNull(item.Price),
      UnitPrice: numberOrNull(item.UnitPrice),
      RefundPrice: numberOrNull(item.RefundPrice),
      DiscountPrice: numberOrNull(item.DiscountPrice),
      RefundDiscountPrice: numberOrNull(item.RefundDiscountPrice),
      PriceWithVAT: numberOrNull(item.PriceWithVAT),
      ItemCode: item.ItemCode,
      CategoryName: item.CategoryName,
    })),
  }
}

async function auditRefundModal() {
  const [audit, refundRows] = await Promise.all([
    readFile(OUTPUT, "utf8").then(JSON.parse),
    readFile(INPUT, "utf8").then(JSON.parse),
  ])
  const modalDetails = []
  for (const row of refundRows) {
    modalDetails.push(await fetchRefundModal(row))
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  const modalByOrder = new Map(modalDetails.filter((row) => row.ok).map((row) => [String(row.reportOrderId), row]))
  const itemEvidence = []
  const orderEvidence = []
  for (const detail of audit.details.filter((row) => row.ok)) {
    const modal = modalByOrder.get(String(detail.reportOrderId))
    const refundedItems = detail.items.filter((item) => Number(item.RefundQuantity || 0) > 0)
    const joined = refundedItems.map((item) => {
      const candidates = modal?.items.filter((modalItem) => String(modalItem.ID) === String(item.ID)) || []
      const fallback = candidates.length ? candidates : (modal?.items.filter((modalItem) => String(modalItem.ItemId) === String(item.ItemId) && normalize(modalItem.Name) === normalize(item.Name)) || [])
      const match = fallback.length === 1 ? fallback[0] : null
      return {
        reportOrderId: detail.reportOrderId,
        itemRowId: item.ID,
        itemId: item.ItemId,
        itemName: item.Name,
        refundQuantity: item.RefundQuantity,
        modalMatches: fallback.length,
        modalPrice: match?.Price ?? null,
        modalUnitPrice: match?.UnitPrice ?? null,
        modalRefundPrice: match?.RefundPrice ?? null,
        modalDiscountPrice: match?.DiscountPrice ?? null,
        modalRefundDiscountPrice: match?.RefundDiscountPrice ?? null,
      }
    })
    itemEvidence.push(...joined)

    const sum = (selector) => joined.reduce((total, item) => {
      const price = selector(item)
      return total + (price != null && price >= 0 ? Number(item.refundQuantity) * price : 0)
    }, 0)
    const directSum = (selector) => joined.reduce((total, item) => {
      const amount = selector(item)
      return total + (amount != null && amount >= 0 ? amount : 0)
    }, 0)
    const allHave = (selector) => joined.length > 0 && joined.every((item) => selector(item) != null && selector(item) >= 0)
    const refundPriceTotal = directSum((item) => item.modalRefundPrice)
    const unitPriceTotal = sum((item) => item.modalUnitPrice)
    const refundDiscountFallbackTotal = directSum((item) => item.modalRefundDiscountPrice != null && item.modalRefundDiscountPrice > 0 ? item.modalRefundDiscountPrice : item.modalRefundPrice)
    const discountFallbackTotal = directSum((item) => item.modalDiscountPrice != null && item.modalDiscountPrice > 0 ? item.modalDiscountPrice : item.modalRefundPrice)
    const checkoutRefundAmount = detail.checkout?.RefundAmount ?? null
    const originalSubtotal = (modal?.items || []).reduce((total, item) => total + Number(item.Quantity || 0) * Number(item.UnitPrice || 0), 0)
    const originalSubtotalComplete = (modal?.items || []).every((item) => item.UnitPrice != null || Number(item.Quantity || 0) === 0)
    orderEvidence.push({
      reportOrderId: detail.reportOrderId,
      refundItemRows: joined.length,
      uniquelyMatchedItemRows: joined.filter((item) => item.modalMatches === 1).length,
      checkoutRefundAmount,
      refundPriceTotal: Number(refundPriceTotal.toFixed(4)),
      unitPriceTotal: Number(unitPriceTotal.toFixed(4)),
      refundDiscountFallbackTotal: Number(refundDiscountFallbackTotal.toFixed(4)),
      discountFallbackTotal: Number(discountFallbackTotal.toFixed(4)),
      originalSubtotal: Number(originalSubtotal.toFixed(4)),
      checkoutSubtotal: detail.checkout?.AmountTotal ?? null,
      originalSubtotalComplete,
      originalSubtotalReconciles: originalSubtotalComplete && closeEnough(originalSubtotal, detail.checkout?.AmountTotal),
      hasNegativeDetailPrice: detail.items.some((item) => Number(item.Price || 0) < 0),
      hasNegativeModalRefundQuantity: (modal?.items || []).some((item) => Number(item.RefundQuantity || 0) < 0),
      refundPriceComplete: allHave((item) => item.modalRefundPrice),
      unitPriceComplete: allHave((item) => item.modalUnitPrice),
      refundPriceReconciles: allHave((item) => item.modalRefundPrice) && closeEnough(refundPriceTotal, checkoutRefundAmount),
      unitPriceReconciles: allHave((item) => item.modalUnitPrice) && closeEnough(unitPriceTotal, checkoutRefundAmount),
      refundDiscountFallbackReconciles: joined.length > 0 && joined.every((item) => item.modalRefundPrice != null || item.modalRefundDiscountPrice != null) && closeEnough(refundDiscountFallbackTotal, checkoutRefundAmount),
      discountFallbackReconciles: joined.length > 0 && joined.every((item) => item.modalRefundPrice != null || item.modalDiscountPrice != null) && closeEnough(discountFallbackTotal, checkoutRefundAmount),
    })
  }

  audit.refundModalEvidence = {
    endpointTemplate: "api/RefundModal/{LocationID}/{TransactionNo}",
    safety: { method: "GET", refundActionsCalled: 0, sourceBusinessDataChanged: false },
    summary: {
      successfulResponses: modalDetails.filter((row) => row.ok).length,
      failedResponses: modalDetails.filter((row) => !row.ok).length,
      refundedItemRows: itemEvidence.length,
      uniquelyMatchedItemRows: itemEvidence.filter((row) => row.modalMatches === 1).length,
      rowsWithRefundPrice: itemEvidence.filter((row) => row.modalRefundPrice != null).length,
      rowsWithUnitPrice: itemEvidence.filter((row) => row.modalUnitPrice != null).length,
      rowsWithRefundDiscountPrice: itemEvidence.filter((row) => row.modalRefundDiscountPrice != null).length,
      ordersRefundPriceComplete: orderEvidence.filter((row) => row.refundPriceComplete).length,
      ordersRefundPriceReconciles: orderEvidence.filter((row) => row.refundPriceReconciles).length,
      ordersUnitPriceReconciles: orderEvidence.filter((row) => row.unitPriceReconciles).length,
      ordersRefundDiscountFallbackReconciles: orderEvidence.filter((row) => row.refundDiscountFallbackReconciles).length,
      ordersDiscountFallbackReconciles: orderEvidence.filter((row) => row.discountFallbackReconciles).length,
      ordersWithCompleteOriginalSubtotal: orderEvidence.filter((row) => row.originalSubtotalComplete).length,
      ordersOriginalSubtotalReconciles: orderEvidence.filter((row) => row.originalSubtotalReconciles).length,
      ordersWithNegativeDetailPrice: orderEvidence.filter((row) => row.hasNegativeDetailPrice).length,
      ordersWithNegativeModalRefundQuantity: orderEvidence.filter((row) => row.hasNegativeModalRefundQuantity).length,
      anomalousOrderIds: orderEvidence.filter((row) => row.hasNegativeDetailPrice || row.hasNegativeModalRefundQuantity || !row.unitPriceReconciles).map((row) => row.reportOrderId),
    },
    orderEvidence,
    itemEvidence,
    responses: modalDetails,
  }
  await writeFile(OUTPUT, `${JSON.stringify(audit, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, refundModalEvidence: audit.refundModalEvidence.summary }, null, 2))
}

async function main() {
  if (process.argv.includes("--reconcile-existing")) {
    await reconcileExistingAudit()
    return
  }
  if (process.argv.includes("--audit-refund-modal")) {
    await auditRefundModal()
    return
  }
  const refundRows = JSON.parse(await readFile(INPUT, "utf8"))
  const details = []
  for (const row of refundRows) {
    details.push(await fetchDetail(row))
    await new Promise((resolve) => setTimeout(resolve, 150))
  }

  const successful = details.filter((detail) => detail.ok)
  const items = successful.flatMap((detail) => detail.items.map((item) => ({ ...item, reportOrderId: detail.reportOrderId, checkout: detail.checkout })))
  const refundedItems = items.filter((item) => Number(item.RefundQuantity || 0) > 0)
  const usablePrice = (item) => [item.RefundPrice, item.UnitPrice, item.Price].find((value) => value != null && value > 0) ?? null
  const detailByReportId = new Map(successful.map((detail) => [String(detail.reportOrderId), detail]))
  const headerChecks = refundRows.map((row) => {
    const detail = detailByReportId.get(String(row.ID))
    return {
      reportOrderId: row.ID,
      detailFound: Boolean(detail),
      refundAmountMatches: detail?.checkout ? closeEnough(numberOrNull(row.RefundAmount), detail.checkout.RefundAmount) : false,
      taxRefundMatches: detail?.checkout ? closeEnough(numberOrNull(row.TaxRefund), detail.checkout.TaxRefund) : false,
      grandTotalMatches: detail?.checkout ? closeEnough(numberOrNull(row.GrandTotal), detail.checkout.GrandTotal) : false,
    }
  })

  const orderReconstructions = successful.map((detail) => {
    const pricedRefundItems = detail.items.filter((item) => Number(item.RefundQuantity || 0) > 0 && usablePrice(item) != null)
    const reconstructedBase = pricedRefundItems.reduce((sum, item) => sum + Number(item.RefundQuantity) * usablePrice(item), 0)
    const refundItemCount = detail.items.filter((item) => Number(item.RefundQuantity || 0) > 0).length
    return {
      reportOrderId: detail.reportOrderId,
      refundItemCount,
      pricedRefundItemCount: pricedRefundItems.length,
      checkoutRefundAmount: detail.checkout?.RefundAmount ?? null,
      reconstructedBase: Number(reconstructedBase.toFixed(4)),
      reconstructsCheckoutRefundAmount: refundItemCount > 0 && pricedRefundItems.length === refundItemCount && closeEnough(reconstructedBase, detail.checkout?.RefundAmount),
    }
  })

  const report = {
    generatedAt: new Date().toISOString(),
    source: BASE_URL,
    endpointTemplate: "api/OrderDetailController/{LocationID}/{refundReport.ID}",
    safety: {
      method: "GET",
      refundOrStatusActionsCalled: 0,
      sourceBusinessDataChanged: false,
    },
    summary: {
      refundReportRows: refundRows.length,
      successfulDetails: successful.length,
      failedDetails: details.length - successful.length,
      totalDetailItems: items.length,
      itemsWithRefundQuantity: refundedItems.length,
      ordersWithRefundedItems: new Set(refundedItems.map((item) => String(item.reportOrderId))).size,
      totalRefundQuantity: Number(refundedItems.reduce((sum, item) => sum + Number(item.RefundQuantity || 0), 0).toFixed(3)),
      fullyRefundedItemRows: refundedItems.filter((item) => item.Quantity != null && item.RefundQuantity >= item.Quantity).length,
      partiallyRefundedItemRows: refundedItems.filter((item) => item.Quantity != null && item.RefundQuantity > 0 && item.RefundQuantity < item.Quantity).length,
      refundedItemsWithName: refundedItems.filter((item) => String(item.Name || "").trim()).length,
      refundedItemsWithItemId: refundedItems.filter((item) => item.ItemId != null).length,
      refundedItemsWithItemCode: refundedItems.filter((item) => String(item.ItemCode || "").trim()).length,
      refundedItemsWithCategory: refundedItems.filter((item) => String(item.CategoryName || "").trim()).length,
      refundedItemsWithPositivePrice: refundedItems.filter((item) => usablePrice(item) != null).length,
      refundedItemsWithRefundPrice: refundedItems.filter((item) => item.RefundPrice != null).length,
      refundedItemsWithUnitPrice: refundedItems.filter((item) => item.UnitPrice != null).length,
      ordersFullyPriceReconstructable: orderReconstructions.filter((row) => row.refundItemCount > 0 && row.refundItemCount === row.pricedRefundItemCount).length,
      ordersMatchingCheckoutRefundAmountFromItems: orderReconstructions.filter((row) => row.reconstructsCheckoutRefundAmount).length,
      reportDetailRefundAmountMatches: headerChecks.filter((row) => row.refundAmountMatches).length,
      reportDetailTaxRefundMatches: headerChecks.filter((row) => row.taxRefundMatches).length,
      reportDetailGrandTotalMatches: headerChecks.filter((row) => row.grandTotalMatches).length,
    },
    headerChecks,
    orderReconstructions,
    details,
  }

  await writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({ output: OUTPUT, summary: report.summary, failures: details.filter((detail) => !detail.ok).map((detail) => ({ reportOrderId: detail.reportOrderId, status: detail.status })) }, null, 2))
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})
