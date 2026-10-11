import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  checkPasswordStrength,
  generateRandomPassword,
  hashPassword,
  needsRehash,
  validatePassword,
  verifyPassword,
} from "./password"

/**
 * The password policy as users meet it: what is accepted, the exact message
 * for each rule, and the generator that produces temporary passwords for
 * welcome emails — every one of which must itself pass the policy, or a new
 * user is handed a password the change form will refuse.
 */

const STRONG = "Correct-Horse-9"

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("validatePassword", () => {
  it("accepts a password meeting every rule", () => {
    expect(validatePassword(STRONG)).toEqual({ valid: true, errors: [] })
  })

  it("accepts exactly 12 and exactly 128 characters, refusing 11 and 129", () => {
    const pad = (length: number) => `Aa1!${"x".repeat(length - 4)}`
    expect(validatePassword(pad(12)).valid).toBe(true)
    expect(validatePassword(pad(128)).valid).toBe(true)
    expect(validatePassword(pad(11)).errors).toEqual(["Password must be at least 12 characters long"])
    expect(validatePassword(pad(129)).errors).toEqual(["Password must not exceed 128 characters"])
  })

  it("names each missing character class", () => {
    expect(validatePassword("ALLUPPER1234!").errors).toEqual(["Password must contain at least one lowercase letter"])
    expect(validatePassword("alllower1234!").errors).toEqual(["Password must contain at least one uppercase letter"])
    expect(validatePassword("NoDigitsHere!!").errors).toEqual(["Password must contain at least one number"])
    expect(validatePassword("NoSpecials1234").errors).toEqual([
      "Password must contain at least one special character (!@#$%^&*)",
    ])
  })

  it("counts a space or any non-alphanumeric character as special", () => {
    expect(validatePassword("Has Space 1234").valid).toBe(true)
    expect(validatePassword("Ünïcode-Pass1").valid).toBe(true)
  })

  it("reports every failing rule at once", () => {
    expect(validatePassword("abc").errors).toHaveLength(4)
  })

  it("refuses a non-string", () => {
    expect(validatePassword(undefined as unknown as string)).toEqual({
      valid: false,
      errors: ["Password must be a string"],
    })
  })
})

describe("checkPasswordStrength", () => {
  it("scores length and variety, capped at 4", () => {
    expect(checkPasswordStrength("Aa1!Aa1!Aa1!Aa1!").score).toBe(4)
    expect(checkPasswordStrength("abcdefgh").score).toBe(1)
    expect(checkPasswordStrength("abc").score).toBe(0)
  })

  it("explains what to add", () => {
    const { feedback } = checkPasswordStrength("abcdefghijkl")
    expect(feedback).toContain("Suggestion: Use both uppercase and lowercase letters")
    expect(feedback).toContain("Suggestion: Add numbers")
    expect(feedback).toContain("Suggestion: Add special characters (!@#$%^&*)")
  })

  it("handles a non-string", () => {
    expect(checkPasswordStrength(null as unknown as string)).toEqual({ score: 0, feedback: ["Invalid password"] })
  })
})

describe("generateRandomPassword", () => {
  it("always satisfies the policy it will be checked against", () => {
    for (let i = 0; i < 500; i += 1) {
      const password = generateRandomPassword()
      expect(password).toHaveLength(16)
      expect(validatePassword(password), password).toEqual({ valid: true, errors: [] })
    }
  })

  it("honours lengths in range and falls back to 16 otherwise", () => {
    expect(generateRandomPassword(12)).toHaveLength(12)
    expect(generateRandomPassword(128)).toHaveLength(128)
    expect(generateRandomPassword(11)).toHaveLength(16)
    expect(generateRandomPassword(129)).toHaveLength(16)
    expect(generateRandomPassword("20" as unknown as number)).toHaveLength(16)
  })

  it("does not put the guaranteed characters in fixed positions", () => {
    const firstChars = new Set(Array.from({ length: 200 }, () => generateRandomPassword()[0]))
    // Without the shuffle the first character would always be lower case.
    expect([...firstChars].some((char) => !/[a-z]/.test(char))).toBe(true)
  })
})

describe("hashPassword", () => {
  it("refuses to hash a password the policy rejects, naming the rules", async () => {
    await expect(hashPassword("short")).rejects.toThrow(/^Invalid password: Password must be at least 12/)
    await expect(hashPassword("")).rejects.toThrow("Password must be a non-empty string")
    await expect(hashPassword("            ")).rejects.toThrow("Password cannot be empty or whitespace")
  })

  it("hashes a valid password so it verifies", async () => {
    const hash = await hashPassword(STRONG)
    expect(await verifyPassword(STRONG, hash)).toBe(true)
    expect(await verifyPassword(`${STRONG}x`, hash)).toBe(false)
  })
})

describe("verifyPassword input guards", () => {
  it.each([
    ["", "$2b$12$x"],
    [STRONG, ""],
    [STRONG, "md5:abcdef"],
  ])("returns false for %j / %j", async (plain, hash) => {
    expect(await verifyPassword(plain, hash)).toBe(false)
  })
})

describe("needsRehash", () => {
  it("flags missing, malformed and differently-costed hashes", () => {
    expect(needsRehash("")).toBe(true)
    expect(needsRehash("nothing")).toBe(true)
    expect(needsRehash("$2b$xx$abc")).toBe(true)
    expect(needsRehash("$2b$04$abcdefghijklmnopqrstuuabcdefghijklmnopqrstuvwxyz012")).toBe(true)
  })
})
