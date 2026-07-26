import { describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { PgDialect } from "drizzle-orm/pg-core"
import { orders, users } from "@/db/schema"
import { resolveDrillDownSortColumn } from "@/lib/server/drill-down-sort"

const maliciousValues = [
  "' OR 1=1 --",
  "'; DROP TABLE users; --",
  "admin'/*",
  "1 UNION SELECT NULL--",
]

const dialect = new PgDialect()

describe("SQL query input boundaries", () => {
  it.each(maliciousValues)("binds %s as ordinary data", (value) => {
    const compiled = dialect.sqlToQuery(
      sql`SELECT ${users.id} FROM ${users} WHERE lower(${users.email}) = ${value}`,
    )

    expect(compiled.sql).not.toContain(value)
    expect(compiled.params).toContain(value)
  })

  it.each(maliciousValues)("binds search pattern %s without changing SQL structure", (value) => {
    const searchPattern = `%${value}%`
    const compiled = dialect.sqlToQuery(
      sql`SELECT ${orders.id} FROM ${orders} WHERE ${orders.tid} ILIKE ${searchPattern}`,
    )

    expect(compiled.sql).not.toContain(value)
    expect(compiled.params).toContain(searchPattern)
  })

  it("binds every value joined into a dynamic IN filter", () => {
    const values = maliciousValues.map((value) => sql`${value}`)
    const compiled = dialect.sqlToQuery(
      sql`SELECT ${orders.id} FROM ${orders} WHERE ${orders.tid} IN (${sql.join(values, sql`, `)})`,
    )

    for (const value of maliciousValues) {
      expect(compiled.sql).not.toContain(value)
      expect(compiled.params).toContain(value)
    }
  })
})

describe("drill-down sort allowlist", () => {
  it("keeps existing valid sort fields", () => {
    expect(resolveDrillDownSortColumn("date")).toBe(orders.createdAt)
    expect(resolveDrillDownSortColumn("value")).toBe(orders.totalCents)
    expect(resolveDrillDownSortColumn("VALUE")).toBe(orders.totalCents)
  })

  it.each([
    "createdAt DESC; DROP TABLE orders;",
    ...maliciousValues,
    "totalCents",
    "",
  ])("defaults invalid sort field %s to the created-at column", (value) => {
    expect(resolveDrillDownSortColumn(value)).toBe(orders.createdAt)
  })
})
