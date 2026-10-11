import { describe, expect, it } from "vitest"

import { getTableConfig, PgTable } from "drizzle-orm/pg-core"

import * as schema from "./schema"

/**
 * Structural invariants of the schema, read from Drizzle's own table
 * configuration (which is also what builds each table's indexes, checks and
 * foreign keys from its config callback).
 *
 * These are the mistakes that pass type-checking and only show up as a failed
 * migration or a silently missing constraint in production: a table with no
 * primary key, a foreign key pointing at a table that does not exist, two
 * indexes or constraints sharing a name, an index over a column the table
 * does not have.
 */

const tables = Object.entries(schema).flatMap(([exportName, table]) =>
  table instanceof PgTable ? [{ exportName, config: getTableConfig(table) }] : [],
)

const tableNames = new Set(tables.map((table) => table.config.name))

describe("schema structure", () => {
  it("exports a substantial set of tables", () => {
    expect(tables.length).toBeGreaterThan(40)
  })

  it("gives every table a primary key", () => {
    const missing = tables.filter(({ config }) =>
      config.primaryKeys.length === 0 && !config.columns.some((column) => column.primary),
    ).map(({ config }) => config.name)
    expect(missing).toEqual([])
  })

  it("uses each table name once", () => {
    const names = tables.map(({ config }) => config.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it("points every foreign key at a table that exists, on columns that exist", () => {
    const problems: string[] = []
    for (const { config } of tables) {
      for (const foreignKey of config.foreignKeys) {
        const reference = foreignKey.reference()
        const target = getTableConfig(reference.foreignTable)
        if (!tableNames.has(target.name)) problems.push(`${config.name} -> ${target.name}`)
        if (reference.columns.length !== reference.foreignColumns.length) {
          problems.push(`${config.name}: column count mismatch`)
        }
        for (const column of reference.foreignColumns) {
          if (!target.columns.some((candidate) => candidate.name === column.name)) {
            problems.push(`${config.name} -> ${target.name}.${column.name}`)
          }
        }
      }
    }
    expect(problems).toEqual([])
  })

  it("names every index, unique constraint and check uniquely across the database", () => {
    const seen = new Map<string, string>()
    const duplicates: string[] = []
    for (const { config } of tables) {
      const names = [
        ...config.indexes.map((index) => index.config.name),
        ...config.checks.map((check) => check.name),
        ...config.uniqueConstraints.map((constraint) => constraint.name),
      ].filter((name): name is string => Boolean(name))
      for (const name of names) {
        const owner = seen.get(name)
        if (owner && owner !== config.name) duplicates.push(`${name} (${owner}, ${config.name})`)
        seen.set(name, config.name)
      }
    }
    expect(duplicates).toEqual([])
  })

  it("builds every index over columns the table actually has", () => {
    const problems: string[] = []
    for (const { config } of tables) {
      const columnNames = new Set(config.columns.map((column) => column.name))
      for (const index of config.indexes) {
        for (const column of index.config.columns) {
          const name = (column as { name?: string }).name
          if (name && !columnNames.has(name)) problems.push(`${index.config.name}: ${name}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it("stores money as integers: no column named *_cents is a float or numeric", () => {
    const problems: string[] = []
    for (const { config } of tables) {
      for (const column of config.columns) {
        if (column.name.endsWith("_cents") && !["PgInteger", "PgBigInt53", "PgBigInt64", "PgSerial"].includes(column.columnType)) {
          problems.push(`${config.name}.${column.name}: ${column.columnType}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  it("keeps the tenant key on the core tenant-owned tables", () => {
    const byName = new Map(tables.map(({ config }) => [config.name, config]))
    for (const name of ["branches", "orders", "order_items", "budgets", "branch_inventory", "organization_inventory", "refunds"]) {
      const config = byName.get(name)
      expect(config, name).toBeDefined()
      expect(config!.columns.some((column) => column.name === "organization_id"), name).toBe(true)
    }
  })
})
