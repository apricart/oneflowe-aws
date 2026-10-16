/**
 * @vitest-environment node
 *
 * The suite-wide jsdom environment resolves @node-rs/bcrypt under browser
 * conditions and hands back a stub without hash/verify, which would silently
 * push these tests onto the bcryptjs fallback and leave the native backend
 * unverified. Node is also the environment this module actually runs in.
 */
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as bcryptjs from "bcryptjs"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))

import {
  activePasswordHasher,
  bcryptCompare,
  bcryptHash,
  PASSWORD_HASHER_TEST_VECTORS,
  resetPasswordHasherForTests,
} from "@/lib/server/password-hasher"

function source(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8")
}

const originalPreference = process.env.PASSWORD_HASHER

function restorePreference(): void {
  if (originalPreference === undefined) delete process.env.PASSWORD_HASHER
  else process.env.PASSWORD_HASHER = originalPreference
  resetPasswordHasherForTests()
}

// Production selects the backend -- and runs its self-test -- once per
// process, so the compatibility suites below share one selection, as a server
// does. Re-selecting before every test re-ran the self-test's twelve real
// bcrypt checks each time and cost the suite over a minute and a half. The
// backend-selection tests re-select explicitly and restore afterwards.
beforeAll(() => {
  resetPasswordHasherForTests()
})

afterAll(restorePreference)

/**
 * The whole point of this change is that it must be invisible to users. These
 * run against the REAL backend selected on this machine -- no mocks -- so a
 * platform whose bcrypt disagrees with bcryptjs fails the build rather than
 * locking anyone out in production.
 */
describe("stored credentials keep verifying", () => {
  it.each(PASSWORD_HASHER_TEST_VECTORS)(
    "accepts a bcryptjs digest: $note",
    async ({ password, hash }) => {
      await expect(bcryptCompare(password, hash)).resolves.toBe(true)
    },
  )

  it.each(PASSWORD_HASHER_TEST_VECTORS)(
    "rejects a wrong password: $note",
    async ({ wrongPassword, hash }) => {
      await expect(bcryptCompare(wrongPassword, hash)).resolves.toBe(false)
      await expect(bcryptCompare("", hash)).resolves.toBe(false)
    },
  )

  // Freshly generated rather than pinned, so this also covers salts the fixed
  // vectors happen not to contain.
  it.each([10, 11, 12, 13])(
    "accepts a freshly generated bcryptjs digest at cost %i",
    async (rounds) => {
      const password = `Live-Vector-${rounds}-Aa1!`
      const hash = await bcryptjs.hash(password, rounds)

      await expect(bcryptCompare(password, hash)).resolves.toBe(true)
      await expect(bcryptCompare(`${password}x`, hash)).resolves.toBe(false)
    },
    30_000,
  )

  it("reads $2a$, $2b$ and $2y$ variants of one digest identically", async () => {
    const password = "Prefix-Variant-Aa1!"
    const base = await bcryptjs.hash(password, 10)

    for (const prefix of ["$2a$", "$2b$", "$2y$"]) {
      const rewritten = `${prefix}${base.slice(4)}`
      await expect(bcryptCompare(password, rewritten)).resolves.toBe(true)
    }
  })

  it("truncates over-72-byte and multi-byte passwords the way bcryptjs does", async () => {
    for (const password of [`${"x".repeat(80)}A1!`, `${"ü".repeat(60)}B2@`, "emoji-🔐-Aa1!"]) {
      const hash = await bcryptjs.hash(password, 10)
      await expect(bcryptCompare(password, hash)).resolves.toBe(true)
    }
  })
})

describe("new digests stay readable by the fallback backend", () => {
  // Rollback safety: a password set while native is active must still verify
  // if the deployment is reverted to bcryptjs.
  it.each([10, 12])("produces a cost-%i digest bcryptjs can verify", async (rounds) => {
    const password = `RoundTrip-${rounds}-Aa1!`
    const hash = await bcryptHash(password, rounds)

    expect(hash.startsWith("$2")).toBe(true)
    expect(hash.split("$")[2]).toBe(String(rounds).padStart(2, "0"))
    await expect(bcryptjs.compare(password, hash)).resolves.toBe(true)
    await expect(bcryptjs.compare(`${password}x`, hash)).resolves.toBe(false)
  })
})

describe("malformed input cannot throw into the login path", () => {
  it.each([
    ["empty string", ""],
    ["not a hash", "not-a-hash"],
    ["truncated prefix", "$2a$"],
    ["unknown variant", "$2x$12$abcdefghijklmnopqrstuv"],
    // Out-of-range cost factors are the ONE input the two backends treat
    // differently (bcryptjs throws, native returns false). No bcrypt
    // implementation can produce them, and refuseOnError() normalises both to
    // a refused login -- pinned here so that normalisation is not lost.
    ["cost above the legal range", `$2a$99$${"a".repeat(53)}`],
    ["cost below the legal range", `$2a$03$${"a".repeat(53)}`],
    ["legacy $2$ with no variant letter", `$2$10$${"a".repeat(53)}`],
  ])("returns false rather than throwing for %s", async (_label, hash) => {
    await expect(bcryptCompare("Password123!", hash)).resolves.toBe(false)
  })
})

describe("backend selection", () => {
  afterEach(restorePreference)

  it("honours PASSWORD_HASHER=bcryptjs as a rollback lever", async () => {
    process.env.PASSWORD_HASHER = "bcryptjs"
    resetPasswordHasherForTests()

    await expect(activePasswordHasher()).resolves.toBe("bcryptjs")
    // Still verifies the same credentials on the legacy backend.
    const { password, hash } = PASSWORD_HASHER_TEST_VECTORS[0]
    await expect(bcryptCompare(password, hash)).resolves.toBe(true)
  })

  it("falls back safely for an unrecognised value", async () => {
    process.env.PASSWORD_HASHER = "nonsense"
    resetPasswordHasherForTests()

    const { password, hash } = PASSWORD_HASHER_TEST_VECTORS[0]
    await expect(bcryptCompare(password, hash)).resolves.toBe(true)
  })

  it("uses the native backend whenever its binary is loadable", async () => {
    let binaryLoadable = true
    try {
      await import("@node-rs/bcrypt")
    } catch {
      binaryLoadable = false
    }

    delete process.env.PASSWORD_HASHER
    resetPasswordHasherForTests()

    // Without this the compatibility suite above could silently be comparing
    // bcryptjs against itself and proving nothing about the deployed backend.
    if (binaryLoadable) {
      await expect(activePasswordHasher()).resolves.toBe("native")
    }
  }, 30_000)

  it("reports which backend is live", async () => {
    delete process.env.PASSWORD_HASHER
    resetPasswordHasherForTests()

    const backend = await activePasswordHasher()
    expect(["native", "bcryptjs"]).toContain(backend)
    // Surfaced so a CI run on a platform without a prebuilt binary is visible
    // rather than silently passing on the fallback.
    console.info(`[password-hasher.test] active backend: ${backend}`)
  })
})

/**
 * Source contracts -- follows lib/server/code-only-load-fixes.test.ts. These
 * stop a future edit from quietly reintroducing main-thread hashing or from
 * changing a stored cost factor.
 */
describe("credential-path source contracts", () => {
  it.each([
    "lib/password.ts",
    "lib/auth-options.ts",
    "app/api/v1/employee-credentials/route.ts",
  ])("%s does not import bcryptjs directly", (path) => {
    expect(source(path)).not.toContain('from "bcryptjs"')
    expect(source(path)).toContain("@/lib/server/password-hasher")
  })

  it("keeps the staff cost factor at 12 and its validated range", () => {
    expect(source("lib/server/env-validation.ts")).toContain(
      "optionalInteger('BCRYPT_ROUNDS', 10, 15, 12)",
    )
    expect(source("lib/password.ts")).toContain("const SALT_ROUNDS = env.BCRYPT_ROUNDS")
    expect(source("lib/password.ts")).toContain("bcryptHash(plain, SALT_ROUNDS)")
  })

  it("keeps the employee credential cost factor unchanged at 10", () => {
    const route = source("app/api/v1/employee-credentials/route.ts")
    expect(route).toContain("await hash(password, 10)")
    expect(route).not.toContain("await hash(password, 12)")
  })

  it("keeps the native addon external to the Next.js bundle", () => {
    expect(source("next.config.mjs")).toContain("serverExternalPackages: ['@node-rs/bcrypt']")
  })
})
