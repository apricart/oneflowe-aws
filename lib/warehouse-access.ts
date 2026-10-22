/**
 * The Warehouse role, in one place.
 *
 * Apricart's warehouse staff: they pick, dispatch and deliver the approved
 * orders of the **branches** Super Admin assigned to them, and nothing else.
 * Modelled on `ORDER_DESK` (`lib/order-desk-access.ts`) and
 * `APRICART_EXECUTIVE` (`lib/apricart-executive-access.ts`), the other two
 * roles that are Apricart's own staff rather than a tenant's:
 *
 *   * **No organization and no branch on the user row.** The reach is tables
 *     of its own — `warehouse_assignments`, one row per branch, and
 *     `warehouse_city_assignments`, one row per city, intersected with
 *     `warehouse_city_organizations`, the organizations those cities apply to
 *     — never a whole organization, re-read from the database on every
 *     request.
 *   * **Only Super Admin creates or manages one.** `ROLE_LEVEL` puts it above
 *     Head Office for that reason alone (`lib/server/user-access-policy.ts`).
 *   * **Confined to one page area and a short API allowlist.** `proxy.ts`
 *     refuses every API call not in `WAREHOUSE_API_RULES` before a handler
 *     runs. That is a second layer: each listed handler also checks the role
 *     and the reach itself. It exists because most handlers check roles
 *     inline, and a role with no organization is exactly the caller an inline
 *     `if (orgId) filter` forgets to filter.
 *
 * What it may do to an order is move its delivery forward one stage at a time
 * (`NOT_STARTED → IN_PROCESS → OUT_FOR_DELIVERY → DELIVERED`), optionally with
 * a delivery challan. It never approves, rejects, cancels, edits, fulfils,
 * prices, refunds or marks an order paid. It does see prices and invoice
 * figures on its own orders. It also reads the whole product catalogue —
 * every menu Super Admin has, prices included — strictly read-only, the
 * tenant-owned menus fenced to the organizations it serves. And it answers, on
 * Apricart's side, the support threads of the branches it serves — never the
 * whole queue (`lib/support-access.ts`). See
 * plans/OF-WAREHOUSE-warehouse-fulfilment-role.md,
 * plans/OF-WAREHOUSE-full-read-only-catalog.md and
 * plans/OF-WAREHOUSE-support-queue.md.
 */

export const WAREHOUSE_ROLE = "WAREHOUSE" as const
export const WAREHOUSE_LABEL = "Warehouse (Apricart)"

/** The warehouse's workspace, outside the admin shell. */
export const WAREHOUSE_HOME = "/warehouse"

/** The shared support pages, where it answers its branches' threads. */
export const WAREHOUSE_SUPPORT_AREA = "/support"
export const WAREHOUSE_AREAS: readonly string[] = [WAREHOUSE_HOME, WAREHOUSE_SUPPORT_AREA]

/** Super Admin's page for assigning warehouse accounts their branches. */
export const WAREHOUSE_TEAM_AREA = "/warehouse-team"

/** Who may create warehouse accounts and assign their branches. */
export const WAREHOUSE_MANAGER_ROLES: readonly string[] = ["SUPER_ADMIN"]

/** Audit action for replacing the branches a warehouse user serves in one organization. */
export const WAREHOUSE_ASSIGNMENT_AUDIT_ACTION = "UPDATE_WAREHOUSE_ASSIGNMENTS"

/** Audit action for assigning or withdrawing one whole city. */
export const WAREHOUSE_CITY_ASSIGNMENT_AUDIT_ACTION = "UPDATE_WAREHOUSE_CITY_ASSIGNMENTS"

/**
 * Audit action for choosing or withdrawing one organization a warehouse user's
 * cities apply to. See plans/OF-WAREHOUSE-city-assignments-by-organization.md.
 */
export const WAREHOUSE_CITY_ORGANIZATION_AUDIT_ACTION = "UPDATE_WAREHOUSE_CITY_ORGANIZATIONS"

/** Most organizations one warehouse user's cities may apply to; one per request. */
export const WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER = 200

/**
 * Most cities one warehouse user may be assigned. A city is changed one per
 * request, so this bounds the reach join, not a request body.
 * See plans/OF-WAREHOUSE-city-assignments.md.
 */
export const WAREHOUSE_CITY_MAX_PER_USER = 200

/** Longest city a request may name — `branches.city` is varchar(100). */
export const WAREHOUSE_CITY_MAX_LENGTH = 100

/**
 * Bounds on one replacement: one organization's branches at a time, so the
 * body stays far under the WAF's 8 KB limit however many branches a warehouse
 * serves overall.
 */
export const WAREHOUSE_ASSIGNMENT_MAX_PER_ORGANIZATION = 1000

export function isWarehouseRole(role: unknown): role is typeof WAREHOUSE_ROLE {
  return role === WAREHOUSE_ROLE
}

export function canManageWarehouse(role: unknown): boolean {
  return typeof role === "string" && WAREHOUSE_MANAGER_ROLES.includes(role)
}

// ---------------------------------------------------------------------------
// The API allowlist
// ---------------------------------------------------------------------------

type WarehouseApiRule = {
  /** The handler file, so a contract test can check it really admits the role. */
  route: string
  methods: readonly string[]
  pattern: RegExp
}

const ORDERS_ROUTE = "app/api/v1/warehouse/orders"
const SUPPORT_ROUTE = "app/api/v1/support"

/**
 * Every API request a warehouse session may make: its own reads and the
 * progress write, the read-only catalogue and its product pictures, the challan
 * upload (the one upload path the WAF allows), the Apricart side of the support
 * pages, and the three calls every account needs to finish a forced password
 * change.
 */
export const WAREHOUSE_API_RULES: readonly WarehouseApiRule[] = [
  { route: `${ORDERS_ROUTE}/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/warehouse\/orders$/ },
  { route: `${ORDERS_ROUTE}/[id]/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/warehouse\/orders\/\d+$/ },
  {
    route: `${ORDERS_ROUTE}/[id]/progress/route.ts`,
    methods: ["POST"],
    pattern: /^\/api\/v1\/warehouse\/orders\/\d+\/progress$/,
  },
  {
    route: `${ORDERS_ROUTE}/[id]/timeline/route.ts`,
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/orders\/\d+\/timeline$/,
  },
  {
    route: `${ORDERS_ROUTE}/[id]/invoice/route.ts`,
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/orders\/\d+\/invoice$/,
  },
  {
    route: `${ORDERS_ROUTE}/[id]/delivery-challan/route.ts`,
    methods: ["GET", "POST"],
    pattern: /^\/api\/v1\/warehouse\/orders\/\d+\/delivery-challan$/,
  },
  {
    route: `${ORDERS_ROUTE}/[id]/delivery-challan/[challanId]/file/route.ts`,
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/orders\/\d+\/delivery-challan\/\d+\/file$/,
  },
  { route: "app/api/v1/warehouse/workload/route.ts", methods: ["GET"], pattern: /^\/api\/v1\/warehouse\/workload$/ },
  // The user's own order-stage notices and mark-all-read
  // (plans/OF-WAREHOUSE-order-stage-notifications.md). The shared
  // /api/v1/notifications stays closed to the role.
  {
    route: "app/api/v1/warehouse/notifications/route.ts",
    methods: ["GET", "PATCH"],
    pattern: /^\/api\/v1\/warehouse\/notifications$/,
  },
  // The product catalogue, read-only: every menu Super Admin has, prices
  // included, the tenant ones fenced to the organizations the warehouse serves
  // (plans/OF-WAREHOUSE-full-read-only-catalog.md). GET only, every one.
  { route: "app/api/v1/warehouse/catalog/route.ts", methods: ["GET"], pattern: /^\/api\/v1\/warehouse\/catalog$/ },
  {
    route: "app/api/v1/warehouse/catalog/categories/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/catalog\/categories$/,
  },
  {
    route: "app/api/v1/warehouse/catalog/taxonomy/categories/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/catalog\/taxonomy\/categories$/,
  },
  {
    route: "app/api/v1/warehouse/catalog/taxonomy/subcategories/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/catalog\/taxonomy\/subcategories$/,
  },
  {
    route: "app/api/v1/warehouse/catalog/organizations/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/catalog\/organizations$/,
  },
  {
    route: "app/api/v1/warehouse/catalog/organization-products/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/catalog\/organization-products$/,
  },
  {
    route: "app/api/v1/warehouse/catalog/group-products/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/catalog\/group-products$/,
  },
  {
    route: "app/api/v1/warehouse/catalog/price-history/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/catalog\/price-history$/,
  },
  {
    route: "app/api/v1/warehouse/catalog/product-requests/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/warehouse\/catalog\/product-requests$/,
  },
  // A catalogue product's picture. Pinned to the `products/` key shape the
  // image route itself enforces (`isValidImageKey`): support attachments, desk
  // screenshots and challans live under other prefixes it never serves.
  {
    route: "app/api/v1/images/[...key]/route.ts",
    methods: ["GET"],
    pattern: /^\/api\/v1\/images\/products\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(?:jpg|png|gif|webp)$/,
  },
  // The support queue of the branches it serves (plans/OF-WAREHOUSE-support-queue.md):
  // exactly the calls the Apricart side of the support pages makes. Not raising
  // a thread (it has no tenant) and not the product picker that belongs to it.
  // Each handler checks the support participant rule and loads the reach.
  { route: `${SUPPORT_ROUTE}/threads/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/support\/threads$/ },
  {
    route: `${SUPPORT_ROUTE}/threads/[id]/route.ts`,
    methods: ["GET", "PATCH"],
    pattern: /^\/api\/v1\/support\/threads\/\d+$/,
  },
  {
    route: `${SUPPORT_ROUTE}/threads/[id]/messages/route.ts`,
    methods: ["POST"],
    pattern: /^\/api\/v1\/support\/threads\/\d+\/messages$/,
  },
  { route: `${SUPPORT_ROUTE}/stats/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/support\/stats$/ },
  { route: `${SUPPORT_ROUTE}/attachments/route.ts`, methods: ["POST"], pattern: /^\/api\/v1\/support\/attachments$/ },
  {
    route: `${SUPPORT_ROUTE}/attachments/[id]/route.ts`,
    methods: ["GET"],
    pattern: /^\/api\/v1\/support\/attachments\/\d+$/,
  },
  // The delivery challan only; the handler refuses every other purpose for this role.
  { route: "app/api/v1/upload/image/route.ts", methods: ["POST"], pattern: /^\/api\/v1\/upload\/image$/ },
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
export function isWarehouseApiRequestAllowed(method: string, pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  const verb = method.toUpperCase()
  return WAREHOUSE_API_RULES.some((rule) => rule.methods.includes(verb) && rule.pattern.test(normalized))
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function warehouseUserShapeError(organizationId: number | null, branchId: number | null): string | null {
  return organizationId || branchId
    ? "Warehouse accounts are not given an organization or branch; assign their branches from Warehouse Team"
    : null
}

/**
 * The only access changes a warehouse account accepts through the user-access
 * route are activation and MFA. Its role is fixed — an account is never turned
 * into, or out of, a cross-tenant one — and its branches are granted from Desk
 * team, never through organization or branch fields.
 */
export function warehouseAccessChangeError(
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
  if (!isWarehouseRole(targetRole) && !isWarehouseRole(nextRole)) return null
  if (nextRole !== targetRole) {
    return "An account cannot be switched to or from Warehouse; create a separate account instead"
  }
  const reachFields = [input.organizationId, input.branchId, input.groupIds, input.branchIds, input.budgetAllocationEnabled]
  if (reachFields.some((value) => value !== undefined)) {
    return "A warehouse account's branches are assigned from Warehouse Team, not here"
  }
  return null
}

// ---------------------------------------------------------------------------
// Reach
// ---------------------------------------------------------------------------

export type WarehouseAccount = {
  role: string | null
  isActive: boolean
  deleted: boolean
}

/**
 * The branches a warehouse user serves: the ones Super Admin assigned — one by
 * one, or as every branch now in an assigned city of a chosen organization —
 * while the account is an
 * active, undeleted warehouse account. An empty result means
 * no reach and must never be widened to an organization or to every tenant.
 *
 * Neither the branch's nor the organization's status is required: an approved
 * order still has to be delivered after its branch is deactivated.
 */
export function resolveWarehouseReach(input: {
  /** The user row as it is now, never the session claim. */
  account: WarehouseAccount | null
  assignedBranchIds: readonly number[]
}): number[] {
  const { account } = input
  if (!account || !isWarehouseRole(account.role) || !account.isActive || account.deleted) return []
  const ids = input.assignedBranchIds.filter((id) => Number.isSafeInteger(id) && id > 0)
  return [...new Set(ids)].sort((a, b) => a - b)
}
