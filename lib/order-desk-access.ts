/**
 * The Order Desk role, in one place.
 *
 * Apricart's internal team keys in orders that customers send by email or
 * WhatsApp. A desk account belongs to no organization. What it may reach is
 * the intersection of two grants, both made by Super Admin and both re-read on
 * the server on every request:
 *
 *   * the organization is marked `managed_ordering` ("Apricart takes this
 *     customer's orders"), and
 *   * the desk user holds an assignment to that organization (every branch) or
 *     to one of its branches (`order_desk_assignments`).
 *
 * Everything here is pure so it can be tested without a database and imported
 * by `proxy.ts` at the edge. The SQL that loads the rows these rules judge is
 * `lib/server/order-desk-scope.ts`.
 *
 * See `plans/OF-ORDER-DESK-internal-order-entry.md`.
 */

import { isOrderDelivered } from "@/lib/fulfillment-status"
import { isAwaitingCorrection } from "@/lib/order-correction"
import { requesterRefundTimingReason } from "@/lib/refund-window"

export const ORDER_DESK_ROLE = "ORDER_DESK" as const
export const ORDER_DESK_LABEL = "Order Desk (Apricart)"

/** Where a desk user lands, and the only page area it may reach. */
export const ORDER_DESK_HOME = "/order-desk"
export const ORDER_DESK_AREAS: readonly string[] = [ORDER_DESK_HOME]

/** Super Admin's screen for creating desk users and granting their reach. */
export const DESK_TEAM_AREA = "/desk-team"

/**
 * Who may create desk users and grant their reach. Super Admin alone: a desk
 * user works across tenants, so no tenant's administrator may make one.
 */
export const ORDER_DESK_MANAGER_ROLES: readonly string[] = ["SUPER_ADMIN"]

export function canManageOrderDesk(role: unknown): boolean {
  return typeof role === "string" && ORDER_DESK_MANAGER_ROLES.includes(role)
}

export function isOrderDeskRole(role: unknown): role is typeof ORDER_DESK_ROLE {
  return role === ORDER_DESK_ROLE
}

/** Audit action for switching an organization's `managed_ordering`. */
export const ORGANIZATION_MANAGED_ORDERING_AUDIT_ACTION = "UPDATE_ORGANIZATION_MANAGED_ORDERING"

// ---------------------------------------------------------------------------
// The API allowlist
// ---------------------------------------------------------------------------

type OrderDeskApiRule = {
  /** The handler file, so a contract test can check it really admits the role. */
  route: string
  methods: readonly string[]
  pattern: RegExp
}

/**
 * Every API request a desk session may make. `proxy.ts` refuses anything else
 * with 403 before a handler runs.
 *
 * This is a second layer, not the authorization: each handler listed here
 * re-checks the role and the desk's reach itself. It exists because most of
 * the API checks roles inline, and a role with no organization of its own is
 * exactly the caller an inline `if (orgId) filter` forgets to filter.
 */
export const ORDER_DESK_API_RULES: readonly OrderDeskApiRule[] = [
  { route: "app/api/v1/orders/route.ts", methods: ["POST"], pattern: /^\/api\/v1\/orders$/ },
  { route: "app/api/v1/order-desk/targets/route.ts", methods: ["GET"], pattern: /^\/api\/v1\/order-desk\/targets$/ },
  { route: "app/api/v1/order-desk/catalogue/route.ts", methods: ["GET"], pattern: /^\/api\/v1\/order-desk\/catalogue$/ },
  { route: "app/api/v1/order-desk/orders/route.ts", methods: ["GET"], pattern: /^\/api\/v1\/order-desk\/orders$/ },
  { route: "app/api/v1/order-desk/orders/[id]/route.ts", methods: ["PUT"], pattern: /^\/api\/v1\/order-desk\/orders\/\d+$/ },
  {
    route: "app/api/v1/order-desk/orders/[id]/fulfil/route.ts",
    methods: ["POST"],
    pattern: /^\/api\/v1\/order-desk\/orders\/\d+\/fulfil$/,
  },
  {
    route: "app/api/v1/order-desk/orders/[id]/cancel/route.ts",
    methods: ["POST"],
    pattern: /^\/api\/v1\/order-desk\/orders\/\d+\/cancel$/,
  },
  {
    route: "app/api/v1/order-desk/orders/[id]/resubmit/route.ts",
    methods: ["POST"],
    pattern: /^\/api\/v1\/order-desk\/orders\/\d+\/resubmit$/,
  },
  {
    route: "app/api/v1/order-desk/orders/[id]/attachment/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/order-desk\/orders\/\d+\/attachment$/,
  },
  // The customer's screenshot. The shared upload route admits the desk and
  // stores its upload privately (`storeOrderIntakeAttachment`).
  { route: "app/api/v1/upload/image/route.ts", methods: ["POST"], pattern: /^\/api\/v1\/upload\/image$/ },
  // A refund request on a fulfilled desk order, and its history. The shared
  // refund route admits the desk for its own orders only; Super Admin approves.
  {
    route: "app/api/v1/orders/[id]/refunds/route.ts",
    methods: ["GET", "POST"],
    pattern: /^\/api\/v1\/orders\/\d+\/refunds$/,
  },
  // The change-password page, which every account must be able to complete.
  { route: "app/api/v1/users/me/change-password/route.ts", methods: ["POST"], pattern: /^\/api\/v1\/users\/me\/change-password$/ },
  {
    route: "app/api/v1/users/me/email-verification/send/route.ts",
    methods: ["POST"],
    pattern: /^\/api\/v1\/users\/me\/email-verification\/send$/,
  },
  {
    route: "app/api/v1/users/me/email-verification/verify/route.ts",
    methods: ["POST"],
    pattern: /^\/api\/v1\/users\/me\/email-verification\/verify$/,
  },
  // Self-service password reset, linked from the workspace's profile menu.
  // Public endpoints that read no session, so a signed-in desk user reaching
  // them gains nothing a signed-out visitor does not already have.
  ...(["request", "verify", "complete"] as const).map((step) => ({
    route: `app/api/v1/auth/password-reset/${step}/route.ts`,
    methods: ["POST"],
    pattern: new RegExp(`^/api/v1/auth/password-reset/${step}$`),
  })),
]

/** Exact match after trailing-slash normalisation — never a prefix. */
export function isOrderDeskApiRequestAllowed(method: string, pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  const verb = method.toUpperCase()
  return ORDER_DESK_API_RULES.some((rule) => rule.methods.includes(verb) && rule.pattern.test(normalized))
}

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

export type DeskAccount = {
  role: string | null
  isActive: boolean
  deleted: boolean
}

export type DeskAssignment = { organizationId: number; branchId: number | null }
export type DeskOrganization = { id: number; managedOrdering: boolean; status: string | null }
export type DeskBranch = { id: number; organizationId: number; status: string | null }

/**
 * What the reach is for.
 *
 *   * `order` — choosing a target and creating an order. The organization and
 *     the branch must both be active.
 *   * `manage` — reading, delivering and fulfilling an order the desk already
 *     entered. Status is not required, so an order at a branch deactivated
 *     after it was placed can still be completed.
 *
 * Both require the organization to be managed and the user to be assigned.
 */
export type DeskReachPurpose = "order" | "manage"

export type DeskReachInput = {
  /** The user row as it is now, never the session claim. */
  account: DeskAccount | null
  assignments: readonly DeskAssignment[]
  organizations: readonly DeskOrganization[]
  branches: readonly DeskBranch[]
}

export type DeskReach = {
  organizationIds: number[]
  branchIds: number[]
}

const NO_REACH: DeskReach = { organizationIds: [], branchIds: [] }

function isActiveStatus(status: string | null | undefined): boolean {
  return status?.toLowerCase() === "active"
}

/**
 * The organizations and branches a desk user reaches. An empty result means no
 * access and must never be widened into "everything" by a caller.
 */
export function resolveDeskReach(input: DeskReachInput, purpose: DeskReachPurpose): DeskReach {
  const account = input.account
  if (!account || !isOrderDeskRole(account.role) || !account.isActive || account.deleted) return NO_REACH

  const organizationById = new Map(input.organizations.map((organization) => [organization.id, organization]))
  const usableOrganization = (organizationId: number) => {
    const organization = organizationById.get(organizationId)
    if (organization?.managedOrdering !== true) return false
    return purpose === "manage" || isActiveStatus(organization.status)
  }
  const usableBranch = (branch: DeskBranch) => purpose === "manage" || isActiveStatus(branch.status)

  const wholeOrganizations = new Set<number>()
  const singleBranches = new Map<number, number>()
  for (const assignment of input.assignments) {
    if (!usableOrganization(assignment.organizationId)) continue
    if (assignment.branchId === null) wholeOrganizations.add(assignment.organizationId)
    else singleBranches.set(assignment.branchId, assignment.organizationId)
  }

  const branchIds = new Set<number>()
  for (const branch of input.branches) {
    if (!usableBranch(branch)) continue
    // A branch assignment counts only for the organization it was written
    // under, so a row that somehow names another tenant's branch reaches
    // nothing.
    const assignedTo = singleBranches.get(branch.id)
    if (wholeOrganizations.has(branch.organizationId) || assignedTo === branch.organizationId) {
      branchIds.add(branch.id)
    }
  }

  const organizationIds = new Set<number>()
  for (const branch of input.branches) {
    if (branchIds.has(branch.id)) organizationIds.add(branch.organizationId)
  }

  return {
    organizationIds: [...organizationIds].sort((a, b) => a - b),
    branchIds: [...branchIds].sort((a, b) => a - b),
  }
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * A desk order is created `PENDING`, whatever the organization's own approval
 * switch says, and waits for an Apricart Executive assigned to that
 * organization. Who decides it is `lib/order-desk-approval.ts`.
 */
export function orderDeskRequiresExecutiveApproval(creatorRole: unknown): boolean {
  return isOrderDeskRole(creatorRole)
}

export const INTAKE_CHANNELS = ["EMAIL", "WHATSAPP", "PHONE", "OTHER"] as const
export type IntakeChannel = (typeof INTAKE_CHANNELS)[number]

export const INTAKE_CHANNEL_LABELS: Record<IntakeChannel, string> = {
  EMAIL: "Email",
  WHATSAPP: "WhatsApp",
  PHONE: "Phone",
  OTHER: "Other",
}

export const INTAKE_REFERENCE_MAX_LENGTH = 255

/**
 * The screenshot of the customer's message. Stored privately under its own
 * prefix (`lib/server/image-storage.ts`), and named on the order by its key —
 * a key the server generated, never a URL or a path from the client.
 */
export const ORDER_INTAKE_ATTACHMENT_PREFIX = "order-intake"
const ORDER_INTAKE_ATTACHMENT_KEY_PATTERN =
  /^order-intake\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|gif|webp)$/

export function isOrderIntakeAttachmentKey(value: unknown): value is string {
  return typeof value === "string" && ORDER_INTAKE_ATTACHMENT_KEY_PATTERN.test(value)
}

/** Audit action of a desk screenshot upload; order creation checks it to bind a key to its uploader. */
export const ORDER_INTAKE_UPLOAD_AUDIT_ACTION = "UPLOAD_ORDER_INTAKE_ATTACHMENT"

/**
 * Where a desk order came from is required; a portal order never carries it,
 * so nothing outside the desk can label its own order as a desk entry.
 */
export function orderIntakeError(
  creatorRole: unknown,
  intake: { intakeChannel?: string | null; intakeReference?: string | null; intakeAttachmentKey?: string | null },
): string | null {
  const hasChannel = Boolean(intake.intakeChannel)
  const hasReference = Boolean(intake.intakeReference?.trim())
  const hasAttachment = intake.intakeAttachmentKey !== undefined && intake.intakeAttachmentKey !== null
  if (isOrderDeskRole(creatorRole)) {
    if (!hasChannel) return "intakeChannel is required for an Order Desk order"
    if (!hasReference) return "intakeReference is required for an Order Desk order"
    if (hasAttachment && !isOrderIntakeAttachmentKey(intake.intakeAttachmentKey)) {
      return "intakeAttachmentKey is not a screenshot uploaded through the Order Desk"
    }
    return null
  }
  return hasChannel || hasReference || hasAttachment ? "Intake details apply only to Order Desk orders" : null
}

export type DeskOrderActions = {
  /**
   * Pending — awaiting approval or returned for correction. Never after
   * approval: an edit then would change what the executive approved.
   */
  canEdit: boolean
  /** Pending, or Active and not yet delivered: it can still be withdrawn. */
  canCancel: boolean
  /** Returned for correction: corrected (or not) and sent back for approval. */
  canResubmit: boolean
  /** Active and delivered (Super Admin records delivery): ready to settle. */
  canFulfil: boolean
  /**
   * Fulfilled, delivered, and within seven days of fulfilment: a refund can be
   * requested for Super Admin to approve.
   */
  canRequestRefund: boolean
}

/**
 * What the desk may do with one of its orders, by state. Approval is an
 * executive's (`lib/order-desk-approval.ts`), delivery is Super Admin's, and no
 * order is fulfilled before that delivery is recorded. The server enforces each
 * of these again.
 */
export function deskOrderActions(
  order: {
    status: string | null
    fulfillmentStatus: string | null
    fulfilledAt: Date | string | null
    returnedForCorrectionAt?: Date | string | null
  },
  now: Date = new Date(),
): DeskOrderActions {
  const status = String(order.status ?? "").toUpperCase()
  const delivered = isOrderDelivered(order.fulfillmentStatus)
  const pending = status === "PENDING"
  const active = status === "APPROVED"
  return {
    canEdit: pending,
    canCancel: pending || (active && !delivered),
    canResubmit: isAwaitingCorrection({ status, returnedForCorrectionAt: order.returnedForCorrectionAt }),
    canFulfil: active && delivered,
    canRequestRefund: requesterRefundTimingReason({ ...order, status }, now) === null,
  }
}

export const CANCELLATION_REASON_MAX_LENGTH = 500

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

/** A desk account belongs to no organization and no branch. */
export function orderDeskUserShapeError(organizationId: number | null, branchId: number | null): string | null {
  return organizationId || branchId
    ? "Order Desk users are not assigned an organization or branch; grant their reach from Desk team"
    : null
}

/**
 * The only access changes a desk account accepts through the user-access
 * route are activation and MFA. Its role is fixed (an account is never turned
 * into, or out of, a cross-tenant one) and its reach is managed through its
 * own assignments, never through `organization_id`/`branch_id`.
 */
export function orderDeskAccessChangeError(
  targetRole: string,
  input: {
    role?: string
    organizationId?: number | null
    branchId?: number | null
    groupIds?: number[]
    branchIds?: number[]
    budgetAllocationEnabled?: boolean
  },
): string | null {
  const nextRole = input.role ?? targetRole
  if (!isOrderDeskRole(targetRole) && !isOrderDeskRole(nextRole)) return null
  if (nextRole !== targetRole) {
    return "An account cannot be switched to or from Order Desk; create a separate account instead"
  }
  const reachFields = [input.organizationId, input.branchId, input.groupIds, input.branchIds, input.budgetAllocationEnabled]
  if (reachFields.some((value) => value !== undefined)) {
    return "Order Desk reach is managed from Desk team, not through organization or branch fields"
  }
  return null
}
