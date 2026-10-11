import { describe, expect, it } from "vitest"
import {
  assignInvoiceNumberAtCreation,
  formatInvoiceNumber,
  generateNextInvoiceNumber,
  INVOICE_CODE_MISSING,
  InvoiceCodeMissingError,
  isInvoiceableTenantCode,
  isInvoiceCodeMissingError,
} from "./invoice-number"

describe("formatInvoiceNumber", () => {
  it("prefixes a 6-digit APR invoice number with the normalized tenant short name", () => {
    expect(formatInvoiceNumber("ubl", 1)).toBe("UBL-APR-000001")
    expect(formatInvoiceNumber("EFU", 2)).toBe("EFU-APR-000002")
    expect(formatInvoiceNumber("UBL_123A", 999999)).toBe("UBL_123A-APR-999999")
  })

  it("rejects invalid sequence values", () => {
    expect(() => formatInvoiceNumber("UBL", 0)).toThrow("Invoice sequence")
    expect(() => formatInvoiceNumber("UBL", 1000000)).toThrow("Invoice sequence")
  })

  it("rejects an invalid tenant short name", () => {
    expect(() => formatInvoiceNumber("", 1)).toThrow("Tenant short name")
    expect(() => formatInvoiceNumber("UBL WEST", 1)).toThrow("Tenant short name")
  })

  it("returns unique values for simultaneous invoice requests", async () => {
    let sequence = 0
    const lockStrengths: string[] = []
    const client = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: (strength: string) => {
              lockStrengths.push(strength)
              return { limit: async () => [{ tenantShortName: "UBL" }] }
            },
          }),
        }),
      }),
      insert: () => ({
        values: () => ({ onConflictDoNothing: async () => undefined }),
      }),
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ nextValue: ++sequence }],
          }),
        }),
      }),
    } as any

    const values = await Promise.all(
      Array.from({ length: 100 }, () => generateNextInvoiceNumber(client, 1)),
    )
    expect(new Set(values).size).toBe(100)
    expect(values).toContain("UBL-APR-000001")
    expect(values).toContain("UBL-APR-000100")
    expect(lockStrengths).toEqual(Array.from({ length: 100 }, () => "share"))
  })

  it("requires the tenant to have a short name", async () => {
    const client = {
      select: () => ({
        from: () => ({
          where: () => ({
            for: () => ({ limit: async () => [{ tenantShortName: null }] }),
          }),
        }),
      }),
    } as any

    await expect(generateNextInvoiceNumber(client, 1)).rejects.toBeInstanceOf(InvoiceCodeMissingError)
  })
})

/** A client whose organization row carries `code`, recording what it was asked to lock. */
function tenantClient(code: string | null) {
  const locked: string[] = []
  const client = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: (mode: string) => {
            locked.push(mode)
            return { limit: async () => [{ tenantShortName: code }] }
          },
        }),
      }),
    }),
  } as any
  return { client, locked }
}

describe("an organization that cannot be invoiced", () => {
  it("is one with no code, or a code no invoice number can carry", () => {
    expect(isInvoiceableTenantCode("UBL")).toBe(true)
    expect(isInvoiceableTenantCode(" ubl_2 ")).toBe(true)
    expect(isInvoiceableTenantCode(null)).toBe(false)
    expect(isInvoiceableTenantCode("")).toBe(false)
    expect(isInvoiceableTenantCode("K-E")).toBe(false)
    expect(isInvoiceableTenantCode("UBL WEST")).toBe(false)
  })

  it("takes no order: creation refuses it, under the same shared lock a code change waits on", async () => {
    const { client, locked } = tenantClient(null)
    const receiptData: { invoiceNumber?: string } = { invoiceNumber: "stale" }
    const attempt = assignInvoiceNumberAtCreation(client, receiptData, { organizationId: 7, tid: "T1", invoiceSequenceReady: true })
    await expect(attempt).rejects.toBeInstanceOf(InvoiceCodeMissingError)
    expect(locked).toEqual(["share"])
  })

  it("an organization with a code places orders that carry no number until delivery", async () => {
    const { client, locked } = tenantClient("UBL")
    const receiptData: { invoiceNumber?: string } = { invoiceNumber: "stale" }
    await assignInvoiceNumberAtCreation(client, receiptData, { organizationId: 7, tid: "T1", invoiceSequenceReady: true })
    expect(receiptData).toEqual({})
    expect(locked).toEqual(["share"])
  })

  it("is recognised by its code, so a route can answer it after a transaction rethrows it", () => {
    expect(isInvoiceCodeMissingError(new InvoiceCodeMissingError())).toBe(true)
    expect(isInvoiceCodeMissingError({ code: INVOICE_CODE_MISSING })).toBe(true)
    expect(isInvoiceCodeMissingError(new Error("Tenant short name"))).toBe(false)
    expect(isInvoiceCodeMissingError(null)).toBe(false)
  })
})

describe("credit note numbers", () => {
  it("come from their own CN series, in the invoice number's shape", async () => {
    const { formatCreditNoteNumber } = await import("./invoice-number")
    expect(formatCreditNoteNumber("ubl", 4)).toBe("UBL-CN-000004")
    expect(() => formatCreditNoteNumber("U-B", 4)).toThrow()
    expect(() => formatCreditNoteNumber("UBL", 0)).toThrow()
  })
})
