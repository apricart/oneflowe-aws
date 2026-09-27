import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"

import { resolveTestDatabaseUrl } from "@/tests/e2e/support/environment"

describe("the E2E database bootstrap", () => {
  afterEach(() => vi.unstubAllEnvs())

  it("resolves an explicitly disposable database", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgres://runner:secret@localhost:5432/oneflowe_test")
    vi.stubEnv("DATABASE_URL", "postgres://runner:secret@localhost:5432/oneflowe_app")

    expect(resolveTestDatabaseUrl()).toBe("postgres://runner:secret@localhost:5432/oneflowe_test")
  })

  it("keeps global setup on the static import path Playwright supports in CI", () => {
    const source = readFileSync(resolve(process.cwd(), "tests/e2e/global-setup.ts"), "utf8")

    expect(source).toContain('import { resolveTestDatabaseUrl } from "./support/environment"')
    expect(source).not.toContain('await import("./support/environment")')
  })

  it("still refuses the application database and a target not named as test data", () => {
    vi.stubEnv("TEST_DATABASE_URL", "postgres://runner:secret@localhost:5432/oneflowe")
    vi.stubEnv("DATABASE_URL", "postgres://runner:secret@localhost:5432/oneflowe_app")
    expect(() => resolveTestDatabaseUrl()).toThrow(/must name a disposable database/i)

    vi.stubEnv("TEST_DATABASE_URL", "postgres://runner:secret@localhost:5432/oneflowe_test")
    vi.stubEnv("DATABASE_URL", "postgres://runner:secret@localhost:5432/oneflowe_test")
    expect(() => resolveTestDatabaseUrl()).toThrow(/name the same database/i)
  })
})
