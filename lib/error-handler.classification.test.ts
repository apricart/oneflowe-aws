import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ERROR_MESSAGES,
  createDetailedError,
  createUserFriendlyError,
  handleError,
  isConflictError,
  isDatabaseError,
  isRetryableError,
  isTimeoutError,
  maskSensitiveData,
  parseDatabaseError,
  parseError,
  safeAsync,
  validateInput,
  validateRange,
} from "./error-handler"

/** What `jsonFetcher` throws for a non-2xx response: the API's message plus its status. */
function apiError(message: string, status: number): Error & { status: number } {
  return Object.assign(new Error(message), { status, statusText: "" })
}

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("parseError — messages our own API wrote", () => {
  it("keeps a 400 that mentions an organization instead of rewriting it as a scope violation", () => {
    expect(parseError(apiError("Branch does not belong to the selected organization", 400))).toEqual({
      type: "VALIDATION_ERROR",
      message: "Branch does not belong to the selected organization",
      field: undefined,
      statusCode: 400,
    })
    expect(parseError(apiError("Invalid organization", 400)).message).toBe("Invalid organization")
  })

  it("does not call every 404 a missing user", () => {
    expect(parseError(apiError("Branch not found", 404))).toMatchObject({
      type: "NOT_FOUND_ERROR",
      message: "Branch not found",
      statusCode: 404,
    })
  })

  it("keeps a specific password message instead of the generic policy text, and still points at the field", () => {
    expect(parseError(apiError("Current password is incorrect", 400))).toMatchObject({
      message: "Current password is incorrect",
      field: "password",
      statusCode: 400,
    })
  })

  it("types the message by its HTTP status", () => {
    expect(parseError(apiError("Sign in again", 401)).type).toBe("AUTHENTICATION_ERROR")
    expect(parseError(apiError("You can only create users within your own organization", 403)).type).toBe("PERMISSION_ERROR")
    expect(parseError(apiError("Order changed", 409)).type).toBe("CONFLICT_ERROR")
    expect(parseError(apiError("Slow down", 429)).type).toBe("RATE_LIMIT_ERROR")
  })

  it("still turns a 'required' message into a labelled, focusable field error", () => {
    expect(parseError(apiError("organizationId required for HEAD_OFFICE", 400))).toEqual({
      type: "VALIDATION_ERROR",
      message: "Organization is required",
      field: "organizationId",
      statusCode: 400,
    })
  })

  it("still maps a duplicate-username message to the username field", () => {
    expect(parseError(apiError("Username already exists. Please choose a different username.", 400))).toMatchObject({
      type: "DUPLICATE_ERROR",
      field: "username",
    })
  })

  it("falls back to the rule text when the API sent only a generic status line", () => {
    expect(parseError(apiError("Request failed with status 404", 404)).message).toBe(ERROR_MESSAGES.USER_NOT_FOUND)
    expect(parseError(apiError("HTTP 403: Forbidden", 403)).statusCode).toBe(403)
  })

  it("never passes a 5xx message through", () => {
    expect(parseError(apiError("relation \"users\" does not exist", 500))).toMatchObject({ statusCode: 500 })
    expect(parseError(apiError("kaboom at /srv/app/lib/x.ts:12", 500))).toEqual({
      type: "SERVER_ERROR",
      message: ERROR_MESSAGES.UNKNOWN_ERROR,
      statusCode: 500,
    })
  })
})

describe("parseError — raw exceptions", () => {
  it.each([
    ["firstName is required", "First name is required", "firstName"],
    ["lastName is required", "Last name is required", "lastName"],
    ["email is required", "Email is required", "email"],
    ["password is required", "Password is required", "password"],
    ["role is required", "Role is required", "role"],
    ["branchId is required", "Branch is required", "branchId"],
  ])("labels %s", (raw, message, field) => {
    expect(parseError(new Error(raw))).toMatchObject({ type: "VALIDATION_ERROR", message, field, statusCode: 400 })
  })

  it("ignores a 'required' message naming no known field", () => {
    expect(parseError(new Error("quantity is required")).type).toBe("SERVER_ERROR")
  })

  it.each([
    ["username is already taken (unique)", "username"],
    ["email already registered", "email"],
    ["phone already exists", "phone"],
    ["employee already exists", "employeeId"],
  ])("maps duplicate %s", (raw, field) => {
    expect(parseError(new Error(raw))).toMatchObject({ type: "DUPLICATE_ERROR", field, statusCode: 400 })
  })

  it.each([
    ["permission denied", "PERMISSION_ERROR", 403],
    ["unauthorized", "PERMISSION_ERROR", 403],
    ["thing not found", "NOT_FOUND_ERROR", 404],
    ["timed out waiting", "NETWORK_ERROR", 408],
    ["network down", "NETWORK_ERROR", 503],
    ["daily limit hit", "MFA_ERROR", 400],
    ["cooldown active", "MFA_ERROR", 400],
    ["Invalid OTP", "MFA_ERROR", 400],
    ["code expired", "MFA_ERROR", 400],
    ["Invalid email", "VALIDATION_ERROR", 400],
    ["Invalid role", "VALIDATION_ERROR", 400],
  ])("classifies %s", (raw, type, statusCode) => {
    expect(parseError(new Error(raw))).toMatchObject({ type, statusCode })
  })

  it("passes through messages our code already worded for the user", () => {
    expect(parseError(new Error("Cannot delete a branch with orders"))).toEqual({
      type: "VALIDATION_ERROR",
      message: "Cannot delete a branch with orders",
      statusCode: 400,
    })
    expect(parseError(new Error("Linked records exist")).message).toBe("Linked records exist")
  })

  it("routes a pg error by its SQLSTATE before any keyword rule", () => {
    const unique = Object.assign(new Error("duplicate key value violates unique constraint on organization"), {
      code: "23505",
      severity: "ERROR",
    })
    expect(parseError(unique)).toMatchObject({ type: "DUPLICATE_ERROR", statusCode: 409 })
  })

  it("never echoes an unknown raw message", () => {
    const parsed = parseError(new Error("secret internal detail"))
    expect(parsed.message).toBe(ERROR_MESSAGES.UNKNOWN_ERROR)
    expect(parsed.statusCode).toBe(500)
  })

  it("tolerates non-Error values", () => {
    expect(parseError(undefined).statusCode).toBe(500)
    expect(parseError("permission problem").type).toBe("PERMISSION_ERROR")
  })
})

describe("parseDatabaseError", () => {
  it.each([
    ["23505", "DUPLICATE_ERROR", 409, false],
    ["23503", "VALIDATION_ERROR", 400, false],
    ["23502", "VALIDATION_ERROR", 400, false],
    ["40001", "CONFLICT_ERROR", 409, true],
    ["40P01", "CONFLICT_ERROR", 409, true],
    ["ECONNREFUSED", "DATABASE_ERROR", 503, true],
    ["ETIMEDOUT", "TIMEOUT_ERROR", 504, true],
  ])("maps SQLSTATE %s", (code, type, statusCode, retryable) => {
    expect(parseDatabaseError({ code, message: "x" })).toMatchObject({ type, statusCode, retryable, code })
  })

  it("treats a timeout message without a code as a timeout", () => {
    expect(parseDatabaseError({ message: "statement timeout" }).type).toBe("TIMEOUT_ERROR")
  })

  it("defaults to a generic database error", () => {
    expect(parseDatabaseError({ code: "42P01", message: "x" })).toMatchObject({ type: "DATABASE_ERROR", statusCode: 500 })
  })
})

describe("error predicates", () => {
  it("recognises database errors by message or code", () => {
    expect(isDatabaseError(null)).toBe(false)
    expect(isDatabaseError(new Error("relation missing"))).toBe(true)
    expect(isDatabaseError({ code: "23503" })).toBe(true)
    expect(isDatabaseError(new Error("plain"))).toBe(false)
  })

  it("recognises timeouts and conflicts", () => {
    expect(isTimeoutError({ code: "ETIMEDOUT" })).toBe(true)
    expect(isTimeoutError(new Error("timed out"))).toBe(true)
    expect(isTimeoutError(null)).toBe(false)
    expect(isConflictError({ code: "40001" })).toBe(true)
    expect(isConflictError(new Error("modified by another user"))).toBe(true)
    expect(isConflictError(undefined)).toBe(false)
  })

  it("retries timeouts and conflicts but not constraint violations", () => {
    expect(isRetryableError({ code: "40P01" })).toBe(true)
    expect(isRetryableError(new Error("timeout"))).toBe(true)
    expect(isRetryableError({ code: "23505" })).toBe(false)
  })
})

describe("maskSensitiveData", () => {
  it("masks secrets at any depth, case-insensitively", () => {
    expect(maskSensitiveData({ user: "a", Password: "p", nested: { apiKey: "k", ok: 1 } })).toEqual({
      user: "a",
      Password: "***MASKED***",
      nested: { apiKey: "***MASKED***", ok: 1 },
    })
  })

  it("keeps arrays as arrays while masking inside them", () => {
    const masked = maskSensitiveData({ items: [{ token: "t", id: 1 }, { id: 2 }] })
    expect(Array.isArray(masked.items)).toBe(true)
    expect(masked.items).toEqual([{ token: "***MASKED***", id: 1 }, { id: 2 }])
  })

  it("returns primitives untouched and does not mutate its input", () => {
    expect(maskSensitiveData("x")).toBe("x")
    expect(maskSensitiveData(null)).toBeNull()
    const input = { otp: "123456" }
    maskSensitiveData(input)
    expect(input.otp).toBe("123456")
  })
})

describe("handleError / createUserFriendlyError / createDetailedError", () => {
  it("logs a validation failure quietly and a server failure loudly", () => {
    handleError(apiError("Bad input", 400), "ctx")
    expect(console.warn).toHaveBeenCalled()
    handleError(new Error("boom"), "ctx")
    expect(console.error).toHaveBeenCalled()
  })

  it("returns the user-facing shape", () => {
    expect(createUserFriendlyError(apiError("Branch not found", 404))).toEqual({
      message: "Branch not found",
      field: undefined,
      type: "NOT_FOUND_ERROR",
      status: 404,
    })
  })

  it("builds a log record with secrets masked", () => {
    const record = createDetailedError(new Error("x"), "ctx", { password: "p" })
    expect(record).toMatchObject({ error: "x", context: "ctx", data: { password: "***MASKED***" } })
    expect(createDetailedError(null, "ctx").error).toBe("Unknown error")
    expect(createDetailedError(null, "ctx").data).toBeUndefined()
  })
})

describe("validateInput / validateRange", () => {
  it("enforces required, length, pattern and custom rules", () => {
    expect(() => validateInput("", "Name", { required: true })).toThrow("Name is required")
    expect(() => validateInput(null, "Name")).not.toThrow()
    expect(() => validateInput("ab", "Name", { minLength: 3 })).toThrow("at least 3")
    expect(() => validateInput("abcd", "Name", { maxLength: 3 })).toThrow("must not exceed 3")
    expect(() => validateInput("a1", "Code", { pattern: /^[a-z]+$/ })).toThrow("Code has an invalid format")
    expect(() => validateInput(5, "Qty", { custom: (value) => value > 10 })).toThrow(ERROR_MESSAGES.INVALID_INPUT)
    expect(() => validateInput("abc", "Name", { minLength: 3, maxLength: 3, pattern: /c$/ })).not.toThrow()
  })

  it("checks numeric bounds inclusively and rejects NaN", () => {
    expect(() => validateRange(Number.NaN, "Qty")).toThrow(TypeError)
    expect(() => validateRange(0, "Qty", 1, 5)).toThrow("Qty must be between 1 and 5")
    expect(() => validateRange(6, "Qty", 1, 5)).toThrow()
    expect(() => validateRange(6, "Qty", undefined, 5)).toThrow("Qty is out of acceptable range")
    expect(() => validateRange(1, "Qty", 1, 5)).not.toThrow()
    expect(() => validateRange(5, "Qty", 1, 5)).not.toThrow()
  })
})

describe("safeAsync", () => {
  it("returns data on success", async () => {
    expect(await safeAsync(async () => 42, "ctx")).toEqual({ data: 42 })
  })

  it("returns a database classification for a database failure", async () => {
    const result = await safeAsync(async () => {
      // As postgres.js raises it: a SQLSTATE plus the server's severity.
      throw Object.assign(new Error("deadlock detected"), { code: "40P01", severity: "ERROR" })
    }, "ctx")
    expect(result.error).toMatchObject({ type: "CONFLICT_ERROR", retryable: true })
  })

  it("returns a parsed error for anything else", async () => {
    const result = await safeAsync(async () => {
      throw new Error("permission denied")
    }, "ctx")
    expect(result.error?.type).toBe("PERMISSION_ERROR")
  })
})
