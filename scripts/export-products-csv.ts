#!/usr/bin/env tsx
/**
 * Export the product catalogue to CSV, one file per table, plus a machine
 * readable description of the schema those files were written from.
 *
 * Read-only: every statement is a SELECT and the connection is opened in a
 * read-only transaction, so this is safe to point at production.
 *
 * Usage:
 *   npm run export:products-csv
 *   npm run export:products-csv -- --output=deliverables/products-csv
 *   npm run export:products-csv -- --organization-id=10
 *
 * `--organization-id` narrows the tenant-scoped tables (organization and
 * branch tiers, group prices). `global_products` is platform-wide and is
 * always exported whole.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"

import type { PoolClient } from "pg"

import { closePool, pool } from "../lib/db-cli"
import { createCsv } from "../lib/spreadsheet"

const DEFAULT_OUTPUT_DIRECTORY = "deliverables/products-csv"

/**
 * The tables that make up the catalogue, in ladder order: the global product,
 * the organization tier that may override it, the branch tier that publishes
 * it, and the group tier that prices it.
 */
const CATALOGUE_TABLES = [
  "global_products",
  "categories",
  "organization_inventory",
  "branch_inventory",
  "group_inventory_prices",
  "organization_products",
  "branch_products",
  "products",
  "skus",
] as const

type CatalogueTable = (typeof CATALOGUE_TABLES)[number]

type Export = {
  file: string
  headers: string[]
  rows: unknown[][]
}

function argument(name: string): string | undefined {
  const flag = `--${name}=`
  const inline = process.argv.find((value) => value.startsWith(flag))
  return inline ? inline.slice(flag.length) : undefined
}

function parseOrganizationId(): number | null {
  const raw = argument("organization-id")
  if (raw === undefined) return null
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`--organization-id must be a positive integer, received "${raw}".`)
  }
  return parsed
}

/** Postgres hands back jsonb as an object and timestamps as Date. Flatten both. */
function csvValue(value: unknown): string | number | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "object") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "string") return value
  if (typeof value === "boolean") return value ? "true" : "false"
  return String(value)
}

async function runExport(
  client: PoolClient,
  file: string,
  text: string,
  values: unknown[] = [],
): Promise<Export> {
  const result = await client.query({ text, values, rowMode: "array" })
  return {
    file,
    headers: result.fields.map((field) => field.name),
    rows: result.rows.map((row: unknown[]) => row.map(csvValue)),
  }
}

/**
 * `information_schema` describes the tables as they actually stand in this
 * database, so the schema file always matches the data files beside it.
 */
async function exportSchema(client: PoolClient): Promise<Export> {
  return runExport(
    client,
    "schema-columns.csv",
    `SELECT c.table_name,
            c.ordinal_position,
            c.column_name,
            c.data_type,
            c.character_maximum_length,
            c.numeric_precision,
            c.numeric_scale,
            c.is_nullable,
            c.column_default
       FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = ANY($1::text[])
      ORDER BY c.table_name, c.ordinal_position`,
    [CATALOGUE_TABLES],
  )
}

/**
 * The catalogue as a person reads it: every global product with its category
 * name and its price in both cents and major units. The raw table dump beside
 * it stays authoritative for anything machine-consumed.
 */
async function exportCatalogueView(client: PoolClient): Promise<Export> {
  return runExport(
    client,
    "catalogue.csv",
    `SELECT gp.id AS global_product_id,
            gp.product_code,
            gp.name,
            gp.description,
            gp.category_id,
            cat.name AS category_name,
            gp.unit,
            gp.status,
            gp.base_price_cents,
            ROUND(gp.base_price_cents / 100.0, 2) AS base_price,
            gp.tax_rate_bp,
            gp.discount_type,
            gp.discount_value_cents,
            gp.discount_active,
            gp.discount_start_at,
            gp.discount_end_at,
            gp.stock_quantity,
            gp.allow_decimal_quantity,
            gp.quantity_step,
            gp.image_url,
            gp.metadata,
            gp.created_at,
            gp.updated_at,
            gp.last_synced_at,
            gp.deleted_at,
            (SELECT count(*) FROM organization_inventory oi
              WHERE oi.global_product_id = gp.id AND oi.deleted_at IS NULL) AS organizations_assigned,
            (SELECT count(*) FROM branch_inventory bi
               JOIN organization_inventory oi2 ON oi2.id = bi.organization_inventory_id
              WHERE oi2.global_product_id = gp.id AND bi.deleted_at IS NULL) AS branches_assigned
       FROM global_products gp
       LEFT JOIN categories cat ON cat.id = gp.category_id
      ORDER BY gp.id`,
  )
}

/** Every column of one catalogue table, optionally narrowed to a tenant. */
async function exportTable(
  client: PoolClient,
  table: CatalogueTable,
  organizationId: number | null,
): Promise<Export> {
  // `table` comes from CATALOGUE_TABLES, never from input, so it is safe to
  // inline. The tenant filter is a bound parameter.
  const scoped = organizationId !== null && table !== "global_products"
  const text = scoped
    ? `SELECT * FROM ${table} WHERE organization_id = $1 ORDER BY id`
    : `SELECT * FROM ${table} ORDER BY id`
  return runExport(client, `${table}.csv`, text, scoped ? [organizationId] : [])
}

async function main(): Promise<void> {
  const organizationId = parseOrganizationId()
  const outputDirectory = resolve(
    process.cwd(),
    argument("output") || DEFAULT_OUTPUT_DIRECTORY,
  )
  mkdirSync(outputDirectory, { recursive: true })

  const client = await pool.connect()
  const exports: Export[] = []
  try {
    await client.query("BEGIN TRANSACTION READ ONLY")
    exports.push(await exportSchema(client))
    exports.push(await exportCatalogueView(client))
    for (const table of CATALOGUE_TABLES) {
      exports.push(await exportTable(client, table, organizationId))
    }
    await client.query("COMMIT")
  } finally {
    client.release()
  }

  console.log(`Output: ${outputDirectory}`)
  if (organizationId !== null) {
    console.log(`Tenant-scoped tables filtered to organization ${organizationId}.`)
  }
  for (const item of exports) {
    writeFileSync(
      resolve(outputDirectory, item.file),
      createCsv(item.headers, item.rows),
      { encoding: "utf8", mode: 0o600 },
    )
    console.log(`  ${item.file.padEnd(30)} ${String(item.rows.length).padStart(7)} rows`)
  }
  console.log("\nThese files hold live catalogue data. Do not commit them.")
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => closePool())
