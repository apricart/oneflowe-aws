/**
 * Reset an existing user's password.
 * Usage: npx tsx scripts/reset-user-password.ts <email> <newPassword>
 */

import * as dotenv from "dotenv"
dotenv.config({ path: ".env.local" })
dotenv.config()

async function main() {
  const { db } = await import("../lib/db-cli")
  const { users } = await import("../db/schema")
  const { eq } = await import("drizzle-orm")
  const bcrypt = (await import("bcryptjs")).default

  const [email, newPassword] = process.argv.slice(2)

  if (!email || !newPassword) {
    console.error("Usage: npx tsx scripts/reset-user-password.ts <email> <newPassword>")
    process.exit(1)
  }

  const [existing] = await db.select().from(users).where(eq(users.email, email)).limit(1)
  if (!existing) {
    throw new Error(`No user found with email: ${email}`)
  }

  const passwordHash = await bcrypt.hash(newPassword, 10)

  await db
    .update(users)
    .set({ passwordHash, updatedAt: new Date() })
    .where(eq(users.id, existing.id))

  console.log(`✅ Password updated for: ${email} (id: ${existing.id})`)
  process.exit(0)
}

main().catch((error) => {
  console.error("❌ Failed:", error)
  process.exit(1)
})
