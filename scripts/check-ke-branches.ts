import * as dotenv from "dotenv"
dotenv.config({ path: ".env.local" })
dotenv.config()

async function main() {
  const { db } = await import("../lib/db-cli")
  const { branches, roles, organizations } = await import("../db/schema")
  const { eq } = await import("drizzle-orm")

  // K-Electric org
  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, code: organizations.code })
    .from(organizations)
    .where(eq(organizations.id, 10))

  console.log("\n── Organization ──────────────────────────────")
  console.log(`  id: ${org.id}  name: ${org.name}  code: ${org.code}`)

  // BRANCH_ADMIN role
  const [role] = await db
    .select({ id: roles.id, name: roles.name })
    .from(roles)
    .where(eq(roles.id, 3))

  console.log("\n── Role ──────────────────────────────────────")
  console.log(`  id: ${role.id}  name: ${role.name}`)

  // K-Electric branches
  const brs = await db
    .select({ id: branches.id, name: branches.name, code: branches.code, status: branches.status })
    .from(branches)
    .where(eq(branches.organizationId, 10))

  console.log(`\n── K-Electric Branches (${brs.length} total) ───────────`)
  brs.forEach(b => console.log(`  [${b.id}] ${b.code}  "${b.name}"  (${b.status})`))

  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
