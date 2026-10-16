/**
 * The read-only Viewer role, in one place.
 *
 * A Viewer belongs to exactly one organization and changes nothing in it. It
 * comes in two shapes, told apart by the branch on its user row:
 *
 *   * organization-wide (no branch) — reads everything Head Office reads, on
 *     Head Office's menu, and nothing else;
 *   * branch-pinned — reads its own dashboard for that branch alone.
 *
 * Read-only is not a rule in this file: it is that no write handler admits the
 * role (`requireApiRole` refuses any role absent from a route's allowlist), that
 * `proxy.ts` refuses a Viewer every write but its own password change
 * (`isViewerApiRequestAllowed`), and that the shared pages hide their write
 * controls (`isReadOnlyRole`). `tests/integration/viewer-write-sweep.test.ts`
 * calls every write handler as a Viewer and is the proof.
 *
 * Reach is the other half. `viewerReadRole` is the single rule every admitted
 * read handler uses: an organization-wide Viewer is scoped *as Head Office* by
 * that handler and nowhere else, a pinned one is refused. `VIEWER_READ_ROUTES`
 * lists every handler that does so; `lib/viewer-access.test.ts` fails when a
 * route names the role without being on it, or names it outside its GET.
 *
 * See `plans/OF-VIEWER-readonly-dashboard-role.md` and
 * `plans/OF-VIEWER-head-office-read-only-menu.md`.
 */

export const VIEWER_ROLE = "VIEWER" as const

/** Where a Viewer lands. */
export const VIEWER_HOME = "/dashboard"

/**
 * Areas a branch-pinned Viewer may navigate to: its dashboard alone.
 * `/change-password` is handled ahead of this in `proxy.ts` so a forced
 * password change can always complete.
 */
export const VIEWER_AREAS: readonly string[] = [VIEWER_HOME]

/**
 * Areas an organization-wide Viewer may navigate to: Head Office's menu.
 * Each is a path prefix, so `/orders` admits an order's own page too.
 *
 * `/inventory` is deliberately not a prefix: Head Office's catalogue pages that
 * add, adjust or assign stock live under it, and a read-only account has no
 * reason to render them. Its three read pages are named exactly in
 * `VIEWER_ORGANIZATION_EXACT_AREAS`.
 *
 * `/invoices` is reached from the order directory; `lib/invoice-access-policy.ts`
 * decides which invoice is readable.
 */
export const VIEWER_ORGANIZATION_AREAS: readonly string[] = [
  VIEWER_HOME,
  "/activity",
  "/branches",
  "/budget-by-quantity",
  "/budgets",
  "/delivery-addresses",
  "/groups",
  "/head-count-requests",
  "/invoices",
  "/join-requests",
  "/orders",
  "/reports",
  "/settings",
  "/support",
  "/users",
]

export const VIEWER_ORGANIZATION_EXACT_AREAS: readonly string[] = [
  "/inventory",
  "/inventory/price-history",
  "/inventory/product-requests",
]

export function isViewerRole(role: unknown): boolean {
  return role === VIEWER_ROLE
}

/**
 * Whether an account is an organization-wide Viewer: the role, an organization,
 * and no branch. Only this shape reads beyond its dashboard.
 */
export function isOrganizationViewer(input: {
  role?: unknown
  organizationId?: unknown
  branchId?: unknown
}): boolean {
  return isViewerRole(input.role)
    && positiveIdOrNull(input.organizationId) !== null
    && positiveIdOrNull(input.branchId) === null
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`)
}

/** Whether a Viewer, pinned or not, may navigate to this shell path. */
export function isViewerAreaAllowed(pathname: string, input: { organizationId: unknown; branchId: unknown }): boolean {
  if (!isOrganizationViewer({ role: VIEWER_ROLE, ...input })) {
    return VIEWER_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))
  }
  return VIEWER_ORGANIZATION_AREAS.some((prefix) => pathMatchesPrefix(pathname, prefix))
    || VIEWER_ORGANIZATION_EXACT_AREAS.includes(pathname)
}

/**
 * The only writes a Viewer token may send: its own password change, and the
 * email check that may go with it. They act on the caller's own account, and
 * the first sign-in forces the change. Everything else that is not a read is
 * refused by `proxy.ts` before a handler runs — in addition to every write
 * handler refusing the role itself, never instead of it.
 */
export const VIEWER_OWN_ACCOUNT_WRITES: readonly string[] = [
  "/api/v1/users/me/change-password",
  "/api/v1/users/me/email-verification/send",
  "/api/v1/users/me/email-verification/verify",
]

const READ_METHODS = new Set(["GET", "HEAD"])

/** Whether `proxy.ts` lets a Viewer token's API request through. */
export function isViewerApiRequestAllowed(method: string, pathname: string): boolean {
  if (READ_METHODS.has(method.toUpperCase())) return true
  return VIEWER_OWN_ACCOUNT_WRITES.includes(pathname)
}

/**
 * How a page should treat a signed-in user: `viewRole` picks which role's view
 * a shared page renders (Head Office's for an organization-wide Viewer), and
 * `readOnly` hides every write control. Presentation only.
 */
export function viewerAccessFor(user: unknown): { role: string | null; viewRole: string | null; readOnly: boolean } {
  const claims = (user ?? {}) as { role?: unknown; organizationId?: unknown; branchId?: unknown }
  const role = typeof claims.role === "string" ? claims.role : null
  return {
    role,
    viewRole: isOrganizationViewer(claims) ? "HEAD_OFFICE" : role,
    readOnly: isReadOnlyRole(role),
  }
}

/**
 * Whether the signed-in role may change nothing at all. Pages use it to hide
 * their write controls; it is presentation, and every write handler refuses
 * the role on its own.
 */
export function isReadOnlyRole(role: unknown): boolean {
  return isViewerRole(role)
}

/**
 * The role an admitted read handler scopes its query by.
 *
 *   * an organization-wide Viewer reads exactly what Head Office reads, so the
 *     handler scopes it as `HEAD_OFFICE` — its organization still comes from
 *     the session, never the request;
 *   * a branch-pinned Viewer, or one with no organization, reads its dashboard
 *     alone and is refused here (`null`);
 *   * every other role reads as itself.
 *
 * Call it in a GET handler only, and only for scope. Anything that releases
 * the fulfilment token, writes an audit row, or tells the UI what the caller
 * may *do* keeps the caller's real role.
 */
export function viewerReadRole(input: {
  role?: unknown
  organizationId?: unknown
  branchId?: unknown
}): string | null {
  if (!isViewerRole(input.role)) return typeof input.role === "string" ? input.role : null
  return isOrganizationViewer(input) ? "HEAD_OFFICE" : null
}

/**
 * A request scope as an admitted read handler should use it: an
 * organization-wide Viewer's becomes Head Office's (same organization, no
 * branch), a branch-pinned or unassigned Viewer's becomes `null` (refuse it),
 * and every other caller's is returned unchanged.
 */
export function viewerReadScope<T extends { role: string; organizationId: number | null; branchId: number | null }>(
  scope: T | null,
): T | null {
  if (!scope) return null
  const role = viewerReadRole(scope)
  if (role === null) return null
  return role === scope.role ? scope : ({ ...scope, role } as T)
}

/** The message a refused Viewer read answers with. */
export const VIEWER_READ_REFUSED = "Forbidden: this account may only view its dashboard"

/**
 * Every route handler that admits a Viewer. Everything else in `app/api/v1/**`
 * refuses it, including every write.
 *
 * The first four serve the dashboard and admit both shapes, scoped by
 * `resolveViewerScope`. The rest serve Head Office's menu and admit an
 * organization-wide Viewer through `viewerReadRole`, in their GET only.
 *
 * Adding a route here is a deliberate act: it widens what a read-only account
 * can see. The contract test treats this list as the control.
 */
export const VIEWER_DASHBOARD_ROUTES: readonly string[] = [
  "app/api/v1/analytics/sales-performance/route.ts",
  "app/api/v1/analytics/drill-down/route.ts",
  "app/api/v1/analytics/earliest-record/route.ts",
  "app/api/v1/branches/route.ts",
]

export const VIEWER_ORGANIZATION_READ_ROUTES: readonly string[] = [
  // The shell: whether the tenant's menu carries budget entries
  "app/api/v1/organizations/budget-policy/route.ts",
  // Users, Join Requests, Settings
  "app/api/v1/users/route.ts",
  "app/api/v1/organizations/route.ts",
  "app/api/v1/organizations/[id]/route.ts",
  "app/api/v1/organizations/join-code/route.ts",
  "app/api/v1/join-requests/route.ts",
  "app/api/v1/settings/route.ts",
  "app/api/v1/branches/[id]/route.ts",
  // Delivery Addresses
  "app/api/v1/delivery-addresses/route.ts",
  // Head Count Requests (read-only; the decision route refuses a Viewer)
  "app/api/v1/branch-head-count-requests/route.ts",
  // Orders, and the invoice behind an order
  "app/api/v1/orders/route.ts",
  "app/api/v1/orders/[id]/route.ts",
  "app/api/v1/orders/[id]/refunds/route.ts",
  "app/api/v1/orders/[id]/delivery-challan/route.ts",
  "app/api/v1/orders/[id]/delivery-challan/[challanId]/file/route.ts",
  "app/api/v1/receipts/[orderId]/route.ts",
  "app/api/v1/receipts/[orderId]/download/route.ts",
  "app/api/v1/receipts/[orderId]/credit-notes/[creditNoteId]/download/route.ts",
  // Product Catalog
  "app/api/v1/head-office/organization-inventory/route.ts",
  "app/api/v1/inventory/organization-products/route.ts",
  "app/api/v1/categories/route.ts",
  "app/api/v1/subcategories/route.ts",
  "app/api/v1/admin/product-price-history/route.ts",
  "app/api/v1/product-requests/route.ts",
  // Group Management
  "app/api/v1/groups/route.ts",
  "app/api/v1/groups/[id]/branch-counts/route.ts",
  "app/api/v1/groups/[id]/branches/route.ts",
  "app/api/v1/groups/[id]/prices/route.ts",
  // Budgets, Budget by Quantity
  "app/api/v1/budgets/route.ts",
  "app/api/v1/budget-quantity/route.ts",
  "app/api/v1/branch/inventory/route.ts",
  "app/api/v1/analytics/budgets/summary/route.ts",
  // Reports
  "app/api/v1/analytics/branches/performance/route.ts",
  "app/api/v1/analytics/groups/route.ts",
  "app/api/v1/analytics/orders/itemized/route.ts",
  "app/api/v1/analytics/organization-stats/route.ts",
  "app/api/v1/analytics/products/catalog-performance/route.ts",
  "app/api/v1/analytics/products/consumption-trend/route.ts",
  "app/api/v1/analytics/products/list/route.ts",
  "app/api/v1/analytics/products/performance/route.ts",
  "app/api/v1/analytics/refunds/route.ts",
  "app/api/v1/analytics/summary/route.ts",
  "app/api/v1/analytics/users/list/route.ts",
  "app/api/v1/analytics/users/performance/route.ts",
  "app/api/v1/analytics/users/products/route.ts",
  "app/api/v1/analytics/executive/budget-burn/item-comparison/route.ts",
  "app/api/v1/analytics/executive/budget-burn/route.ts",
  "app/api/v1/analytics/executive/compare/route.ts",
  "app/api/v1/analytics/executive/drill-down/route.ts",
  "app/api/v1/analytics/executive/matrix/route.ts",
  "app/api/v1/analytics/executive/options/route.ts",
  "app/api/v1/analytics/executive/overview/route.ts",
  "app/api/v1/reports/consolidated-invoice/route.ts",
  "app/api/v1/reports/consolidated-invoice/pdf/route.ts",
  "app/api/v1/reports/consolidated-invoice/xlsx/route.ts",
  "app/api/v1/reports/consolidated-invoice/csv/route.ts",
  // Support
  "app/api/v1/support/threads/route.ts",
  "app/api/v1/support/threads/[id]/route.ts",
  "app/api/v1/support/stats/route.ts",
  "app/api/v1/support/attachments/[id]/route.ts",
  // Activity Log
  "app/api/v1/activity-logs/route.ts",
]

/**
 * Server modules that scope an organization-wide Viewer as Head Office for
 * every caller, rather than behind an option. Each is safe only while every
 * route calling it is a read; `lib/viewer-access.test.ts` pins that.
 */
export const VIEWER_READ_HELPERS: ReadonlyArray<{ module: string; entry: string }> = [
  { module: "lib/server/executive-analytics-scope.ts", entry: "resolveExecutiveScope" },
  { module: "lib/server/consolidated-invoice-report.ts", entry: "loadConsolidatedInvoiceReport" },
  { module: "lib/server/invoice-access.ts", entry: "authorizeInvoiceRequest" },
]

export const VIEWER_READ_ROUTES: readonly string[] = [
  ...VIEWER_DASHBOARD_ROUTES,
  ...VIEWER_ORGANIZATION_READ_ROUTES,
]

export type ViewerScopeInput = {
  /** From the session, never from the request. */
  organizationId: number | null | undefined
  /** From the session. When set, the Viewer is pinned to this branch. */
  branchId: number | null | undefined
  /** Whatever the query string asked for. Ignored when the Viewer is pinned. */
  requestedBranchId?: number | null
}

export type ViewerScope =
  | { organizationId: number; branchId: number | null; error?: undefined }
  | { error: string; organizationId?: undefined; branchId?: undefined }

const NO_ORGANIZATION = "Access denied: this account is not assigned to an organization"

function positiveIdOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}

/**
 * The organization and branch a Viewer's query runs against.
 *
 * The organization is always the session's. The branch is the session's when
 * the account is pinned, and only then falls back to the request — so a pinned
 * Viewer naming a sibling branch on the query string still reads its own.
 */
export function resolveViewerScope(input: ViewerScopeInput): ViewerScope {
  const organizationId = positiveIdOrNull(input.organizationId)
  if (!organizationId) return { error: NO_ORGANIZATION }

  const pinnedBranchId = positiveIdOrNull(input.branchId)
  if (pinnedBranchId) return { organizationId, branchId: pinnedBranchId }

  return { organizationId, branchId: positiveIdOrNull(input.requestedBranchId) }
}

/**
 * The branch id list a Viewer's query runs against, for the endpoints that take
 * one. A pinned Viewer collapses to its own branch whatever was requested; an
 * unpinned one passes its request through for the caller to validate against
 * the tenant, exactly as Head Office's is.
 */
export function resolveViewerBranchIds(input: {
  branchId: number | null | undefined
  requestedBranchIds?: ReadonlyArray<unknown>
}): number[] {
  const pinnedBranchId = positiveIdOrNull(input.branchId)
  if (pinnedBranchId) return [pinnedBranchId]

  return Array.from(new Set(
    (input.requestedBranchIds ?? [])
      .map(positiveIdOrNull)
      .filter((id): id is number => id !== null),
  ))
}

/** Whether a Viewer may pick its own branch filter, or is pinned to one. */
export function viewerMayFilterBranches(branchId: number | null | undefined): boolean {
  return positiveIdOrNull(branchId) === null
}
