import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  ORDER_LIST_PRICE_SORT_KEYS,
  ORDER_LIST_SORT_KEYS,
  ORDER_REPORT_PRICE_SORT_KEYS,
  ORDER_REPORT_SORT_KEYS,
  REFUND_REPORT_PRICE_SORT_KEYS,
  REFUND_REPORT_SORT_KEYS,
  sortKeysForCaller,
} from "@/lib/list-sort-keys"

const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

/**
 * Every table whose headers sort (plans/OF-TABLE-column-sorting.md), with the
 * header cells that deliberately do not: the Orders table's pinned token and
 * action columns, and its Organization (Super Admin only) and Partial Delivery
 * columns, which the list endpoint has no sort key for; the Product ledger's
 * Discount column (always 0); and the Group report's expand-chevron column. A
 * new header cell without `aria-sort` fails here — make it sortable or add it
 * to the exceptions with a reason.
 */
const SORTABLE_TABLES: Array<[path: string, unsortableHeaders: number]> = [
  ["components/orders/orders-directory.tsx", 4],
  // The two-band header's three band cells, and the S. No / Designation cells
  // (one template in the column map): Designation is always blank.
  ["components/reports/consolidated-invoice/consolidated-invoice-document.tsx", 4],
  ["app/(portal)/reports/organization-report/page.tsx", 0],
  ["app/(portal)/reports/order-report/page.tsx", 0],
  ["app/(portal)/reports/refund-report/page.tsx", 0],
  ["app/(portal)/reports/budget-summary/page.tsx", 0],
  ["app/(portal)/reports/product-performance/page.tsx", 1],
  ["app/(portal)/reports/user-report/page.tsx", 0],
  ["app/(portal)/reports/branch-reports/page.tsx", 0],
  ["app/(portal)/reports/groups/page.tsx", 1],
  ["components/group-portal/group-order-report.tsx", 0],
]

/** The three paginated endpoints: each sorts on the server from its allowlist. */
const SERVER_SORTED_ROUTES: Array<[path: string, keys: string, priceKeys: string, sqlMap: string]> = [
  ["app/api/v1/orders/route.ts", "ORDER_LIST_SORT_KEYS", "ORDER_LIST_PRICE_SORT_KEYS", "ORDER_LIST_SORT_SQL"],
  ["app/api/v1/analytics/summary/route.ts", "ORDER_REPORT_SORT_KEYS", "ORDER_REPORT_PRICE_SORT_KEYS", "ORDER_REPORT_SORT_SQL"],
  ["app/api/v1/analytics/refunds/route.ts", "REFUND_REPORT_SORT_KEYS", "REFUND_REPORT_PRICE_SORT_KEYS", "REFUND_REPORT_SORT_SQL"],
]

describe("table column sorting contract", () => {
  it.each(SORTABLE_TABLES)("every header cell in %s sorts, bar the stated exceptions", (path, unsortable) => {
    const file = source(path)
    const headerCells = (file.match(/<(?:TableHead|th)[\s>]/g) ?? []).length
    const sortableCells = (file.match(/<(?:TableHead|th)\s+aria-sort=\{ariaSortFor\(/g) ?? []).length

    expect(headerCells).toBeGreaterThan(0)
    expect(sortableCells).toBe(headerCells - unsortable)
    expect(file).toContain("SortableHeader")
  })

  it.each(SERVER_SORTED_ROUTES)(
    "%s admits a sort only from its allowlist, minus price keys when prices are hidden",
    (path, keys, priceKeys, sqlMap) => {
      const route = source(path)
      expect(route).toMatch(new RegExp(`parseSortParams\\(\\s*[\\w.]+,\\s*sortKeysForCaller\\(${keys}, ${priceKeys}, pricesHidden\\)`))
      expect(route).toContain(`${sqlMap}[`)
      expect(route).toContain("orderBySortSql(")
      // The direction never comes from the request text.
      expect(route).not.toMatch(/sql\.raw\([^)]*(?:sort|dir)/i)
    },
  )

  it("the paginated pages send the sort to the server rather than sorting one page", () => {
    for (const page of [
      "app/(portal)/orders/page.tsx",
      "app/(portal)/reports/order-report/page.tsx",
      "app/(portal)/reports/refund-report/page.tsx",
    ]) {
      const file = source(page)
      expect(file).toContain("appendSortParams(")
      expect(file).not.toContain("sortRows(")
    }
  })

  it("drops every price key, and only those, for a caller whose prices are hidden", () => {
    for (const [keys, priceKeys] of [
      [ORDER_LIST_SORT_KEYS, ORDER_LIST_PRICE_SORT_KEYS],
      [ORDER_REPORT_SORT_KEYS, ORDER_REPORT_PRICE_SORT_KEYS],
      [REFUND_REPORT_SORT_KEYS, REFUND_REPORT_PRICE_SORT_KEYS],
    ] as Array<[readonly string[], readonly string[]]>) {
      expect(sortKeysForCaller(keys, priceKeys, false)).toEqual(keys)
      const hidden = sortKeysForCaller(keys, priceKeys, true)
      expect(hidden).toEqual(keys.filter((key) => !priceKeys.includes(key)))
      expect(priceKeys.every((key) => keys.includes(key))).toBe(true)
    }
  })
})
