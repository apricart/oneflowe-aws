import * as dotenv from "dotenv"
dotenv.config({ path: ".env.local" })
dotenv.config()

const ORG_ID = 10 // K-Electric

async function main() {
  const { db } = await import("../lib/db-cli")
  const {
    organizations,
    branches,
    users,
    globalProducts,
    organizationInventory,
    branchInventory,
    orders,
    budgets,
    groups,
  } = await import("../db/schema")
  const { eq, sql } = await import("drizzle-orm")

  const [org] = await db.select().from(organizations).where(eq(organizations.id, ORG_ID))
  console.log("\n── Organization ──────────────────────────────")
  console.log(org ? `  id=${org.id} name=${org.name} code=${org.code}` : "  NOT FOUND")

  const branchCount = await db.select({ c: sql<number>`count(*)` }).from(branches).where(eq(branches.organizationId, ORG_ID))
  console.log(`\n── Branches ───────────────────────────────────`)
  console.log(`  count: ${branchCount[0].c}`)

  const userCount = await db.select({ c: sql<number>`count(*)` }).from(users).where(eq(users.organizationId, ORG_ID))
  console.log(`\n── Users ──────────────────────────────────────`)
  console.log(`  count: ${userCount[0].c}`)

  const orgInvCount = await db.select({ c: sql<number>`count(*)` }).from(organizationInventory).where(eq(organizationInventory.organizationId, ORG_ID))
  console.log(`\n── Organization Inventory (products assigned to org) ──`)
  console.log(`  count: ${orgInvCount[0].c}`)

  const branchInvCount = await db
    .select({ c: sql<number>`count(*)` })
    .from(branchInventory)
    .where(eq(branchInventory.organizationId, ORG_ID))
  console.log(`\n── Branch Inventory (products assigned to branches) ──`)
  console.log(`  count: ${branchInvCount[0].c}`)

  const globalProductCount = await db.select({ c: sql<number>`count(*)` }).from(globalProducts)
  console.log(`\n── Global Products (master catalog, platform-wide) ──`)
  console.log(`  count: ${globalProductCount[0].c}`)

  const orderCount = await db.select({ c: sql<number>`count(*)` }).from(orders).where(eq(orders.organizationId, ORG_ID))
  console.log(`\n── Existing Orders for K-Electric ──────────────`)
  console.log(`  count: ${orderCount[0].c}`)

  const budgetCount = await db.select({ c: sql<number>`count(*)` }).from(budgets).where(eq(budgets.organizationId, ORG_ID))
  console.log(`\n── Budgets for K-Electric ───────────────────────`)
  console.log(`  count: ${budgetCount[0].c}`)

  const groupCount = await db.select({ c: sql<number>`count(*)` }).from(groups).where(eq(groups.organizationId, ORG_ID))
  console.log(`\n── Groups for K-Electric ────────────────────────`)
  console.log(`  count: ${groupCount[0].c}`)

  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
