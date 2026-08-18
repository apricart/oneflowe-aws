import { describe, expect, it } from "vitest"

import {
  advanceSessionPolicyClaims,
  getEffectiveSessionExpiresAt,
  getSessionExpirationReason,
  isSessionActivityUpdate,
  issueSessionPolicyClaims,
  normalizeSessionIdleTimeoutMinutes,
  SESSION_ABSOLUTE_TIMEOUT_MS,
  SESSION_ACTIVITY_UPDATE_MARKER,
  SESSION_IDLE_TIMEOUT_MINUTES_DEFAULT,
  SESSION_IDLE_TIMEOUT_MINUTES_MAX,
  SESSION_IDLE_TIMEOUT_MINUTES_MIN,
} from "@/lib/session-policy"

const START = 2_000_000_000_000
const MINUTE = 60_000

describe("session policy", () => {
  it("issues immutable absolute and bounded idle claims", () => {
    const claims = issueSessionPolicyClaims(START, 10)

    expect(claims).toEqual({
      sessionPolicyVersion: 1,
      sessionStartedAt: START,
      sessionLastActivityAt: START,
      sessionIdleTimeoutMinutes: 10,
      sessionAbsoluteExpiresAt: START + SESSION_ABSOLUTE_TIMEOUT_MS,
    })
  })

  it("enforces idle expiry exactly at the deadline", () => {
    const token = issueSessionPolicyClaims(START, 5)

    expect(getSessionExpirationReason(token, START + 5 * MINUTE - 1)).toBeNull()
    expect(getSessionExpirationReason(token, START + 5 * MINUTE)).toBe(
      "idle_timeout",
    )
  })

  it("enforces absolute expiry despite recent activity", () => {
    const token = {
      ...issueSessionPolicyClaims(START, 15),
      sessionLastActivityAt: START + SESSION_ABSOLUTE_TIMEOUT_MS - MINUTE,
    }

    expect(
      getSessionExpirationReason(
        token,
        START + SESSION_ABSOLUTE_TIMEOUT_MS - 1,
      ),
    ).toBeNull()
    expect(
      getSessionExpirationReason(token, START + SESSION_ABSOLUTE_TIMEOUT_MS),
    ).toBe("absolute_timeout")
  })

  it("does not advance activity during a passive poll", () => {
    const token = {
      sub: "user-1",
      role: "HEAD_OFFICE",
      organizationId: 17,
      ...issueSessionPolicyClaims(START, 15),
    }
    const next = advanceSessionPolicyClaims(token, {
      now: START + MINUTE,
      idleTimeoutMinutes: 15,
      recordActivity: false,
    })

    expect(next.sessionStartedAt).toBe(START)
    expect(next.sessionLastActivityAt).toBe(START)
    expect(next.sessionAbsoluteExpiresAt).toBe(
      START + SESSION_ABSOLUTE_TIMEOUT_MS,
    )
    expect(next.role).toBe("HEAD_OFFICE")
    expect(next.organizationId).toBe(17)
  })

  it("advances only idle activity after a valid explicit update", () => {
    const token = issueSessionPolicyClaims(START, 15)
    const next = advanceSessionPolicyClaims(token, {
      now: START + MINUTE,
      idleTimeoutMinutes: 10,
      recordActivity: true,
    })

    expect(next.sessionStartedAt).toBe(START)
    expect(next.sessionLastActivityAt).toBe(START + MINUTE)
    expect(next.sessionIdleTimeoutMinutes).toBe(10)
    expect(next.sessionAbsoluteExpiresAt).toBe(
      START + SESSION_ABSOLUTE_TIMEOUT_MS,
    )
    expect(getEffectiveSessionExpiresAt(next)).toBe(START + 11 * MINUTE)
  })

  it("never resurrects an already idle-expired token", () => {
    const expired = issueSessionPolicyClaims(START, 5)
    const next = advanceSessionPolicyClaims(expired, {
      now: START + 5 * MINUTE,
      idleTimeoutMinutes: 15,
      recordActivity: true,
    })

    expect(next.sessionInvalidReason).toBe("idle_timeout")
    expect(next.sessionLastActivityAt).toBe(START)
    expect(getSessionExpirationReason(next, START + 5 * MINUTE)).toBe(
      "idle_timeout",
    )
  })

  it("applies a tightened tenant policy before recording activity", () => {
    const token = issueSessionPolicyClaims(START, 15)
    const next = advanceSessionPolicyClaims(token, {
      now: START + 6 * MINUTE,
      idleTimeoutMinutes: 5,
      recordActivity: true,
    })

    expect(next.sessionInvalidReason).toBe("idle_timeout")
    expect(next.sessionLastActivityAt).toBe(START)
  })

  it("fails closed for legacy, malformed, and future-extending policies", () => {
    const valid = issueSessionPolicyClaims(START, 15)

    expect(getSessionExpirationReason({ sub: "legacy" }, START)).toBe(
      "invalid_policy",
    )
    expect(
      getSessionExpirationReason(
        { ...valid, sessionLastActivityAt: Number.NaN },
        START,
      ),
    ).toBe("invalid_policy")
    expect(
      getSessionExpirationReason(
        { ...valid, sessionLastActivityAt: START - 1 },
        START,
      ),
    ).toBe("invalid_policy")
    expect(
      getSessionExpirationReason(
        {
          ...valid,
          sessionAbsoluteExpiresAt:
            START + SESSION_ABSOLUTE_TIMEOUT_MS + 1,
        },
        START,
      ),
    ).toBe("invalid_policy")
    expect(
      getSessionExpirationReason(
        { ...valid, sessionStartedAt: START + 60_001 },
        START,
      ),
    ).toBe("invalid_policy")
  })

  it("normalizes configuration without weakening stricter tenant values", () => {
    expect(normalizeSessionIdleTimeoutMinutes("1")).toBe(
      SESSION_IDLE_TIMEOUT_MINUTES_MIN,
    )
    expect(normalizeSessionIdleTimeoutMinutes(999)).toBe(
      SESSION_IDLE_TIMEOUT_MINUTES_MAX,
    )
    expect(normalizeSessionIdleTimeoutMinutes(7.5)).toBe(
      SESSION_IDLE_TIMEOUT_MINUTES_DEFAULT,
    )
    expect(normalizeSessionIdleTimeoutMinutes(false, 7)).toBe(7)
  })

  it("recognizes only the exact activity update marker", () => {
    expect(
      isSessionActivityUpdate({ activity: SESSION_ACTIVITY_UPDATE_MARKER }),
    ).toBe(true)
    expect(isSessionActivityUpdate({ activity: true })).toBe(false)
    expect(isSessionActivityUpdate(null)).toBe(false)
  })
})
