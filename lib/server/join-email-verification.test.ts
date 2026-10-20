import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  joinEmailCodeDigest,
  joinEmailDigest,
  joinEmailProofDigest,
} from "@/lib/server/join-email-verification"

/**
 * The digests behind the join page's email proof
 * (plans/OF-JOIN-email-otp-verification.md). The database behaviour — attempt
 * cap, resend, daily cap, single use, binding at submit — is carried by
 * `tests/integration/join-email-verification.test.ts`.
 */

const source = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), "utf8")
const CHALLENGE_A = "11111111-1111-4111-8111-111111111111"
const CHALLENGE_B = "22222222-2222-4222-8222-222222222222"

describe("join email digests", () => {
  it("names an address the way the join request stores it, case and spacing aside", () => {
    expect(joinEmailDigest(" Ada.Lovelace@KE.com.pk ")).toBe(joinEmailDigest("ada.lovelace@ke.com.pk"))
    expect(joinEmailDigest("ada@ke.com.pk")).not.toBe(joinEmailDigest("ada2@ke.com.pk"))
    expect(joinEmailDigest("ada@ke.com.pk")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("binds a code and a proof to their challenge", () => {
    expect(joinEmailCodeDigest(CHALLENGE_A, "123456")).not.toBe(joinEmailCodeDigest(CHALLENGE_B, "123456"))
    expect(joinEmailProofDigest(CHALLENGE_A, "p".repeat(43))).not.toBe(joinEmailProofDigest(CHALLENGE_B, "p".repeat(43)))
  })

  it("keeps the three purposes apart, so a code's digest is never a proof's", () => {
    expect(joinEmailCodeDigest(CHALLENGE_A, "123456")).not.toBe(joinEmailProofDigest(CHALLENGE_A, "123456"))
  })

  it("is not the password reset's digest of the same values", async () => {
    const { passwordResetCodeDigest } = await import("@/lib/server/password-reset")
    expect(joinEmailCodeDigest(CHALLENGE_A, "123456")).not.toBe(passwordResetCodeDigest(CHALLENGE_A, "123456"))
  })
})

describe("join email verification contract", () => {
  const migration = source("drizzle/20261025120000_join_email_verification.sql")
  const server = source("lib/server/join-email-verification.ts")

  it("stores digests only — no code, proof or address column", () => {
    expect(migration).toContain('"email_digest" varchar(64) NOT NULL')
    expect(migration).toContain('"code_digest" varchar(64) NOT NULL')
    expect(migration).toContain('"proof_digest" varchar(64)')
    expect(migration).not.toMatch(/"email" varchar|"code" varchar|"proof" varchar/)
  })

  it("caps attempts and keeps one live challenge per organization and address", () => {
    expect(migration).toContain('"attempts" <= 5')
    expect(migration).toMatch(/UNIQUE INDEX IF NOT EXISTS "join_email_verifications_live_uq"[^;]*\("organization_id","email_digest"\)[^;]*"consumed_at" IS NULL/)
  })

  it("denies the browser database roles", () => {
    expect(migration).toContain('REVOKE ALL ON TABLE "join_email_verifications" FROM anon')
    expect(migration).toContain('REVOKE ALL ON TABLE "join_email_verifications" FROM authenticated')
  })

  it("draws the code and the proof from node:crypto, never Math.random", () => {
    expect(server).toContain("randomInt(100_000, 1_000_000)")
    expect(server).toContain("randomBytes(32)")
    expect(server).not.toContain("Math.random")
  })

  it("never asks whether the address belongs to an account", () => {
    expect(server).not.toMatch(/\busers\b.*from "@\/db\/schema"|from\(users\)|usernameExists|assertUniqueUserFields/)
  })
})
