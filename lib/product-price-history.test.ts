import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  isProductPriceHistoryRange,
  resolveProductPriceHistoryRange,
  toIsoTimestamp,
} from "@/lib/product-price-history"

describe("product price history ranges", () => {
  const now = new Date("2026-09-25T12:00:00.000Z")

  it("provides a readable label for each supported window", () => {
    expect(resolveProductPriceHistoryRange("90d", now)).toMatchObject({ label: "Last 90 days" })
    expect(resolveProductPriceHistoryRange("180d", now)).toMatchObject({ label: "Last 6 months" })
    expect(resolveProductPriceHistoryRange("1y", now)).toMatchObject({ label: "Last 12 months" })
    expect(resolveProductPriceHistoryRange("all", now)).toEqual({ key: "all", label: "All time", startAt: null })
  })

  it("calculates the range boundaries without mutating the supplied date", () => {
    expect(resolveProductPriceHistoryRange("90d", now).startAt?.toISOString()).toBe("2026-06-27T12:00:00.000Z")
    expect(resolveProductPriceHistoryRange("1y", now).startAt?.toISOString()).toBe("2025-09-25T12:00:00.000Z")
    expect(now.toISOString()).toBe("2026-09-25T12:00:00.000Z")
  })

  it("rejects unknown range keys", () => {
    expect(isProductPriceHistoryRange("90d")).toBe(true)
    expect(isProductPriceHistoryRange("quarter")).toBe(false)
    expect(isProductPriceHistoryRange(null)).toBe(false)
  })
})

describe("database timestamp normalization", () => {
  it("accepts both Date objects and PostgreSQL timestamp strings", () => {
    const expected = "2026-09-01T00:00:00.000Z"
    expect(toIsoTimestamp(new Date(expected))).toBe(expected)
    expect(toIsoTimestamp("2026-09-01 00:00:00+00")).toBe(expected)
  })

  it("returns null for absent or invalid database values", () => {
    expect(toIsoTimestamp(null)).toBeNull()
    expect(toIsoTimestamp(undefined)).toBeNull()
    expect(toIsoTimestamp("not-a-timestamp")).toBeNull()
  })
})

describe("product price history persistence contract", () => {
  const source = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8")

  it("uses the dedicated ledger rather than rebuilding the feature from orders", () => {
    const route = source("app/api/v1/admin/product-price-history/route.ts")

    expect(route).toContain("productPriceHistory")
    expect(route).not.toContain("orderItems")
    expect(route).not.toContain("orders.createdAt")
  })

  it("backfills transitions idempotently and installs triggers for every price tier", () => {
    const migration = source("drizzle/20260926180000_add_product_price_history.sql")

    expect(migration).toContain("LAG(oi.price_cents)")
    expect(migration).toContain("PARTITION BY oi.global_product_id, o.organization_id, b.group_id")
    expect(migration).toContain("oi.price_cents > 0")
    expect(migration).toContain("previous_price_cents IS DISTINCT FROM price_cents")
    expect(migration).toContain("ON CONFLICT (source_key) WHERE source_key IS NOT NULL DO NOTHING")
    expect(migration).toContain("global_product_price_history_trg")
    expect(migration).toContain("organization_price_history_trg")
    expect(migration).toContain("group_price_history_trg")
    expect(migration).not.toMatch(/UPDATE\s+(global_products|organization_inventory|group_inventory_prices)/i)
  })

  it("repairs previously backfilled branch duplicates without deleting live changes", () => {
    const migration = source("drizzle/20260926200000_compact_product_price_history.sql")

    expect(migration).toContain("COALESCE(group_id, -1)")
    expect(migration).toContain("source IN ('ORDER_BACKFILL', 'MIGRATION_BASELINE')")
    expect(migration).toContain("previous_timeline_price_cents = price_cents")
    expect(migration).not.toContain("source IN ('CATALOG_CHANGE'")
  })
})
