#!/usr/bin/env tsx

import { mkdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = {
  "Legacy Order ID": number
  "Reason Not Imported": string
  "Exact Missing Database Value(s) Required": string
}

const SOURCE = resolve("updatedReports/ke-remaining-non-cancelled-orders-21-2026-08-04.xlsx")
const OUTPUT = resolve(
  process.argv[2] || "deliverables/KE_Remaining_Non-Cancelled_Orders_Missing_Values_2026-08-05.xlsx",
)

const finalStatusRequirement =
  "Authoritative final-state evidence. For a completed import, target orders.status must be FULFILLED and orders.fulfillment_status must be DELIVERED; otherwise provide explicit written approval to treat the legacy state as delivered."

const noLiveRecordRequirement =
  "Authoritative proof that this is a real finalized order, plus the complete source values for created_at, created_by_user_id, final status, subtotal_cents, tax_cents, total_cents, and every item (product mapping, quantity, and price_cents). The live source currently returns ID 0 with no header, checkout, or items; do not import without this evidence."

const requirementsById = new Map<number, Pick<Row, "Reason Not Imported" | "Exact Missing Database Value(s) Required">>([
  [41, {
    "Reason Not Imported": "Legacy order is still Out For Delivery (StatusID 9 / DeliveryStatus 506), not a final delivered state.",
    "Exact Missing Database Value(s) Required": finalStatusRequirement,
  }],
  [43, {
    "Reason Not Imported": "Full refund includes PKR 645.00 item refund plus PKR 116.10 tax refund; the current database/import path cannot reconcile a separate tax refund to refund_items.",
    "Exact Missing Database Value(s) Required": "Approved database representation for tax_refund_cents = 11,610. The approved rule must state whether orders.refund_amount_cents and refunds.amount_cents are 64,500 or 76,110 cents and how refund_items will reconcile to that amount; the current schema has no separate tax-refund field.",
  }],
  [44, {
    "Reason Not Imported": "Order remains Out For Delivery and has an unsupported partial refund: PKR 196.00 item refund plus PKR 35.28 tax refund.",
    "Exact Missing Database Value(s) Required": "1) Authoritative final-state evidence (target FULFILLED / DELIVERED if completed). 2) Approved database representation for item refund 19,600 cents and tax refund 3,528 cents, including the exact orders.refund_amount_cents, refunds.amount_cents, and refund_items values that reconcile.",
  }],
  [51, {
    "Reason Not Imported": "Legacy order is still Out For Delivery (StatusID 9 / DeliveryStatus 506), not a final delivered state.",
    "Exact Missing Database Value(s) Required": finalStatusRequirement,
  }],
  [53, {
    "Reason Not Imported": "Legacy order is still Out For Delivery (StatusID 9 / DeliveryStatus 506), not a final delivered state.",
    "Exact Missing Database Value(s) Required": finalStatusRequirement,
  }],
  [60, {
    "Reason Not Imported": "Order is Out For Delivery, and Tapal Danedar Teabags (600 PCS) has two quantity-1 lines with conflicting values: PKR 3,295.00 and PKR 0.00.",
    "Exact Missing Database Value(s) Required": "1) Authoritative final-state evidence (target FULFILLED / DELIVERED if completed). 2) Exact corrected Tapal Danedar Teabags (600 PCS) line set: confirm whether one or both quantity-1 rows are real and assign each retained row an exact price_cents value (current candidates are 329,500 and 0).",
  }],
  [87, {
    "Reason Not Imported": "Legacy order is still Out For Delivery (StatusID 9 / DeliveryStatus 506), not a final delivered state.",
    "Exact Missing Database Value(s) Required": finalStatusRequirement,
  }],
  [173, {
    "Reason Not Imported": "Refund evidence is corrupted: refund quantities exceed purchased quantities and produce negative remaining values, while checkout shows a full PKR 295.60 refund.",
    "Exact Missing Database Value(s) Required": "Authoritative confirmation of corrected refund_items. The only full-refund set that matches the order and checkout is: TEST 2 quantity 1 / amount_cents 22,000; TEST 3 quantity 2 / amount_cents 3,160; TEST 1 quantity 2 / amount_cents 4,400; refunds.amount_cents and orders.refund_amount_cents = 29,560.",
  }],
  [174, {
    "Reason Not Imported": "Refund evidence is corrupted: source refund quantity is 6 for a purchased quantity of 1, while checkout shows a full PKR 22.00 refund.",
    "Exact Missing Database Value(s) Required": "Authoritative confirmation of corrected refund_items: TEST 1 quantity 1 / amount_cents 2,200; refunds.amount_cents and orders.refund_amount_cents = 2,200.",
  }],
  [177, {
    "Reason Not Imported": "Refund evidence is corrupted: refund quantities exceed purchased quantities and produce negative remaining values, while checkout shows a full PKR 257.80 refund.",
    "Exact Missing Database Value(s) Required": "Authoritative confirmation of corrected refund_items. The only full-refund set that matches the order and checkout is: TEST 2 quantity 1 / amount_cents 22,000; TEST 3 quantity 1 / amount_cents 1,580; TEST 1 quantity 1 / amount_cents 2,200; refunds.amount_cents and orders.refund_amount_cents = 25,780.",
  }],
  [192, {
    "Reason Not Imported": "Refund values reconcile, but source product TEST 3 has no safe K-Electric target product mapping.",
    "Exact Missing Database Value(s) Required": "Approved global_product_id and organization_inventory_id for source item TEST 3 (source quantity 1, price_cents 1,580, refunded quantity 1, refund amount_cents 1,580). No matching K-Electric catalog product or legacy mapping exists in the current database.",
  }],
  [415, {
    "Reason Not Imported": "Two item lines exist, but the checkout/header totals are missing and StatusID 1 is not final; DeliveryStatus 507 alone is insufficient.",
    "Exact Missing Database Value(s) Required": "Authoritative final status plus subtotal_cents, tax_cents, and total_cents. Item lines imply a candidate subtotal_cents of 822,000 (PKR 8,220.00), but the exact checkout tax and total are absent and must be confirmed before setting target FULFILLED / DELIVERED.",
  }],
  [1100, {
    "Reason Not Imported": "Refund values reconcile, but source product Millac Tea Whitener 850gm has no approved legacy-to-target mapping.",
    "Exact Missing Database Value(s) Required": "Confirm the mapping of source Millac Tea Whitener 850gm to existing K-Electric global_product_id 238 and organization_inventory_id 248 (Milac Instant Tea whitener (850gm)); otherwise provide the exact alternate IDs. Source line values are quantity 2 and price_cents 159,000 each.",
  }],
  [1155, {
    "Reason Not Imported": "Legacy order is still In Process (StatusID 2 / DeliveryStatus 503), not a final delivered state.",
    "Exact Missing Database Value(s) Required": finalStatusRequirement,
  }],
  ...[1168, 1169, 1170, 1171, 1172, 1173, 1184].map((id) => [id, {
    "Reason Not Imported": "No real live order record exists; the source returns the default empty ID 0 record, indicating an abandoned or deleted draft.",
    "Exact Missing Database Value(s) Required": noLiveRecordRequirement,
  }] as const),
])

function main() {
  const source = XLSX.readFile(SOURCE, { cellDates: false })
  const sourceSheet = source.Sheets["Remaining Orders"]
  if (!sourceSheet) throw new Error("Source workbook is missing Remaining Orders")

  const sourceRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sourceSheet, {
    defval: null,
    raw: true,
  })
  const sourceIds = sourceRows.map((row) => Number(row["Legacy Order ID"])).sort((a, b) => a - b)
  const requirementIds = [...requirementsById.keys()].sort((a, b) => a - b)
  if (sourceIds.length !== 21 || JSON.stringify(sourceIds) !== JSON.stringify(requirementIds)) {
    throw new Error(`Remaining-order scope mismatch: ${sourceIds.join(", ")}`)
  }

  const rows: Row[] = sourceIds.map((id) => {
    const requirement = requirementsById.get(id)
    if (!requirement) throw new Error(`Missing requirement for legacy order ${id}`)
    return { "Legacy Order ID": id, ...requirement }
  })

  const headers = Object.keys(rows[0])
  const sheet = XLSX.utils.json_to_sheet(rows, { header: headers })
  sheet["!cols"] = [{ wch: 18 }, { wch: 58 }, { wch: 105 }]
  sheet["!rows"] = [{ hpt: 30 }, ...rows.map(() => ({ hpt: 78 }))]
  sheet["!autofilter"] = { ref: `A1:C${rows.length + 1}` }
  sheet["!freeze"] = {
    xSplit: 0,
    ySplit: 1,
    topLeftCell: "A2",
    activePane: "bottomLeft",
    state: "frozen",
  } as never

  for (let row = 0; row <= rows.length; row += 1) {
    for (let column = 0; column < headers.length; column += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (!cell) continue
      cell.s = {
        alignment: {
          vertical: "top",
          horizontal: row === 0 ? "center" : column === 0 ? "center" : "left",
          wrapText: true,
        },
        font: row === 0 ? { bold: true, color: { rgb: "FFFFFF" } } : undefined,
        fill: row === 0 ? { patternType: "solid", fgColor: { rgb: "1F4E78" } } : undefined,
      }
    }
  }

  const workbook = XLSX.utils.book_new()
  workbook.Props = {
    Title: "K-Electric Remaining Non-Cancelled Orders - Missing Values",
    Subject: "Minimal import-blocker list verified against the live K-Electric database",
    Author: "OneFlow",
    CreatedDate: new Date(),
  }
  XLSX.utils.book_append_sheet(workbook, sheet, "Remaining Orders")
  mkdirSync(dirname(OUTPUT), { recursive: true })
  XLSX.writeFile(workbook, OUTPUT, { bookType: "xlsx", compression: true, cellStyles: true })

  const validation = XLSX.readFile(OUTPUT, { cellDates: false })
  if (validation.SheetNames.length !== 1 || validation.SheetNames[0] !== "Remaining Orders") {
    throw new Error("Workbook must contain exactly one Remaining Orders sheet")
  }
  const validatedRows = XLSX.utils.sheet_to_json<Row>(validation.Sheets["Remaining Orders"], {
    defval: null,
    raw: true,
  })
  if (validatedRows.length !== 21) throw new Error(`Expected 21 rows, found ${validatedRows.length}`)
  if (JSON.stringify(Object.keys(validatedRows[0])) !== JSON.stringify(headers)) {
    throw new Error("Workbook must contain exactly the three approved columns")
  }

  console.log(JSON.stringify({
    status: "PASS",
    output: OUTPUT,
    sheets: validation.SheetNames,
    rows: validatedRows.length,
    columns: Object.keys(validatedRows[0]).length,
    legacyOrderIds: validatedRows.map((row) => row["Legacy Order ID"]),
  }, null, 2))
}

main()
