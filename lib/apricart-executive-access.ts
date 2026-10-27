/**
 * The Apricart Executive role, in one place.
 *
 * Apricart's CEO and directors: they read the management delivery dashboard
 * across **every** organization, and they approve, reject or return the orders
 * Apricart's Order Desk keys in — only in the organizations Super Admin
 * assigned to them (`apricart_executive_assignments`). Nothing else. Modelled
 * on `ORDER_DESK` (`lib/order-desk-access.ts`), the other role that is
 * Apricart's own staff rather than a tenant's:
 *
 *   * **No organization and no branch.** The dashboard reads every tenant, by
 *     definition, so neither is ever written onto the user row. The approval
 *     reach is a table of its own, re-read on every request.
 *   * **Only Super Admin creates or manages one.** `ROLE_LEVEL` puts it above
 *     Head Office for that reason alone (`lib/server/user-access-policy.ts`).
 *   * **Confined to one page area and a short API allowlist.** `proxy.ts`
 *     refuses every API call not in `APRICART_EXECUTIVE_API_RULES` before a
 *     handler runs. That is a second layer: each listed handler also checks the
 *     role itself. It exists because most handlers check roles inline, and a
 *     role with no organization is exactly the caller an inline
 *     `if (orgId) filter` forgets to filter.
 *
 * See plans/OF-DELIVERY-management-delivery-dashboard.md and
 * plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */

export const APRICART_EXECUTIVE_ROLE = "APRICART_EXECUTIVE" as const
export const APRICART_EXECUTIVE_LABEL = "Apricart Executive"

/** The executive's workspace: the delivery dashboard, outside the admin shell. */
export const APRICART_EXECUTIVE_HOME = "/executive"
export const APRICART_EXECUTIVE_AREAS: readonly string[] = [APRICART_EXECUTIVE_HOME]

/** The same dashboard inside the admin shell, for Super Admin. */
export const DELIVERY_DASHBOARD_AREA = "/delivery-dashboard"

/** Who may read the delivery dashboard's endpoints. */
export const DELIVERY_DASHBOARD_ROLES: readonly string[] = ["SUPER_ADMIN", APRICART_EXECUTIVE_ROLE]

/** Who may create executive accounts and assign their organizations. */
export const APRICART_EXECUTIVE_MANAGER_ROLES: readonly string[] = ["SUPER_ADMIN"]

/** Audit action for replacing the organizations an executive approves for. */
export const APRICART_EXECUTIVE_ASSIGNMENT_AUDIT_ACTION = "UPDATE_APRICART_EXECUTIVE_ASSIGNMENTS"

/** Bounds on one replacement of an executive's organizations. */
export const APRICART_EXECUTIVE_ASSIGNMENT_MAX = 200

export function isApricartExecutiveRole(role: unknown): role is typeof APRICART_EXECUTIVE_ROLE {
  return role === APRICART_EXECUTIVE_ROLE
}

export function canReadDeliveryDashboard(role: unknown): boolean {
  return typeof role === "string" && DELIVERY_DASHBOARD_ROLES.includes(role)
}

// ---------------------------------------------------------------------------
// The API allowlist
// ---------------------------------------------------------------------------

type ApricartExecutiveApiRule = {
  /** The handler file, so a contract test can check it really admits the role. */
  route: string
  methods: readonly string[]
  pattern: RegExp
}

/** The executive's approval handlers, each of which checks the role and the reach itself. */
const APPROVAL_ROUTE = "app/api/v1/executive/approvals"

/**
 * Every API request an executive session may make: the dashboard reads, the
 * Order Desk approvals, and the three calls every account needs to finish a
 * forced password change.
 */
export const APRICART_EXECUTIVE_API_RULES: readonly ApricartExecutiveApiRule[] = [
  { route: "app/api/v1/delivery-dashboard/route.ts", methods: ["GET"], pattern: /^\/api\/v1\/delivery-dashboard$/ },
  {
    route: "app/api/v1/delivery-dashboard/orders/[id]/timeline/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/delivery-dashboard\/orders\/\d+\/timeline$/,
  },
  { route: `${APPROVAL_ROUTE}/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/executive\/approvals$/ },
  ...(["approve", "reject", "return"] as const).map((action) => ({
    route: `${APPROVAL_ROUTE}/[id]/${action}/route.ts`,
    methods: ["POST"],
    pattern: new RegExp(String.raw`^/api/v1/executive/approvals/\d+/${action}$`),
  })),
  {
    route: `${APPROVAL_ROUTE}/[id]/attachment/route.ts`,
    methods: ["GET"],
    pattern: /^\/api\/v1\/executive\/approvals\/\d+\/attachment$/,
  },
  // The price contract alert on the workspace, for its assigned organizations
  // (plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md).
  { route: "app/api/v1/price-contracts/alerts/route.ts", methods: ["GET"], pattern: /^\/api\/v1\/price-contracts\/alerts$/ },
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
]

/** Exact match after trailing-slash normalisation — never a prefix. */
export function isApricartExecutiveApiRequestAllowed(method: string, pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  const verb = method.toUpperCase()
  return APRICART_EXECUTIVE_API_RULES.some((rule) => rule.methods.includes(verb) && rule.pattern.test(normalized))
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function apricartExecutiveUserShapeError(organizationId: number | null, branchId: number | null): string | null {
  return organizationId || branchId
    ? "Apricart Executive accounts read every organization and are not assigned an organization or branch"
    : null
}

/**
 * The only access changes an executive account accepts through the
 * user-access route are activation and MFA. Its role is fixed — an account is
 * never turned into, or out of, a cross-tenant one — and it has no reach to
 * edit.
 */
export function apricartExecutiveAccessChangeError(
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
  if (!isApricartExecutiveRole(targetRole) && !isApricartExecutiveRole(nextRole)) return null
  if (nextRole !== targetRole) {
    return "An account cannot be switched to or from Apricart Executive; create a separate account instead"
  }
  const reachFields = [input.organizationId, input.branchId, input.groupIds, input.branchIds, input.budgetAllocationEnabled]
  if (reachFields.some((value) => value !== undefined)) {
    return "Apricart Executive accounts read every organization and have no organization or branch to change"
  }
  return null
}

// ---------------------------------------------------------------------------
// Approval reach
// ---------------------------------------------------------------------------

export type ExecutiveAccount = {
  role: string | null
  isActive: boolean
  deleted: boolean
}

/**
 * The organizations an executive may decide Order Desk orders for: the ones
 * Super Admin assigned, while the account is an active, undeleted executive.
 * An empty result means no approval reach and must never be widened.
 *
 * Neither the organization's status nor its `managed_ordering` flag is
 * required. Only an executive can decide a desk order, so requiring either
 * would strand an organization's pending desk orders — and the budget and
 * stock they hold — the moment it stopped being managed or was deactivated.
 */
export function resolveExecutiveApprovalReach(input: {
  /** The user row as it is now, never the session claim. */
  account: ExecutiveAccount | null
  assignedOrganizationIds: readonly number[]
}): number[] {
  const { account } = input
  if (!account || !isApricartExecutiveRole(account.role) || !account.isActive || account.deleted) return []
  const ids = input.assignedOrganizationIds.filter((id) => Number.isSafeInteger(id) && id > 0)
  return [...new Set(ids)].sort((a, b) => a - b)
}
