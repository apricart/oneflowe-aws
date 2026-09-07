import { describe, expect, it } from "vitest"

import {
  SUPPORT_PARTICIPANT_ROLES,
  canManageSupportThread,
  canPostSupportMessage,
  canRaiseSupportThread,
  canReadSupportThread,
  canReferenceOrderInSupportThread,
  supportThreadVisibilityScope,
  type SupportViewer,
} from "./support-access"
import type { SupportStatus } from "./support-thread"

const APRICART: SupportViewer = {
  userId: "apricart-1",
  role: "SUPER_ADMIN",
  organizationId: null,
  branchId: null,
}
const HEAD_OFFICE: SupportViewer = {
  userId: "ho-1",
  role: "HEAD_OFFICE",
  organizationId: 10,
  branchId: null,
}
const BRANCH_ADMIN: SupportViewer = {
  userId: "ba-1",
  role: "BRANCH_ADMIN",
  organizationId: 10,
  branchId: 5,
}
const ORDER_PORTAL: SupportViewer = {
  userId: "op-1",
  role: "ORDER_PORTAL",
  organizationId: 10,
  branchId: 5,
}
const GROUP_ORDER_PORTAL: SupportViewer = {
  userId: "gop-1",
  role: "GROUP_ORDER_PORTAL",
  organizationId: 10,
  branchId: null,
}
const GROUP_USER: SupportViewer = {
  userId: "gu-1",
  role: "GROUP_USER",
  organizationId: 10,
  branchId: null,
}

/** A thread raised by the Order Portal user on branch 5 of organization 10. */
const ownThread = {
  organizationId: 10,
  branchId: 5,
  createdByUserId: "op-1",
}
/** Someone else's thread, same branch. */
const peerThread = {
  organizationId: 10,
  branchId: 5,
  createdByUserId: "op-2",
}
/** Someone else's thread, a different branch of the same organization. */
const otherBranchThread = {
  organizationId: 10,
  branchId: 6,
  createdByUserId: "op-3",
}
/** Another tenant entirely. */
const otherTenantThread = {
  organizationId: 11,
  branchId: 7,
  createdByUserId: "op-4",
}

describe("the visibility scope each role is narrowed to", () => {
  it("gives Apricart the whole platform", () => {
    expect(supportThreadVisibilityScope(APRICART)).toEqual({ kind: "all" })
  })

  it("gives Head Office its organization", () => {
    expect(supportThreadVisibilityScope(HEAD_OFFICE)).toEqual({
      kind: "organization",
      organizationId: 10,
    })
  })

  it("gives a branch administrator its branch and its own threads", () => {
    expect(supportThreadVisibilityScope(BRANCH_ADMIN)).toEqual({
      kind: "branch",
      organizationId: 10,
      branchId: 5,
      userId: "ba-1",
    })
  })

  it("gives every requester role only what it raised", () => {
    for (const viewer of [ORDER_PORTAL, GROUP_USER, GROUP_ORDER_PORTAL]) {
      expect(supportThreadVisibilityScope(viewer)).toEqual({
        kind: "own",
        organizationId: 10,
        userId: viewer.userId,
      })
    }
  })

  it("refuses a session with no tenant rather than widening it", () => {
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL", "GROUP_USER"]) {
      expect(
        supportThreadVisibilityScope({
          userId: "u",
          role,
          organizationId: null,
          branchId: 5,
        }),
      ).toEqual({ kind: "none" })
    }
  })

  it("refuses a role that is not a participant", () => {
    for (const role of [null, undefined, "", "SUPPLIER", "super_admin"]) {
      expect(supportThreadVisibilityScope({ userId: "u", role, organizationId: 10, branchId: 5 }))
        .toEqual({ kind: "none" })
    }
  })

  it("refuses a viewer with no user id", () => {
    expect(
      supportThreadVisibilityScope({ userId: "", role: "SUPER_ADMIN", organizationId: null, branchId: null }),
    ).toEqual({ kind: "none" })
  })

  it("narrows a branch administrator with no branch to its own threads", () => {
    expect(
      supportThreadVisibilityScope({ ...BRANCH_ADMIN, branchId: null }),
    ).toEqual({ kind: "own", organizationId: 10, userId: "ba-1" })
  })
})

describe("reading a thread", () => {
  it("lets Apricart read every thread, including across tenants", () => {
    for (const thread of [ownThread, peerThread, otherBranchThread, otherTenantThread]) {
      expect(canReadSupportThread({ viewer: APRICART, thread })).toBe(true)
    }
  })

  it("lets Head Office read every thread in its own organization", () => {
    for (const thread of [ownThread, peerThread, otherBranchThread]) {
      expect(canReadSupportThread({ viewer: HEAD_OFFICE, thread })).toBe(true)
    }
  })

  it("lets a branch administrator read its own branch but not a sibling branch", () => {
    expect(canReadSupportThread({ viewer: BRANCH_ADMIN, thread: peerThread })).toBe(true)
    expect(canReadSupportThread({ viewer: BRANCH_ADMIN, thread: otherBranchThread })).toBe(false)
  })

  it("lets a branch administrator read a thread it raised even with no branch on it", () => {
    expect(
      canReadSupportThread({
        viewer: BRANCH_ADMIN,
        thread: { organizationId: 10, branchId: null, createdByUserId: "ba-1" },
      }),
    ).toBe(true)
  })

  it("confines the Order Portal to threads it raised, not its branch's", () => {
    expect(canReadSupportThread({ viewer: ORDER_PORTAL, thread: ownThread })).toBe(true)
    expect(canReadSupportThread({ viewer: ORDER_PORTAL, thread: peerThread })).toBe(false)
  })

  it("confines the group roles to threads they raised", () => {
    for (const viewer of [GROUP_USER, GROUP_ORDER_PORTAL]) {
      expect(
        canReadSupportThread({
          viewer,
          thread: { organizationId: 10, branchId: 5, createdByUserId: viewer.userId },
        }),
      ).toBe(true)
      // Explicitly not widened to the branches they cover.
      expect(canReadSupportThread({ viewer, thread: peerThread })).toBe(false)
    }
  })

  it("denies every client role a thread belonging to another tenant", () => {
    for (const viewer of [HEAD_OFFICE, BRANCH_ADMIN, ORDER_PORTAL, GROUP_USER, GROUP_ORDER_PORTAL]) {
      expect(canReadSupportThread({ viewer, thread: otherTenantThread })).toBe(false)
    }
  })

  it("denies a thread that a same-id user raised in another tenant", () => {
    // A user id colliding across tenants must not be enough on its own: the
    // organization is checked as well as the creator.
    expect(
      canReadSupportThread({
        viewer: ORDER_PORTAL,
        thread: { organizationId: 11, branchId: 5, createdByUserId: "op-1" },
      }),
    ).toBe(false)
  })

  it("denies a missing thread", () => {
    expect(canReadSupportThread({ viewer: APRICART, thread: null })).toBe(false)
    expect(canReadSupportThread({ viewer: APRICART, thread: undefined })).toBe(false)
  })
})

describe("posting to a thread", () => {
  const withStatus = (status: SupportStatus) => ({ ...ownThread, status })

  it("lets a participant post to a live thread", () => {
    for (const status of ["OPEN", "AWAITING_CUSTOMER", "RESOLVED"] as SupportStatus[]) {
      expect(canPostSupportMessage({ viewer: ORDER_PORTAL, thread: withStatus(status) })).toBe(true)
    }
  })

  it("stops everyone posting to a closed thread, Apricart included", () => {
    for (const viewer of [APRICART, HEAD_OFFICE, BRANCH_ADMIN, ORDER_PORTAL]) {
      expect(canPostSupportMessage({ viewer, thread: withStatus("CLOSED") })).toBe(false)
    }
  })

  it("never lets a non-reader post", () => {
    expect(
      canPostSupportMessage({
        viewer: ORDER_PORTAL,
        thread: { ...peerThread, status: "OPEN" },
      }),
    ).toBe(false)
  })
})

describe("raising and triaging", () => {
  it("lets every participant role raise a thread", () => {
    for (const role of SUPPORT_PARTICIPANT_ROLES) {
      expect(canRaiseSupportThread(role)).toBe(true)
    }
  })

  it("refuses to let a non-participant raise one", () => {
    for (const role of [null, undefined, "", "SUPPLIER"]) {
      expect(canRaiseSupportThread(role)).toBe(false)
    }
  })

  it("keeps triage with Apricart alone", () => {
    expect(canManageSupportThread("SUPER_ADMIN")).toBe(true)
    for (const role of ["HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "GROUP_ORDER_PORTAL", "ORDER_PORTAL", null]) {
      expect(canManageSupportThread(role)).toBe(false)
    }
  })
})

describe("which order a thread may cite", () => {
  const ownOrder = {
    organizationId: 10,
    branchId: 5,
    createdByUserId: "op-1",
    groupOrderId: null,
  }
  const peerOrder = { ...ownOrder, createdByUserId: "op-2" }
  const groupOrder = { ...peerOrder, groupOrderId: 77 }
  const otherBranchOrder = { ...ownOrder, branchId: 6 }
  const otherTenantOrder = { ...ownOrder, organizationId: 11 }

  it("lets Apricart cite any order at all", () => {
    for (const order of [ownOrder, peerOrder, otherBranchOrder, otherTenantOrder]) {
      expect(canReferenceOrderInSupportThread({ viewer: APRICART, order })).toBe(true)
    }
  })

  it("lets Head Office cite any order in its organization but not another tenant's", () => {
    expect(canReferenceOrderInSupportThread({ viewer: HEAD_OFFICE, order: otherBranchOrder })).toBe(true)
    expect(canReferenceOrderInSupportThread({ viewer: HEAD_OFFICE, order: otherTenantOrder })).toBe(false)
  })

  it("pins a branch administrator to its own branch", () => {
    expect(canReferenceOrderInSupportThread({ viewer: BRANCH_ADMIN, order: peerOrder })).toBe(true)
    expect(canReferenceOrderInSupportThread({ viewer: BRANCH_ADMIN, order: otherBranchOrder })).toBe(false)
  })

  it("lets the Order Portal cite its own order and a group order for its branch", () => {
    expect(canReferenceOrderInSupportThread({ viewer: ORDER_PORTAL, order: ownOrder })).toBe(true)
    expect(canReferenceOrderInSupportThread({ viewer: ORDER_PORTAL, order: groupOrder })).toBe(true)
  })

  it("stops the Order Portal citing a colleague's ordinary order", () => {
    expect(canReferenceOrderInSupportThread({ viewer: ORDER_PORTAL, order: peerOrder })).toBe(false)
  })

  it("stops the Order Portal citing anything off its branch", () => {
    expect(canReferenceOrderInSupportThread({ viewer: ORDER_PORTAL, order: otherBranchOrder })).toBe(false)
    expect(
      canReferenceOrderInSupportThread({
        viewer: ORDER_PORTAL,
        order: { ...groupOrder, branchId: 6 },
      }),
    ).toBe(false)
  })

  it("lets a group role cite an order on a branch it covers", () => {
    expect(
      canReferenceOrderInSupportThread({
        viewer: GROUP_ORDER_PORTAL,
        order: peerOrder,
        scopedBranchIds: [5, 6],
      }),
    ).toBe(true)
  })

  it("stops a group role citing a branch outside its assignments", () => {
    expect(
      canReferenceOrderInSupportThread({
        viewer: GROUP_ORDER_PORTAL,
        order: peerOrder,
        scopedBranchIds: [6, 7],
      }),
    ).toBe(false)
  })

  it("still lets a group role cite an order it raised, even with no assignments left", () => {
    // Assignments can be taken away after the order was placed. The person who
    // raised it can still ask about it.
    expect(
      canReferenceOrderInSupportThread({
        viewer: GROUP_ORDER_PORTAL,
        order: { ...peerOrder, createdByUserId: "gop-1" },
        scopedBranchIds: [],
      }),
    ).toBe(true)
  })

  it("treats an omitted assignment list as no assignments, not as every branch", () => {
    expect(
      canReferenceOrderInSupportThread({ viewer: GROUP_ORDER_PORTAL, order: peerOrder }),
    ).toBe(false)
  })

  it("denies a missing order and a non-participant", () => {
    expect(canReferenceOrderInSupportThread({ viewer: APRICART, order: null })).toBe(false)
    expect(
      canReferenceOrderInSupportThread({
        viewer: { userId: "u", role: "SUPPLIER", organizationId: 10, branchId: 5 },
        order: ownOrder,
      }),
    ).toBe(false)
  })

  it("denies an order with no organization of its own", () => {
    expect(
      canReferenceOrderInSupportThread({
        viewer: HEAD_OFFICE,
        order: { ...ownOrder, organizationId: null },
      }),
    ).toBe(false)
  })
})
