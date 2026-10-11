import { describe, expect, it } from "vitest"

import {
  MigrationTargetRefusal,
  assertTargetMatchesEnvironment,
  describeMigrationTarget,
  migrationSslFor,
  parseMigrationArgs,
  productionPlanDigest,
  selectMigrationUrl,
} from "./migration-target"

const LOCAL_DEV = "postgres://postgres:secret@127.0.0.1:54322/postgres"
const LOCAL_TEST = "postgres://postgres:secret@localhost:5433/oneflowe_test"
const PROD = "postgresql://migrator:secret@aws-0-region.pooler.supabase.com:5432/postgres"

describe("parseMigrationArgs", () => {
  it("reads the environment and the confirmation", () => {
    expect(parseMigrationArgs(["--env=production", "--confirm=abc"])).toEqual({
      environment: "production",
      confirm: "abc",
    })
  })

  it("names no environment when none is given, so plain db:migrate applies nothing", () => {
    expect(parseMigrationArgs([])).toEqual({ environment: null, confirm: null })
  })

  it("refuses an unknown environment and an unknown argument", () => {
    expect(() => parseMigrationArgs(["--env=prod"])).toThrow(/Unknown --env "prod"/)
    expect(() => parseMigrationArgs(["--force"])).toThrow(/Unknown argument "--force"/)
  })

  it("treats an empty --confirm as no confirmation", () => {
    expect(parseMigrationArgs(["--env=production", "--confirm="]).confirm).toBeNull()
  })
})

describe("selectMigrationUrl", () => {
  it("test prefers TEST_DATABASE_URL over MIGRATION_DATABASE_URL", () => {
    expect(
      selectMigrationUrl("test", { TEST_DATABASE_URL: LOCAL_TEST, MIGRATION_DATABASE_URL: PROD }),
    ).toEqual({ url: LOCAL_TEST, variable: "TEST_DATABASE_URL" })
  })

  it("test falls back to MIGRATION_DATABASE_URL, which is what CI sets", () => {
    expect(selectMigrationUrl("test", { MIGRATION_DATABASE_URL: LOCAL_TEST }).variable).toBe(
      "MIGRATION_DATABASE_URL",
    )
  })

  it("development and production never read TEST_DATABASE_URL", () => {
    expect(() => selectMigrationUrl("development", { TEST_DATABASE_URL: LOCAL_TEST })).toThrow(
      /No development database configured/,
    )
    expect(() => selectMigrationUrl("production", { TEST_DATABASE_URL: LOCAL_TEST })).toThrow(
      /\.env\.production\.local/,
    )
  })

  it("ignores a blank value", () => {
    expect(() => selectMigrationUrl("production", { MIGRATION_DATABASE_URL: "  " })).toThrow()
  })
})

describe("assertTargetMatchesEnvironment", () => {
  it("development accepts a local database and refuses a remote one", () => {
    expect(() => assertTargetMatchesEnvironment("development", LOCAL_DEV)).not.toThrow()
    expect(() =>
      assertTargetMatchesEnvironment("development", "postgres://u:p@localhost/oneflowe"),
    ).not.toThrow()
    expect(() => assertTargetMatchesEnvironment("development", PROD)).toThrow(
      /Refusing to run development migrations against aws-0-region\.pooler\.supabase\.com\/postgres/,
    )
  })

  it("test requires a database named test, wherever it is", () => {
    expect(() => assertTargetMatchesEnvironment("test", LOCAL_TEST)).not.toThrow()
    expect(() =>
      assertTargetMatchesEnvironment("test", "postgres://u:p@db.example.com/staging_TEST"),
    ).not.toThrow()
    expect(() => assertTargetMatchesEnvironment("test", LOCAL_DEV)).toThrow(/must contain "test"/)
    expect(() => assertTargetMatchesEnvironment("test", PROD)).toThrow(/must contain "test"/)
  })

  it("production refuses a local database and a test database", () => {
    expect(() => assertTargetMatchesEnvironment("production", PROD)).not.toThrow()
    expect(() => assertTargetMatchesEnvironment("production", LOCAL_DEV)).toThrow(/local database/)
    expect(() =>
      assertTargetMatchesEnvironment("production", "postgres://u:p@db.example.com/oneflowe_test"),
    ).toThrow(/test database/)
  })

  it("refuses a malformed or non-postgres URL without echoing it", () => {
    for (const url of ["not a url", "mysql://u:hunter2@host/db"]) {
      let message = ""
      try {
        assertTargetMatchesEnvironment("production", url)
      } catch (error) {
        message = (error as Error).message
      }
      expect(message).toMatch(/not a valid postgres:\/\/ URL/)
      expect(message).not.toContain("hunter2")
    }
  })

  it("refuses with MigrationTargetRefusal, which the runner reports as a refusal, not a failed migration", () => {
    expect(() => assertTargetMatchesEnvironment("production", LOCAL_DEV)).toThrow(
      MigrationTargetRefusal,
    )
    expect(() => selectMigrationUrl("production", {})).toThrow(MigrationTargetRefusal)
    expect(() => parseMigrationArgs(["--env=staging"])).toThrow(MigrationTargetRefusal)
  })

  it("never puts the password in a refusal", () => {
    expect(() => assertTargetMatchesEnvironment("development", PROD)).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret") }),
    )
  })
})

describe("describeMigrationTarget", () => {
  it("names host, database and user, never the password", () => {
    const described = describeMigrationTarget(PROD)
    expect(described).toBe("aws-0-region.pooler.supabase.com:5432/postgres as migrator")
    expect(described).not.toContain("secret")
  })
})

describe("productionPlanDigest", () => {
  const tags = ["20261014120000_a", "20261015120000_b"]

  it("is stable for the same target and plan", () => {
    expect(productionPlanDigest(PROD, tags)).toBe(productionPlanDigest(PROD, [...tags]))
    expect(productionPlanDigest(PROD, tags)).toMatch(/^[0-9a-f]{16}$/)
  })

  it("does not depend on the password", () => {
    expect(productionPlanDigest(PROD, tags)).toBe(
      productionPlanDigest(PROD.replace("secret", "rotated"), tags),
    )
  })

  it("changes when the database or the pending set changes", () => {
    const base = productionPlanDigest(PROD, tags)
    expect(productionPlanDigest(PROD.replace(":5432", ":6543"), tags)).not.toBe(base)
    expect(productionPlanDigest(PROD.replace("/postgres", "/other"), tags)).not.toBe(base)
    expect(productionPlanDigest(PROD.replace("migrator", "app"), tags)).not.toBe(base)
    expect(productionPlanDigest(PROD, [...tags, "20261016120000_c"])).not.toBe(base)
    expect(productionPlanDigest(PROD, tags.slice(1))).not.toBe(base)
  })
})

describe("migrationSslFor", () => {
  it("needs no TLS locally, tolerates the Supabase pooler, and verifies production", () => {
    expect(migrationSslFor("development", LOCAL_DEV)).toBe(false)
    expect(migrationSslFor("production", PROD)).toEqual({ rejectUnauthorized: false })
    expect(migrationSslFor("production", "postgres://u:p@db.example.com/oneflowe")).toEqual({
      rejectUnauthorized: true,
    })
    expect(migrationSslFor("test", "postgres://u:p@db.example.com/oneflowe_test")).toBe(false)
  })
})
