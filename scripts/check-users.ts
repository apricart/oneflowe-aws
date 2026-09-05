import * as dotenv from "dotenv"
dotenv.config({ path: ".env.local" })
dotenv.config()

async function main() {
  const { db } = await import("../lib/db-cli")
  const { roles, users } = await import("../db/schema")
  const { eq } = await import("drizzle-orm")

  const rows = await db
    .select({
      email: users.email,
      username: users.username,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
      isActive: users.isActive,
      // A mirrored account signs in by username only; blank means portal-created.
      externalSource: users.externalSource,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))

  console.log("\nUsers in database:")
  console.table(rows)
  process.exit(0)
}

main().catch((e) => { console.error(e.message); process.exit(1) })
