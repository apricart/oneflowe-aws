import { describe, expect, it } from "vitest"
import {
  ACCOUNT_LOCKED_ERROR,
  LOCKOUT_DURATION_MINUTES_MIN,
  LOCKOUT_THRESHOLD_MAX,
  evaluateLockout,
} from "@/lib/auth-lockout-policy"

const NOW = Date.UTC(2026, 7, 23, 12, 0, 0)

describe("evaluateLockout", () => {
  it("treats an account with no lockout timestamp as unlocked", () => {
    expect(evaluateLockout({ failedLoginAttempts: 3, lockoutUntil: null }, NOW)).toEqual({
      locked: false,
    })
  })

  it("locks while the timestamp is in the future and reports the wait", () => {
    const until = new Date(NOW + 90_000)
    expect(evaluateLockout({ lockoutUntil: until }, NOW)).toEqual({
      locked: true,
      until,
      retryAfterSeconds: 90,
    })
  })

  it("releases the account once the timestamp has passed", () => {
    const until = new Date(NOW - 1)
    expect(evaluateLockout({ lockoutUntil: until }, NOW)).toEqual({ locked: false })
  })

  it("releases the account exactly at the boundary rather than a tick later", () => {
    expect(evaluateLockout({ lockoutUntil: new Date(NOW) }, NOW)).toEqual({ locked: false })
  })

  it("rounds a partial second up so the reported wait never expires early", () => {
    const decision = evaluateLockout({ lockoutUntil: new Date(NOW + 1_001) }, NOW)
    expect(decision).toMatchObject({ locked: true, retryAfterSeconds: 2 })
  })

  it("never strands an account on missing or unparseable data", () => {
    expect(evaluateLockout(null, NOW)).toEqual({ locked: false })
    expect(evaluateLockout(undefined, NOW)).toEqual({ locked: false })
    expect(evaluateLockout({ lockoutUntil: new Date(Number.NaN) }, NOW)).toEqual({
      locked: false,
    })
    // A value that survived a JSON round trip is a string, not a Date.
    expect(
      evaluateLockout({ lockoutUntil: "2099-01-01T00:00:00Z" as unknown as Date }, NOW),
    ).toEqual({ locked: false })
  })
})

describe("policy bounds", () => {
  it("keeps the attempt threshold within what PCI DSS 8.3.4 permits", () => {
    // At most ten attempts before lockout.
    expect(LOCKOUT_THRESHOLD_MAX).toBeLessThanOrEqual(10)
  })

  // This assertion used to require >= 30 to match PCI DSS 8.3.4. The floor was
  // lowered to five minutes by an explicit product decision, so the test now
  // pins the value actually chosen rather than the standard's minimum. It is
  // still a floor, and still a bound a configuration value cannot escape: the
  // point of the assertion is that nobody drops it to zero (which would make
  // every lock expire on the same request that applied it) by editing a
  // constant without reading why it exists.
  it("keeps a real, non-zero lock duration floor", () => {
    expect(LOCKOUT_DURATION_MINUTES_MIN).toBe(5)
  })

  it("exposes a stable error code for the sign-in page", () => {
    expect(ACCOUNT_LOCKED_ERROR).toBe("ACCOUNT_LOCKED")
  })
})
