import { describe, expect, it } from "vitest"

import {
  SUPPORT_CATEGORIES,
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_ORDER_SEARCH_MAX_LENGTH,
  SUPPORT_RETIRED_CATEGORIES,
  SUPPORT_SELECTABLE_CATEGORIES,
  SUPPORT_STATUSES,
  isSelectableSupportCategory,
  isSupportCategory,
  isProductRequiredForCategory,
  canTransitionSupportStatus,
  isTerminalSupportStatus,
  nextSupportStatusAfterMessage,
  parseSupportOrderSearch,
  parseSupportThreadReference,
  supportOrderSearchId,
  supportSideForRole,
  supportThreadReference,
  type SupportSide,
  type SupportStatus,
} from "./support-thread"

describe("which side of the conversation a role speaks for", () => {
  it("puts Apricart on the operator side", () => {
    expect(supportSideForRole("SUPER_ADMIN")).toBe("APRICART")
  })

  it("puts the Apricart Support agent on the operator side too", () => {
    expect(supportSideForRole("APRICART_SUPPORT")).toBe("APRICART")
  })

  it("keeps Apricart's other staff roles off the operator side", () => {
    // They are Apricart's people, but not on the support queue: none of them
    // may speak for Apricart in a client's conversation.
    for (const role of ["ORDER_DESK", "APRICART_EXECUTIVE", "WAREHOUSE", "VIEWER"]) {
      expect(supportSideForRole(role), role).toBe("CUSTOMER")
    }
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


describe("retiring a category narrows the write path, not the vocabulary", () => {
  it("still recognises a retired category, so an existing thread keeps its label", () => {
    // A thread raised under BILLING before it was retired must not start
    // printing a raw "BILLING" in the list, and must stay reachable by filter.
    for (const retired of SUPPORT_RETIRED_CATEGORIES) {
      expect(isSupportCategory(retired), `${retired} must stay readable`).toBe(true)
      expect(SUPPORT_CATEGORIES).toContain(retired)
      expect(SUPPORT_CATEGORY_LABELS[retired]).toBeTruthy()
    }
  })

  it("refuses a retired category for a new thread", () => {
    for (const retired of SUPPORT_RETIRED_CATEGORIES) {
      expect(isSelectableSupportCategory(retired), `${retired} must not be raisable`).toBe(false)
      expect(SUPPORT_SELECTABLE_CATEGORIES).not.toContain(retired)
    }
  })

  it("keeps the selectable list exactly the vocabulary minus the retired set", () => {
    // The two are declared separately because `z.enum` needs a literal tuple.
    // This is what stops them drifting.
    const expected = SUPPORT_CATEGORIES.filter(
      (category) => !(SUPPORT_RETIRED_CATEGORIES as readonly string[]).includes(category),
    )
    expect([...SUPPORT_SELECTABLE_CATEGORIES]).toEqual(expected)
  })

  it("labels every selectable category", () => {
    for (const category of SUPPORT_SELECTABLE_CATEGORIES) {
      expect(SUPPORT_CATEGORY_LABELS[category]).toBeTruthy()
    }
  })

  it("accepts every selectable category as readable too", () => {
    for (const category of SUPPORT_SELECTABLE_CATEGORIES) {
      expect(isSupportCategory(category)).toBe(true)
      expect(isSelectableSupportCategory(category)).toBe(true)
    }
  })

  it("rejects anything that is not a category at all", () => {
    for (const value of [undefined, null, "", "billing", "BILLING_AND_PAYMENT", 3]) {
      expect(isSelectableSupportCategory(value)).toBe(false)
    }
  })
})

describe("searching the queue by order id", () => {
  it("reads nothing typed as an absent search, not a search for nothing", () => {
    // The distinction matters: a blank field must leave the list unfiltered
    // rather than filter it down to the threads citing an empty reference.
    for (const value of [null, undefined, "", "   ", "\t\n"]) {
      expect(parseSupportOrderSearch(value)).toEqual({ ok: true, term: null })
    }
  })

  it("trims what the person typed", () => {
    expect(parseSupportOrderSearch("  ORD-000123  ")).toEqual({ ok: true, term: "ORD-000123" })
  })

  it("keeps a term the length of the column that holds an order reference", () => {
    const term = "A".repeat(SUPPORT_ORDER_SEARCH_MAX_LENGTH)
    expect(parseSupportOrderSearch(term)).toEqual({ ok: true, term })
  })

  it("refuses a longer term rather than truncating it", () => {
    // Truncating would search for something shorter, and so broader, than what
    // was typed — the list would answer with rows the person did not ask for.
    const result = parseSupportOrderSearch("A".repeat(SUPPORT_ORDER_SEARCH_MAX_LENGTH + 1))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(String(SUPPORT_ORDER_SEARCH_MAX_LENGTH))
  })

  it("refuses anything that is not text at all", () => {
    for (const value of [7, {}, [], true]) {
      expect(parseSupportOrderSearch(value).ok).toBe(false)
    }
  })

  it("keeps a wildcard as a literal term for the caller to escape", () => {
    // The parser does not neuter `%`; escaping belongs to the query layer,
    // which knows it is building a LIKE pattern.
    expect(parseSupportOrderSearch("100%")).toEqual({ ok: true, term: "100%" })
  })

  it("recognises a bare number as an internal order id", () => {
    expect(supportOrderSearchId("42")).toBe(42)
    expect(supportOrderSearchId("0042")).toBe(42)
  })

  it("does not read a reference or a partial one as an id", () => {
    for (const term of ["ORD-42", "42-A", "4 2", "42.0", "-42", "1e3", ""]) {
      expect(supportOrderSearchId(term), `${term} is not an id`).toBeNull()
    }
  })

  it("refuses zero and anything past the safe integer range", () => {
    expect(supportOrderSearchId("0")).toBeNull()
    expect(supportOrderSearchId("9".repeat(30))).toBeNull()
  })
})

describe("which categories must name a product", () => {
  it("requires one of every category that is about something in the catalogue", () => {
    for (const category of ["INVOICE", "ORDER", "DELIVERY", "PRODUCT"] as const) {
      expect(isProductRequiredForCategory(category), `${category} must name a product`).toBe(true)
    }
  })

  it("leaves it optional under OTHER, and only under OTHER", () => {
    expect(isProductRequiredForCategory("OTHER")).toBe(false)

    const optional = SUPPORT_SELECTABLE_CATEGORIES.filter(
      (category) => !isProductRequiredForCategory(category),
    )
    expect(optional).toEqual(["OTHER"])
  })
})
