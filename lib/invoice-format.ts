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
 * The closing note on the invoice.
 *
 * The invoice is issued by the platform rather than counter-signed, so it says
 * so outright in place of the signature blocks it used to print. Both the
 * on-screen invoice and the PDF read it from here so the two cannot disagree.
 */
export const INVOICE_SYSTEM_GENERATED_NOTE =
    "This is a system-generated invoice and does not require a signature or stamp."
