import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { readMigrationEnvFor } from "./migration-env"

const LOCAL = "postgres://u:p@localhost:54322/postgres"
const ELSEWHERE = "postgres://u:p@db.example.com/postgres"
const TEST_DB = "postgres://u:p@localhost:5433/oneflowe_test"

describe("readMigrationEnvFor", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migration-env-"))
    vi.stubEnv("MIGRATION_DATABASE_URL", undefined)
    vi.stubEnv("TEST_DATABASE_URL", undefined)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(dir, { recursive: true, force: true })
  })

  function write(file: string, body: string): void {
    writeFileSync(join(dir, file), body)
  }

  it("development prefers .env.development.local over .env.local", () => {
    write(".env.local", `MIGRATION_DATABASE_URL=${ELSEWHERE}\n`)
    write(".env.development.local", `MIGRATION_DATABASE_URL=${LOCAL}\n`)

    const { env, filesRead } = readMigrationEnvFor("development", dir)

    expect(env.MIGRATION_DATABASE_URL).toBe(LOCAL)
    expect(filesRead).toEqual([".env.development.local", ".env.local"])
  })

  it("development falls back to .env.local", () => {
    write(".env.local", `MIGRATION_DATABASE_URL=${LOCAL}\n`)

    expect(readMigrationEnvFor("development", dir).env.MIGRATION_DATABASE_URL).toBe(LOCAL)
  })

  it("test and production never read .env.local", () => {
    write(".env.local", `MIGRATION_DATABASE_URL=${ELSEWHERE}\nTEST_DATABASE_URL=${ELSEWHERE}\n`)

    for (const environment of ["test", "production"] as const) {
      const { env, filesRead } = readMigrationEnvFor(environment, dir)
      expect(env.MIGRATION_DATABASE_URL).toBeUndefined()
      expect(env.TEST_DATABASE_URL).toBeUndefined()
      expect(filesRead).toEqual([])
    }
  })

  it("each environment reads its own file", () => {
    write(".env.test.local", `TEST_DATABASE_URL=${TEST_DB}\n`)
    write(".env.prod.local", `MIGRATION_DATABASE_URL=${ELSEWHERE}\n`)

    expect(readMigrationEnvFor("test", dir).env.TEST_DATABASE_URL).toBe(TEST_DB)
    expect(readMigrationEnvFor("test", dir).env.MIGRATION_DATABASE_URL).toBeUndefined()
    expect(readMigrationEnvFor("production", dir).env.MIGRATION_DATABASE_URL).toBe(ELSEWHERE)
  })

  it("production never reads .env.production.local, which Next loads into every production-mode tool", () => {
    write(".env.production.local", `MIGRATION_DATABASE_URL=${ELSEWHERE}\n`)

    expect(readMigrationEnvFor("production", dir).env.MIGRATION_DATABASE_URL).toBeUndefined()
  })

  it("lets the shell win over every file", () => {
    write(".env.prod.local", `MIGRATION_DATABASE_URL=${ELSEWHERE}\n`)
    vi.stubEnv("MIGRATION_DATABASE_URL", LOCAL)

    expect(readMigrationEnvFor("production", dir).env.MIGRATION_DATABASE_URL).toBe(LOCAL)
  })

  it("leaves process.env untouched", () => {
    write(".env.prod.local", `MIGRATION_DATABASE_URL=${ELSEWHERE}\n`)

    readMigrationEnvFor("production", dir)

    expect(process.env.MIGRATION_DATABASE_URL).toBeUndefined()
  })
})
