import * as dotenv from "dotenv"
import { readFileSync } from "fs"
import { resolve } from "path"
dotenv.config({ path: ".env.local" })
dotenv.config()

const CSV_PATH = resolve("userlist.csv")
const ORG_ID = 10

async function main() {
  const { db } = await import("../lib/db-cli")
  const { branches, users } = await import("../db/schema")
  const { eq, inArray } = await import("drizzle-orm")

  // Load all K-Electric branches into a map (lowercase name → branch)
  const allBranches = await db
    .select({ id: branches.id, name: branches.name, code: branches.code })
    .from(branches)
    .where(eq(branches.organizationId, ORG_ID))

  const branchMap = new Map<string, { id: number; name: string; code: string | null }>()
  for (const b of allBranches) {
    branchMap.set(b.name.toLowerCase().trim(), b)
  }

  // Load existing usernames to detect conflicts
  const existingUsers = await db.select({ username: users.username, email: users.email }).from(users)
  const existingUsernames = new Set(existingUsers.map(u => (u.username || "").toLowerCase()))
  const existingEmails = new Set(existingUsers.map(u => (u.email || "").toLowerCase()))

  // Parse CSV
  const raw = readFileSync(CSV_PATH, "utf-8")
  const lines = raw.split(/\r?\n/).filter(l => l.trim())
  const dataLines = lines.slice(1) // skip header

  // Track issues
  const issues: string[] = []
  const warnings: string[] = []
  const ready: number[] = []
  const loginCodesSeen = new Set<string>()
  const emailsSeen = new Map<string, number[]>() // email → row numbers

  let noEmail = 0, noLoginCode = 0, noBranchMatch = 0, dupLoginCode = 0

  for (let i = 0; i < dataLines.length; i++) {
    const cols = dataLines[i].split(",")
    const rowNum = i + 2 // 1-indexed, offset by header
    const firstName = (cols[0] || "").trim()
    const lastName   = (cols[1] || "").trim()
    const location   = (cols[2] || "").trim()
    const password   = (cols[3] || "").trim()
    const loginCode  = (cols[4] || "").trim()
    const email      = (cols[5] || "").trim()

    const rowProblems: string[] = []

    // 1. Email check
    if (!email || email === " " || email === "") {
      rowProblems.push("❌ MISSING EMAIL (required)")
      noEmail++
    }

    // 2. Login Code check
    if (!loginCode) {
      rowProblems.push("❌ MISSING LOGIN CODE (username)")
      noLoginCode++
    } else if (loginCodesSeen.has(loginCode.toLowerCase())) {
      rowProblems.push(`❌ DUPLICATE LOGIN CODE within CSV: "${loginCode}"`)
      dupLoginCode++
    } else if (existingUsernames.has(loginCode.toLowerCase())) {
      rowProblems.push(`⚠️  LOGIN CODE "${loginCode}" already exists in DB`)
    } else {
      loginCodesSeen.add(loginCode.toLowerCase())
    }

    // 3. Branch / Location check
    const branch = branchMap.get(location.toLowerCase().trim())
    if (!branch) {
      rowProblems.push(`❌ LOCATION "${location}" — no matching branch in DB`)
      noBranchMatch++
    }

    // 4. Password check
    if (!password) {
      rowProblems.push("❌ MISSING PASSWORD")
    }

    // 5. Last name warnings (informational)
    if (lastName === "-") {
      // Will be stored as NULL — no problem
    } else if (/^\(.*\)$/.test(lastName) || ["DM","Bs","DGM"].includes(lastName)) {
      warnings.push(`  Row ${rowNum}: Last name looks like a job title: "${lastName}" for ${firstName}`)
    }

    // 6. Shared emails (track)
    const emailKey = email.toLowerCase()
    if (emailKey && emailKey !== " ") {
      if (!emailsSeen.has(emailKey)) emailsSeen.set(emailKey, [])
      emailsSeen.get(emailKey)!.push(rowNum)
    }

    if (rowProblems.length > 0) {
      issues.push(`  Row ${rowNum} [${firstName} ${lastName}]:`)
      rowProblems.forEach(p => issues.push(`    ${p}`))
    } else {
      ready.push(rowNum)
    }
  }

  // Shared email report
  const sharedEmails: string[] = []
  for (const [email, rows] of emailsSeen.entries()) {
    if (rows.length > 1) {
      sharedEmails.push(`  "${email}" → rows ${rows.join(", ")}`)
    }
  }

  console.log("\n════════════════════════════════════════════════════════════")
  console.log("  User CSV Investigation Report")
  console.log("════════════════════════════════════════════════════════════")
  console.log(`  File           : ${CSV_PATH}`)
  console.log(`  Total data rows: ${dataLines.length}`)
  console.log(`  Ready to import: ${ready.length}`)
  console.log(`  Rows with issues: ${dataLines.length - ready.length}`)
  console.log("────────────────────────────────────────────────────────────")

  console.log("\nISSUES (must fix before import):")
  if (issues.length === 0) {
    console.log("  ✅ None!")
  } else {
    issues.forEach(l => console.log(l))
  }

  if (warnings.length > 0) {
    console.log("\nWARNINGS (last name looks like a job title — will be stored as-is):")
    warnings.forEach(l => console.log(l))
  }

  if (sharedEmails.length > 0) {
    console.log("\nSHARED EMAILS (multiple users with same email — allowed by schema but flagging):")
    sharedEmails.forEach(l => console.log(l))
  }

  console.log("\n────────────────────────────────────────────────────────────")
  console.log(`  Summary:`)
  console.log(`    Missing email      : ${noEmail}`)
  console.log(`    Branch not found   : ${noBranchMatch}`)
  console.log(`    Duplicate login code: ${dupLoginCode}`)
  console.log(`    Shared email groups: ${sharedEmails.length}`)
  console.log("════════════════════════════════════════════════════════════\n")

  process.exit(0)
}

main().catch(e => { console.error(e.message); process.exit(1) })
