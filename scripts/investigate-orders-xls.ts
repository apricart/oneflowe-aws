import * as dotenv from "dotenv"
import { readFileSync } from "fs"
import { resolve } from "path"
dotenv.config({ path: ".env.local" })
dotenv.config()

const FILE_PATH = resolve("Orders (1).xls")
const ORG_ID = 10 // K-Electric

interface OrderRow {
  lineNo: number
  location: string
  transactionNo: string
  orderNo: string
  date: string
  userDetails: string
  locationGroup: string
  grandTotal: string
  orderType: string
  orderStatus: string
}

function parseCSV(): OrderRow[] {
  let raw = readFileSync(FILE_PATH, "utf-8")
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)
  const lines = raw.split(/\r?\n/).filter((l) => l.trim())
  const rows: OrderRow[] = []
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",")
    rows.push({
      lineNo: i + 1,
      location: (cols[0] || "").trim(),
      transactionNo: (cols[1] || "").trim(),
      orderNo: (cols[2] || "").trim(),
      date: (cols[3] || "").trim(),
      userDetails: (cols[4] || "").trim(),
      locationGroup: (cols[5] || "").trim(),
      grandTotal: (cols[6] || "").trim(),
      orderType: (cols[7] || "").trim(),
      orderStatus: (cols[8] || "").trim(),
    })
  }
  return rows
}

/** Strip a trailing "(Role/Title)" parenthetical from a user-details string. */
function stripDesignation(s: string): { name: string; designation: string | null } {
  const m = s.match(/^(.*?)\s*\(([^)]+)\)\s*$/)
  if (m) return { name: m[1].trim(), designation: m[2].trim() }
  return { name: s.trim(), designation: null }
}

async function main() {
  const rows = parseCSV()

  console.log("\n════════════════════════════════════════════════════════════")
  console.log("  Orders File Investigation  —  Orders (1).xls")
  console.log("════════════════════════════════════════════════════════════")
  console.log(`  File       : ${FILE_PATH}`)
  console.log(`  Data rows  : ${rows.length}`)
  console.log("────────────────────────────────────────────────────────────\n")

  console.log("RAW ROWS:")
  rows.forEach((r) => {
    console.log(`  [L${r.lineNo}] loc="${r.location}" txn=${r.transactionNo} orderNo=${r.orderNo} date=${r.date} user="${r.userDetails}" group="${r.locationGroup}" total=${r.grandTotal} type="${r.orderType}" status="${r.orderStatus}"`)
  })

  // ── Column-level distinct values ──────────────────────────────────────
  const distinct = (key: keyof OrderRow) => [...new Set(rows.map((r) => r[key]))]

  console.log("\n── Distinct: OrderType ─────────────────────────")
  console.log(" ", distinct("orderType"))
  console.log("── Distinct: Order Status ──────────────────────")
  console.log(" ", distinct("orderStatus"))
  console.log("── Distinct: LocationGroup ─────────────────────")
  console.log(" ", distinct("locationGroup"))

  // ── Cross-reference against DB ──────────────────────────────────────
  const { db } = await import("../lib/db-cli")
  const { branches, users, groups } = await import("../db/schema")
  const { eq } = await import("drizzle-orm")

  const allBranches = await db
    .select({ id: branches.id, name: branches.name, code: branches.code })
    .from(branches)
    .where(eq(branches.organizationId, ORG_ID))
  const branchMap = new Map(allBranches.map((b) => [b.name.toLowerCase().trim(), b]))

  const allUsers = await db
    .select({ id: users.id, fullName: users.fullName, email: users.email, username: users.username, branchId: users.branchId })
    .from(users)
    .where(eq(users.organizationId, ORG_ID))
  const userByName = new Map(allUsers.map((u) => [(u.fullName || "").toLowerCase().trim(), u]))

  const allGroups = await db.select().from(groups).where(eq(groups.organizationId, ORG_ID))

  console.log("\n════════════════════════════════════════════════════════════")
  console.log("  CROSS-REFERENCE AGAINST DATABASE")
  console.log("════════════════════════════════════════════════════════════")

  console.log(`\n  K-Electric branches in DB : ${allBranches.length}`)
  console.log(`  K-Electric users in DB    : ${allUsers.length}`)
  console.log(`  K-Electric groups in DB   : ${allGroups.length}  ${allGroups.length === 0 ? "(none exist yet — LocationGroup has no home)" : ""}`)

  console.log("\n── Location → Branch match ─────────────────────")
  let locMatched = 0, locUnmatched = 0
  for (const r of rows) {
    const b = branchMap.get(r.location.toLowerCase().trim())
    if (b) {
      console.log(`  ✓ [L${r.lineNo}] "${r.location}" → branch id=${b.id} code=${b.code}`)
      locMatched++
    } else {
      console.log(`  ✗ [L${r.lineNo}] "${r.location}" → NO MATCHING BRANCH`)
      locUnmatched++
    }
  }

  console.log("\n── UserDetails → User match ────────────────────")
  let userMatched = 0, userUnmatched = 0
  for (const r of rows) {
    const { name, designation } = stripDesignation(r.userDetails)
    const u = userByName.get(name.toLowerCase().trim())
    if (u) {
      console.log(`  ✓ [L${r.lineNo}] "${r.userDetails}" → user id=${u.id} (name="${name}"${designation ? `, designation="${designation}"` : ""})`)
      userMatched++
    } else {
      console.log(`  ✗ [L${r.lineNo}] "${r.userDetails}" → NO MATCHING USER (parsed name="${name}"${designation ? `, designation="${designation}"` : ""})`)
      userUnmatched++
    }
  }

  console.log("\n── Date format check ───────────────────────────")
  for (const r of rows) {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(r.date) && !isNaN(Date.parse(r.date))
    console.log(`  ${valid ? "✓" : "✗"} [L${r.lineNo}] "${r.date}"`)
  }

  console.log("\n── GrandTotal numeric check ────────────────────")
  for (const r of rows) {
    const n = Number(r.grandTotal)
    console.log(`  ${!isNaN(n) ? "✓" : "✗"} [L${r.lineNo}] "${r.grandTotal}" → ${n}`)
  }

  console.log("\n── TransactionNo / OrderNo uniqueness ──────────")
  const txnKey = rows.map((r) => `${r.location}|${r.transactionNo}|${r.orderNo}`)
  const dupKeys = txnKey.filter((k, i) => txnKey.indexOf(k) !== i)
  console.log(`  Composite (location, transactionNo, orderNo) duplicates: ${dupKeys.length}`)
  if (dupKeys.length) console.log("   ", [...new Set(dupKeys)])

  console.log("\n════════════════════════════════════════════════════════════")
  console.log("  SUMMARY")
  console.log("════════════════════════════════════════════════════════════")
  console.log(`  Locations matched   : ${locMatched}/${rows.length}  (unmatched: ${locUnmatched})`)
  console.log(`  Users matched       : ${userMatched}/${rows.length}  (unmatched: ${userUnmatched})`)
  console.log(`  Distinct LocationGroup values found: ${distinct("locationGroup").length} — none exist in "groups" table yet`)
  console.log(`  NOTE: file has NO line-item / product-level detail (no SKU, qty, unit price columns)`)
  console.log(`        only an order-level GrandTotal is present.`)
  console.log("════════════════════════════════════════════════════════════\n")

  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
