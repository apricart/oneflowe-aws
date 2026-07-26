import { describe, expect, it } from "vitest"

import { decodeUtf8Csv, parseStrictCsv } from "@/lib/server/csv-import"

const options = {
  requiredHeaders: ["productcode", "name"],
  allowedHeaders: ["productcode", "name", "description"],
  maximumRows: 2,
} as const

describe("strict CSV import", () => {
  it("supports quoted commas and escaped quotes", () => {
    const rows = parseStrictCsv({
      content: 'productCode,name,description\r\nP1,"Widget, Large","A ""quoted"" item"',
      ...options,
    })
    expect(rows).toEqual([{
      productcode: "P1",
      name: "Widget, Large",
      description: 'A "quoted" item',
    }])
  })

  it("rejects unexpected headers, malformed rows and excessive rows", () => {
    expect(() => parseStrictCsv({
      content: "productCode,name,role\nP1,Widget,SUPER_ADMIN",
      ...options,
    })).toThrow("Unexpected headers")
    expect(() => parseStrictCsv({
      content: 'productCode,name\nP1,"unterminated',
      ...options,
    })).toThrow("malformed")
    expect(() => parseStrictCsv({
      content: "productCode,name\nP1,A\nP2,B\nP3,C",
      ...options,
    })).toThrow("too many rows")
  })

  it("rejects invalid UTF-8", () => {
    expect(() => decodeUtf8Csv(Buffer.from([0xff, 0xfe, 0xfd]))).toThrow("UTF-8")
  })

  it("accepts one header from each required alias group", () => {
    expect(parseStrictCsv({
      content: "product_code,name\nP-1,Widget",
      requiredHeaders: ["name"],
      requiredHeaderGroups: [["productcode", "product_code"]],
      allowedHeaders: ["productcode", "product_code", "name"],
    })).toEqual([{ product_code: "P-1", name: "Widget" }])
  })
})
