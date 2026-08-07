#!/usr/bin/env tsx

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"
import * as XLSX from "xlsx"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

type Row = Record<string, any>

const ORGANIZATION = { id: 10, code: "0001", name: "K-Electric" }
const SOURCE_SYSTEM = "KE_LOGISTICS"
const INPUT = resolve(process.argv[2] || "Receivable Details.xlsx")
const OUTPUT = resolve(process.argv[3] || "updatedReports/ke-receivables-match-source.json")

function text(value: unknown): string {
  return String(value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim()
}

function parseMoney(value: unknown): number {
  const raw = String(value ?? "").trim()
  if (!raw) return 0
  const negative = /^\(.*\)$/.test(raw)
  const parsed = Number(raw.replace(/[^0-9.]/g, ""))
  if (!Number.isFinite(parsed)) throw new Error(`Invalid money value: ${raw}`)
  return Math.round(parsed * 100) * (negative ? -1 : 1)
}

function parseQuantity(value: unknown): number {
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim())
  if (!Number.isFinite(parsed)) throw new Error(`Invalid quantity value: ${value}`)
  return parsed
}

function dateKey(value: unknown): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString().slice(0, 10)
  const parsed = new Date(String(value ?? "").trim())
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid date value: ${value}`)
  return parsed.toISOString().slice(0, 10)
}

function sourceHeader(payload: unknown): Row {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {}
  const row = payload as Row
  const nested = row.sourceHeader ?? row.source_header ?? row.header
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested : row
}

function parseWorkbook() {
  const workbook = XLSX.readFile(INPUT, { cellDates: true })
  if (workbook.SheetNames.length !== 1) throw new Error(`Expected one worksheet, found ${workbook.SheetNames.length}`)
  const worksheet = workbook.Sheets[workbook.SheetNames[0]]
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(worksheet, { header: 1, defval: null, raw: true })
  const headers = (matrix[1] ?? []).map((value) => text(value))
  const required = [
    "Customer Name",
    "Date",
    "Transaction#",
    "Item Name",
    "Quantity Ordered",
    "Item Price (BCY)",
    "Total (BCY)",
    "Tax Amount (FCY)",
    "Total with Tax",
    "Shipping Street 1",
    "Warehouse Name",
  ]
  const missing = required.filter((header) => !headers.includes(header))
  if (missing.length) throw new Error(`Missing workbook headers: ${missing.join(", ")}`)
  const column = new Map(headers.map((header, index) => [header, index]))
  const value = (row: unknown[], header: string) => row[column.get(header)!]
  const data = matrix.slice(2).filter((row) => row.some((cell) => cell != null && text(cell)))
  const totalRows = data.filter((row) => text(value(row, "Customer Name")).toUpperCase() === "TOTAL")
  const detailRows = data.filter((row) => text(value(row, "Customer Name")).toUpperCase() !== "TOTAL")
  if (totalRows.length !== 1) throw new Error(`Expected exactly one TOTAL row, found ${totalRows.length}`)
  if (detailRows.some((row) => text(value(row, "Customer Name")).toUpperCase() !== "K-ELECTRIC LIMITED")) {
    throw new Error("Workbook contains a customer other than K-ELECTRIC LIMITED")
  }

  const groups = new Map<string, Row[]>()
  detailRows.forEach((row, index) => {
    const invoiceNumber = text(value(row, "Transaction#"))
    if (!invoiceNumber) throw new Error(`Workbook row ${index + 3} has no Transaction#`)
    const item: Row = {
      workbookRow: index + 3,
      invoiceNumber,
      customerName: text(value(row, "Customer Name")),
      date: dateKey(value(row, "Date")),
      itemName: text(value(row, "Item Name")),
      quantity: parseQuantity(value(row, "Quantity Ordered")),
      unitPriceCents: parseMoney(value(row, "Item Price (BCY)")),
      subtotalCents: parseMoney(value(row, "Total (BCY)")),
      taxCents: parseMoney(value(row, "Tax Amount (FCY)")),
      totalCents: parseMoney(value(row, "Total with Tax")),
      shippingAddress: text(value(row, "Shipping Street 1")),
      warehouseName: text(value(row, "Warehouse Name")),
    }
    const group = groups.get(invoiceNumber) ?? []
    group.push(item)
    groups.set(invoiceNumber, group)
  })

  const invoices = [...groups].map(([invoiceNumber, items]) => {
    const dates = [...new Set(items.map((item) => item.date))]
    const addresses = [...new Set(items.map((item) => item.shippingAddress))]
    if (dates.length !== 1) throw new Error(`Invoice ${invoiceNumber} has multiple dates: ${dates.join(", ")}`)
    if (addresses.length !== 1) throw new Error(`Invoice ${invoiceNumber} has multiple shipping addresses`)
    return {
      invoiceNumber,
      date: dates[0],
      shippingAddress: addresses[0],
      warehouseNames: [...new Set(items.map((item) => item.warehouseName).filter(Boolean))],
      lineCount: items.length,
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      subtotalCents: items.reduce((sum, item) => sum + item.subtotalCents, 0),
      taxCents: items.reduce((sum, item) => sum + item.taxCents, 0),
      totalCents: items.reduce((sum, item) => sum + item.totalCents, 0),
      items,
    }
  }).sort((left, right) => left.date.localeCompare(right.date) || left.invoiceNumber.localeCompare(right.invoiceNumber))

  const totalRow = totalRows[0]
  const footer = {
    quantity: parseQuantity(value(totalRow, "Quantity Ordered")),
    subtotalCents: parseMoney(value(totalRow, "Total (BCY)")),
    totalCents: parseMoney(value(totalRow, "Total with Tax")),
  }
  const calculated = {
    quantity: invoices.reduce((sum, invoice) => sum + invoice.quantity, 0),
    subtotalCents: invoices.reduce((sum, invoice) => sum + invoice.subtotalCents, 0),
    taxCents: invoices.reduce((sum, invoice) => sum + invoice.taxCents, 0),
    totalCents: invoices.reduce((sum, invoice) => sum + invoice.totalCents, 0),
  }
  if (Math.abs(footer.quantity - calculated.quantity) > 0.0001) throw new Error("Workbook quantity does not reconcile to footer")
  if (footer.subtotalCents !== calculated.subtotalCents) throw new Error("Workbook subtotal does not reconcile to footer")
  if (footer.totalCents !== calculated.totalCents) throw new Error("Workbook total does not reconcile to footer")
  return { worksheetName: workbook.SheetNames[0], footer, calculated, invoices }
}

async function main() {
  const workbook = parseWorkbook()
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()
  let organization: Row
  let orderRows: Row[]
  let itemRows: Row[]
  try {
    await client.query("begin transaction isolation level repeatable read read only")
    await client.query("set local statement_timeout = '120s'")
    organization = (await client.query(
      "select id, code, name, status from organizations where id = $1",
      [ORGANIZATION.id],
    )).rows[0] ?? null
    if (!organization
      || Number(organization.id) !== ORGANIZATION.id
      || organization.code !== ORGANIZATION.code
      || organization.name !== ORGANIZATION.name
      || text(organization.status).toUpperCase() !== "ACTIVE") {
      throw new Error(`K-Electric organization identity gate failed: ${JSON.stringify(organization)}`)
    }
    orderRows = (await client.query(`
      select
        o.id as database_order_id,
        o.tid,
        o.status,
        o.fulfillment_status,
        o.subtotal_cents,
        o.tax_cents,
        o.total_cents,
        o.refund_amount_cents,
        to_char(o.created_at at time zone 'Asia/Karachi', 'YYYY-MM-DD') as database_created_date,
        b.id as branch_id,
        b.name as branch_name,
        u.id as creator_user_id,
        u.full_name as creator_full_name,
        loi.legacy_order_id,
        loi.source_payload
      from orders o
      join branches b on b.id = o.branch_id and b.organization_id = o.organization_id
      join users u on u.id = o.created_by_user_id and u.organization_id = o.organization_id
      left join legacy_order_imports loi
        on loi.order_id = o.id
       and loi.organization_id = o.organization_id
       and loi.source_system = $2
      where o.organization_id = $1
      order by o.id
    `, [ORGANIZATION.id, SOURCE_SYSTEM])).rows
    itemRows = (await client.query(`
      select
        oi.id as database_order_item_id,
        oi.order_id as database_order_id,
        oi.global_product_id,
        oi.product_name,
        oi.product_code,
        oi.unit,
        oi.quantity,
        oi.price_cents
      from order_items oi
      join orders o on o.id = oi.order_id and o.organization_id = oi.organization_id
      where o.organization_id = $1
      order by oi.order_id, oi.id
    `, [ORGANIZATION.id])).rows
    await client.query("rollback")
  } catch (error) {
    await client.query("rollback").catch(() => undefined)
    throw error
  } finally {
    client.release()
    await pool.end()
  }

  const itemsByOrder = new Map<number, Row[]>()
  for (const row of itemRows) {
    const orderId = Number(row.database_order_id)
    const item = {
      databaseOrderItemId: Number(row.database_order_item_id),
      globalProductId: Number(row.global_product_id),
      productName: text(row.product_name),
      productCode: text(row.product_code),
      unit: text(row.unit),
      quantity: Number(row.quantity),
      unitPriceCents: Number(row.price_cents),
      subtotalCents: Math.round(Number(row.quantity) * Number(row.price_cents)),
    }
    const group = itemsByOrder.get(orderId) ?? []
    group.push(item)
    itemsByOrder.set(orderId, group)
  }
  const orders = orderRows.map((row) => {
    const header = sourceHeader(row.source_payload)
    const items = itemsByOrder.get(Number(row.database_order_id)) ?? []
    return {
      databaseOrderId: Number(row.database_order_id),
      tid: text(row.tid),
      legacyOrderId: row.legacy_order_id == null ? null : Number(row.legacy_order_id),
      status: text(row.status),
      fulfillmentStatus: text(row.fulfillment_status),
      date: text(row.database_created_date),
      branchId: Number(row.branch_id),
      branchName: text(row.branch_name),
      creatorUserId: text(row.creator_user_id),
      creatorFullName: text(row.creator_full_name),
      subtotalCents: Number(row.subtotal_cents),
      taxCents: Number(row.tax_cents),
      totalCents: Number(row.total_cents),
      refundAmountCents: row.refund_amount_cents == null ? 0 : Number(row.refund_amount_cents),
      source: {
        location: text(header.LocationName ?? header.Location),
        transactionNo: header.TransactionNo == null || header.TransactionNo === "" ? null : Number(header.TransactionNo),
        orderNo: header.OrderNo == null || header.OrderNo === "" ? null : Number(header.OrderNo),
        date: text(header.OrderCreatedDT ?? header.CreatedOn).slice(0, 10),
        userDetails: text(header.UserDetails ?? header.OrderTakerName),
        locationGroup: text(header.LocationGroup),
        grandTotalCents: header.GrandTotal == null || header.GrandTotal === "" ? null : Math.round(Number(header.GrandTotal) * 100),
        orderType: text(header.OrderType),
      },
      lineCount: items.length,
      quantity: items.reduce((sum, item) => sum + item.quantity, 0),
      itemSubtotalCents: items.reduce((sum, item) => sum + item.subtotalCents, 0),
      items,
    }
  })
  if (orders.some((order) => order.itemSubtotalCents !== order.subtotalCents)) {
    const bad = orders.filter((order) => order.itemSubtotalCents !== order.subtotalCents).map((order) => order.tid)
    throw new Error(`Database item subtotals do not reconcile: ${bad.join(", ")}`)
  }

  const report = {
    generatedAt: new Date().toISOString(),
    mode: "production read-only",
    databaseChanges: 0,
    input: INPUT,
    organization: { id: Number(organization.id), code: organization.code, name: organization.name },
    workbook,
    database: {
      orderCount: orders.length,
      itemCount: itemRows.length,
      subtotalCents: orders.reduce((sum, order) => sum + order.subtotalCents, 0),
      taxCents: orders.reduce((sum, order) => sum + order.taxCents, 0),
      totalCents: orders.reduce((sum, order) => sum + order.totalCents, 0),
      orders,
    },
  }
  mkdirSync(dirname(OUTPUT), { recursive: true })
  writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  console.log(JSON.stringify({
    output: OUTPUT,
    warehouseInvoices: workbook.invoices.length,
    warehouseItems: workbook.invoices.reduce((sum, invoice) => sum + invoice.lineCount, 0),
    warehouseQuantity: workbook.calculated.quantity,
    warehouseTotalCents: workbook.calculated.totalCents,
    databaseOrders: orders.length,
    databaseItems: itemRows.length,
    databaseQuantity: orders.reduce((sum, order) => sum + order.quantity, 0),
    databaseTotalCents: report.database.totalCents,
    databaseChanges: 0,
  }, null, 2))
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
