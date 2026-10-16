import { readFileSync } from "node:fs"
import path from "node:path"

import { describe, expect, it } from "vitest"

import {
  globalProductAdminCreateSchema,
  globalProductAdminUpdateSchema,
} from "@/lib/server/mutation-validation"

const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8")

describe("a global product's code is assigned by the server", () => {
  it("refuses a create that names its own code", () => {
    expect(globalProductAdminCreateSchema.safeParse({ name: "Tea", basePrice: 10 }).success).toBe(true)
    expect(
      globalProductAdminCreateSchema.safeParse({ productCode: "PRD--1", name: "Tea", basePrice: 10 }).success,
    ).toBe(false)
  })

  it("still lets an edit change the code", () => {
    expect(globalProductAdminUpdateSchema.safeParse({ id: 1, productCode: "PRD--9" }).success).toBe(true)
  })

  it("draws the code and inserts the product in one transaction, under the lock", () => {
    const route = read("app/api/v1/admin/global-inventory/route.ts")
    const post = route.slice(route.indexOf("export async function POST"))
    const draw = post.indexOf("assignGlobalProductCodeInTx(tx)")
    expect(post.indexOf("db.transaction(")).toBeGreaterThanOrEqual(0)
    expect(draw).toBeGreaterThan(post.indexOf("db.transaction("))
    expect(draw).toBeLessThan(post.indexOf("tx.insert(globalProducts)"))

    const helper = read("lib/server/global-product-code.ts")
    expect(helper.indexOf("pg_advisory_xact_lock")).toBeLessThan(helper.indexOf("return nextGlobalProductCode(tx)"))
  })
})
