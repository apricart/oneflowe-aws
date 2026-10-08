import { readFileSync } from "node:fs"
import { resolve } from "node:path"

import { describe, expect, it } from "vitest"

import {
  DEFAULT_ORDERING_BLOCK_THRESHOLD,
  ORDERING_BLOCK_THRESHOLD_MAX,
  ORDERING_BLOCK_THRESHOLD_MIN,
  ORDERING_BLOCK_THRESHOLD_RANGE_MESSAGE,
  isOrderingBlockThreshold,
  orderingBlockThresholdOrDefault,
  parseOrderingBlockThresholdDraft,
} from "@/lib/ordering-block-threshold"
import { PAYMENT_CONTROL_POLICY } from "@/lib/payment-control-policy"
import { UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD } from "@/lib/unacknowledged-delivery-block"

const source = (path: string) =>
  readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n")

describe("the bounds and the default", () => {
  it("are 1 to 100, defaulting to the 2 both blocks used before they were configurable", () => {
    expect(ORDERING_BLOCK_THRESHOLD_MIN).toBe(1)
    expect(ORDERING_BLOCK_THRESHOLD_MAX).toBe(100)
    expect(DEFAULT_ORDERING_BLOCK_THRESHOLD).toBe(2)
  })

  it("both blocks take their default from here", () => {
    expect(PAYMENT_CONTROL_POLICY.overdueBlockThreshold).toBe(DEFAULT_ORDERING_BLOCK_THRESHOLD)
    expect(UNACKNOWLEDGED_DELIVERY_BLOCK_THRESHOLD).toBe(DEFAULT_ORDERING_BLOCK_THRESHOLD)
  })

  it("the range message names both bounds", () => {
    expect(ORDERING_BLOCK_THRESHOLD_RANGE_MESSAGE).toBe("Enter a whole number from 1 to 100.")
  })
})

describe("isOrderingBlockThreshold", () => {
  it.each([1, 2, 3, 20, 21, 99, 100])("accepts %s", (value) => {
    expect(isOrderingBlockThreshold(value)).toBe(true)
  })

  it.each([
    0,
    -1,
    101,
    1_000,
    1.5,
    0.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "2",
    "",
    null,
    undefined,
    true,
    {},
    [2],
  ])("refuses %s", (value) => {
    expect(isOrderingBlockThreshold(value)).toBe(false)
  })
})

describe("orderingBlockThresholdOrDefault — a gate never fails open", () => {
  it.each([1, 7, 100])("keeps a valid %s", (value) => {
    expect(orderingBlockThresholdOrDefault(value)).toBe(value)
  })

  it.each([0, -5, 101, 2.5, Number.NaN, null, undefined, "50"])(
    "reads %s as the default, never as 'no limit'",
    (value) => {
      expect(orderingBlockThresholdOrDefault(value)).toBe(DEFAULT_ORDERING_BLOCK_THRESHOLD)
    },
  )
})

describe("parseOrderingBlockThresholdDraft — what the Company form's field holds", () => {
  it.each([
    ["1", 1],
    ["2", 2],
    ["100", 100],
    [" 5 ", 5],
    ["05", 5],
    ["007", 7],
  ])("reads %j as %i", (text, value) => {
    expect(parseOrderingBlockThresholdDraft(text)).toEqual({ ok: true, value })
  })

  it.each([
    "",
    "   ",
    "0",
    "000",
    "101",
    "999999",
    "1234567",
    "-1",
    "+3",
    "1.5",
    "2.0",
    "1e1",
    "0x10",
    "abc",
    "3 4",
    "٣",
  ])("refuses %j with the range message", (text) => {
    expect(parseOrderingBlockThresholdDraft(text)).toEqual({ ok: false, message: ORDERING_BLOCK_THRESHOLD_RANGE_MESSAGE })
  })
})

/**
 * The database holds the same bounds as the code, so no writer — a script, a
 * console session — can store a limit the gates would then replace with the
 * default.
 */
describe("the database holds the same bounds and default", () => {
  const bounds = `BETWEEN ${ORDERING_BLOCK_THRESHOLD_MIN} AND ${ORDERING_BLOCK_THRESHOLD_MAX}`

  it("db/schema.ts", () => {
    const schema = source("db/schema.ts")
    for (const column of ["unpaid_invoice_block_threshold", "unacknowledged_delivery_block_threshold"]) {
      const at = schema.indexOf(`integer("${column}")`)
      expect(at, column).toBeGreaterThan(-1)
      expect(schema.slice(at, schema.indexOf("),", at) + 2)).toContain(`.default(${DEFAULT_ORDERING_BLOCK_THRESHOLD})`)
    }
    expect(schema).toContain(`sql\`\${t.unpaidInvoiceBlockThreshold} ${bounds}\``)
    expect(schema).toContain(`sql\`\${t.unacknowledgedDeliveryBlockThreshold} ${bounds}\``)
  })

  it("the migration, which is registered in the journal", () => {
    const tag = "20261009120000_add_ordering_block_thresholds"
    const migration = source(`drizzle/${tag}.sql`)
    expect(migration).toContain(`"unpaid_invoice_block_threshold" integer NOT NULL DEFAULT ${DEFAULT_ORDERING_BLOCK_THRESHOLD}`)
    expect(migration).toContain(`"unacknowledged_delivery_block_threshold" integer NOT NULL DEFAULT ${DEFAULT_ORDERING_BLOCK_THRESHOLD}`)
    expect(migration).toContain(`"organizations"."unpaid_invoice_block_threshold" ${bounds}`)
    expect(migration).toContain(`"organizations"."unacknowledged_delivery_block_threshold" ${bounds}`)

    const journal = JSON.parse(source("drizzle/meta/_journal.json")) as { entries: Array<{ tag: string; when: number }> }
    const index = journal.entries.findIndex((entry) => entry.tag === tag)
    expect(index).toBeGreaterThan(0)
    // The runner applies in journal order and skips an entry stamped earlier
    // than the last one applied.
    expect(journal.entries[index].when).toBeGreaterThan(journal.entries[index - 1].when)
  })
})
