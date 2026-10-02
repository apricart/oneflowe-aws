import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import {
  passwordResetCodeDigest,
  passwordResetIdentifierDigest,
} from "@/lib/server/password-reset"

const source = (relativePath: string) => readFileSync(join(process.cwd(), relativePath), "utf8")

describe("password reset secret digests", () => {
  it("binds an OTP digest to its challenge and never returns the OTP", () => {
    const first = passwordResetCodeDigest("11111111-1111-4111-8111-111111111111", "123456")
    const second = passwordResetCodeDigest("22222222-2222-4222-8222-222222222222", "123456")

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(first).not.toBe("123456")
    expect(second).not.toBe(first)
  })

  it("normalizes identifiers before creating opaque rate-limit keys", () => {
    expect(passwordResetIdentifierDigest(" Person-OP ")).toBe(
      passwordResetIdentifierDigest("person-op"),
    )
  })
})

describe("password reset security contract", () => {
  it("stores digests, caps guesses, and denies browser database roles", () => {
    const migration = source("drizzle/20260929184428_add_password_reset_challenges.sql")

    expect(migration).toContain('"code_digest" varchar(64)')
    expect(migration).toContain('"attempts" <= 5')
    expect(migration).toContain("ENABLE ROW LEVEL SECURITY")
    expect(migration).toContain("REVOKE ALL ON TABLE \"password_reset_challenges\" FROM anon")
    expect(migration).not.toContain('"code" varchar')
  })

  it("revokes sessions and increments the credential version without deleting records", () => {
    const service = source("lib/server/password-reset.ts")

    expect(service).toContain("sessionVersion: sql")
    expect(service).toContain("revokedAt: now")
    expect(service).toContain("invalidateSessionValidationCache(subject.subjectId)")
    expect(service).not.toContain(".delete(")
  })

  it("exposes reset from login and every ordering storefront profile", () => {
    expect(source("app/(auth)/login/page.tsx")).toContain('href="/forgot-password"')
    expect(source("app/shop/page.tsx")).toContain("OrderPortalProfileMenu")
    expect(source("components/group-portal/storefront/storefront-header.tsx"))
      .toContain("OrderPortalProfileMenu")
  })
})
