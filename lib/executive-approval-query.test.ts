import { describe, expect, it } from "vitest"

import {
  EXECUTIVE_APPROVAL_PAGE_SIZE_DEFAULT,
  EXECUTIVE_APPROVAL_PAGE_SIZE_MAX,
  EXECUTIVE_APPROVAL_SEARCH_MAX_LENGTH,
  executiveApprovalActions,
  executiveApprovalSelection,
  parseExecutiveApprovalListQuery,
} from "@/lib/executive-approval-query"

const parse = (query: string) => parseExecutiveApprovalListQuery(new URLSearchParams(query))

describe("the executive's approval list query", () => {
  it("starts on the orders waiting for approval, first page, default size", () => {
    expect(parse("")).toEqual({
      ok: true,
      value: { tab: "awaiting_approval", organizationId: null, search: "", page: 1, limit: EXECUTIVE_APPROVAL_PAGE_SIZE_DEFAULT },
    })
  })

  it("accepts every tab, in any case", () => {
    for (const tab of ["awaiting_approval", "returned", "approved", "rejected", "all"]) {
      const result = parse(`status=${tab.toUpperCase()}`)
      expect(result.ok && result.value.tab).toBe(tab)
    }
  })

  it("refuses an unknown tab", () => {
    expect(parse("status=delivered")).toEqual({ ok: false, error: expect.stringMatching(/status must be one of/) })
  })

  it("refuses an organization id that is not a positive integer", () => {
    for (const bad of ["0", "-1", "1.5", "abc", "1e3x"]) {
      expect(parse(`organizationId=${bad}`).ok, bad).toBe(false)
    }
    const result = parse("organizationId=11")
    expect(result.ok && result.value.organizationId).toBe(11)
  })

  it("bounds the page size and the page, and falls back on nonsense", () => {
    const big = parse("limit=1000&page=999999999")
    expect(big.ok && big.value.limit).toBe(EXECUTIVE_APPROVAL_PAGE_SIZE_MAX)
    expect(big.ok && big.value.page).toBe(10_000)
    const junk = parse("limit=-3&page=zero")
    expect(junk.ok && junk.value.limit).toBe(EXECUTIVE_APPROVAL_PAGE_SIZE_DEFAULT)
    expect(junk.ok && junk.value.page).toBe(1)
  })

  it("trims the search and refuses one that is too long", () => {
    const trimmed = parse("q=%20%20TID-9%20")
    expect(trimmed.ok && trimmed.value.search).toBe("TID-9")
    expect(parse(`q=${"x".repeat(EXECUTIVE_APPROVAL_SEARCH_MAX_LENGTH + 1)}`).ok).toBe(false)
  })
})

describe("what each tab selects", () => {
  it("splits pending orders by whether they are with the desk", () => {
    expect(executiveApprovalSelection("awaiting_approval")).toEqual({ kind: "pending", returned: false })
    expect(executiveApprovalSelection("returned")).toEqual({ kind: "pending", returned: true })
  })

  it("selects decided orders and everything", () => {
    expect(executiveApprovalSelection("approved")).toEqual({ kind: "approved" })
    expect(executiveApprovalSelection("rejected")).toEqual({ kind: "rejected" })
    expect(executiveApprovalSelection("all")).toEqual({ kind: "all" })
  })
})

describe("what the executive may do", () => {
  it("approves, rejects or returns an order awaiting approval", () => {
    expect(executiveApprovalActions({ status: "PENDING", returnedForCorrectionAt: null }))
      .toEqual({ canApprove: true, canReject: true, canReturn: true })
  })

  it("may only reject an order that is with the desk for correction", () => {
    expect(executiveApprovalActions({ status: "pending", returnedForCorrectionAt: "2026-10-06T09:00:00.000Z" }))
      .toEqual({ canApprove: false, canReject: true, canReturn: false })
  })

  it.each(["APPROVED", "REJECTED", "CANCELLED", "FULFILLED", ""])("does nothing with a %s order", (status) => {
    expect(executiveApprovalActions({ status, returnedForCorrectionAt: null }))
      .toEqual({ canApprove: false, canReject: false, canReturn: false })
  })
})
