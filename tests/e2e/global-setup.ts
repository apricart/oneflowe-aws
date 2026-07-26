import { migrateAndSeedE2EDatabase } from "./support/database"

export default async function globalSetup() {
  console.log("[E2E] Migrating and seeding the isolated test database...")
  await migrateAndSeedE2EDatabase()
  console.log("[E2E] Test database is ready.")
}
