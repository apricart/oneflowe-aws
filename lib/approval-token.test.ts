import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  generateApprovalToken,
  hashApprovalToken,
  isValidTokenFormat,
  verifyApprovalToken,
} from "./approval-token"

/**
 * The fulfilment token is the only thing standing between "approved" and
 * "fulfilled" for a hand-off, so the properties that matter are: it is drawn
 * from the unambiguous alphabet, it is never stored in plaintext, it verifies
 * regardless of the case/whitespace a person types it with, and every malformed
 * input verifies as false rather than throwing.
 */

const ALPHABET = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]+$/

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("generateApprovalToken", () => {
  it("produces a 10-character token from the unambiguous alphabet by default", () => {
    for (let i = 0; i < 200; i += 1) {
      const token = generateApprovalToken()
      expect(token).toHaveLength(10)
      expect(token).toMatch(ALPHABET)
      // 0/O and 1/I are excluded; L stays so the alphabet is exactly 32
      // symbols, which keeps `byte % 32` free of modulo bias.
      expect(token).not.toMatch(/[01OI]/)
    }
  })

  it("honours a requested length inside 6–32", () => {
    expect(generateApprovalToken(6)).toHaveLength(6)
    expect(generateApprovalToken(32)).toHaveLength(32)
  })

  it("falls back to the default for an out-of-range or non-numeric length", () => {
    expect(generateApprovalToken(5)).toHaveLength(10)
    expect(generateApprovalToken(33)).toHaveLength(10)
    expect(generateApprovalToken(Number.NaN)).toHaveLength(10)
  })

  it("does not repeat itself", () => {
    const tokens = new Set(Array.from({ length: 500 }, () => generateApprovalToken()))
    expect(tokens.size).toBe(500)
  })

  it("uses every symbol of the alphabet (no truncated range)", () => {
    const seen = new Set<string>()
    for (let i = 0; i < 400; i += 1) for (const char of generateApprovalToken(32)) seen.add(char)
    expect(seen.size).toBe(32)
  })
})

describe("hashApprovalToken / verifyApprovalToken", () => {
  it("stores a bcrypt hash, never the token, and verifies it back", async () => {
    const token = generateApprovalToken()
    const hash = await hashApprovalToken(token)

    expect(hash).toMatch(/^\$2[aby]\$10\$/)
    expect(hash).not.toContain(token)
    expect(await verifyApprovalToken(token, hash)).toBe(true)
  })

  it("accepts the token typed in lower case or with surrounding spaces", async () => {
    const hash = await hashApprovalToken("ABCDEF2345")
    expect(await verifyApprovalToken("abcdef2345", hash)).toBe(true)
    expect(await verifyApprovalToken("  AbCdEf2345 \n", hash)).toBe(true)
  })

  it("hashes a lower-case token to the same canonical value", async () => {
    const hash = await hashApprovalToken("abcdef2345")
    expect(await verifyApprovalToken("ABCDEF2345", hash)).toBe(true)
  })

  it("rejects a different token", async () => {
    const hash = await hashApprovalToken("ABCDEF2345")
    expect(await verifyApprovalToken("ABCDEF2346", hash)).toBe(false)
  })

  it.each([
    ["", "Token must be a non-empty string"],
    ["   ", "Token cannot be empty after trimming"],
    ["ABC23", "Token too short"],
    ["A".repeat(33), "Token too long"],
    ["ABCDEF0123", "Token contains invalid characters"],
    ["ABC-DEF-23", "Token contains invalid characters"],
  ])("refuses to hash %j", async (token, message) => {
    await expect(hashApprovalToken(token)).rejects.toThrow(message)
  })

  it.each([
    ["", "$2b$10$abcdefghijklmnopqrstuv"],
    ["ABCDEF2345", ""],
    ["ABCDEF2345", "plaintext-not-a-hash"],
    ["   ", "$2b$10$abcdefghijklmnopqrstuv"],
    ["ABC", "$2b$10$abcdefghijklmnopqrstuv"],
    ["A".repeat(40), "$2b$10$abcdefghijklmnopqrstuv"],
  ])("verifies %j against %j as false without throwing", async (token, hash) => {
    expect(await verifyApprovalToken(token, hash)).toBe(false)
  })

  it("does not accept the stored hash itself as a token", async () => {
    const hash = await hashApprovalToken("ABCDEF2345")
    expect(await verifyApprovalToken(hash, hash)).toBe(false)
  })

  it("verifies as false for a corrupt bcrypt hash", async () => {
    expect(await verifyApprovalToken("ABCDEF2345", "$2b$10$corrupt")).toBe(false)
  })
})

describe("isValidTokenFormat", () => {
  it("accepts well-formed tokens in any case", () => {
    expect(isValidTokenFormat("ABCDEF")).toBe(true)
    expect(isValidTokenFormat(" abcdef2345 ")).toBe(true)
  })

  it("rejects ambiguous characters, wrong lengths and non-strings", () => {
    expect(isValidTokenFormat("ABCDE0")).toBe(false)
    expect(isValidTokenFormat("ABCDE")).toBe(false)
    expect(isValidTokenFormat("A".repeat(33))).toBe(false)
    expect(isValidTokenFormat("")).toBe(false)
    expect(isValidTokenFormat(null as unknown as string)).toBe(false)
  })
})
