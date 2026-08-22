const MONTH_LABELS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
]

const US_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/

function toLabel(year: number, monthIndex: number, day: number) {
    if (monthIndex < 0 || monthIndex > 11 || day < 1 || day > 31) return null
    return `${String(day).padStart(2, "0")} ${MONTH_LABELS[monthIndex]} ${year}`
}

/**
 * Renders an invoice date as "27 Jul 2026".
 *
 * Invoice snapshots store the date as the "MM/DD/YYYY" string produced when the
 * order was placed, so the stored text is parsed explicitly rather than handed
 * to `new Date`, whose locale guesswork would flip day and month. Anything that
 * cannot be parsed is returned untouched — an unfamiliar legacy value is still
 * better on the invoice than an empty field.
 */
export function formatInvoiceDisplayDate(value: unknown): string {
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return toLabel(value.getFullYear(), value.getMonth(), value.getDate()) ?? ""
    }

    const raw = typeof value === "string" ? value.trim() : ""
    if (!raw) return ""

    const usMatch = US_DATE.exec(raw)
    if (usMatch) {
        const [, month, day, year] = usMatch
        return toLabel(Number(year), Number(month) - 1, Number(day)) ?? raw
    }

    const isoMatch = ISO_DATE.exec(raw)
    if (isoMatch) {
        const [, year, month, day] = isoMatch
        return toLabel(Number(year), Number(month) - 1, Number(day)) ?? raw
    }

    return raw
}

/**
 * The purchase-order reference printed on the invoice.
 *
 * This is the buyer's own reference, supplied when the order was placed, and it
 * is printed only when there is one. It deliberately does not fall back to the
 * invoice number: repeating the invoice number under "P.O.#" made the invoice
 * assert a purchase order that the buyer never raised.
 */
export function getInvoicePoNumber(receiptData: { poNumber?: unknown } | null | undefined): string {
    const poNumber = typeof receiptData?.poNumber === "string" ? receiptData.poNumber.trim() : ""
    return poNumber || "N/A"
}
