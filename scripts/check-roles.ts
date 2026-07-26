import * as dotenv from "dotenv"
dotenv.config({ path: ".env.local" })
dotenv.config()

async function main() {
  const { db } = await import("../lib/db-cli")
  const { roles } = await import("../db/schema")

  const r = await db.select({ id: roles.id, name: roles.name }).from(roles)
  console.log("\nRoles in database:")
  console.table(r)
  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
