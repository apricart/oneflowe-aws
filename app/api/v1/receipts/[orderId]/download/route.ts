import { NextRequest, NextResponse } from "next/server"
import { safeFilenamePart } from "@/lib/security"
import { db } from "@/lib/db"
import { branches, orderItems, organizations, refundItems, refunds, users } from "@/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { aggregateReceiptRefundItems, getReceiptItemQuantity, getReceiptNetTotal, toDisplayNameCase } from "@/lib/receipt-display"
import {
    buildInvoiceLines,
    buildInvoiceTotals,
    formatInvoiceMoney,
    formatInvoiceQuantity,
    formatInvoiceTaxPercent,
    type InvoiceLine,
    type InvoiceTotals,
} from "@/lib/invoice-lines"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { formatBranchAddress } from "@/lib/branch-address"
import { authorizeInvoiceRequest } from "@/lib/server/invoice-access"
import { getReceiptUserDisplayName } from "@/lib/receipt-user"
import { INVOICE_ISSUER } from "@/lib/invoice-issuer"
import { formatInvoiceDisplayDate, getInvoicePoNumber } from "@/lib/invoice-format"
import { jsPDF } from "jspdf"
import path from "node:path"
import fs from "node:fs"

export async function GET(
    req: NextRequest,
    props: { params: Promise<{ orderId: string }> }
) {
    try {
        const params = await props.params
        const orderId = Number.parseInt(params.orderId)
        if (Number.isNaN(orderId)) {
            return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
        }

        // Single authority for authentication, tenant isolation, role access,
        // per-user ownership, and invoice availability.
        const access = await authorizeInvoiceRequest(orderId)
        if (!access.ok) {
            return NextResponse.json({ error: access.denial.error }, { status: access.denial.status })
        }
        const { order, role: userRole } = access

        const pricesHidden = await shouldHidePricesForRole(userRole, order.organizationId)
        if (pricesHidden) {
            return NextResponse.json({ error: "Invoice download is unavailable while prices are hidden" }, { status: 403 })
        }

        const userIdentityColumns = {
            fullName: users.fullName,
            firstName: users.firstName,
            lastName: users.lastName,
            username: users.username,
            email: users.email,
            phone: users.phone,
        }
        const [creatorRows, approverRows] = await Promise.all([
            db
                .select(userIdentityColumns)
                .from(users)
                .where(eq(users.id, order.createdByUserId))
                .limit(1),
            order.approvedByUserId
                ? db
                    .select(userIdentityColumns)
                    .from(users)
                    .where(eq(users.id, order.approvedByUserId))
                    .limit(1)
                : Promise.resolve([]),
        ])
        const creator = creatorRows[0]
        const approver = approverRows[0]
        const creatorName = getReceiptUserDisplayName(creator, "Unknown")
        const approverName = getReceiptUserDisplayName(
            approver,
            order.approvedByUserId ? "Unknown" : "N/A"
        )

        let branchAddress = ""
        if (order.branchId !== null && order.organizationId !== null) {
            const [branchDetails] = await db
                .select({
                    address: branches.address,
                    city: branches.city,
                    province: branches.province,
                })
                .from(branches)
                .where(and(
                    eq(branches.id, order.branchId),
                    eq(branches.organizationId, order.organizationId),
                ))
                .limit(1)
            branchAddress = formatBranchAddress(branchDetails)
        }

        let organizationName = ""
        let organizationNtn = ""
        if (order.organizationId !== null) {
            const [organizationDetails] = await db
                .select({
                    name: organizations.name,
                    ntnNumber: organizations.ntnNumber,
                })
                .from(organizations)
                .where(eq(organizations.id, order.organizationId))
                .limit(1)
            organizationName = organizationDetails?.name || ""
            organizationNtn = organizationDetails?.ntnNumber || ""
        }

        const refundRows = await db
            .select({
                productName: orderItems.productName,
                quantity: refundItems.quantity,
                amount: refundItems.amountCents,
            })
            .from(refundItems)
            .innerJoin(refunds, eq(refundItems.refundId, refunds.id))
            .innerJoin(orderItems, eq(refundItems.orderItemId, orderItems.id))
            .where(and(
                eq(refunds.orderId, orderId),
                sql`UPPER(${refunds.status}) IN ('APPROVED', 'COMPLETED')`,
            ))

        const totalApprovedRefundAmount = (order.refundAmountCents || 0) / 100
        const refundedItems = aggregateReceiptRefundItems(refundRows.map((item) => ({
            productName: item.productName || "Unknown",
            quantity: item.quantity || 0,
            amount: (item.amount || 0) / 100,
        })))
        const derivedStatus = getOrderDerivedStatus({
            status: order.status,
            refundAmountCents: order.refundAmountCents,
        }, "fulfilled")

        const receiptData = {
            ...(order.receiptData as any),
            buyerAddress: branchAddress,
            organizationName: (order.receiptData as any)?.organizationName || organizationName || "",
            organizationNtn: organizationNtn || (order.receiptData as any)?.organizationNtn || "",
            // The order row is the record of the buyer's purchase order; the
            // snapshot is the fallback for orders whose row predates the column.
            poNumber: order.poNumber || (order.receiptData as any)?.poNumber || "",
            placedByName: creatorName,
            placedByPhone: creator?.phone || null,
            approvedByName: approverName,
            status: derivedStatus.label,
            statusKey: derivedStatus.key,
            refund: totalApprovedRefundAmount,
            refundedItems,
            totalAmount: getReceiptNetTotal(order.receiptData as any, totalApprovedRefundAmount),
        }

        const pdfBuffer = renderReceiptPagePdf(receiptData)
        const invoiceFilePart = safeFilenamePart(receiptData.invoiceNumber, String(orderId))

        return new NextResponse(pdfBuffer, {
            headers: {
                "Content-Type": "application/pdf",
                "Content-Disposition": `attachment; filename="invoice-${invoiceFilePart}.pdf"`,
            },
        })
    } catch (e: any) {
        console.error("Invoice generation error:", e)
        return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
    }
}

type PdfColor = [number, number, number]

const colors = {
    primary: [15, 23, 42] as PdfColor,
    secondary: [100, 116, 139] as PdfColor,
    muted: [148, 163, 184] as PdfColor,
    border: [226, 232, 240] as PdfColor,
    softBorder: [241, 245, 249] as PdfColor,
    card: [251, 252, 253] as PdfColor,
    row: [248, 250, 252] as PdfColor,
    subRow: [250, 251, 252] as PdfColor,
    white: [255, 255, 255] as PdfColor,
    red: [239, 68, 68] as PdfColor,
}

function renderReceiptPagePdf(receiptData: any) {
    const doc = new jsPDF({ unit: "mm", format: "a4" })
    const margin = 18
    const pageWidth = 210
    const pageHeight = 297
    const right = pageWidth - margin
    const contentWidth = right - margin
    const itemQuantity = getReceiptItemQuantity(receiptData.items)
    const refundedItems = Array.isArray(receiptData.refundedItems) ? receiptData.refundedItems : []
    const refundAmount = Number(receiptData.refund || 0)
    // Both invoice formats build their rows from the same module, so the PDF
    // and the on-screen invoice cannot drift apart.
    const invoiceLines = buildInvoiceLines(receiptData)
    const invoiceTotals = buildInvoiceTotals(receiptData, invoiceLines, refundAmount)
    const summaryHeight = getSummaryHeight(invoiceTotals, refundedItems)
    const footerReserve = 24

    drawPageShell(doc)

    let y = drawMasthead(doc, margin, right)
    y = drawPartyGrid(doc, receiptData, itemQuantity, margin, y, contentWidth)
    y += 6

    y = drawItemsTable(doc, invoiceLines, margin, y, contentWidth, pageHeight)
    y += 7

    if (y + summaryHeight + footerReserve > pageHeight - 16) {
        doc.addPage()
        drawPageShell(doc)
        y = 24
    }

    y = drawSummary(doc, invoiceTotals, refundedItems, right, y, pageHeight)
    drawFooter(doc, Math.max(y + 14, 258), margin, right, pageHeight)

    return doc.output("arraybuffer")
}

function drawPageShell(doc: any) {
    const margin = 18
    const right = 192
    const pageHeight = 297
    const cardPadding = 8
    setFill(doc, colors.white)
    setDraw(doc, colors.border)
    doc.setLineWidth(0.25)
    doc.roundedRect(
        margin - cardPadding,
        10,
        right - margin + cardPadding * 2,
        pageHeight - 20,
        1.5,
        1.5,
        "FD",
    )
}

/** Issuer identity on the left, document title on the right. Returns the y to continue from. */
function drawMasthead(doc: any, margin: number, right: number) {
    const textX = margin + 44
    let y = 22

    try {
        const logoPath = path.join(process.cwd(), "public", "apricart-logo-blue.png")
        if (fs.existsSync(logoPath)) {
            const logoData = fs.readFileSync(logoPath).toString("base64")
            doc.addImage(`data:image/png;base64,${logoData}`, "PNG", margin, 17, 38, 11, undefined, "FAST")
        } else {
            setText(doc, colors.primary)
            doc.setFont("helvetica", "bold")
            doc.setFontSize(15)
            doc.text("APRICART", margin, 25)
        }
    } catch {
        setText(doc, colors.primary)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(15)
        doc.text("APRICART", margin, 25)
    }

    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    setText(doc, colors.primary)
    doc.text(INVOICE_ISSUER.name, textX, y)

    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    setText(doc, colors.secondary)
    y += 5
    for (const line of INVOICE_ISSUER.addressLines) {
        doc.text(line, textX, y)
        y += 4
    }
    doc.text(`NTN: ${INVOICE_ISSUER.ntn}`, textX, y)
    y += 4
    doc.text(`STRN: ${INVOICE_ISSUER.strn}`, textX, y)

    doc.setFont("helvetica", "normal")
    doc.setFontSize(20)
    setText(doc, colors.secondary)
    doc.text("INVOICE", right, 26, { align: "right" })

    return Math.max(y + 8, 46)
}

type PartyLine = {
    label?: string
    value: string
    strong?: boolean
}

/**
 * Invoice references and the Bill To / Delivery To parties, drawn as one
 * bordered grid so the PDF matches the on-screen invoice header.
 */
function drawPartyGrid(doc: any, receiptData: any, itemQuantity: number, x: number, y: number, width: number) {
    const half = width / 2
    const pad = 4
    const headHeight = 7

    const metaLeft: Array<[string, string]> = [
        ["Invoice#", receiptData.invoiceNumber || "N/A"],
        ["Invoice Date", formatInvoiceDisplayDate(receiptData.date) || "N/A"],
        ["P.O.#", getInvoicePoNumber(receiptData)],
    ]
    const metaRight: Array<[string, string]> = [
        ["Status", String(receiptData.status || "PENDING")],
        ["Total Items", String(itemQuantity)],
        ["Subtotal", `PKR ${formatMoney(receiptData.subtotal)}`],
    ]
    const metaHeight = pad * 2 + Math.max(metaLeft.length, metaRight.length) * 4.6

    const billTo: PartyLine[] = [
        { value: receiptData.organizationName || receiptData.buyerName || "N/A", strong: true },
    ]
    if (receiptData.organizationNtn) {
        billTo.push({ label: "NTN:", value: String(receiptData.organizationNtn) })
    }

    const deliverTo: PartyLine[] = [
        { value: receiptData.buyerName || "N/A", strong: true },
    ]
    if (receiptData.organizationName) {
        deliverTo.push({ value: receiptData.organizationName })
    }
    deliverTo.push({ label: "Address:", value: toDisplayNameCase(receiptData.buyerAddress || "-") })
    deliverTo.push({ label: "Phone:", value: String(receiptData.placedByPhone || receiptData.buyerPhone || "N/A") })
    deliverTo.push({ label: "Initiator:", value: toDisplayNameCase(receiptData.placedByName || "N/A") })
    deliverTo.push({ label: "Approver:", value: toDisplayNameCase(receiptData.approvedByName || "N/A") })

    const cellWidth = half - pad * 2
    const bodyHeight = pad * 2 + Math.max(
        drawPartyLines(doc, billTo, 0, 0, cellWidth, true),
        drawPartyLines(doc, deliverTo, 0, 0, cellWidth, true),
    )
    const gridHeight = metaHeight + headHeight + bodyHeight

    // Header band fill first, then the grid rules on top of it
    setFill(doc, [241, 245, 249])
    doc.rect(x, y + metaHeight, width, headHeight, "F")

    setDraw(doc, [203, 213, 225])
    doc.setLineWidth(0.25)
    doc.rect(x, y, width, gridHeight)
    doc.line(x, y + metaHeight, x + width, y + metaHeight)
    doc.line(x, y + metaHeight + headHeight, x + width, y + metaHeight + headHeight)
    doc.line(x + half, y, x + half, y + gridHeight)

    drawMetaColumn(doc, metaLeft, x + pad, y + pad + 3.6, cellWidth)
    drawMetaColumn(doc, metaRight, x + half + pad, y + pad + 3.6, cellWidth)

    doc.setFont("helvetica", "bold")
    doc.setFontSize(8)
    setText(doc, colors.secondary)
    doc.text("BILL TO", x + pad, y + metaHeight + 4.8)
    doc.text("DELIVERY TO", x + half + pad, y + metaHeight + 4.8)

    const bodyY = y + metaHeight + headHeight + pad + 3.2
    drawPartyLines(doc, billTo, x + pad, bodyY, cellWidth)
    drawPartyLines(doc, deliverTo, x + half + pad, bodyY, cellWidth)

    return y + gridHeight
}

function drawMetaColumn(doc: any, rows: Array<[string, string]>, x: number, y: number, width: number) {
    const labelWidth = 24
    let rowY = y

    rows.forEach(([label, value]) => {
        doc.setFont("helvetica", "normal")
        doc.setFontSize(8.5)
        setText(doc, colors.secondary)
        doc.text(`${label} :`, x, rowY)

        doc.setFont("helvetica", "bold")
        setText(doc, colors.primary)
        doc.text(truncateToWidth(doc, String(value), width - labelWidth), x + labelWidth, rowY)
        rowY += 4.6
    })
}

/** Draws one party cell, or only measures it when `measureOnly` is set. Returns the height used. */
function drawPartyLines(doc: any, lines: PartyLine[], x: number, y: number, width: number, measureOnly = false) {
    let cursorY = y
    let height = 0

    for (const line of lines) {
        if (line.strong) {
            doc.setFont("helvetica", "bold")
            doc.setFontSize(9.5)
            const wrapped = doc.splitTextToSize(line.value, width)
            if (!measureOnly) {
                setText(doc, colors.primary)
                wrapped.forEach((text: string, index: number) => doc.text(text, x, cursorY + index * 4.4))
            }
            cursorY += wrapped.length * 4.4 + 0.8
            height += wrapped.length * 4.4 + 0.8
            continue
        }

        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        const labelWidth = line.label ? doc.getTextWidth(`${line.label} `) : 0
        if (!measureOnly && line.label) {
            setText(doc, colors.muted)
            doc.text(line.label, x, cursorY)
        }

        doc.setFont("helvetica", "normal")
        doc.setFontSize(8)
        const wrapped = doc.splitTextToSize(line.value, Math.max(width - labelWidth, 12))
        if (!measureOnly) {
            setText(doc, colors.secondary)
            wrapped.forEach((text: string, index: number) => doc.text(text, x + labelWidth, cursorY + index * 4))
        }
        cursorY += wrapped.length * 4
        height += wrapped.length * 4
    }

    return height
}

function truncateToWidth(doc: any, value: string, maxWidth: number) {
    if (doc.getTextWidth(value) <= maxWidth) return value

    let text = value
    while (text.length > 1 && doc.getTextWidth(`${text}...`) > maxWidth) {
        text = text.slice(0, -1)
    }
    return `${text}...`
}

/**
 * Column positions for the invoice grid, measured from the table's left edge.
 * Named so the header and the body rows can never fall out of alignment.
 */
const ITEM_COLUMNS = {
    serial: 3,
    description: 10,
    quantity: 100,
    rate: 122,
    taxPercent: 137,
    tax: 155,
} as const

function drawItemsTableHeader(doc: any, x: number, y: number, width: number) {
    setFill(doc, colors.primary)
    doc.rect(x, y, width, 10, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(7.5)
    setText(doc, colors.white)
    doc.text("#", x + ITEM_COLUMNS.serial, y + 6.8)
    doc.text("ITEM & DESCRIPTION", x + ITEM_COLUMNS.description, y + 6.8)
    doc.text("QTY", x + ITEM_COLUMNS.quantity, y + 6.8, { align: "right" })
    doc.text("RATE", x + ITEM_COLUMNS.rate, y + 6.8, { align: "right" })
    doc.text("TAX %", x + ITEM_COLUMNS.taxPercent, y + 6.8, { align: "right" })
    doc.text("TAX", x + ITEM_COLUMNS.tax, y + 6.8, { align: "right" })
    doc.text("AMOUNT", x + width - 3, y + 6.8, { align: "right" })
}

function drawItemRow(doc: any, line: InvoiceLine, x: number, y: number, width: number) {
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    setText(doc, colors.secondary)
    doc.text(String(line.serial), x + ITEM_COLUMNS.serial, y + 4.8)

    setText(doc, colors.primary)
    doc.text(truncate(line.description, 44), x + ITEM_COLUMNS.description, y + 4.8)

    const quantity = line.unit
        ? `${formatInvoiceQuantity(line.quantity)} ${line.unit}`
        : formatInvoiceQuantity(line.quantity)
    doc.text(quantity, x + ITEM_COLUMNS.quantity, y + 4.8, { align: "right" })
    doc.text(formatInvoiceMoney(line.rate), x + ITEM_COLUMNS.rate, y + 4.8, { align: "right" })
    doc.text(formatInvoiceTaxPercent(line.taxPercent), x + ITEM_COLUMNS.taxPercent, y + 4.8, { align: "right" })
    doc.text(formatInvoiceMoney(line.tax), x + ITEM_COLUMNS.tax, y + 4.8, { align: "right" })

    doc.setFont("helvetica", "bold")
    doc.text(formatInvoiceMoney(line.amount), x + width - 3, y + 4.8, { align: "right" })

    setDraw(doc, colors.softBorder)
    doc.setLineWidth(0.25)
    doc.line(x, y + 7, x + width, y + 7)
}

function drawItemsTable(doc: any, lines: InvoiceLine[], x: number, y: number, width: number, pageHeight: number) {
    let currentY = y

    drawItemsTableHeader(doc, x, currentY, width)
    currentY += 10

    lines.forEach((line) => {
        if (currentY + 7 > pageHeight - 26) {
            doc.addPage()
            drawPageShell(doc)
            currentY = 24
            drawItemsTableHeader(doc, x, currentY, width)
            currentY += 10
        }
        drawItemRow(doc, line, x, currentY, width)
        currentY += 7
    })

    return currentY
}

function getSummaryHeight(totals: InvoiceTotals, refundedItems: any[]) {
    const rowHeight = 6.5
    let rows = 3

    if (totals.discount > 0) rows += 1
    if (totals.deliveryCharges > 0) rows += 1
    if (totals.refund > 0) rows += 1

    const refundedItemsHeight = refundedItems.length > 0
        ? 11 + refundedItems.length * 4.5
        : 0

    return rows * rowHeight + refundedItemsHeight + 14
}

function drawSummary(doc: any, totals: InvoiceTotals, refundedItems: any[], right: number, y: number, pageHeight: number) {
    let currentY = y
    const x = right - 76
    const width = 76
    const summaryHeight = getSummaryHeight(totals, refundedItems)

    if (currentY + summaryHeight > pageHeight - 40) {
        doc.addPage()
        drawPageShell(doc)
        currentY = 24
    }

    const row = (label: string, value: string, color: PdfColor = colors.primary) => {
        doc.setFont("helvetica", "normal")
        doc.setFontSize(8)
        setText(doc, colors.muted)
        doc.text(label, x, currentY)
        doc.setFont("helvetica", "bold")
        setText(doc, color)
        doc.text(value, x + width, currentY, { align: "right" })
        setDraw(doc, colors.border)
        ;(doc as any).setLineDashPattern?.([1, 1], 0)
        doc.line(x, currentY + 2.2, x + width, currentY + 2.2)
        ;(doc as any).setLineDashPattern?.([], 0)
        currentY += 6.5
    }

    row("Sub Total", formatInvoiceMoney(totals.subTotal))
    row(totals.taxLabel, formatInvoiceMoney(totals.taxAmount))

    if (totals.discount > 0) {
        row("Platform Discount", `-${formatInvoiceMoney(totals.discount)}`, colors.red)
    }

    if (totals.deliveryCharges > 0) {
        row("Delivery Charges", formatInvoiceMoney(totals.deliveryCharges))
    }

    if (totals.refund > 0) {
        row("Refunded", `-${formatInvoiceMoney(totals.refund)}`, colors.red)
    }

    row("Rounding", formatInvoiceMoney(totals.rounding))

    if (refundedItems.length > 0) {
        setFill(doc, [254, 242, 242])
        setDraw(doc, [254, 226, 226])
        doc.roundedRect(x, currentY, width, 9 + refundedItems.length * 4.5, 2, 2, "FD")
        doc.setFont("helvetica", "bold")
        doc.setFontSize(7)
        setText(doc, colors.red)
        doc.text("REFUNDED ITEMS", x + 3, currentY + 4.8)
        currentY += 8
        refundedItems.forEach((item) => {
            doc.setFont("helvetica", "normal")
            doc.setFontSize(7)
            setText(doc, colors.secondary)
            doc.text(truncate(`${item.quantity}x ${item.productName}`, 30), x + 3, currentY)
            setText(doc, colors.red)
            doc.text(`-PKR ${formatMoney(item.amount || 0)}`, x + width - 3, currentY, { align: "right" })
            currentY += 4.5
        })
        currentY += 2
    }

    setFill(doc, colors.primary)
    doc.roundedRect(x, currentY, width, 14, 2, 2, "F")
    doc.setFont("helvetica", "bold")
    doc.setFontSize(8.5)
    setText(doc, colors.white)
    doc.text("TOTAL", x + 4, currentY + 9)
    doc.setFontSize(12)
    doc.text(`PKR ${formatInvoiceMoney(totals.total)}`, x + width - 4, currentY + 9, { align: "right" })
    currentY += 14

    return currentY
}

function drawFooter(doc: any, y: number, margin: number, right: number, pageHeight: number) {
    let footerY = y
    if (footerY > pageHeight - 24) {
        doc.addPage()
        drawPageShell(doc)
        footerY = 244
    }

    setDraw(doc, colors.softBorder)
    doc.line(margin, footerY, right, footerY)

    doc.setFont("helvetica", "bold")
    doc.setFontSize(7)
    setText(doc, colors.muted)
    doc.text("AUTHENTICATION", margin, footerY + 8)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(6.5)
    setText(doc, [203, 213, 225])
    doc.text(`Generated on: ${new Date().toLocaleString()}`, margin, footerY + 13)
    doc.text("Authorized by Apricart", margin, footerY + 18)

    setDraw(doc, [203, 213, 225])
    doc.line(right - 86, footerY + 12, right - 56, footerY + 12)
    doc.line(right - 38, footerY + 12, right - 8, footerY + 12)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(6.5)
    setText(doc, colors.muted)
    doc.text("ACCOUNTANT", right - 71, footerY + 17, { align: "center" })
    doc.text("AUTHORIZED SIGN", right - 23, footerY + 17, { align: "center" })
}

function setText(doc: any, color: PdfColor) {
    doc.setTextColor(color[0], color[1], color[2])
}

function setFill(doc: any, color: PdfColor) {
    doc.setFillColor(color[0], color[1], color[2])
}

function setDraw(doc: any, color: PdfColor) {
    doc.setDrawColor(color[0], color[1], color[2])
}

function truncate(value: string, maxLength: number) {
    if (!value) return ""
    return value.length > maxLength ? `${value.slice(0, Math.max(0, maxLength - 3))}...` : value
}

function formatMoney(value: unknown) {
    return Number(value || 0).toLocaleString()
}
