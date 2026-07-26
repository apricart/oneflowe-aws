#!/usr/bin/env tsx
/**
 * Import branches from CSV for a specific organization.
 *
 * Usage:
 *   npx tsx scripts/import-branches-csv.ts                 → dry run (no DB writes)
 *   npx tsx scripts/import-branches-csv.ts --insert        → actually insert
 *
 * Hard-coded target: K-Electric (organizationId = 1)
 *
 * The CSV has unquoted commas inside address fields, so we reconstruct
 * the address by scanning forward from col[1] until we hit a phone number,
 * email address, or time value — those mark the end of the address field.
 */

import { readFileSync, statSync } from "fs"
import { resolve } from "path"
import * as dotenv from "dotenv"

dotenv.config({ path: ".env.local" })
dotenv.config()

// ─── Config ────────────────────────────────────────────────────────────────

const CSV_PATH = resolve("Branch List(2).csv")
const ORG_ID = 10 // K-Electric (id=10, code='0001')
const DRY_RUN = !process.argv.includes("--insert")

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Returns true if this column value looks like a phone number. */
function isPhone(val: string): boolean {
  const v = val.trim()
  if (!v || v === "-") return false
  // Must have no letters — phone numbers only contain digits, spaces, dashes, +, /
  if (/[a-zA-Z]/.test(v)) return false
  const digits = v.replace(/[^\d]/g, "")
  return digits.length >= 7
}

/** Returns true if this column value is a signal that the address has ended. */
function isAddressEnd(val: string): boolean {
  const v = val.trim()
  if (!v) return false
  if (v.includes("@")) return true           // email
  if (/^\d{1,2}:\d{2}/.test(v)) return true // time  e.g. "5:00:00"
  if (isPhone(v)) return true                // phone number
  return false
}

/** Returns true if col[0] looks like a real branch name (not a corrupt/overflow row). */
function isValidName(name: string): boolean {
  const n = (name ?? "").trim()
  if (n.length < 2) return false
  if (/^\d/.test(n)) return false                  // starts with digit → address spill
  if (/^cell\b/i.test(n)) return false             // "Cell # 03362199647"
  if (/^location\s/i.test(n)) return false         // "Location Qayumabad..."
  if (n.includes("@")) return false                // email in name column
  return true
}

// ─── Parse CSV ─────────────────────────────────────────────────────────────

if (statSync(CSV_PATH).size > 2 * 1024 * 1024) {
  throw new Error("Branch CSV exceeds the 2MB limit.")
}
const raw = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(CSV_PATH))
const lines = raw.split(/\r?\n/)
if (lines.length > 5001) throw new Error("Branch CSV exceeds the 5,000-row limit.")

interface BranchRow {
  name: string
  address: string
  sourceLineNo: number
}

const extracted: BranchRow[] = []
const skipped: { lineNo: number; raw: string; reason: string }[] = []

for (let i = 1; i < lines.length; i++) {
  const line = lines[i].trim()
  if (!line) continue

  const cols = line.split(",")
  const rawName = (cols[0] ?? "").trim()

  if (!isValidName(rawName)) {
    if (rawName) {
      skipped.push({ lineNo: i + 1, raw: rawName, reason: "name looks like overflow/corrupt row" })
    }
    continue
  }

  // Reconstruct address: scan col[1]+ until we hit a stop signal
  const addressParts: string[] = []
  for (let c = 1; c < cols.length; c++) {
    const v = cols[c].trim()
    if (isAddressEnd(v)) break
    if (v.length > 1) addressParts.push(v) // skip single-char junk like "-"
  }

  extracted.push({
    name: rawName,
    address: addressParts.join(", ").trim(),
    sourceLineNo: i + 1,
  })
}

// ─── Deduplicate within CSV (case-insensitive, keep first occurrence) ──────

const seenNames = new Set<string>()
const deduped: BranchRow[] = []
const csvDuplicates: { lineNo: number; name: string; keepLine: number }[] = []

for (const branch of extracted) {
  const key = branch.name.toLowerCase().trim()
  if (seenNames.has(key)) {
    const keepLine = deduped.find(b => b.name.toLowerCase().trim() === key)!.sourceLineNo
    csvDuplicates.push({ lineNo: branch.sourceLineNo, name: branch.name, keepLine })
  } else {
    seenNames.add(key)
    deduped.push(branch)
  }
}

// ─── Report ────────────────────────────────────────────────────────────────

console.log("\n════════════════════════════════════════════════════════════")
console.log(`  Branch CSV Import  —  ${DRY_RUN ? "DRY RUN (no DB writes)" : "⚠  LIVE INSERT"}`)
console.log("════════════════════════════════════════════════════════════")
console.log(`  File   : ${CSV_PATH}`)
console.log(`  Org ID : ${ORG_ID}  (K-Electric)`)
console.log(`  Valid  : ${deduped.length} branches (after dedup)`)
console.log(`  CSV duplicates removed: ${csvDuplicates.length}`)
console.log(`  Corrupt rows skipped  : ${skipped.length}`)
console.log("────────────────────────────────────────────────────────────\n")

console.log("BRANCHES TO IMPORT:")
deduped.forEach((b, idx) => {
  console.log(`  ${String(idx + 1).padStart(3, " ")}. [L${b.sourceLineNo}] ${b.name}`)
  if (b.address) console.log(`       Address: ${b.address}`)
})

if (csvDuplicates.length) {
  console.log("\nCSV DUPLICATES (skipped — first occurrence kept):")
  csvDuplicates.forEach((d) => {
    console.log(`  Line ${d.lineNo}: "${d.name}" → duplicate of line ${d.keepLine}`)
  })
}

if (skipped.length) {
  console.log("\nCORRUPT ROWS SKIPPED:")
  skipped.forEach((s) => {
    console.log(`  Line ${s.lineNo}: "${s.raw}" → ${s.reason}`)
  })
}

if (DRY_RUN) {
  console.log("\n────────────────────────────────────────────────────────────")
  console.log("  DRY RUN complete — nothing was written to the database.")
  console.log("  To perform the actual insert run:")
  console.log("    npx tsx scripts/import-branches-csv.ts --insert")
  console.log("────────────────────────────────────────────────────────────\n")
  process.exit(0)
}

// ─── Live insert (dynamic imports so dry-run never touches the DB) ─────────

async function runInsert() {
  const { db } = await import("../lib/db-cli")
  const { branches: branchesTable, organizations } = await import("../db/schema")
  const { eq, and, sql } = await import("drizzle-orm")
  let inserted = 0
  let skippedDuplicate = 0

  await db.transaction(async (tx) => {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('oneflowe:branch-import'))`)
  // Verify the organisation exists
  const [org] = await tx
    .select({ id: organizations.id, name: organizations.name, code: organizations.code })
    .from(organizations)
    .where(eq(organizations.id, ORG_ID))
    .limit(1)

  if (!org) {
    console.error(`\n❌  Organization ID ${ORG_ID} not found in database.`)
    process.exit(1)
  }

  console.log(`\n✅  Found org: ${org.name} (code: ${org.code})`)

  // Get current branch count to seed the code counter
  const [{ count: existingCount }] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(branchesTable)
    .where(eq(branchesTable.organizationId, ORG_ID))

  let codeCounter = Number(existingCount)

  console.log(`\nCurrent branch count for ${org.name}: ${codeCounter}`)
  console.log("Starting inserts...\n")

  for (const branch of deduped) {
    // Check for duplicate name (case-insensitive) within the same org
    const [existing] = await tx
      .select({ id: branchesTable.id })
      .from(branchesTable)
      .where(
        and(
          eq(branchesTable.organizationId, ORG_ID),
          sql`lower(${branchesTable.name}) = ${branch.name.toLowerCase()}`
        )
      )
      .limit(1)

    if (existing) {
      console.log(`  SKIP (duplicate): ${branch.name}`)
      skippedDuplicate++
      continue
    }

    codeCounter++
    const code = `${org.code}-${codeCounter.toString().padStart(2, "0")}`

    await tx.insert(branchesTable).values({
      organizationId: ORG_ID,
      name: branch.name,
      address: branch.address || null,
      code,
      status: "active",
    })

    console.log(`  ✅  [${code}] ${branch.name}`)
    inserted++
  }
  })

  console.log("\n════════════════════════════════════════════════════════════")
  console.log(`  Done.  Inserted: ${inserted}  |  Skipped (duplicates): ${skippedDuplicate}`)
  console.log("════════════════════════════════════════════════════════════\n")
}

runInsert().catch((err) => {
  console.error("\n❌  Insert failed:", err.message)
  process.exit(1)
})
