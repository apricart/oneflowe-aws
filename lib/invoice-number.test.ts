import { describe, expect, it } from "vitest"
import { formatInvoiceNumber, generateNextInvoiceNumber } from "./invoice-number"

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

    await expect(generateNextInvoiceNumber(client, 1)).rejects.toThrow("Tenant short name")
  })
})
