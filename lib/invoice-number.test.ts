import { describe, expect, it } from "vitest"
import { formatInvoiceNumber, generateNextInvoiceNumber } from "./invoice-number"

describe("formatInvoiceNumber", () => {
  it("formats a 6-digit APR invoice number", () => {
    expect(formatInvoiceNumber(1)).toBe("APR-000001")
    expect(formatInvoiceNumber(2)).toBe("APR-000002")
    expect(formatInvoiceNumber(999999)).toBe("APR-999999")
  })

  it("rejects invalid sequence values", () => {
    expect(() => formatInvoiceNumber(0)).toThrow("Invoice sequence")
    expect(() => formatInvoiceNumber(1000000)).toThrow("Invoice sequence")
  })

  it("returns unique values for simultaneous invoice requests", async () => {
    let sequence = 0
    const client = {
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
    expect(values).toContain("APR-000001")
    expect(values).toContain("APR-000100")
  })
})
