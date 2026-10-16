import { describe, expect, it } from "vitest"

import {
  HEAD_COUNT_DECISION_ROLES,
  HEAD_COUNT_DIRECT_WRITE_ROLES,
  HEAD_COUNT_REQUEST_ROLES,
  canDecideBranchHeadCount,
  canReadBranchHeadCountRequests,
  canRequestBranchHeadCount,
  canWriteBranchHeadCount,
} from "@/lib/branch-head-count-access"
import type { Role } from "@/lib/rbac"

/**
 * Every role, listed rather than derived, so adding a role to `Role` without
 * deciding what it may do with a head count fails here.
 */
const EVERY_ROLE: Role[] = [
  "SUPER_ADMIN",
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
  "VIEWER",
  "ORDER_DESK",
  "APRICART_EXECUTIVE",
  "WAREHOUSE",
]

describe("who may set a head count directly", () => {
  it("is Super Admin and Head Office only", () => {
    expect(EVERY_ROLE.filter(canWriteBranchHeadCount)).toEqual(["SUPER_ADMIN", "HEAD_OFFICE"])
    expect(HEAD_COUNT_DIRECT_WRITE_ROLES).toEqual(["SUPER_ADMIN", "HEAD_OFFICE"])
  })
})

describe("who may request one", () => {
  it("is Branch Admin and Group User only", () => {
    expect(EVERY_ROLE.filter(canRequestBranchHeadCount)).toEqual(["GROUP_USER", "BRANCH_ADMIN"])
  })

  it("never includes a role that may set the figure itself", () => {
    expect(HEAD_COUNT_REQUEST_ROLES.filter(canWriteBranchHeadCount)).toEqual([])
  })
})

describe("who may decide one", () => {
  it("is Head Office and nobody else", () => {
    expect(EVERY_ROLE.filter(canDecideBranchHeadCount)).toEqual(["HEAD_OFFICE"])
  })

  it("shares no role with the requesters, so no one approves their own request", () => {
    expect(HEAD_COUNT_REQUEST_ROLES.filter((role) => HEAD_COUNT_DECISION_ROLES.includes(role))).toEqual([])
  })
})

describe("who may read the queue", () => {
  it("is the requesters plus the decider", () => {
    expect(EVERY_ROLE.filter(canReadBranchHeadCountRequests))
      .toEqual(["HEAD_OFFICE", "GROUP_USER", "BRANCH_ADMIN"])
  })

  it.each([undefined, null, 7, "head_office", ""])("refuses a malformed role %s", (role) => {
    expect(canReadBranchHeadCountRequests(role)).toBe(false)
    expect(canRequestBranchHeadCount(role)).toBe(false)
    expect(canDecideBranchHeadCount(role)).toBe(false)
    expect(canWriteBranchHeadCount(role)).toBe(false)
  })
})
