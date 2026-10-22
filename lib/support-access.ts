/**
 * Who may read, answer and triage a support thread.
 *
 * A support thread is a conversation between one client organization and
 * Apricart. Apricart — `SUPER_ADMIN`, and the `APRICART_SUPPORT` agent who works
 * the queue (`SUPPORT_APRICART_ROLES`) — is a participant in every thread. On
 * the client side the participants are the person who raised it and the people
 * already accountable for that branch's orders:
 *
 * | Viewer                              | Sees                                       |
 * |-------------------------------------|--------------------------------------------|
 * | `SUPER_ADMIN`, `APRICART_SUPPORT`   | every thread, every organization           |
 * | `WAREHOUSE`                         | threads at a branch it serves, or citing an order at one |
 * | `HEAD_OFFICE`                       | every thread in their organization         |
 * | `BRANCH_ADMIN`                      | threads on their branch, plus their own    |
 * | `ORDER_PORTAL`                      | threads they raised                        |
 * | `GROUP_USER`, `GROUP_ORDER_PORTAL`  | threads they raised                        |
 *
 * The group roles are deliberately **not** widened to their assigned branch
 * set. They are neither the branch's administrator nor the organization's head
 * office, so they sit outside the chain this feature describes; widening them
 * would put one requester's complaint in front of another. Doing it later is a
 * change to `supportThreadVisibilityScope` and nothing else.
 *
 * The warehouse is on Apricart's side of the conversation but its queue is
 * fenced to the branches it serves (`reachBranchIds`, loaded from the database
 * by `withSupportReach`); see plans/OF-WAREHOUSE-support-queue.md.
 *
 * This module is pure — no database, no session, no request. It decides the
 * rule; callers supply the facts and are responsible for having read those
 * facts from the session rather than from the request.
 */

import {
  readsWholeSupportQueue,
  isTerminalSupportStatus,
  supportSideForRole,
  type SupportStatus,
} from "@/lib/support-thread"
import { isWarehouseRole } from "@/lib/warehouse-access"

/** Every role that may hold a conversation with Apricart. */
export const SUPPORT_PARTICIPANT_ROLES = [
  "SUPER_ADMIN",
  "APRICART_SUPPORT",
  "WAREHOUSE",
  "HEAD_OFFICE",
  "BRANCH_ADMIN",
  "GROUP_USER",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
] as const

export type SupportParticipantRole = (typeof SUPPORT_PARTICIPANT_ROLES)[number]

export function isSupportParticipantRole(value: unknown): value is SupportParticipantRole {
  return (
    typeof value === "string" &&
    SUPPORT_PARTICIPANT_ROLES.includes(value as SupportParticipantRole)
  )
}

/** The viewer, as read from the session. Never from a request body. */
export type SupportViewer = {
  userId: string
  role: string | null | undefined
  organizationId: number | null | undefined
  branchId: number | null | undefined
  /**
   * The branches a `WAREHOUSE` viewer serves, read from the database by
   * `withSupportReach` — never from the session or the request. Absent means
   * not loaded, and a warehouse viewer without it reads nothing.
   */
  reachBranchIds?: readonly number[] | null
}

/** The parts of a thread the visibility rule needs. Structural, so it stays DB-free. */
export type SupportThreadSubject = {
  organizationId: number
  branchId: number | null | undefined
  createdByUserId: string
  /** The branch of the order the thread cites, when it cites one of its own tenant. */
  orderBranchId?: number | null
}

/**
 * How a viewer's thread list is narrowed.
 *
 * - `all`          — every thread on the platform (Apricart's whole queue).
 * - `branches`     — threads at one of `branchIds`, or citing an order at one
 *                    (the warehouse).
 * - `organization` — every thread in `organizationId`.
 * - `branch`       — threads on `branchId`, plus threads this viewer raised.
 * - `own`          — threads this viewer raised, inside their organization.
 * - `none`         — nothing; the role is not a participant, or its session is
 *                    missing the scope its role requires.
 *
 * A list endpoint builds its `where` clause from this rather than from a role
 * comparison, so the list and the single-thread read cannot drift apart.
 */
export type SupportVisibilityScope =
  | { kind: "all" }
  | { kind: "branches"; branchIds: number[] }
  | { kind: "organization"; organizationId: number }
  | { kind: "branch"; organizationId: number; branchId: number; userId: string }
  | { kind: "own"; organizationId: number; userId: string }
  | { kind: "none" }

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

export function supportThreadVisibilityScope(viewer: SupportViewer): SupportVisibilityScope {
  if (!viewer?.userId || !isSupportParticipantRole(viewer.role)) return { kind: "none" }

  if (readsWholeSupportQueue(viewer.role)) return { kind: "all" }

  if (isWarehouseRole(viewer.role)) {
    // Its reach is the branches it serves, never an organization and never its
    // session's claims. Not loaded, or empty, is nothing — never everything.
    const branchIds = [...new Set((viewer.reachBranchIds ?? []).map(positiveInteger))]
      .filter((id): id is number => id !== null)
      .sort((a, b) => a - b)
    return branchIds.length === 0 ? { kind: "none" } : { kind: "branches", branchIds }
  }

  // Every other role is pinned to a tenant. A session without one is refused
  // rather than widened — an absent organization is not "all organizations".
  const organizationId = positiveInteger(viewer.organizationId)
  if (organizationId === null) return { kind: "none" }

  if (viewer.role === "HEAD_OFFICE") return { kind: "organization", organizationId }

  if (viewer.role === "BRANCH_ADMIN") {
    const branchId = positiveInteger(viewer.branchId)
    // A branch administrator with no branch on their session still reads what
    // they raised themselves; they simply have no branch to read for.
    return branchId === null
      ? { kind: "own", organizationId, userId: viewer.userId }
      : { kind: "branch", organizationId, branchId, userId: viewer.userId }
  }

  return { kind: "own", organizationId, userId: viewer.userId }
}

/**
 * May this viewer read this thread?
 *
 * The single-thread answer, derived from the same scope the list uses so the
 * two can never disagree.
 */
export function canReadSupportThread(input: {
  viewer: SupportViewer
  thread: SupportThreadSubject | null | undefined
}): boolean {
  const { viewer, thread } = input
  if (!thread) return false

  const scope = supportThreadVisibilityScope(viewer)
  switch (scope.kind) {
    case "all":
      return true
    case "branches":
      return [thread.branchId, thread.orderBranchId].some(
        (branchId) => typeof branchId === "number" && scope.branchIds.includes(branchId),
      )
    case "organization":
      return thread.organizationId === scope.organizationId
    case "branch":
      return (
        thread.organizationId === scope.organizationId &&
        (thread.branchId === scope.branchId || thread.createdByUserId === scope.userId)
      )
    case "own":
      return (
        thread.organizationId === scope.organizationId &&
        thread.createdByUserId === scope.userId
      )
    default:
      return false
  }
}

/** Anyone who can hold a conversation can start one. */
export function canRaiseSupportThread(role: string | null | undefined): boolean {
  return isSupportParticipantRole(role)
}

/**
 * May this viewer post a message to this thread?
 *
 * Reading it is necessary but not sufficient: a closed thread is finished, for
 * Apricart as much as for the client. Reopening is an explicit act.
 */
export function canPostSupportMessage(input: {
  viewer: SupportViewer
  thread: (SupportThreadSubject & { status: SupportStatus }) | null | undefined
}): boolean {
  const { viewer, thread } = input
  if (!thread) return false
  if (isTerminalSupportStatus(thread.status)) return false
  return canReadSupportThread({ viewer, thread })
}

/**
 * May this viewer triage — assign a thread, change its priority, close it?
 *
 * Apricart alone. Triage is the platform operator's view of its own queue, not
 * something a tenant administers.
 */
export function canManageSupportThread(role: string | null | undefined): boolean {
  return supportSideForRole(role) === "APRICART"
}

/**
 * May this viewer cite this order when raising a thread?
 *
 * A thread that names an order exposes that order's number and total to
 * everyone who can read the thread, so the person raising it must be able to
 * read the order in the first place. This is the *reference* rule and is
 * deliberately no wider than the order's own visibility:
 *
 * - Apricart's whole-queue roles may cite any order. (The warehouse raises no
 *   thread — it has no tenant — so it falls to the tenant check and cites none.)
 * - Head Office may cite any order in its organization.
 * - A branch administrator may cite any order on its branch.
 * - Everyone else may cite an order on their branch that they raised, or a
 *   group order raised for their branch — the same widening `ORDER_PORTAL`
 *   already has for reading (`lib/group-order-visibility.ts`).
 */
export function canReferenceOrderInSupportThread(input: {
  viewer: SupportViewer
  order:
    | {
        organizationId: number | null
        branchId: number
        createdByUserId: string | null
        groupOrderId?: number | null
      }
    | null
    | undefined
  /** Branches this viewer covers, for the multi-branch roles. */
  scopedBranchIds?: readonly number[]
}): boolean {
  const { viewer, order } = input
  if (!order || !isSupportParticipantRole(viewer?.role)) return false

  if (readsWholeSupportQueue(viewer.role)) return true

  const organizationId = positiveInteger(viewer.organizationId)
  if (organizationId === null || order.organizationId !== organizationId) return false

  if (viewer.role === "HEAD_OFFICE") return true

  if (viewer.role === "BRANCH_ADMIN") {
    return order.branchId === positiveInteger(viewer.branchId)
  }

  if (viewer.role === "GROUP_USER" || viewer.role === "GROUP_ORDER_PORTAL") {
    const covered = (input.scopedBranchIds ?? []).includes(order.branchId)
    return covered || order.createdByUserId === viewer.userId
  }

  // ORDER_PORTAL: own order on own branch, or a group order raised for it.
  if (order.branchId !== positiveInteger(viewer.branchId)) return false
  const isGroupOrder = typeof order.groupOrderId === "number"
  return isGroupOrder || order.createdByUserId === viewer.userId
}
