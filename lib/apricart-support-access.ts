/**
 * The Apricart Support role, in one place.
 *
 * Apricart's support agents: they work the support queue — every thread, in
 * every organization — with everything Super Admin can do there (reply,
 * resolve, triage, close and reopen, be assigned), and reach nothing else in
 * the platform. Modelled on `APRICART_EXECUTIVE`
 * (`lib/apricart-executive-access.ts`), the other Apricart role confined to one
 * area:
 *
 *   * **No organization and no branch.** The support queue spans every tenant,
 *     so neither is ever written onto the user row.
 *   * **Only Super Admin creates or manages one.** `ROLE_LEVEL` puts it above
 *     Head Office for that reason alone (`lib/server/user-access-policy.ts`).
 *   * **Confined to `/support` and a short API allowlist.** `proxy.ts` refuses
 *     every API call not in `APRICART_SUPPORT_API_RULES` before a handler runs.
 *     Each listed handler also checks the support rules itself
 *     (`lib/support-access.ts`); this layer exists because most handlers check
 *     roles inline, and a role with no organization is exactly the caller an
 *     inline `if (orgId) filter` forgets to filter.
 *
 * Which side of a conversation it speaks for is `SUPPORT_APRICART_ROLES` in
 * `lib/support-thread.ts`, not this module.
 *
 * See plans/OF-SUPPORT-apricart-support-role.md.
 */

export const APRICART_SUPPORT_ROLE = "APRICART_SUPPORT" as const
export const APRICART_SUPPORT_LABEL = "Apricart Support"

/** The agent's only page area: the shared support pages. */
export const APRICART_SUPPORT_HOME = "/support"
export const APRICART_SUPPORT_AREAS: readonly string[] = [APRICART_SUPPORT_HOME]

export function isApricartSupportRole(role: unknown): role is typeof APRICART_SUPPORT_ROLE {
  return role === APRICART_SUPPORT_ROLE
}

// ---------------------------------------------------------------------------
// The API allowlist
// ---------------------------------------------------------------------------

type ApricartSupportApiRule = {
  /** The handler file, so a contract test can check it really admits the role. */
  route: string
  methods: readonly string[]
  pattern: RegExp
}

const SUPPORT_ROUTE = "app/api/v1/support"

/**
 * Every API request a support session may make: the calls the support pages
 * make on the Apricart side, and the three calls every account needs to finish
 * a forced password change.
 *
 * Deliberately absent: `POST /api/v1/support/threads` (Apricart raises no
 * thread — it has no tenant to raise one for) and `/api/v1/support/products`
 * (the product picker belongs to the raise dialog).
 */
export const APRICART_SUPPORT_API_RULES: readonly ApricartSupportApiRule[] = [
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
export function isApricartSupportApiRequestAllowed(method: string, pathname: string): boolean {
  const normalized = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname
  const verb = method.toUpperCase()
  return APRICART_SUPPORT_API_RULES.some((rule) => rule.methods.includes(verb) && rule.pattern.test(normalized))
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

export function apricartSupportUserShapeError(organizationId: number | null, branchId: number | null): string | null {
  return organizationId || branchId
    ? "Apricart Support accounts answer every organization's support requests and are not assigned an organization or branch"
    : null
}

/**
 * The only access changes a support account accepts through the user-access
 * route are activation and MFA. Its role is fixed — an account is never turned
 * into, or out of, a cross-tenant one — and it has no reach to edit.
 */
export function apricartSupportAccessChangeError(
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
  if (!isApricartSupportRole(targetRole) && !isApricartSupportRole(nextRole)) return null
  if (nextRole !== targetRole) {
    return "An account cannot be switched to or from Apricart Support; create a separate account instead"
  }
  const reachFields = [input.organizationId, input.branchId, input.groupIds, input.branchIds, input.budgetAllocationEnabled]
  if (reachFields.some((value) => value !== undefined)) {
    return "Apricart Support accounts answer every organization and have no organization or branch to change"
  }
  return null
}
