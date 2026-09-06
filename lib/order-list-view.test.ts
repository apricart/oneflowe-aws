import { describe, expect, it } from "vitest"

import { selectOrdersForListView } from "@/lib/order-list-view"

const order = (
  id: number,
  status: string,
  createdAt: string,
  refundAmountCents = 0,
) => ({ id, status, createdAt, refundAmountCents })

const ids = (rows: { id: number }[]) => rows.map((row) => row.id)

describe("selectOrdersForListView", () => {
  const rows = [
    order(1, "PENDING", "2026-01-01T00:00:00.000Z"),
    order(2, "APPROVED", "2026-01-02T00:00:00.000Z"),
    order(3, "FULFILLED", "2026-01-03T00:00:00.000Z"),
    order(4, "PARTIALLY_FULFILLED", "2026-01-04T00:00:00.000Z", 5_000),
    order(5, "REJECTED", "2026-01-05T00:00:00.000Z"),
    order(6, "CANCELLED", "2026-01-06T00:00:00.000Z"),
    order(7, "REFUNDED", "2026-01-07T00:00:00.000Z", 20_000),
  ]

  it("returns every order newest first when no tab narrows the list", () => {
    const selected = selectOrdersForListView(rows, { statusFilter: "all", splitFilter: "all" })

    expect(ids(selected)).toEqual([7, 6, 5, 4, 3, 2, 1])
  })

  it("narrows to a single status for the plain tabs", () => {
    expect(ids(selectOrdersForListView(rows, { statusFilter: "pending", splitFilter: "all" }))).toEqual([1])
    expect(ids(selectOrdersForListView(rows, { statusFilter: "approved", splitFilter: "all" }))).toEqual([2])
    expect(ids(selectOrdersForListView(rows, { statusFilter: "refunded", splitFilter: "all" }))).toEqual([7])
  })

  it("counts a cancelled order under the rejected tab", () => {
    expect(ids(selectOrdersForListView(rows, { statusFilter: "rejected", splitFilter: "all" }))).toEqual([6, 5])
  })

  it("keeps partially fulfilled orders on the fulfilled tab", () => {
    expect(ids(selectOrdersForListView(rows, { statusFilter: "fulfilled", splitFilter: "all" }))).toEqual([4, 3])
  })

  it("applies the split only on the tabs that offer one", () => {
    // The fulfilled tab offers the split, so it narrows.
    expect(ids(selectOrdersForListView(rows, { statusFilter: "fulfilled", splitFilter: "full" }))).toEqual([4, 3])
    // The pending tab does not, so a stale split must not silently empty it.
    expect(ids(selectOrdersForListView(rows, { statusFilter: "pending", splitFilter: "full" }))).toEqual([1])
  })

  it("tolerates a missing status rather than throwing on it", () => {
    const withoutStatus = [{ id: 8, createdAt: "2026-01-08T00:00:00.000Z" }]

    expect(ids(selectOrdersForListView(withoutStatus, { statusFilter: "all", splitFilter: "all" }))).toEqual([8])
    expect(selectOrdersForListView(withoutStatus, { statusFilter: "pending", splitFilter: "all" })).toEqual([])
  })

  it("does not reorder or otherwise disturb the array it was given", () => {
    const source = [...rows]
    selectOrdersForListView(source, { statusFilter: "all", splitFilter: "all" })

    expect(ids(source)).toEqual([1, 2, 3, 4, 5, 6, 7])
  })
})
