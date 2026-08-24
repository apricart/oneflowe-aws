/**
 * @vitest-environment node
 *
 * Node rather than the suite-wide jsdom, so verifyPassword() is exercised on
 * the same bcrypt backend production selects. See password-hasher.test.ts.
 */

import * as bcryptjs from "bcryptjs"
import { describe, expect, it, vi } from "vitest"

vi.mock("server-only", () => ({}))
vi.mock("@/lib/server/env", () => ({ env: { BCRYPT_ROUNDS: 12 } }))

import { hashPassword, needsRehash, verifyPassword } from "@/lib/password"

/**
 * The user-facing guarantee of moving bcrypt off the event loop: an account
 * whose hash was written by the old code must still log in with the SAME
 * password, untouched, with no reset and no re-hash.
 *
 * Every hash here is produced by bcryptjs exactly as the pre-change code would
 * have written it, then verified through the current login path.
 */
describe("existing passwords still authenticate after the backend swap", () => {
  it.each([
    ["staff default cost", 12],
    ["employee credential cost", 10],
    ["a lower legacy cost", 11],
  ])("verifies a password stored at %s", async (_label, rounds) => {
    const password = "ExistingUser-Pass1!"
    const legacyHash = await bcryptjs.hash(password, rounds)

    await expect(verifyPassword(password, legacyHash)).resolves.toBe(true)
  })

  it.each(["$2a$", "$2b$", "$2y$"])(
    "verifies a stored hash written with the %s prefix",
    async (prefix) => {
      const password = "PrefixUser-Pass1!"
      const base = await bcryptjs.hash(password, 10)

      await expect(verifyPassword(password, `${prefix}${base.slice(4)}`)).resolves.toBe(true)
    },
  )

  it("still verifies non-ASCII passwords byte-for-byte", async () => {
    for (const password of ["Ürdu-Pá$$w0rd1!", "emoji-🔐-Passw0rd1!", "پاسورڈ-Ab1!x"]) {
      const legacyHash = await bcryptjs.hash(password, 10)
      await expect(verifyPassword(password, legacyHash)).resolves.toBe(true)
    }
  })

  it("still refuses the wrong password", async () => {
    const legacyHash = await bcryptjs.hash("CorrectHorse-1!", 10)

    // Mutates the first byte: bcrypt truncates at 72 bytes, so an appended
    // suffix would not necessarily change what the algorithm sees.
    await expect(verifyPassword("XorrectHorse-1!", legacyHash)).resolves.toBe(false)
    await expect(verifyPassword("", legacyHash)).resolves.toBe(false)
    await expect(verifyPassword("CorrectHorse-1", legacyHash)).resolves.toBe(false)
  })

  it("returns false instead of throwing for a corrupt stored hash", async () => {
    for (const corrupt of ["", "not-a-hash", "$1$md5$abc", "$2a$"]) {
      await expect(verifyPassword("CorrectHorse-1!", corrupt)).resolves.toBe(false)
    }
  })
})

describe("newly set passwords remain interoperable", () => {
  it("writes a hash the current login path accepts", async () => {
    const password = "BrandNewUser-Pass1!"
    const hash = await hashPassword(password)

    await expect(verifyPassword(password, hash)).resolves.toBe(true)
    await expect(verifyPassword("XrandNewUser-Pass1!", hash)).resolves.toBe(false)
  })

  it("writes a hash the legacy bcryptjs backend can still read", async () => {
    // Rollback safety: reverting the deployment must not strand a password
    // that was set while the native backend was live.
    const password = "RollbackUser-Pass1!"
    const hash = await hashPassword(password)

    await expect(bcryptjs.compare(password, hash)).resolves.toBe(true)
  })

  it("keeps writing at the configured cost factor, so no mass rehash is triggered", async () => {
    const hash = await hashPassword("CostFactorUser-Pass1!")

    expect(hash.split("$")[2]).toBe("12")
    expect(needsRehash(hash)).toBe(false)
  })

  it("still flags a genuinely outdated cost factor for rehash", async () => {
    const oldHash = await bcryptjs.hash("OldCostUser-Pass1!", 10)

    expect(needsRehash(oldHash)).toBe(true)
    // ...but the user can still log in in the meantime.
    await expect(verifyPassword("OldCostUser-Pass1!", oldHash)).resolves.toBe(true)
  })
})
