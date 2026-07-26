import * as dotenv from "dotenv"
dotenv.config({ path: ".env.local" })
dotenv.config()

async function main() {
  const { db } = await import("../lib/db-cli")
  const { organizations } = await import("../db/schema")
  const { sql } = await import("drizzle-orm")

  const orgs = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      code: organizations.code,
      status: organizations.status,
    })
    .from(organizations)

  console.log("\nOrganizations in database:")
  console.table(orgs)
  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
