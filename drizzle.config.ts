import { defineConfig } from "drizzle-kit";
import { loadMigrationEnv } from "./lib/server/migration-env";

const migrationEnv = loadMigrationEnv();

export default defineConfig({
  schema: "./db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: migrationEnv.MIGRATION_DATABASE_URL,
  },
  verbose: true,
  strict: true,
  migrations: {
    prefix: "timestamp",
  },
});
