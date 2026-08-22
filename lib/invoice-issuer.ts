/**
 * Legal identity of the company that issues every invoice.
 *
 * Kept in one place so the on-screen invoice and the downloadable PDF always
 * print the same masthead. Update here and both formats follow.
 */
export const INVOICE_ISSUER = {
    name: "Apricart E-Stores Private Limited",
    addressLines: [
        "Plot No. A-504, Sector 6-A,",
        "Mehran Town, Korangi Industrial Area,",
        "Karachi, Pakistan.",
    ],
    ntn: "A062189-8",
    strn: "A062189-8",
} as const
