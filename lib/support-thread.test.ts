import { describe, expect, it } from "vitest"

import {
  SUPPORT_STATUSES,
  canTransitionSupportStatus,
  isTerminalSupportStatus,
  nextSupportStatusAfterMessage,
  parseSupportThreadReference,
  supportSideForRole,
  supportThreadReference,
  type SupportSide,
  type SupportStatus,
} from "./support-thread"

describe("which side of the conversation a role speaks for", () => {
  it("puts Apricart on the operator side", () => {
    expect(supportSideForRole("SUPER_ADMIN")).toBe("APRICART")
  })

  it("puts every client role on the customer side", () => {
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "GROUP_ORDER_PORTAL", "ORDER_PORTAL"]) {
      expect(supportSideForRole(role)).toBe("CUSTOMER")
    }
  })

  it("treats an absent or unrecognised role as a customer, never as Apricart", () => {
    for (const role of [null, undefined, "", "ADMIN", "super_admin"]) {
      expect(supportSideForRole(role)).toBe("CUSTOMER")
    }
  })
})

describe("posting a message moves the thread", () => {
  it("hands a thread back to Apricart when the customer writes", () => {
    for (const from of ["OPEN", "AWAITING_CUSTOMER", "RESOLVED"] as SupportStatus[]) {
      expect(nextSupportStatusAfterMessage(from, "CUSTOMER")).toBe("OPEN")
    }
  })

  it("hands a thread back to the customer when Apricart writes", () => {
    for (const from of ["OPEN", "AWAITING_CUSTOMER", "RESOLVED"] as SupportStatus[]) {
      expect(nextSupportStatusAfterMessage(from, "APRICART")).toBe("AWAITING_CUSTOMER")
    }
  })

  it("reopens a resolved thread rather than leaving it settled", () => {
    expect(nextSupportStatusAfterMessage("RESOLVED", "CUSTOMER")).toBe("OPEN")
  })

  it("leaves a closed thread closed, for either side", () => {
    expect(nextSupportStatusAfterMessage("CLOSED", "CUSTOMER")).toBe("CLOSED")
    expect(nextSupportStatusAfterMessage("CLOSED", "APRICART")).toBe("CLOSED")
  })

  it("recognises exactly one terminal status", () => {
    const terminal = SUPPORT_STATUSES.filter(isTerminalSupportStatus)
    expect(terminal).toEqual(["CLOSED"])
  })
})

describe("hand-made status transitions", () => {
  const allow = (from: SupportStatus, to: SupportStatus, side: SupportSide) =>
    canTransitionSupportStatus({ from, to, side }).ok

  it("lets either side resolve a live thread", () => {
    for (const side of ["CUSTOMER", "APRICART"] as SupportSide[]) {
      expect(allow("OPEN", "RESOLVED", side)).toBe(true)
      expect(allow("AWAITING_CUSTOMER", "RESOLVED", side)).toBe(true)
    }
  })

  it("lets either side reopen a resolved thread", () => {
    for (const side of ["CUSTOMER", "APRICART"] as SupportSide[]) {
      expect(allow("RESOLVED", "OPEN", side)).toBe(true)
    }
  })

  it("lets only Apricart close a thread", () => {
    expect(allow("OPEN", "CLOSED", "APRICART")).toBe(true)
    expect(allow("RESOLVED", "CLOSED", "APRICART")).toBe(true)
    expect(allow("OPEN", "CLOSED", "CUSTOMER")).toBe(false)
    expect(allow("RESOLVED", "CLOSED", "CUSTOMER")).toBe(false)
  })

  it("lets only Apricart reopen a closed thread", () => {
    expect(allow("CLOSED", "OPEN", "APRICART")).toBe(true)
    expect(allow("CLOSED", "OPEN", "CUSTOMER")).toBe(false)
  })

  it("refuses to resolve a closed thread from either side", () => {
    expect(allow("CLOSED", "RESOLVED", "APRICART")).toBe(false)
    expect(allow("CLOSED", "RESOLVED", "CUSTOMER")).toBe(false)
  })

  it("never lets awaiting-reply be set by hand — posting is what sets it", () => {
    for (const from of SUPPORT_STATUSES) {
      for (const side of ["CUSTOMER", "APRICART"] as SupportSide[]) {
        expect(allow(from, "AWAITING_CUSTOMER", side)).toBe(false)
      }
    }
  })

  it("refuses to move a live thread to open by hand", () => {
    expect(allow("AWAITING_CUSTOMER", "OPEN", "CUSTOMER")).toBe(false)
    expect(allow("AWAITING_CUSTOMER", "OPEN", "APRICART")).toBe(false)
  })

  it("refuses a no-op transition and says so", () => {
    for (const status of SUPPORT_STATUSES) {
      const result = canTransitionSupportStatus({ from: status, to: status, side: "APRICART" })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.reason).toMatch(/already/i)
    }
  })

  it("gives a reason a client can be shown for every refusal", () => {
    for (const from of SUPPORT_STATUSES) {
      for (const to of SUPPORT_STATUSES) {
        for (const side of ["CUSTOMER", "APRICART"] as SupportSide[]) {
          const result = canTransitionSupportStatus({ from, to, side })
          if (!result.ok) {
            expect(result.reason.length).toBeGreaterThan(0)
            expect(result.reason).not.toMatch(/undefined|null/)
          }
        }
      }
    }
  })
})

describe("the human reference", () => {
  it("pads to six digits", () => {
    expect(supportThreadReference(1)).toBe("SUP-000001")
    expect(supportThreadReference(123)).toBe("SUP-000123")
  })

  it("grows past six digits rather than truncating", () => {
    expect(supportThreadReference(12345678)).toBe("SUP-12345678")
  })

  it("refuses to invent a reference for something that is not an id", () => {
    for (const id of [0, -1, 1.5, Number.NaN]) {
      expect(supportThreadReference(id)).toBe("SUP-------")
    }
  })

  it("round-trips through the parser", () => {
    for (const id of [1, 42, 999999, 1000000]) {
      expect(parseSupportThreadReference(supportThreadReference(id))).toBe(id)
    }
  })

  it("accepts a bare number and a lowercase prefix, the way a person types one", () => {
    expect(parseSupportThreadReference("123")).toBe(123)
    expect(parseSupportThreadReference("sup-000123")).toBe(123)
    expect(parseSupportThreadReference("  SUP-123  ")).toBe(123)
  })

  it("rejects anything else", () => {
    for (const value of ["", "SUP-", "SUP-abc", "12a", null, undefined, "SUP-0", "0"]) {
      expect(parseSupportThreadReference(value)).toBeNull()
    }
  })
})
