#!/usr/bin/env tsx
/**
 * Gives the K-Electric legacy products the category / sub-category they were
 * imported without, and restates the historical receipt snapshots that were
 * frozen with the placeholder "General" in both slots.
 *
 * The KE_LOGISTICS export carried no taxonomy at all, so the importer left
 * `category_id` null on every product it created and `generateReceiptData`
 * fell through to its "General" default when it snapshotted each order. The
 * result is that all 133 uncategorized products in the entire global catalog
 * are K-Electric legacy rows, every one of them reports as "Uncategorized",
 * and 820 invoices print a single "General" group.
 *
 * Two things are written:
 *
 *   global_products   category_id (the sub-category) and a merged
 *                     metadata.parentCategoryId (its parent) — exactly the
 *                     pair `components/global-inventory/product-form.tsx`
 *                     writes when a Super Admin saves a product by hand.
 *
 *   orders.receipt_data
 *                     the frozen `items` tree, regrouped under the real
 *                     category names using the same rules as
 *                     `groupItemsHierarchically` in lib/receipt-generator.ts.
 *
 * The existing taxonomy is leaf-only: every categorized product hangs off a
 * sub-category, never off a top-level parent. Thirteen of its leaves already
 * fit K-Electric stock; the remaining products (45 of them biscuits) have no
 * home, so thirteen new leaves are created under the existing seven parents.
 * No new top-level category is introduced and no existing row is renamed or
 * reparented.
 *
 * Money is never touched. The receipt rewrite re-buckets the existing item
 * objects verbatim — id, description, rate, quantity, tax, total and unit are
 * carried across untouched — and recomputes only the group subtotals, which
 * are asserted to sum back to the value they had before.
 *
 * Scope is pinned three ways: organization 10, a KE_LOGISTICS `legacySource`
 * on the product, and a matching legacy_product_mappings row. A product that
 * has since been categorized by hand drops out of the plan, so the script is
 * safe to re-run.
 *
 * Sixteen of these products also sit in the org 2 and org 6 inventories.
 * global_products is one shared catalog, so those orgs see the same new
 * labels; that is unavoidable, and it replaces "Uncategorized" for them too.
 * Only K-Electric receipts are rewritten.
 *
 * Default mode is a read-only dry run.
 */

import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import * as dotenv from "dotenv"

import { compareCodeUnits } from "../lib/code-unit-order"

dotenv.config({ path: ".env.local", quiet: true })
dotenv.config({ quiet: true })

const KE = { id: 10, code: "0001", name: "K-Electric" } as const
const CONFIRM_ORGANIZATION = `${KE.id}:${KE.code}:${KE.name}`
const LEGACY_SOURCE = "KE_LOGISTICS"
const ADVISORY_LOCK = 700014

/** The seven existing top-level categories, asserted by name before use. */
const PARENTS: Record<number, string> = {
  2: "Beverages",
  11: "Dairy & Alternatives",
  12: "Household & Personal Care",
  13: "Pantry Staples",
  20: "Stationery & Office Supplies",
  23: "Cleaning Supplies",
  25: "Electronics & Accessories",
}

/**
 * Every sub-category this plan assigns to. `existingId` names a leaf already in
 * the taxonomy — asserted, never created. A null `existingId` is a leaf that
 * has to be created because nothing in the tree covers that shelf.
 */
const SUBCATEGORIES: Record<string, { parentId: number; existingId: number | null }> = {
  "Instant Coffee":       { parentId: 2,  existingId: 15 },
  "Tea":                  { parentId: 2,  existingId: 16 },
  "Green Tea":            { parentId: 2,  existingId: 17 },
  "Milk":                 { parentId: 2,  existingId: 22 },
  "Bottled Water":        { parentId: 2,  existingId: 27 },
  "Soft Drinks":          { parentId: 2,  existingId: null },
  "Juices":               { parentId: 2,  existingId: null },
  "Squash & Syrups":      { parentId: 2,  existingId: null },
  "Tissue Papers":        { parentId: 12, existingId: 18 },
  "Hand Wash & Soaps":    { parentId: 12, existingId: null },
  "Oral Care":            { parentId: 12, existingId: null },
  "Sugar":                { parentId: 13, existingId: 19 },
  "Milk & Dairy":         { parentId: 13, existingId: 29 },
  "Biscuits & Snacks":    { parentId: 13, existingId: null },
  "Dry Fruits":           { parentId: 13, existingId: null },
  "Crockery & Cutlery":   { parentId: 20, existingId: null },
  "Office Accessories":   { parentId: 20, existingId: null },
  "Scrub Pads / Sponges": { parentId: 23, existingId: 24 },
  "Cleaning Tools":       { parentId: 23, existingId: null },
  "Cleaning Chemicals":   { parentId: 23, existingId: null },
  "Pest Control":         { parentId: 23, existingId: null },
  "Garbage Bags":         { parentId: 23, existingId: null },
  "Batteries":            { parentId: 25, existingId: 26 },
}

/**
 * The classification, keyed by product id with its product code asserted so a
 * renumbered or substituted catalog aborts rather than being miscategorized.
 * Names are deliberately not asserted: several legacy names embed literal tab
 * characters, which no round-trip through a report survives intact.
 *
 * Where an app-created twin already exists the plan follows it rather than the
 * name alone — "Nestle Everyday / Milac (1 KG)" goes to Milk & Dairy because
 * "Nestle Everyday 1kg" (186) is already filed there, not to Tea Whitener.
 */
const PLAN: Array<[id: number, code: string, subcategory: string]> = [
  [165, "PRD--20",  "Milk"],
  [166, "PRD--21",  "Soft Drinks"],
  [167, "PRD--22",  "Tea"],
  [168, "PRD--23",  "Cleaning Tools"],
  [169, "PRD--24",  "Scrub Pads / Sponges"],
  [170, "PRD--25",  "Cleaning Tools"],
  [171, "PRD--26",  "Pest Control"],
  [172, "PRD--27",  "Cleaning Tools"],
  [173, "PRD--28",  "Cleaning Tools"],
  [174, "PRD--29",  "Cleaning Chemicals"],
  [175, "PRD--30",  "Pest Control"],
  [176, "PRD--31",  "Soft Drinks"],
  [179, "PRD--34",  "Juices"],
  [180, "PRD--35",  "Soft Drinks"],
  [181, "PRD--36",  "Soft Drinks"],
  [182, "PRD--37",  "Sugar"],
  [183, "PRD--38",  "Instant Coffee"],
  [184, "PRD--39",  "Crockery & Cutlery"],
  [185, "PRD--40",  "Crockery & Cutlery"],
  [188, "PRD--43",  "Tea"],
  [189, "PRD--44",  "Milk & Dairy"],
  [190, "PRD--45",  "Instant Coffee"],
  [191, "PRD--46",  "Green Tea"],
  [192, "PRD--47",  "Biscuits & Snacks"],
  [194, "PRD--49",  "Instant Coffee"],
  [195, "PRD--50",  "Tea"],
  [198, "PRD--53",  "Biscuits & Snacks"],
  [199, "PRD--54",  "Biscuits & Snacks"],
  [201, "PRD--56",  "Milk"],
  [202, "PRD--57",  "Tissue Papers"],
  [204, "PRD--59",  "Biscuits & Snacks"],
  [205, "PRD--60",  "Biscuits & Snacks"],
  [206, "PRD--61",  "Green Tea"],
  [207, "PRD--62",  "Oral Care"],
  [209, "PRD--64",  "Tea"],
  [210, "PRD--65",  "Scrub Pads / Sponges"],
  [211, "PRD--66",  "Biscuits & Snacks"],
  [213, "PRD--68",  "Biscuits & Snacks"],
  [214, "PRD--69",  "Scrub Pads / Sponges"],
  [216, "PRD--71",  "Tea"],
  [217, "PRD--72",  "Green Tea"],
  [218, "PRD--73",  "Batteries"],
  [219, "PRD--74",  "Garbage Bags"],
  [220, "PRD--75",  "Cleaning Tools"],
  [221, "PRD--76",  "Crockery & Cutlery"],
  [222, "PRD--77",  "Instant Coffee"],
  [223, "PRD--78",  "Crockery & Cutlery"],
  [224, "PRD--79",  "Instant Coffee"],
  [225, "PRD--80",  "Biscuits & Snacks"],
  [226, "PRD--81",  "Hand Wash & Soaps"],
  [227, "PRD--82",  "Tea"],
  [228, "PRD--83",  "Soft Drinks"],
  [229, "PRD--84",  "Instant Coffee"],
  [230, "PRD--85",  "Tissue Papers"],
  [231, "PRD--86",  "Soft Drinks"],
  [232, "PRD--87",  "Soft Drinks"],
  [233, "PRD--88",  "Office Accessories"],
  [234, "PRD--89",  "Tissue Papers"],
  [235, "PRD--90",  "Tea"],
  [236, "PRD--91",  "Hand Wash & Soaps"],
  [237, "PRD--92",  "Tissue Papers"],
  [239, "PRD--94",  "Tea"],
  [240, "PRD--95",  "Hand Wash & Soaps"],
  [243, "PRD--98",  "Cleaning Chemicals"],
  [244, "PRD--99",  "Soft Drinks"],
  [245, "PRD--100", "Green Tea"],
  [246, "PRD--101", "Pest Control"],
  [247, "PRD--102", "Tea"],
  [248, "PRD--103", "Bottled Water"],
  [249, "PRD--104", "Bottled Water"],
  [250, "PRD--105", "Tea"],
  [251, "PRD--106", "Cleaning Chemicals"],
  [252, "PRD--107", "Instant Coffee"],
  [253, "PRD--108", "Instant Coffee"],
  [254, "PRD--109", "Cleaning Chemicals"],
  [255, "PRD--110", "Dry Fruits"],
  [256, "PRD--111", "Squash & Syrups"],
  [257, "PRD--112", "Squash & Syrups"],
  [258, "PRD--113", "Biscuits & Snacks"],
  [259, "PRD--114", "Instant Coffee"],
  [260, "PRD--115", "Biscuits & Snacks"],
  [261, "PRD--116", "Garbage Bags"],
  [262, "PRD--117", "Tissue Papers"],
  [263, "PRD--118", "Tissue Papers"],
  [264, "PRD--119", "Biscuits & Snacks"],
  [265, "PRD--120", "Instant Coffee"],
  [266, "PRD--121", "Instant Coffee"],
  [267, "PRD--122", "Biscuits & Snacks"],
  [268, "PRD--123", "Instant Coffee"],
  [269, "PRD--124", "Biscuits & Snacks"],
  [270, "PRD--125", "Biscuits & Snacks"],
  [271, "PRD--126", "Biscuits & Snacks"],
  [272, "PRD--127", "Biscuits & Snacks"],
  [273, "PRD--128", "Biscuits & Snacks"],
  [274, "PRD--129", "Biscuits & Snacks"],
  [275, "PRD--130", "Biscuits & Snacks"],
  [276, "PRD--131", "Biscuits & Snacks"],
  [277, "PRD--132", "Biscuits & Snacks"],
  [278, "PRD--133", "Biscuits & Snacks"],
  [279, "PRD--134", "Biscuits & Snacks"],
  [280, "PRD--135", "Biscuits & Snacks"],
  [281, "PRD--136", "Biscuits & Snacks"],
  [282, "PRD--137", "Biscuits & Snacks"],
  [283, "PRD--138", "Biscuits & Snacks"],
  [284, "PRD--139", "Biscuits & Snacks"],
  [285, "PRD--140", "Biscuits & Snacks"],
  [286, "PRD--141", "Biscuits & Snacks"],
  [287, "PRD--142", "Biscuits & Snacks"],
  [288, "PRD--143", "Biscuits & Snacks"],
  [289, "PRD--144", "Biscuits & Snacks"],
  [290, "PRD--145", "Biscuits & Snacks"],
  [291, "PRD--146", "Biscuits & Snacks"],
  [292, "PRD--147", "Biscuits & Snacks"],
  [293, "PRD--148", "Biscuits & Snacks"],
  [294, "PRD--149", "Biscuits & Snacks"],
  [295, "PRD--150", "Biscuits & Snacks"],
  [296, "PRD--151", "Biscuits & Snacks"],
  [297, "PRD--152", "Biscuits & Snacks"],
  [298, "PRD--153", "Biscuits & Snacks"],
  [299, "PRD--154", "Biscuits & Snacks"],
  [300, "PRD--155", "Biscuits & Snacks"],
  [301, "PRD--156", "Biscuits & Snacks"],
  [302, "PRD--157", "Biscuits & Snacks"],
  [303, "PRD--158", "Biscuits & Snacks"],
  [304, "PRD--159", "Biscuits & Snacks"],
  [305, "PRD--160", "Biscuits & Snacks"],
  [306, "PRD--161", "Biscuits & Snacks"],
  [307, "PRD--162", "Biscuits & Snacks"],
  [308, "PRD--163", "Biscuits & Snacks"],
  [315, "PRD--167", "Tea"],
  [323, "PRD--175", "Oral Care"],
  [325, "PRD--176", "Milk"],
]

/**
 * Deliberately left uncategorized. A scratch row from the legacy portal that
 * was never ordered — it belongs on no shelf, and inventing one for it would
 * put a "TEST 1" line into the category reports.
 */
const SKIPPED: Array<[id: number, code: string, reason: string]> = [
  [193, "PRD--48", "test record, never ordered (0 order lines)"],
]

interface ProductRow {
  id: number
  productCode: string
  name: string
  status: string
  categoryId: number | null
  metadata: Record<string, unknown> | null
}

interface ReceiptItem { id: number; total: number; [key: string]: unknown }

/** Every KE legacy product still lacking a category. */
const TARGET_QUERY = `
  select
    gp.id,
    gp.product_code as "productCode",
    gp.name,
    gp.status,
    gp.category_id as "categoryId",
    gp.metadata
  from global_products gp
  where gp.category_id is null
    and gp.metadata->>'legacySource' = $2
    and exists (
      select 1 from legacy_product_mappings lpm
      where lpm.global_product_id = gp.id
        and lpm.organization_id = $1
        and lpm.source_system = $2
    )
  order by gp.id
`

/** Uncategorized products outside KE tenancy. Expected empty; never touched. */
const OUT_OF_SCOPE_QUERY = `
  select gp.id, gp.product_code as "productCode", gp.name
  from global_products gp
  where gp.category_id is null
    and not (
      gp.metadata->>'legacySource' = $2
      and exists (
        select 1 from legacy_product_mappings lpm
        where lpm.global_product_id = gp.id
          and lpm.organization_id = $1
          and lpm.source_system = $2
      )
    )
  order by gp.id
`

const RECEIPT_QUERY = `
  select o.id, o.tid, o.receipt_data as "receiptData"
  from orders o
  where o.organization_id = $1
    and o.receipt_data is not null
  order by o.id
`

function arg(name: string): string | undefined {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/** Money equality on the receipt's two-decimal rupee figures. */
function sameMoney(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100
}

/**
 * Flattens either receipt shape into its item list. K-Electric carries both:
 * 798 orders use the current nested `subCategories` tree, and 22 older ones use
 * the flat `{ categoryName, items, subtotal }` form that the `ReceiptData` type
 * in db/schema.ts still describes. Both are rebuilt into the nested shape that
 * lib/receipt-generator.ts produces today and components/receipts renders.
 */
function flattenReceiptItems(items: unknown): ReceiptItem[] {
  if (!Array.isArray(items)) return []
  const flat: ReceiptItem[] = []
  for (const group of items as Array<Record<string, unknown>>) {
    if (Array.isArray(group.subCategories)) {
      for (const sub of group.subCategories as Array<Record<string, unknown>>) {
        for (const item of (sub.items as ReceiptItem[]) ?? []) flat.push(item)
      }
    } else if (Array.isArray(group.items)) {
      for (const item of group.items as ReceiptItem[]) flat.push(item)
    }
  }
  return flat
}

/**
 * Regroups items under real category names, mirroring `groupItemsHierarchically`
 * in lib/receipt-generator.ts: parented categories give main = parent name and
 * sub = leaf name, anything unresolved keeps the "General" / "General" default,
 * sub-categories sort by name inside a group, groups sort by name.
 *
 * Item objects are passed through untouched — this only changes which bucket
 * each one sits in and what the buckets are called.
 */
function regroup(
  flat: ReceiptItem[],
  labels: Map<number, { main: string; sub: string }>,
): Array<Record<string, unknown>> {
  const groups = new Map<string, Map<string, ReceiptItem[]>>()
  for (const item of flat) {
    const label = labels.get(Number(item.id)) ?? { main: "General", sub: "General" }
    if (!groups.has(label.main)) groups.set(label.main, new Map())
    const subs = groups.get(label.main)!
    if (!subs.has(label.sub)) subs.set(label.sub, [])
    subs.get(label.sub)!.push(item)
  }

  const result: Array<Record<string, unknown>> = []
  groups.forEach((subs, mainName) => {
    const subCategories: Array<Record<string, unknown>> = []
    let total = 0
    subs.forEach((items, subName) => {
      const subtotal = round2(items.reduce((sum, item) => sum + Number(item.total ?? 0), 0))
      subCategories.push({ subCategoryName: subName, items, subtotal })
      total += subtotal
    })
    result.push({
      mainCategoryName: mainName,
      subCategories: subCategories.toSorted((a, b) =>
        String(a.subCategoryName).localeCompare(String(b.subCategoryName))),
      total: round2(total),
    })
  })
  return result.sort((a, b) =>
    String(a.mainCategoryName).localeCompare(String(b.mainCategoryName)))
}

/**
 * The main / sub label for every categorized product, read from the live tree
 * so products categorized outside this plan are honoured too, with the plan's
 * own assignments overlaid. Both the dry run and the commit build their labels
 * this way, so the preview counts are the ones the commit will produce.
 */
async function loadLabels(
  client: { query: (text: string) => Promise<{ rows: Array<Record<string, unknown>> }> },
  overlay: Array<[id: number, code: string, subcategory: string]>,
): Promise<Map<number, { main: string; sub: string }>> {
  const rows = (await client.query(`
    select gp.id, coalesce(parent.name, cat.name) as main,
           case when parent.id is not null then cat.name else 'General' end as sub
    from global_products gp
    join categories cat on cat.id = gp.category_id
    left join categories parent on parent.id = cat.parent_id
  `)).rows
  const labels = new Map<number, { main: string; sub: string }>(
    rows.map((row) => [Number(row.id), { main: String(row.main), sub: String(row.sub) }]))
  for (const [id, , sub] of overlay) {
    labels.set(id, { main: PARENTS[SUBCATEGORIES[sub].parentId], sub })
  }
  return labels
}

function planDigest(rows: ProductRow[]): string {
  const canonical = rows.map((row) => {
    const assignment = PLAN.find(([id]) => id === row.id)
    const skip = SKIPPED.find(([id]) => id === row.id)
    return [row.id, row.productCode, row.status, assignment?.[2] ?? `SKIP:${skip?.[2] ?? "unplanned"}`].join("|")
  })
  return createHash("sha256").update(canonical.join("\n")).digest("hex")
}

function reportPath(commit: boolean): string {
  const requested = arg("--output")
  if (requested) return resolve(requested)
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  return resolve(commit
    ? `backups/ke-legacy-categorization-commit-${stamp}.json`
    : "deliverables/ke-legacy-categorization-preflight.json")
}

function saveReport(path: string, value: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8")
}

async function main() {
  const commit = process.argv.includes("--commit")
  const output = reportPath(commit)
  const { pool } = await import("../lib/db-cli")
  const client = await pool.connect()

  try {
    const organization = (await client.query(
      "select id, code, name from organizations where id = $1", [KE.id])).rows[0]
    assert(
      organization?.id === KE.id && organization.code === KE.code && organization.name === KE.name,
      "K-Electric organization identity mismatch",
    )

    // The parents the new leaves hang off must be the ones this plan was
    // written against, by name, or a renamed tree would be silently extended.
    const parentRows = (await client.query(
      "select id, name, parent_id as \"parentId\" from categories where id = any($1::int[])",
      [Object.keys(PARENTS).map(Number)])).rows
    for (const [id, name] of Object.entries(PARENTS)) {
      const row = parentRows.find((candidate) => candidate.id === Number(id))
      assert(row?.name === name, `Category ${id} is not "${name}"`)
      assert(row.parentId === null, `Category ${id} ("${name}") is not top-level`)
    }

    // Likewise every leaf the plan reuses rather than creates.
    const existingLeafIds = Object.values(SUBCATEGORIES)
      .map((entry) => entry.existingId).filter((id): id is number => id !== null)
    const leafRows = (await client.query(
      "select id, name, parent_id as \"parentId\" from categories where id = any($1::int[])",
      [existingLeafIds])).rows
    for (const [name, entry] of Object.entries(SUBCATEGORIES)) {
      if (entry.existingId === null) continue
      const row = leafRows.find((candidate) => candidate.id === entry.existingId)
      assert(row?.name === name, `Sub-category ${entry.existingId} is not "${name}"`)
      assert(row.parentId === entry.parentId, `"${name}" is not under ${PARENTS[entry.parentId]}`)
    }

    for (const [, , subcategory] of PLAN) {
      assert(SUBCATEGORIES[subcategory], `Plan references unknown sub-category "${subcategory}"`)
    }

    const targets = (await client.query<ProductRow>(TARGET_QUERY, [KE.id, LEGACY_SOURCE])).rows
    const outOfScope = (await client.query(OUT_OF_SCOPE_QUERY, [KE.id, LEGACY_SOURCE])).rows

    // Products categorized by hand since the plan was written simply drop out.
    const planned = PLAN.filter(([id]) => targets.some((row) => row.id === id))
    const skipped = SKIPPED.filter(([id]) => targets.some((row) => row.id === id))
    const unplanned = targets.filter((row) =>
      !PLAN.some(([id]) => id === row.id) && !SKIPPED.some(([id]) => id === row.id))
    assert(
      unplanned.length === 0,
      `Uncategorized KE products missing from the plan: ${unplanned.map((r) => `${r.id} (${r.productCode}) ${r.name}`).join("; ")}`,
    )
    for (const [id, code] of [...planned, ...skipped]) {
      const row = targets.find((candidate) => candidate.id === id)!
      assert(row.productCode === code, `Product ${id} is ${row.productCode}, expected ${code}`)
    }

    const digest = planDigest(targets)
    const newLeaves = [...new Set(planned.map(([, , sub]) => sub))]
      .filter((name) => SUBCATEGORIES[name].existingId === null)
      .sort(compareCodeUnits)

    const bySubcategory = [...new Set(planned.map(([, , sub]) => sub))].sort(compareCodeUnits).map((sub) => ({
      parent: PARENTS[SUBCATEGORIES[sub].parentId],
      subcategory: sub,
      isNew: SUBCATEGORIES[sub].existingId === null,
      products: planned.filter(([, , candidate]) => candidate === sub).length,
    }))

    const assignments = planned.map(([id, code, sub]) => ({
      id,
      productCode: code,
      name: targets.find((row) => row.id === id)!.name,
      parentCategory: PARENTS[SUBCATEGORIES[sub].parentId],
      subCategory: sub,
    }))

    const summary = {
      organizationId: KE.id,
      uncategorizedKeProducts: targets.length,
      productsCategorized: planned.length,
      productsIntentionallySkipped: skipped.length,
      newSubCategories: newLeaves.length,
      reusedSubCategories: bySubcategory.filter((row) => !row.isNew).length,
      uncategorizedOutsideKeTenancy: outOfScope.length,
      bySubcategory,
    }

    const baseReport: Record<string, unknown> = {
      kind: "KE_LEGACY_PRODUCT_CATEGORIZATION",
      mode: commit ? "COMMIT_REQUESTED" : "DRY_RUN",
      generatedAt: new Date().toISOString(),
      organization,
      policy: {
        scope: "K-Electric legacy products (organization 10 + KE_LOGISTICS) with no category, and the KE receipt snapshots that print them",
        productChange: "set category_id to the sub-category and merge metadata.parentCategoryId — the same pair the Super Admin product form writes",
        receiptChange: "regroup the existing receipt_data items under the real category names, using the grouping rules in lib/receipt-generator.ts",
        moneyUntouched: "item id, description, rate, quantity, tax, total and unit are carried across verbatim; only group subtotals are recomputed, and asserted to sum to their previous value",
        taxonomy: "thirteen new leaves under the seven existing parents; no new top-level category, no rename, no reparent",
        sharedCatalog: "sixteen of these products also sit in org 2 and org 6 inventories and will show the same labels there; only KE receipts are rewritten",
        outOfScope: "any uncategorized product outside K-Electric tenancy is reported but never modified",
      },
      summary,
      newSubCategories: newLeaves.map((name) => ({ name, parent: PARENTS[SUBCATEGORIES[name].parentId] })),
      assignments,
      skipped: skipped.map(([id, code, reason]) => ({
        id, productCode: code, name: targets.find((row) => row.id === id)!.name, reason,
      })),
      uncategorizedOutsideKeTenancy: outOfScope,
      planSha256: digest,
      requiredCommitArguments: {
        confirmOrganization: CONFIRM_ORGANIZATION,
        confirmPlanSha256: digest,
        expectedProducts: planned.length,
      },
    }

    if (!commit) {
      // Preview the receipt rewrite without writing, so the dry run reports the
      // real order and money numbers rather than a promise about them.
      const labels = await loadLabels(client, planned)
      const receipts = (await client.query(RECEIPT_QUERY, [KE.id])).rows
      let wouldChange = 0
      let stillGeneral = 0
      for (const row of receipts) {
        const flat = flattenReceiptItems(row.receiptData?.items)
        const before = round2(flat.reduce((sum, item) => sum + Number(item.total ?? 0), 0))
        const after = regroup(flat, labels)
        const afterTotal = round2(after.reduce((sum, group) => sum + Number(group.total ?? 0), 0))
        assert(sameMoney(before, afterTotal), `Receipt total would move on order ${row.id}`)
        if (JSON.stringify(after) !== JSON.stringify(row.receiptData?.items)) wouldChange += 1
        if (after.some((group) => group.mainCategoryName === "General")) stillGeneral += 1
      }
      const receiptPreview = {
        ordersInspected: receipts.length,
        ordersRewritten: wouldChange,
        ordersStillCarryingGeneral: stillGeneral,
      }
      saveReport(output, { ...baseReport, receiptPreview })
      console.log(JSON.stringify({
        mode: "DRY_RUN",
        output,
        summary,
        newSubCategories: baseReport.newSubCategories,
        receiptPreview,
        planSha256: digest,
        requiredCommitArguments: baseReport.requiredCommitArguments,
      }, null, 2))
      return
    }

    assert(planned.length > 0, "No uncategorized K-Electric product remains; nothing to categorize")
    assert(arg("--confirm-organization") === CONFIRM_ORGANIZATION, `--confirm-organization must equal ${CONFIRM_ORGANIZATION}`)
    assert(arg("--confirm-plan-sha256") === digest, "--confirm-plan-sha256 does not match")
    const expectedProducts = Number(arg("--expected-products"))
    assert(
      Number.isSafeInteger(expectedProducts) && expectedProducts === planned.length,
      `--expected-products must equal ${planned.length}`,
    )

    await client.query("begin")
    try {
      await client.query("select pg_advisory_xact_lock($1)", [ADVISORY_LOCK])
      const lockedTargets = (await client.query<ProductRow>(TARGET_QUERY, [KE.id, LEGACY_SOURCE])).rows
      assert(planDigest(lockedTargets) === digest, "Product state changed after preflight; aborting")

      // 1. Create the missing leaves. Matched on name + parent so a re-run or a
      //    concurrently created leaf is adopted rather than duplicated.
      const leafIds = new Map<string, number>()
      for (const [name, entry] of Object.entries(SUBCATEGORIES)) {
        if (entry.existingId !== null) { leafIds.set(name, entry.existingId); continue }
        if (!newLeaves.includes(name)) continue
        const existing = await client.query(
          "select id from categories where name = $1 and parent_id = $2", [name, entry.parentId])
        if (existing.rows.length > 0) { leafIds.set(name, existing.rows[0].id); continue }
        const inserted = await client.query(
          "insert into categories (organization_id, name, parent_id) values (null, $1, $2) returning id",
          [name, entry.parentId])
        leafIds.set(name, inserted.rows[0].id)
      }

      // 2. Categorize the products. The category_id = null guard makes the
      //    update a no-op if anyone categorized the row concurrently.
      for (const [id, code, sub] of planned) {
        const categoryId = leafIds.get(sub)!
        const updated = await client.query(`
          update global_products
          set category_id = $2,
              metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('parentCategoryId', $3::int),
              updated_at = now()
          where id = $1
            and product_code = $4
            and category_id is null
            and metadata->>'legacySource' = $5
          returning id, category_id as "categoryId", metadata
        `, [id, categoryId, SUBCATEGORIES[sub].parentId, code, LEGACY_SOURCE])
        assert(updated.rows.length === 1, `Concurrent change detected for product ${id}`)
        assert(updated.rows[0].categoryId === categoryId, `Category not applied to product ${id}`)
        const metadata = updated.rows[0].metadata as Record<string, unknown>
        assert(
          metadata.parentCategoryId === SUBCATEGORIES[sub].parentId,
          `parentCategoryId not applied to product ${id}`,
        )
        assert(metadata.legacySource === LEGACY_SOURCE, `legacySource lost on product ${id}`)
      }

      // 3. Restate the receipt snapshots. Reading the tree back after step 2
      //    means no overlay is needed — the plan is already committed to it.
      const labels = await loadLabels(client, [])

      const receipts = (await client.query(RECEIPT_QUERY, [KE.id])).rows
      let receiptsRewritten = 0
      let shapeConverted = 0
      for (const row of receipts) {
        const original = row.receiptData?.items
        const flat = flattenReceiptItems(original)
        if (flat.length === 0) continue
        const beforeTotal = round2(flat.reduce((sum, item) => sum + Number(item.total ?? 0), 0))
        const wasFlatShape = Array.isArray(original)
          && original.some((group: Record<string, unknown>) => !Array.isArray(group.subCategories))
        const rebuilt = regroup(flat, labels)

        // Nothing may be dropped, duplicated or repriced by the re-bucketing.
        const afterFlat = flattenReceiptItems(rebuilt)
        assert(afterFlat.length === flat.length, `Item count moved on order ${row.id}`)
        const afterTotal = round2(afterFlat.reduce((sum, item) => sum + Number(item.total ?? 0), 0))
        assert(sameMoney(beforeTotal, afterTotal), `Receipt total moved on order ${row.id}`)
        const groupTotal = round2(rebuilt.reduce((sum, group) => sum + Number(group.total ?? 0), 0))
        assert(sameMoney(beforeTotal, groupTotal), `Group totals do not reconcile on order ${row.id}`)

        if (JSON.stringify(rebuilt) === JSON.stringify(original)) continue
        const updated = await client.query(`
          update orders
          set receipt_data = jsonb_set(receipt_data, '{items}', $2::jsonb, true)
          where id = $1 and organization_id = $3
          returning id
        `, [row.id, JSON.stringify(rebuilt), KE.id])
        assert(updated.rows.length === 1, `Receipt update missed order ${row.id}`)
        receiptsRewritten += 1
        if (wasFlatShape) shapeConverted += 1
      }

      const audit = await client.query(`
        insert into audit_logs (user_id, organization_id, branch_id, action, entity, entity_id, metadata)
        values (null, $1, null, 'KE_LEGACY_PRODUCT_CATEGORIZATION', 'global_products', $2, $3::jsonb)
        returning id
      `, [KE.id, digest.slice(0, 128), JSON.stringify({
        planSha256: digest,
        productsCategorized: planned.length,
        productIds: planned.map(([id]) => id),
        skippedProductIds: skipped.map(([id]) => id),
        subCategoriesCreated: newLeaves.map((name) => ({ name, id: leafIds.get(name), parentId: SUBCATEGORIES[name].parentId })),
        receiptsRewritten,
        receiptShapeConverted: shapeConverted,
        pricesModified: 0,
        statusesModified: 0,
      })])
      await client.query("commit")

      // Post-commit verification on a fresh read.
      const remaining = (await client.query<ProductRow>(TARGET_QUERY, [KE.id, LEGACY_SOURCE])).rows
      assert(
        remaining.length === skipped.length,
        `${remaining.length} KE products remain uncategorized, expected ${skipped.length}`,
      )
      const generalLeft = (await client.query(`
        select count(*)::int as count from orders o
        where o.organization_id = $1
          and exists (
            select 1 from jsonb_array_elements(o.receipt_data->'items') g
            where g->>'mainCategoryName' = 'General' or g->>'categoryName' = 'General')
      `, [KE.id])).rows[0].count
      const moneyCheck = (await client.query(`
        select count(*)::int as count from orders o
        where o.organization_id = $1
          and abs((
            select coalesce(sum((g->>'total')::numeric), 0)
            from jsonb_array_elements(o.receipt_data->'items') g
          ) - (o.receipt_data->>'subtotal')::numeric) > 0.005
      `, [KE.id])).rows[0].count

      const commitReport = {
        ...baseReport,
        mode: "COMMITTED",
        committedAt: new Date().toISOString(),
        auditLogId: audit.rows[0].id,
        subCategoriesCreated: newLeaves.map((name) => ({ name, id: leafIds.get(name), parent: PARENTS[SUBCATEGORIES[name].parentId] })),
        validation: {
          keProductsStillUncategorized: remaining.length,
          intentionallySkipped: skipped.length,
          receiptsRewritten,
          receiptShapeConverted: shapeConverted,
          receiptsStillCarryingGeneral: generalLeft,
          receiptsWhoseGroupTotalsMissSubtotal: moneyCheck,
        },
      }
      saveReport(output, commitReport)
      console.log(JSON.stringify({
        mode: "COMMITTED",
        output,
        summary,
        auditLogId: audit.rows[0].id,
        subCategoriesCreated: commitReport.subCategoriesCreated,
        validation: commitReport.validation,
      }, null, 2))
    } catch (error) {
      await client.query("rollback")
      throw error
    }
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
