import { NextRequest, NextResponse } from "next/server"
import { safeFilenamePart } from "@/lib/security"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { branches, orders, orderItems, refundItems, refunds, users } from "@/db/schema"
import { and, eq, sql } from "drizzle-orm"
import { shouldHidePricesForRole } from "@/lib/price-visibility"
import { aggregateReceiptRefundItems, getReceiptItemQuantity, getReceiptNetTotal, toDisplayNameCase } from "@/lib/receipt-display"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { formatBranchAddress } from "@/lib/branch-address"
import { jsPDF } from "jspdf"
import path from "path"
import fs from "fs"

export async function GET(
    req: NextRequest,
    props: { params: Promise<{ orderId: string }> }
) {
    try {
        const session = await getServerSession(authOptions)
        if (!session?.user) {
            return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
        }

        const params = await props.params
        const orderId = parseInt(params.orderId)
        if (isNaN(orderId)) {
            return NextResponse.json({ error: "Invalid order ID" }, { status: 400 })
        }

        const [order] = await db
            .select()
            .from(orders)
            .where(eq(orders.id, orderId))
            .limit(1)

        if (!order || !order.receiptData) {
            return NextResponse.json({ error: "Invoice not found" }, { status: 404 })
        }

        const { verifyResourceAccess } = await import("@/lib/auth")
        const hasAccess = await verifyResourceAccess(order.organizationId, order.branchId)
        if (!hasAccess) {
            return NextResponse.json({ error: "Forbidden: You do not have access to this invoice" }, { status: 403 })
        }

        const userRole = (session.user as any).role
        const pricesHidden = await shouldHidePricesForRole(userRole, order.organizationId)
        if (pricesHidden) {
            return NextResponse.json({ error: "Invoice download is unavailable while prices are hidden" }, { status: 403 })
        }

        const [creator] = await db
            .select({
                fullName: users.fullName,
                firstName: users.firstName,
                lastName: users.lastName,
                username: users.username,
                email: users.email,
                phone: users.phone,
            })
            .from(users)
            .where(eq(users.id, order.createdByUserId))
            .limit(1)

        const creatorName = creator
            ? (
                creator.fullName ||
                [creator.firstName, creator.lastName].filter(Boolean).join(" ") ||
                creator.username ||
                creator.email ||
                "Unknown"
            )
            : "Unknown"

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
            placedByName: creatorName,
            placedByPhone: creator?.phone || null,
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
    const summaryHeight = getSummaryHeight(receiptData, refundAmount, refundedItems)
    const footerReserve = 24

    drawPageShell(doc)
    drawHeader(doc, receiptData, margin, right)

    let y = 70
    drawDetailCards(doc, receiptData, itemQuantity, margin, y, contentWidth)
    y += 44

    y = drawItemsTable(doc, receiptData, margin, y, contentWidth, pageHeight)
    y += 7

    if (y + summaryHeight + footerReserve > pageHeight - 16) {
        doc.addPage()
        drawPageShell(doc)
        y = 24
    }

    y = drawSummary(doc, receiptData, refundAmount, refundedItems, right, y, pageHeight)
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

function drawHeader(doc: any, receiptData: any, margin: number, right: number) {
    const pageWidth = 210
    const logoWidth = 50
    const logoHeight = 14
    const logoX = (pageWidth - logoWidth) / 2

    try {
        const logoPath = path.join(process.cwd(), "public", "apricart-logo-blue.png")
        if (fs.existsSync(logoPath)) {
            const logoData = fs.readFileSync(logoPath).toString("base64")
            doc.addImage(`data:image/png;base64,${logoData}`, "PNG", logoX, 22, logoWidth, logoHeight, undefined, "FAST")
        } else {
            setText(doc, colors.primary)
            doc.setFont("helvetica", "bold")
            doc.setFontSize(22)
            doc.text("ONEFLOWE", pageWidth / 2, 32, { align: "center" })
        }
    } catch {
        setText(doc, colors.primary)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(22)
        doc.text("ONEFLOWE", pageWidth / 2, 32, { align: "center" })
    }

    doc.setFont("helvetica", "bold")
    doc.setFontSize(10)
    setText(doc, colors.primary)
    doc.text("FROM:", margin, 47)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)
    doc.text(truncate("Apricart E-Store Pvt Ltd", 42), margin, 53)

    setDraw(doc, colors.border)
    doc.setLineWidth(0.5)
    doc.line(margin, 62, right, 62)
}

function drawDetailCards(doc: any, receiptData: any, itemQuantity: number, x: number, y: number, width: number) {
    const gap = 6
    const cardWidth = (width - gap * 2) / 3
    const cardHeight = 38

    drawCard(doc, x, y, cardWidth, cardHeight, "BILLED TO", [
        ["Name:", receiptData.buyerName || "N/A"],
        ["Address:", toDisplayNameCase(receiptData.buyerAddress || "-")],
        ["Created By:", toDisplayNameCase(receiptData.placedByName || "N/A")],
        ["Phone:", receiptData.placedByPhone || receiptData.buyerPhone || "N/A"],
    ])

    drawCard(doc, x + cardWidth + gap, y, cardWidth, cardHeight, "ORDER DETAILS", [
        ["Invoice #:", receiptData.invoiceNumber || "N/A"],
        ["Date:", receiptData.date || "N/A"],
        ["Status:", receiptData.status || "PENDING"],
    ])

    drawCard(doc, x + (cardWidth + gap) * 2, y, cardWidth, cardHeight, "QUICK SUMMARY", [
        ["Items:", String(itemQuantity)],
        ["Subtotal:", `PKR ${formatMoney(receiptData.subtotal)}`],
    ])
}

function drawCard(doc: any, x: number, y: number, width: number, height: number, title: string, rows: Array<[string, string]>) {
    setFill(doc, colors.card)
    setDraw(doc, colors.softBorder)
    doc.roundedRect(x, y, width, height, 2, 2, "FD")

    doc.setFont("helvetica", "bold")
    doc.setFontSize(8)
    setText(doc, colors.secondary)
    doc.text(title, x + 4, y + 7)

    setDraw(doc, colors.border)
    doc.setLineWidth(0.25)
    doc.line(x + 4, y + 10.5, x + width - 4, y + 10.5)

    let rowY = y + 16.5
    rows.forEach(([label, value]) => {
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        setText(doc, colors.muted)
        doc.text(label, x + 4, rowY)

        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        setText(doc, colors.primary)
        doc.text(truncate(String(value), 24), x + width - 4, rowY, { align: "right" })
        rowY += 5.2
    })
}

function drawItemsTable(doc: any, receiptData: any, x: number, y: number, width: number, pageHeight: number) {
    let serial = 0
    let currentY = y

    const drawHeader = () => {
        setFill(doc, colors.primary)
        doc.rect(x, currentY, width, 10, "F")
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8.5)
        setText(doc, colors.white)
        doc.text("#", x + 4, currentY + 6.8)
        doc.text("DESCRIPTION", x + 24, currentY + 6.8)
        doc.text("QTY", x + 116, currentY + 6.8, { align: "right" })
        doc.text("PRICE", x + 138, currentY + 6.8, { align: "right" })
        doc.text("TOTAL", x + width - 4, currentY + 6.8, { align: "right" })
        currentY += 10
    }

    const ensureSpace = (height: number) => {
        if (currentY + height <= pageHeight - 26) return
        doc.addPage()
        drawPageShell(doc)
        currentY = 24
        drawHeader()
    }

    drawHeader()

    receiptData.items?.forEach((category: any) => {
        ensureSpace(7)
        setFill(doc, colors.row)
        doc.rect(x, currentY, width, 7, "F")
        doc.setFont("helvetica", "bold")
        doc.setFontSize(8)
        setText(doc, colors.secondary)
        doc.text(String(category.mainCategoryName || category.categoryName || "ITEMS").toUpperCase(), x + 4, currentY + 4.8)
        currentY += 7

        const subCategories = category.subCategories || [{ subCategoryName: "", items: category.items }]
        subCategories.forEach((subCategory: any) => {
            if (subCategory.subCategoryName) {
                ensureSpace(6)
                setFill(doc, colors.subRow)
                doc.rect(x, currentY, width, 6, "F")
                doc.setFont("helvetica", "bold")
                doc.setFontSize(7.5)
                setText(doc, colors.muted)
                doc.text(`> ${subCategory.subCategoryName}`, x + 10, currentY + 4.2)
                currentY += 6
            }

            subCategory.items?.forEach((item: any) => {
                ensureSpace(7)
                serial += 1
                doc.setFont("helvetica", "normal")
                doc.setFontSize(8)
                setText(doc, colors.secondary)
                doc.text(String(serial), x + 4, currentY + 4.8)

                setText(doc, colors.primary)
                doc.text(truncate(item.description || "", 60), x + 24, currentY + 4.8)
                doc.text(String(item.quantity || 0), x + 116, currentY + 4.8, { align: "right" })
                doc.text(formatMoney(item.rate), x + 138, currentY + 4.8, { align: "right" })
                doc.setFont("helvetica", "bold")
                doc.text(formatMoney(item.total), x + width - 4, currentY + 4.8, { align: "right" })

                setDraw(doc, colors.softBorder)
                doc.setLineWidth(0.25)
                doc.line(x, currentY + 7, x + width, currentY + 7)
                currentY += 7
            })
        })
    })

    return currentY
}

function getSummaryHeight(receiptData: any, refundAmount: number, refundedItems: any[]) {
    const rowHeight = 6.5
    let rows = 3

    if (Number(receiptData.deliveryCharges || 0) > 0) {
        rows += 1
    }

    if (refundAmount > 0) {
        rows += 1
    }

    const refundedItemsHeight = refundedItems.length > 0
        ? 11 + refundedItems.length * 4.5
        : 0

    return rows * rowHeight + refundedItemsHeight + 14
}

function drawSummary(doc: any, receiptData: any, refundAmount: number, refundedItems: any[], right: number, y: number, pageHeight: number) {
    let currentY = y
    const x = right - 76
    const width = 76
    const summaryHeight = getSummaryHeight(receiptData, refundAmount, refundedItems)

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

    row("Subtotal Amount", `PKR ${formatMoney(receiptData.subtotal)}`)
    row("Tax & Processing", `PKR ${formatMoney(receiptData.tax)}`)
    row("Platform Discount", `-PKR ${formatMoney(receiptData.discount)}`, colors.red)

    if (Number(receiptData.deliveryCharges || 0) > 0) {
        row("Delivery Charges", `PKR ${formatMoney(receiptData.deliveryCharges)}`)
    }

    if (refundAmount > 0) {
        row("Refunded", `-PKR ${formatMoney(refundAmount)}`, colors.red)
    }

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
    doc.text("TOTAL PAYABLE", x + 4, currentY + 9)
    doc.setFontSize(12)
    doc.text(`PKR ${formatMoney(receiptData.totalAmount)}`, x + width - 4, currentY + 9, { align: "right" })
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
    doc.text("Authorized by OneFlowe ERP System", margin, footerY + 18)

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
