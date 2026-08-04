import { resolve } from "node:path"
import * as XLSX from "xlsx"

type Row = Record<string, any>

const REQUIRED = "Required"

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function rowsFromSheet(workbook: XLSX.WorkBook, sheetName: string): Row[] {
  const sheet = workbook.Sheets[sheetName]
  assert(sheet, `Missing source sheet: ${sheetName}`)
  return XLSX.utils.sheet_to_json<Row>(sheet, { defval: null, raw: true })
}

function autoWidth(rows: Row[], headers: string[]): XLSX.ColInfo[] {
  return headers.map((header) => {
    const width = rows.reduce((maximum, row) => {
      const value = row[header]
      const text = value instanceof Date ? value.toISOString() : String(value ?? "")
      return Math.max(maximum, text.length)
    }, header.length)
    const maximumWidth = header === "Comment" ? 70 : header === "Missing Required Values" ? 60 : 34
    return { wch: Math.min(Math.max(width + 2, 12), maximumWidth) }
  })
}

function main() {
  const repoRoot = process.cwd()
  const sourcePath = resolve(
    repoRoot,
    process.argv[2] || "deliverables/KE_Non-Cancelled_Unimported_Orders_Import_Requirements_2026-08-03.xlsx",
  )
  const outputPath = resolve(
    repoRoot,
    process.argv[3] || "deliverables/KE_Simplified_Import_Tracker_2026-08-03.xlsx",
  )

  const source = XLSX.readFile(sourcePath, { cellDates: true })
  const orders = rowsFromSheet(source, "Import Review")
  const products = rowsFromSheet(source, "Order Products")
  const orderById = new Map(orders.map((row) => [Number(row["Legacy Order ID"]), row]))

  assert(orders.length === 77, `Expected 77 orders, found ${orders.length}`)
  assert(products.length === 679, `Expected 679 product/placeholder rows, found ${products.length}`)

  const simplifiedRows = products.map((product) => {
    const id = Number(product["Legacy Order ID"])
    const order = orderById.get(id)
    assert(order, `No order row found for product order ${id}`)

    const orderMissing = String(order["Missing Required Values"] || "").trim()
    const productMissing = String(product["Missing Required Product Values"] || "").trim()
    const missing = [orderMissing, productMissing]
      .filter((value) => value && value !== "None")
      .filter((value, index, values) => values.indexOf(value) === index)
      .join("; ") || "None"

    const productComment = String(product.Comment || "").trim()
    const orderComment = String(order.Comment || "").trim()

    return {
      "Legacy Order ID": id,
      "Order Number": order["Order Number"] ?? REQUIRED,
      "Transaction Number": order["Transaction Number"] ?? REQUIRED,
      "Created At": order["Created At"] ?? REQUIRED,
      "Branch / Location": order["Branch / Location"] ?? REQUIRED,
      "DB Branch ID": order["DB Branch ID"] ?? REQUIRED,
      "User Details": order["User Details"] ?? REQUIRED,
      "DB Created By User ID": order["DB Created By User ID"] ?? REQUIRED,
      "Product Evidence": product["Product Evidence Type"] ?? REQUIRED,
      "Product Name": product["Product Name"] ?? REQUIRED,
      "Quantity": product.Quantity ?? REQUIRED,
      "Unit Price PKR": product["Resolved Unit Price Cents"] === REQUIRED
        ? REQUIRED
        : Number(product["Resolved Unit Price Cents"]) / 100,
      "DB Global Product ID": product["DB Global Product ID"] ?? REQUIRED,
      "DB Organization Inventory ID": product["DB Organization Inventory ID"] ?? REQUIRED,
      "Order Subtotal PKR": order["Order Subtotal PKR"] ?? REQUIRED,
      "Tax PKR": order["Tax PKR"] ?? REQUIRED,
      "Grand Total PKR": order["Grand Total PKR"] ?? REQUIRED,
      "Refund Type": order["Refund Classification"] ?? "NONE",
      "Total Refund PKR": order["Total Refund PKR"] ?? "N/A",
      "Status to Import": order["Status to Import"] ?? REQUIRED,
      "Fulfillment Status to Import": order["Fulfillment Status to Import"] ?? REQUIRED,
      "Status Before Refund": order["Status Immediately Before Refund"] ?? "N/A",
      "Refunded At": order["Refunded At to Import"] ?? "N/A",
      "Import Readiness": order["Import Readiness"] ?? REQUIRED,
      "Missing Required Values": missing,
      "Comment": [orderComment, productComment].filter(Boolean).join(" "),
    }
  })

  const headers = Object.keys(simplifiedRows[0])
  assert(headers.at(-1) === "Comment", "Comment must be the final column")
  const sheet = XLSX.utils.json_to_sheet(simplifiedRows, { header: headers })
  sheet["!cols"] = autoWidth(simplifiedRows, headers)
  sheet["!autofilter"] = {
    ref: XLSX.utils.encode_range({
      s: { r: 0, c: 0 },
      e: { r: simplifiedRows.length, c: headers.length - 1 },
    }),
  }
  sheet["!freeze"] = { xSplit: 0, ySplit: 1, topLeftCell: "A2", activePane: "bottomLeft" }

  const headerIndex = new Map(headers.map((header, index) => [header, index]))
  for (const header of ["Created At"]) {
    const column = headerIndex.get(header)
    if (column === undefined) continue
    for (let row = 1; row <= simplifiedRows.length; row += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (cell instanceof Object && cell.t === "d") cell.z = "yyyy-mm-dd hh:mm"
    }
  }
  for (const header of ["Unit Price PKR", "Order Subtotal PKR", "Tax PKR", "Grand Total PKR", "Total Refund PKR"]) {
    const column = headerIndex.get(header)
    if (column === undefined) continue
    for (let row = 1; row <= simplifiedRows.length; row += 1) {
      const cell = sheet[XLSX.utils.encode_cell({ r: row, c: column })]
      if (cell && typeof cell.v === "number") cell.z = "#,##0.00"
    }
  }

  const workbook = XLSX.utils.book_new()
  workbook.Props = {
    Title: "K-Electric Simplified Import Tracker",
    Subject: "One-sheet tracker for 77 non-cancelled, live-unimported K-Electric legacy orders",
    Author: "OneFlow",
    CreatedDate: new Date(),
  }
  XLSX.utils.book_append_sheet(workbook, sheet, "Import Tracker")
  XLSX.writeFile(workbook, outputPath, { bookType: "xlsx", compression: true })

  const validation = XLSX.readFile(outputPath, { cellDates: true })
  assert(validation.SheetNames.length === 1, `Expected one sheet, found ${validation.SheetNames.length}`)
  assert(validation.SheetNames[0] === "Import Tracker", "Unexpected output sheet name")
  const validatedRows = rowsFromSheet(validation, "Import Tracker")
  assert(validatedRows.length === products.length, "Output row count mismatch")
  assert(new Set(validatedRows.map((row) => Number(row["Legacy Order ID"]))).size === orders.length, "Output order coverage mismatch")
  assert(Object.keys(validatedRows[0]).at(-1) === "Comment", "Validated Comment column is not last")

  console.log(JSON.stringify({
    status: "PASS",
    outputPath,
    sheet: validation.SheetNames[0],
    columns: Object.keys(validatedRows[0]).length,
    rows: validatedRows.length,
    uniqueOrders: new Set(validatedRows.map((row) => Number(row["Legacy Order ID"]))).size,
    requiredRows: validatedRows.filter((row) => String(row["Missing Required Values"]) !== "None").length,
  }, null, 2))
}

try {
  main()
} catch (error) {
  console.error(error)
  process.exitCode = 1
}
