/**
 * The Finance role, in one place.
 *
 * Apricart's finance staff: they read orders and every report the way Super
 * Admin does — but only in the organizations Super Admin assigned to them
 * (`finance_organization_assignments`) — and the one thing they change is
 * whether an order is Paid or Unpaid. Modelled on the other Apricart roles
 * (`ORDER_DESK`, `APRICART_EXECUTIVE`, `WAREHOUSE`, `APRICART_SUPPORT`):
 *
 *   * **No organization and no branch.** The reach is a table of its own,
 *     re-read on every request (`lib/server/finance-scope.ts`); an empty set
 *     reads nothing, never everything.
 *   * **Only Super Admin creates or manages one.** `ROLE_LEVEL` puts it above
 *     Head Office for that reason alone (`lib/server/user-access-policy.ts`).
 *   * **Confined to a few page areas and an API allowlist.** `proxy.ts`
 *     refuses every API call not in `FINANCE_API_RULES` before a handler runs.
 *     That is a second layer: each listed handler checks the role and fences
 *     it itself. It exists because most handlers check roles inline, and a
 *     role with no organization is exactly the caller an inline
 *     `if (orgId) filter` forgets to filter.
 *
 * A listed read handler scopes Finance as Super Admin with the organization
 * filter forced to `fenceFinanceOrganizationIds(...)`. Super Admin's path reads
 * an empty filter as "every organization", so the fence is never empty when a
 * handler carries on — an empty fence is a refusal.
 *
 * See plans/OF-FINANCE-finance-role.md.
 */

export const FINANCE_ROLE = "FINANCE" as const
export const FINANCE_LABEL = "Finance"

/** The payment KPIs page, where a Finance account lands. */
export const FINANCE_HOME = "/finance"

/**
 * Pages a Finance session may open. Each is a path prefix, so `/orders` admits
 * an order's own page and `/reports` every report. `/change-password` is
 * handled ahead of this in `proxy.ts`.
 */
export const FINANCE_AREAS: readonly string[] = [FINANCE_HOME, "/orders", "/invoices", "/reports"]

/** Report pages that are not view-only, or not for this role. */
export const FINANCE_EXCLUDED_REPORT_AREAS: readonly string[] = ["/reports/group-orders"]

/** Who may create Finance accounts and assign their organizations. */
export const FINANCE_MANAGER_ROLES: readonly string[] = ["SUPER_ADMIN"]

/** Who may read the payment KPIs. */
export const FINANCE_KPI_ROLES: readonly string[] = ["SUPER_ADMIN", FINANCE_ROLE]

/** Who may mark an order Paid or Unpaid. */
export const PAYMENT_STATUS_UPDATE_ROLES = ["SUPER_ADMIN", FINANCE_ROLE] as const

/** Audit action for replacing the organizations a Finance account reads. */
export const FINANCE_ORGANIZATION_AUDIT_ACTION = "UPDATE_FINANCE_ORGANIZATIONS"

/**
 * Bound on one Finance account's organizations, and so on one replacement
 * body: a few hundred ids stay well under the WAF's 8 KB body limit.
 */
export const FINANCE_ORGANIZATION_MAX = 500

export function isFinanceRole(role: unknown): role is typeof FINANCE_ROLE {
  return role === FINANCE_ROLE
}

export function canUpdatePaymentStatus(role: unknown): boolean {
  return typeof role === "string" && (PAYMENT_STATUS_UPDATE_ROLES as readonly string[]).includes(role)
}

export function canReadFinanceKpis(role: unknown): boolean {
  return typeof role === "string" && FINANCE_KPI_ROLES.includes(role)
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** Whether a Finance session may navigate to this page. */
export function isFinanceAreaAllowed(pathname: string): boolean {
  if (FINANCE_EXCLUDED_REPORT_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))) return false
  return FINANCE_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))
}

// ---------------------------------------------------------------------------
// The API allowlist
// ---------------------------------------------------------------------------

export type FinanceApiRule = {
  /** The handler file, so a contract test can check it really fences the role. */
  route: string
  methods: readonly string[]
  pattern: RegExp
}

const ID = String.raw`\d+`

function read(route: string, pattern: string): FinanceApiRule {
  return { route: `app/api/v1/${route}/route.ts`, methods: ["GET"], pattern: new RegExp(`^/api/v1/${pattern}$`) }
}

/**
 * The read handlers a Finance session may call. Each one fences the role
 * through `resolveFinanceReadScope` (or, for one order, `financeReachesOrganization`);
 * `lib/finance-access.test.ts` checks that every file listed here does.
 */
export const FINANCE_READ_RULES: readonly FinanceApiRule[] = [
  // The payment KPIs page
  read("finance/payment-kpis", "finance/payment-kpis"),
  // Filter options on the orders page and every report
  read("organizations", "organizations"),
  read("branches", "branches"),
  read("groups", "groups"),
  read("categories", "categories"),
  // Orders, one order, and what is attached to it
  read("orders", "orders"),
  read("orders/[id]", `orders/${ID}`),
  read("orders/[id]/refunds", `orders/${ID}/refunds`),
  read("orders/[id]/delivery-challan", `orders/${ID}/delivery-challan`),
  read("orders/[id]/delivery-challan/[challanId]/file", `orders/${ID}/delivery-challan/${ID}/file`),
  read("orders/[id]/intake-screenshot", `orders/${ID}/intake-screenshot`),
  // The invoice and credit notes behind an order
  read("receipts/[orderId]", `receipts/${ID}`),
  read("receipts/[orderId]/download", `receipts/${ID}/download`),
  read("receipts/[orderId]/credit-notes/[creditNoteId]/download", `receipts/${ID}/credit-notes/${ID}/download`),
  // Reports
  read("analytics/earliest-record", "analytics/earliest-record"),
  read("analytics/summary", "analytics/summary"),
  read("analytics/refunds", "analytics/refunds"),
  read("analytics/budgets/summary", "analytics/budgets/summary"),
  read("analytics/branches/performance", "analytics/branches/performance"),
  read("analytics/groups", "analytics/groups"),
  read("analytics/organization-stats", "analytics/organization-stats"),
  read("analytics/orders/itemized", "analytics/orders/itemized"),
  read("analytics/products/performance", "analytics/products/performance"),
  read("analytics/products/list", "analytics/products/list"),
  read("analytics/products/consumption-trend", "analytics/products/consumption-trend"),
  read("analytics/users/performance", "analytics/users/performance"),
  read("analytics/users/products", "analytics/users/products"),
  read("analytics/users/list", "analytics/users/list"),
  read("analytics/executive/options", "analytics/executive/options"),
  read("analytics/executive/overview", "analytics/executive/overview"),
  read("analytics/executive/compare", "analytics/executive/compare"),
  read("analytics/executive/matrix", "analytics/executive/matrix"),
  read("analytics/executive/drill-down", "analytics/executive/drill-down"),
  read("analytics/executive/budget-burn", "analytics/executive/budget-burn"),
  read("analytics/executive/budget-burn/item-comparison", "analytics/executive/budget-burn/item-comparison"),
  read("reports/consolidated-invoice", "reports/consolidated-invoice"),
  read("reports/consolidated-invoice/pdf", "reports/consolidated-invoice/pdf"),
  read("reports/consolidated-invoice/xlsx", "reports/consolidated-invoice/xlsx"),
  read("reports/consolidated-invoice/csv", "reports/consolidated-invoice/csv"),
]

/** The calls every account needs to finish a forced password change. */
const OWN_ACCOUNT_RULES: readonly FinanceApiRule[] = [
  "users/me/change-password",
  "users/me/email-verification/send",
  "users/me/email-verification/verify",
].map((path) => ({ route: `app/api/v1/${path}/route.ts`, methods: ["POST"], pattern: new RegExp(`^/api/v1/${path}$`) }))

/** The one change Finance makes. */
export const FINANCE_WRITE_RULES: readonly FinanceApiRule[] = [
  {
    route: "app/api/v1/orders/[id]/payment-status/route.ts",
    methods: ["POST"],
    pattern: new RegExp(`^/api/v1/orders/${ID}/payment-status$`),
  },
]

export const FINANCE_API_RULES: readonly FinanceApiRule[] = [
  ...FINANCE_READ_RULES,
  ...FINANCE_WRITE_RULES,
  ...OWN_ACCOUNT_RULES,
]

/** Exact match after trailing-slash normalisation — never a prefix. */
export function isFinanceApiRequestAllowed(method: string, pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  const verb = method.toUpperCase()
  const allowsVerb = (rule: FinanceApiRule) => rule.methods.includes(verb) || (verb === "HEAD" && rule.methods.includes("GET"))
  return FINANCE_API_RULES.some((rule) => allowsVerb(rule) && rule.pattern.test(normalized))
}

// ---------------------------------------------------------------------------
// The organization fence
// ---------------------------------------------------------------------------

export type FinanceOrganizationFence =
  | { ok: true; organizationIds: number[] }
  | { ok: false; status: 403; error: string }

export const FINANCE_NO_ORGANIZATIONS = "No organizations are assigned to this finance account"
export const FINANCE_ORGANIZATION_OUTSIDE_REACH = "Organization is outside your assigned organizations"

function positiveIds(values: readonly unknown[]): number[] {
  return [...new Set(values.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b)
}

/**
 * The organizations a Finance read runs against: what was asked for, provided
 * every requested organization is assigned; otherwise every assigned one.
 *
 * Never returns an empty list as success — the Super Admin path a handler
 * then takes reads an empty list as "every organization". A request naming an
 * organization outside the reach is refused rather than silently narrowed, so
 * a report never presents a partial answer as the one asked for.
 */
export function fenceFinanceOrganizationIds(
  assignedOrganizationIds: readonly unknown[],
  requestedOrganizationIds: readonly unknown[] = [],
): FinanceOrganizationFence {
  const assigned = positiveIds(assignedOrganizationIds)
  if (assigned.length === 0) return { ok: false, status: 403, error: FINANCE_NO_ORGANIZATIONS }

  const requested = positiveIds(requestedOrganizationIds)
  if (requested.length === 0) return { ok: true, organizationIds: assigned }

  const reach = new Set(assigned)
  if (requested.some((id) => !reach.has(id))) {
    return { ok: false, status: 403, error: FINANCE_ORGANIZATION_OUTSIDE_REACH }
  }
  return { ok: true, organizationIds: requested }
}

export type FinanceAccount = {
  role: string | null
  isActive: boolean
  deleted: boolean
}

/**
 * The organizations a Finance account reads: its assignments, while the
 * account is an active, undeleted Finance account. Empty otherwise, and an
 * empty result must never be widened.
 */
export function resolveFinanceReach(input: {
  /** The user row as it is now, never the session claim. */
  account: FinanceAccount | null
  assignedOrganizationIds: readonly number[]
}): number[] {
  const { account } = input
  if (!account || !isFinanceRole(account.role) || !account.isActive || account.deleted) return []
  return positiveIds(input.assignedOrganizationIds)
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function financeUserShapeError(organizationId: number | null, branchId: number | null): string | null {
  return organizationId || branchId
    ? "Finance accounts read their assigned organizations and are not assigned an organization or branch"
    : null
}

/** A new Finance account must be given at least one organization. */
export function financeOrganizationsError(role: string, organizationIds: readonly number[]): string | null {
  if (isFinanceRole(role)) {
    return organizationIds.length === 0 ? "Choose at least one organization for a Finance account" : null
  }
  return organizationIds.length > 0 ? "Only Finance accounts are assigned organizations this way" : null
}

/**
 * The only access changes a Finance account accepts through the user-access
 * route are activation and MFA. Its role is fixed, and its organizations are
 * replaced through their own route.
 */
export function financeAccessChangeError(
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
  if (!isFinanceRole(targetRole) && !isFinanceRole(nextRole)) return null
  if (nextRole !== targetRole) {
    return "An account cannot be switched to or from Finance; create a separate account instead"
  }
  const reachFields = [input.organizationId, input.branchId, input.groupIds, input.branchIds, input.budgetAllocationEnabled]
  if (reachFields.some((value) => value !== undefined)) {
    return "Finance accounts have no organization or branch to change; edit their assigned organizations instead"
  }
  return null
}
