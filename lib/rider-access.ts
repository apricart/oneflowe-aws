/**
 * The Rider role and rider-ops API allowlists, in one place.
 *
 * Riders are Apricart field staff with no organization on the user row.
 * Reach is the set of `rider_order_assignments` rows for that user — never a
 * branch city rule. Warehouse managers (`WAREHOUSE`) and Super Admin create
 * and assign via `/api/v1/rider-ops`. See plans/OF-RIDER-DELIVERY-backend.md.
 */

export const RIDER_ROLE = "RIDER" as const
export const RIDER_LABEL = "Rider (Apricart)"

/** Riders have no web shell in this pass; API-only. */
export const RIDER_HOME = "/rider"
export const RIDER_AREAS: readonly string[] = [RIDER_HOME]

export const RIDER_MANAGER_ROLES: readonly string[] = ["SUPER_ADMIN", "WAREHOUSE"]

export function isRiderRole(role: unknown): role is typeof RIDER_ROLE {
  return role === RIDER_ROLE
}

export function canManageRiders(role: unknown): boolean {
  return typeof role === "string" && RIDER_MANAGER_ROLES.includes(role)
}

export function riderUserShapeError(
  organizationId: number | null,
  branchId: number | null,
): string | null {
  return organizationId || branchId
    ? "Rider accounts are not given an organization or branch"
    : null
}

export function riderAccessChangeError(
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
  if (!isRiderRole(targetRole) && !isRiderRole(nextRole)) return null
  if (nextRole !== targetRole) {
    return "An account cannot be switched to or from Rider; create a separate account instead"
  }
  const reachFields = [
    input.organizationId,
    input.branchId,
    input.groupIds,
    input.branchIds,
    input.budgetAllocationEnabled,
  ]
  if (reachFields.some((value) => value !== undefined)) {
    return "A rider account has no organization or branch assignment"
  }
  return null
}

type ApiRule = {
  route: string
  methods: readonly string[]
  pattern: RegExp
}

const RIDER_BASE = "app/api/v1/rider"
const OPS_BASE = "app/api/v1/rider-ops"

/**
 * Every API a RIDER session may call. proxy.ts refuses anything else.
 * Password-change endpoints match the other Apricart staff roles.
 */
export const RIDER_API_RULES: readonly ApiRule[] = [
  { route: `${RIDER_BASE}/auth/login/route.ts`, methods: ["POST"], pattern: /^\/api\/v1\/rider\/auth\/login$/ },
  { route: `${RIDER_BASE}/auth/refresh/route.ts`, methods: ["POST"], pattern: /^\/api\/v1\/rider\/auth\/refresh$/ },
  { route: `${RIDER_BASE}/auth/logout/route.ts`, methods: ["POST"], pattern: /^\/api\/v1\/rider\/auth\/logout$/ },
  { route: `${RIDER_BASE}/auth/me/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/rider\/auth\/me$/ },
  { route: `${RIDER_BASE}/profile/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/rider\/profile$/ },
  { route: `${RIDER_BASE}/duty/route.ts`, methods: ["PATCH"], pattern: /^\/api\/v1\/rider\/duty$/ },
  { route: `${RIDER_BASE}/orders/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/rider\/orders$/ },
  {
    route: `${RIDER_BASE}/orders/[orderId]/route.ts`,
    methods: ["GET"],
    pattern: /^\/api\/v1\/rider\/orders\/[^/]+$/,
  },
  {
    route: `${RIDER_BASE}/orders/[orderId]/status/route.ts`,
    methods: ["PATCH"],
    pattern: /^\/api\/v1\/rider\/orders\/[^/]+\/status$/,
  },
  {
    route: `${RIDER_BASE}/orders/[orderId]/arrive/route.ts`,
    methods: ["POST"],
    pattern: /^\/api\/v1\/rider\/orders\/[^/]+\/arrive$/,
  },
  {
    route: `${RIDER_BASE}/orders/[orderId]/pod/route.ts`,
    methods: ["POST"],
    pattern: /^\/api\/v1\/rider\/orders\/[^/]+\/pod$/,
  },
  {
    route: `${RIDER_BASE}/orders/[orderId]/fulfillment-token/route.ts`,
    methods: ["POST"],
    pattern: /^\/api\/v1\/rider\/orders\/[^/]+\/fulfillment-token$/,
  },
  { route: `${RIDER_BASE}/route/route.ts`, methods: ["GET"], pattern: /^\/api\/v1\/rider\/route$/ },
  { route: `${RIDER_BASE}/location/route.ts`, methods: ["POST"], pattern: /^\/api\/v1\/rider\/location$/ },
  {
    route: "app/api/v1/users/me/change-password/route.ts",
    methods: ["POST"],
    pattern: /^\/api\/v1\/users\/me\/change-password$/,
  },
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

/**
 * rider-ops routes warehouse / Super Admin may call. Merged into the warehouse
 * proxy allowlist so WAREHOUSE is not refused before the handler runs.
 */
export const RIDER_OPS_API_RULES: readonly ApiRule[] = [
  { route: `${OPS_BASE}/riders/route.ts`, methods: ["GET", "POST"], pattern: /^\/api\/v1\/rider-ops\/riders$/ },
  {
    route: `${OPS_BASE}/riders/[id]/route.ts`,
    methods: ["GET", "PATCH"],
    pattern: /^\/api\/v1\/rider-ops\/riders\/[0-9a-f-]{36}$/i,
  },
  { route: `${OPS_BASE}/depot/route.ts`, methods: ["GET", "PUT"], pattern: /^\/api\/v1\/rider-ops\/depot$/ },
  {
    route: `${OPS_BASE}/assignments/route.ts`,
    methods: ["GET", "POST"],
    pattern: /^\/api\/v1\/rider-ops\/assignments$/,
  },
  {
    route: `${OPS_BASE}/assignments/sequence/route.ts`,
    methods: ["PATCH"],
    pattern: /^\/api\/v1\/rider-ops\/assignments\/sequence$/,
  },
  {
    route: `${OPS_BASE}/assignments/[id]/route.ts`,
    methods: ["GET"],
    pattern: /^\/api\/v1\/rider-ops\/assignments\/\d+$/,
  },
  {
    route: `${OPS_BASE}/assignments/[id]/pod/approve/route.ts`,
    methods: ["POST"],
    pattern: /^\/api\/v1\/rider-ops\/assignments\/\d+\/pod\/approve$/,
  },
  {
    route: `${OPS_BASE}/assignments/[id]/pod/reject/route.ts`,
    methods: ["POST"],
    pattern: /^\/api\/v1\/rider-ops\/assignments\/\d+\/pod\/reject$/,
  },
  {
    route: `${OPS_BASE}/riders/locations/route.ts`,
    methods: ["GET"],
    pattern: /^\/api\/v1\/rider-ops\/riders\/locations$/,
  },
]

function normalizePath(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
}

export function isRiderApiRequestAllowed(method: string, pathname: string): boolean {
  const normalized = normalizePath(pathname)
  const verb = method.toUpperCase()
  // Login + refresh are public (no session yet).
  if (
    verb === "POST" &&
    (normalized === "/api/v1/rider/auth/login" || normalized === "/api/v1/rider/auth/refresh")
  ) {
    return true
  }
  return RIDER_API_RULES.some((rule) => rule.methods.includes(verb) && rule.pattern.test(normalized))
}

export function isRiderOpsApiRequestAllowed(method: string, pathname: string): boolean {
  const normalized = normalizePath(pathname)
  const verb = method.toUpperCase()
  return RIDER_OPS_API_RULES.some(
    (rule) => rule.methods.includes(verb) && rule.pattern.test(normalized),
  )
}
