/**
 * The admin activity log: the vocabulary, the classification rules and the
 * pagination cursor. Pure — no database, no request, no React.
 *
 * Three tables hold the trail (`audit_logs`, `system_logs`,
 * `group_audit_logs`), each with its own column names, and the action strings
 * inside them were written by many hands over a long time: `CREATE`,
 * `import_products`, `CASCADE_UPDATE`, `AUTH_LOGIN_SUCCESS`. This module is
 * what turns that into one vocabulary the screen can group, filter and label.
 *
 * The three rule tables below — `OPERATION_RULES`, `CATEGORY_RULES` and
 * `SEVERITY_RULES` — are deliberately the *only* statement of the
 * classification. `lib/server/activity-log-sql.ts` generates its SQL `CASE`
 * from the same tables rather than restating the rules, because the operation
 * is both a label on a row and a filter that selects rows — and a filter that
 * disagrees with the label it filters on is a screen that silently lies.
 *
 * See `plans/OF-AUDIT-admin-activity-log.md`.
 */

import type { Role } from "@/lib/rbac"

/** Which table an event came out of. */
export const ACTIVITY_SOURCES = ["audit", "system", "group"] as const

export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]

/**
 * Tie-break rank for two events sharing a timestamp. Fixed and total, because
 * the keyset cursor is only exact while the sort is: reordering these would
 * make an in-flight cursor skip or repeat a row.
 */
export const ACTIVITY_SOURCE_RANK: Readonly<Record<ActivitySource, number>> = {
  audit: 1,
  system: 2,
  group: 3,
}

export function isActivitySource(value: unknown): value is ActivitySource {
  return typeof value === "string" && (ACTIVITY_SOURCES as readonly string[]).includes(value)
}

export function activitySourceOfRank(rank: number): ActivitySource | null {
  for (const source of ACTIVITY_SOURCES) {
    if (ACTIVITY_SOURCE_RANK[source] === rank) return source
  }
  return null
}

/** What kind of change the action was. Drives the operation filter. */
export const ACTIVITY_OPERATIONS = [
  "auth",
  "create",
  "update",
  "delete",
  "approve",
  "reject",
  "export",
  "other",
] as const

export type ActivityOperation = (typeof ACTIVITY_OPERATIONS)[number]

/** Which part of the product the action belongs to. Drives the category filter. */
export const ACTIVITY_CATEGORIES = [
  "authentication",
  "user",
  "organization",
  "branch",
  "group",
  "order",
  "refund",
  "budget",
  "pricing",
  "inventory",
  "catalogue",
  "settings",
  "reports",
  "support",
  "system",
] as const

export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number]

/**
 * The roles the actor filter accepts — every role the application assigns
 * (`Role` in `lib/rbac.ts`). An allowlist, so the value reaches SQL only as one
 * of these literals.
 *
 * The filter selects on the role the **Who** column shows: the role the row
 * itself recorded where its table has one, else the account's role today. See
 * `actorRolePredicate` in `lib/server/activity-log-sql.ts`.
 */
export const ACTIVITY_ACTOR_ROLES = [
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
] as const satisfies readonly Role[]

export type ActivityActorRole = (typeof ACTIVITY_ACTOR_ROLES)[number]

/**
 * The roles a tenant's own people hold. An organization reader (Head Office, an
 * organization-wide Viewer) may filter by these alone: Apricart's internal
 * roles are not the tenant's to see, and `applyActivityReach` refuses them.
 */
export const ACTIVITY_TENANT_ACTOR_ROLES = [
  "HEAD_OFFICE",
  "GROUP_USER",
  "BRANCH_ADMIN",
  "GROUP_ORDER_PORTAL",
  "ORDER_PORTAL",
  "VIEWER",
] as const satisfies readonly ActivityActorRole[]

export function isTenantActorRole(value: unknown): boolean {
  return typeof value === "string" && (ACTIVITY_TENANT_ACTOR_ROLES as readonly string[]).includes(value)
}

export function isActivityActorRole(value: unknown): value is ActivityActorRole {
  return typeof value === "string" && (ACTIVITY_ACTOR_ROLES as readonly string[]).includes(value)
}

/**
 * How much a reader scanning the page should care. Presentation only — nothing
 * is blocked, alerted or charged from a severity.
 */
export const ACTIVITY_SEVERITIES = ["critical", "warning", "notice", "info"] as const

export type ActivitySeverity = (typeof ACTIVITY_SEVERITIES)[number]

/**
 * How a rule tests an action string. The action is upper-cased first, so every
 * `value` below is written upper-case and matching is case-insensitive — which
 * is what lets one rule cover both `UPDATE_GLOBAL_PRODUCT` and the
 * lower-cased `update_global_product` already in the table.
 */
export type ActionMatchKind = "exact" | "prefix" | "suffix" | "contains"

export type ActionRule<T> = {
  kind: ActionMatchKind
  value: string
  result: T
}

/**
 * **Operation and category are matched separately, and that is the whole point.**
 *
 * They are orthogonal: `DELETE_CATEGORY` is a *delete* of a *catalogue* thing,
 * and `CREATE_GROUP` is a *create* of a *group* thing. A single table keyed on
 * the action string cannot express that — a `CATEGORY` rule placed before the
 * generic `DELETE` rule silently reclassified every category delete as an
 * update, and the operation filter then agreed with the wrong label instead of
 * the right one. One table per question, each ordered, each first-match-wins.
 *
 * `OPERATION_RULES` reads the **verb**. Ordered; specific before general, so a
 * rule added at the end can only claim actions nothing above it claimed.
 *
 * Grounded in the action strings the application actually writes today —
 * `grep -rhoE 'action: *"[A-Za-z_0-9]+"' app lib` — rather than invented, so
 * `other` stays a genuinely small residue.
 */
export const OPERATION_RULES: readonly ActionRule<ActivityOperation>[] = [
  // A setting that *governs* sign-in is a configuration change, not a sign-in.
  // Ahead of the LOGIN rule below, which would otherwise claim it.
  { kind: "contains", value: "NETWORK_LOGIN", result: "update" },

  // Authentication is its own operation: none of the verbs below describe it,
  // and a reader scanning for sign-in activity wants it in one bucket.
  { kind: "prefix", value: "AUTH_", result: "auth" },
  { kind: "contains", value: "LOGIN", result: "auth" },
  { kind: "contains", value: "LOGOUT", result: "auth" },
  { kind: "contains", value: "SIGN_IN", result: "auth" },
  { kind: "contains", value: "MFA", result: "auth" },
  { kind: "contains", value: "PASSWORD", result: "auth" },
  { kind: "contains", value: "SESSION_REVOKED", result: "auth" },
  { kind: "contains", value: "LOCKOUT", result: "auth" },
  { kind: "contains", value: "ACCOUNT_LOCKED", result: "auth" },

  // Decisions. Before the generic verbs, because an approval is the moment
  // money is committed and must not read as an ordinary update.
  { kind: "contains", value: "APPROVED", result: "approve" },
  { kind: "contains", value: "APPROVE", result: "approve" },
  // Covers FULFILLED and FULFILLMENT too; a separate FULFILL rule would be
  // unreachable.
  { kind: "contains", value: "FULFIL", result: "approve" },
  { kind: "contains", value: "REJECTED", result: "reject" },
  { kind: "contains", value: "REJECT", result: "reject" },
  { kind: "contains", value: "CANCELLED", result: "reject" },
  { kind: "contains", value: "CANCEL", result: "reject" },

  // Reads that are recorded. `VIEW_GROUP_REPORT` is the only one today.
  { kind: "contains", value: "EXPORT", result: "export" },
  { kind: "contains", value: "SEND_SCHEDULED_REPORT", result: "export" },
  { kind: "prefix", value: "VIEW_", result: "export" },

  // Removal, including every word this codebase uses for it.
  { kind: "contains", value: "DELETE", result: "delete" },
  { kind: "contains", value: "REMOVE", result: "delete" },
  { kind: "prefix", value: "CLEANUP", result: "update" },
  { kind: "prefix", value: "CLEAN_", result: "delete" },
  { kind: "prefix", value: "CLEAR_", result: "delete" },
  // A soft delete is still a removal to the person reading the page. This must
  // stay ahead of the bare `ACTIVATE` rule further down, which it contains.
  { kind: "contains", value: "DEACTIVATE", result: "delete" },
  { kind: "contains", value: "DISABLE", result: "delete" },

  // Addition.
  { kind: "contains", value: "CREATE", result: "create" },
  { kind: "prefix", value: "IMPORT_", result: "create" },
  { kind: "contains", value: "REQUESTED", result: "create" },
  { kind: "prefix", value: "ADD_", result: "create" },
  { kind: "contains", value: "GENERATED", result: "create" },
  { kind: "contains", value: "SENT", result: "create" },
  { kind: "prefix", value: "SEND_", result: "create" },
  { kind: "prefix", value: "UPLOAD", result: "create" },
  { kind: "prefix", value: "REPLY", result: "create" },
  { kind: "prefix", value: "REBUILD", result: "create" },

  // Change, last, because most action strings that reach here are one.
  { kind: "contains", value: "UPDATE", result: "update" },
  { kind: "contains", value: "EDITED", result: "update" },
  { kind: "prefix", value: "SET_", result: "update" },
  { kind: "prefix", value: "TOGGLE_", result: "update" },
  { kind: "prefix", value: "PROPAGATE_", result: "update" },
  { kind: "prefix", value: "CASCADE_", result: "update" },
  { kind: "prefix", value: "ASSIGN", result: "update" },
  { kind: "prefix", value: "RESET_", result: "update" },
  { kind: "contains", value: "RESTORE", result: "update" },
  { kind: "contains", value: "PROCESSED", result: "update" },
  { kind: "contains", value: "EXPIRE", result: "update" },
  { kind: "contains", value: "ACTIVATE", result: "update" },
  { kind: "contains", value: "ENABLE", result: "update" },
]

/**
 * `CATEGORY_RULES` reads the **noun** — which part of the product the action
 * touched. Ordered most specific first: `ORDER_PAYMENT_STATUS_UPDATE` is an
 * order, not a payment setting.
 */
export const CATEGORY_RULES: readonly ActionRule<ActivityCategory>[] = [
  // A setting that governs sign-in, ahead of the LOGIN rule for the same reason
  // as in OPERATION_RULES.
  { kind: "contains", value: "NETWORK_LOGIN", result: "settings" },

  { kind: "prefix", value: "AUTH_", result: "authentication" },
  { kind: "contains", value: "LOGIN", result: "authentication" },
  { kind: "contains", value: "MFA", result: "authentication" },
  { kind: "contains", value: "PASSWORD", result: "authentication" },
  { kind: "contains", value: "LOCKOUT", result: "authentication" },
  { kind: "contains", value: "SESSION", result: "authentication" },

  // Privilege before people: a role or permission change is a system-level act
  // even when its object happens to be a user.
  { kind: "contains", value: "PERMISSION", result: "system" },
  { kind: "contains", value: "ROLE", result: "system" },

  { kind: "contains", value: "PRICE", result: "pricing" },
  { kind: "contains", value: "REFUND", result: "refund" },
  { kind: "contains", value: "BUDGET", result: "budget" },
  { kind: "contains", value: "SUPPORT", result: "support" },
  { kind: "contains", value: "ORDER", result: "order" },
  { kind: "contains", value: "GROUP", result: "group" },
  // A tenant's stocked catalogue is inventory, not tenant administration —
  // ahead of the bare ORGANIZATION rule, which would otherwise claim it.
  { kind: "contains", value: "ORGANIZATION_INVENTORY", result: "inventory" },
  { kind: "contains", value: "ORGANIZATION", result: "organization" },
  // A branch's catalogue and stock are not branch administration. Both are
  // ahead of the bare BRANCH rule, which would otherwise claim them.
  { kind: "contains", value: "BRANCH_PRODUCT", result: "catalogue" },
  { kind: "contains", value: "BRANCH_INVENTORY", result: "inventory" },
  { kind: "contains", value: "BRANCH", result: "branch" },
  { kind: "contains", value: "CREDENTIAL", result: "user" },
  { kind: "contains", value: "USER", result: "user" },
  { kind: "contains", value: "SUBCATEGORY", result: "catalogue" },
  { kind: "contains", value: "CATEGORY", result: "catalogue" },
  { kind: "contains", value: "SUPPLIER", result: "catalogue" },
  { kind: "contains", value: "MODIFIER", result: "catalogue" },
  { kind: "contains", value: "PRODUCT", result: "catalogue" },
  { kind: "contains", value: "INVENTORY", result: "inventory" },
  { kind: "contains", value: "STOCK", result: "inventory" },
  { kind: "contains", value: "SETTING", result: "settings" },
  { kind: "contains", value: "REPORT", result: "reports" },
  { kind: "contains", value: "SCHEDULE", result: "reports" },
]

/**
 * `SEVERITY_RULES` reads weight, and is consulted **before** the default that
 * operation and category imply. These are the rows an administrator scanning
 * the page must not miss: a privilege change, a price change, a lockout, and
 * anything that reached many rows at once.
 */
export const SEVERITY_RULES: readonly ActionRule<ActivitySeverity>[] = [
  { kind: "contains", value: "PERMISSION", result: "critical" },
  { kind: "contains", value: "APPROVER_ROLE", result: "critical" },
  { kind: "exact", value: "USER_ACCESS_UPDATE", result: "critical" },
  { kind: "contains", value: "PRIVATE_NETWORK_LOGIN", result: "critical" },
  { kind: "contains", value: "PRICE", result: "critical" },
  { kind: "contains", value: "PASSWORD", result: "critical" },
  { kind: "contains", value: "ACCOUNT_LOCKED", result: "critical" },
  { kind: "contains", value: "LOCKOUT", result: "critical" },
  { kind: "contains", value: "CREDENTIAL", result: "critical" },
  { kind: "prefix", value: "BULK_", result: "critical" },
  { kind: "prefix", value: "CASCADE_", result: "critical" },
  { kind: "prefix", value: "CLEAN_", result: "critical" },
  { kind: "prefix", value: "RESET_", result: "critical" },
  { kind: "prefix", value: "REBUILD", result: "critical" },
  { kind: "prefix", value: "CLEANUP", result: "critical" },
  { kind: "prefix", value: "CREATE_ORGANIZATION", result: "critical" },
  // Removing a second factor is removing a security control, and is the first
  // thing someone holding a stolen session would do.
  { kind: "contains", value: "MFA_DISABLED", result: "critical" },
  // A tenant's figures leaving the application by email.
  { kind: "contains", value: "SCHEDULED_REPORT", result: "notice" },
]

/**
 * The weight a row carries when no `SEVERITY_RULES` entry claims it. A delete is
 * always worth a second look; a decision or a money movement is worth noticing.
 */
export const SEVERITY_BY_OPERATION: Readonly<Record<ActivityOperation, ActivitySeverity>> = {
  auth: "info",
  create: "info",
  update: "info",
  delete: "critical",
  approve: "notice",
  reject: "notice",
  export: "info",
  other: "info",
}

/**
 * `system` is deliberately absent: it is the *default* category, so weighting it
 * would quietly promote every action no rule recognises.
 */
export const SEVERITY_BY_CATEGORY: Partial<Readonly<Record<ActivityCategory, ActivitySeverity>>> = {
  refund: "notice",
  budget: "notice",
  organization: "notice",
  user: "notice",
}

/** Highest wins. Also the order the screen sorts a severity legend in. */
export const SEVERITY_RANK: Readonly<Record<ActivitySeverity, number>> = {
  info: 0,
  notice: 1,
  warning: 2,
  critical: 3,
}

function highestSeverity(...candidates: (ActivitySeverity | undefined)[]): ActivitySeverity {
  let best: ActivitySeverity = "info"
  for (const candidate of candidates) {
    if (candidate && SEVERITY_RANK[candidate] > SEVERITY_RANK[best]) best = candidate
  }
  return best
}

/** What an action falls back to when no rule claims it. */
export const UNCLASSIFIED: Readonly<{
  operation: ActivityOperation
  category: ActivityCategory
  severity: ActivitySeverity
}> = { operation: "other", category: "system", severity: "info" }

export function matchesActionRule<T>(rule: ActionRule<T>, upperAction: string): boolean {
  switch (rule.kind) {
    case "exact":
      return upperAction === rule.value
    case "prefix":
      return upperAction.startsWith(rule.value)
    case "suffix":
      return upperAction.endsWith(rule.value)
    case "contains":
      return upperAction.includes(rule.value)
  }
}

/**
 * The first rule of a table that claims this action, or null. Exported so the
 * SQL generator and its test walk the same path the labels take.
 */
export function matchActionRule<T>(
  rules: readonly ActionRule<T>[],
  action: string,
): ActionRule<T> | null {
  const upper = normalizeActionForMatch(action)
  if (upper.length === 0) return null
  for (const rule of rules) {
    if (matchesActionRule(rule, upper)) return rule
  }
  return null
}

/** Upper-case and trim, so `update_global_product` classifies like `UPDATE_GLOBAL_PRODUCT`. */
export function normalizeActionForMatch(action: string | null | undefined): string {
  return typeof action === "string" ? action.trim().toUpperCase() : ""
}

export function operationOf(action: string): ActivityOperation {
  return matchActionRule(OPERATION_RULES, action)?.result ?? UNCLASSIFIED.operation
}

export function categoryOf(action: string): ActivityCategory {
  return matchActionRule(CATEGORY_RULES, action)?.result ?? UNCLASSIFIED.category
}

/**
 * A failed attempt is never merely informational, however its action would
 * classify on its own — a failed login and a successful one are the same
 * action string and very different rows to a reader. Critical stays critical:
 * a failure cannot make a row matter *less*.
 */
export function severityOf(action: string, success = true): ActivitySeverity {
  // The highest of the three, rather than the first to answer: `USER_DELETE` is
  // a delete (critical) of a user (notice), and reading them in either fixed
  // order would let one of the two silently decide for the other.
  const base = highestSeverity(
    matchActionRule(SEVERITY_RULES, action)?.result,
    SEVERITY_BY_OPERATION[operationOf(action)],
    SEVERITY_BY_CATEGORY[categoryOf(action)],
  )

  if (success) return base
  return base === "critical" ? "critical" : "warning"
}

/** `AUTH_LOGIN_SUCCESS` -> `Auth login success`. Never shown instead of the raw action. */
export function actionLabel(action: string | null | undefined): string {
  const raw = typeof action === "string" ? action.trim() : ""
  if (raw.length === 0) return "Unknown action"
  const words = raw.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** `organization_settings` / `GlobalProduct` -> `Organization settings` / `Global product`. */
export function entityLabel(entity: string | null | undefined): string {
  const raw = typeof entity === "string" ? entity.trim() : ""
  if (raw.length === 0) return "—"
  const spaced = raw
    .replace(/[_\-.]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

// ---------------------------------------------------------------------------
// Query bounds
// ---------------------------------------------------------------------------

/** One page. The maximum bounds both the response size and one query's work. */
export const ACTIVITY_PAGE_SIZE_DEFAULT = 50
export const ACTIVITY_PAGE_SIZE_MAX = 200

/**
 * How far back one query may reach. The default keeps the first read of the
 * screen cheap; the maximum stops a single request asking for the whole
 * history of three unbounded tables.
 */
export const ACTIVITY_DEFAULT_WINDOW_DAYS = 7
export const ACTIVITY_MAX_WINDOW_DAYS = 366

/** Bounded so a hostile or pasted value cannot become an expensive `ILIKE`. */
export const ACTIVITY_SEARCH_MAX_LENGTH = 128

/** `action` is `varchar(128)` in all three tables. */
export const ACTIVITY_ACTION_MAX_LENGTH = 128

export const MS_PER_DAY = 24 * 60 * 60 * 1000

export function clampPageSize(limit: number | null | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) return ACTIVITY_PAGE_SIZE_DEFAULT
  const whole = Math.floor(limit)
  if (whole < 1) return 1
  return Math.min(whole, ACTIVITY_PAGE_SIZE_MAX)
}

export type ActivityWindow = { from: Date; to: Date }

/**
 * Resolve the window a request asked for, refusing rather than silently
 * truncating an over-long one: an administrator who asked for two years and
 * quietly got one would read the result as "nothing happened".
 */
export function resolveWindow(
  from: Date | null | undefined,
  to: Date | null | undefined,
  now: Date,
): { window: ActivityWindow } | { error: string } {
  const end = to ?? now
  const start = from ?? new Date(end.getTime() - ACTIVITY_DEFAULT_WINDOW_DAYS * MS_PER_DAY)
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return { error: "from and to must be valid dates" }
  }
  if (start.getTime() > end.getTime()) {
    return { error: "from must not be later than to" }
  }
  const days = (end.getTime() - start.getTime()) / MS_PER_DAY
  if (days > ACTIVITY_MAX_WINDOW_DAYS) {
    return { error: `The date range may not exceed ${ACTIVITY_MAX_WINDOW_DAYS} days` }
  }
  return { window: { from: start, to: end } }
}

// ---------------------------------------------------------------------------
// The keyset cursor
// ---------------------------------------------------------------------------

export type ActivityCursor = {
  /** Epoch milliseconds of the last row on the previous page. */
  occurredAtMs: number
  source: ActivitySource
  id: number
}

/**
 * Opaque to the client on purpose: it is a position in a sort, not an API, and
 * encoding it keeps a caller from hand-building one that walks a different
 * ordering than the server is using.
 */
export function encodeActivityCursor(cursor: ActivityCursor): string {
  const raw = `${cursor.occurredAtMs}.${ACTIVITY_SOURCE_RANK[cursor.source]}.${cursor.id}`
  return Buffer.from(raw, "utf8").toString("base64url")
}

/** Null for anything malformed — a bad cursor is a 400, never a silent first page. */
export function decodeActivityCursor(value: string | null | undefined): ActivityCursor | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return null
  let raw: string
  try {
    raw = Buffer.from(value, "base64url").toString("utf8")
  } catch {
    return null
  }
  const parts = raw.split(".")
  if (parts.length !== 3) return null
  const [msPart, rankPart, idPart] = parts
  if (!/^\d{1,15}$/.test(msPart) || !/^\d{1,2}$/.test(rankPart) || !/^\d{1,12}$/.test(idPart)) {
    return null
  }
  const source = activitySourceOfRank(Number(rankPart))
  if (!source) return null
  return { occurredAtMs: Number(msPart), source, id: Number(idPart) }
}

/**
 * How one branch of the union compares its timestamp against the cursor.
 *
 * The page is ordered `occurredAt DESC, sourceRank DESC, id DESC`, and the
 * cursor predicate is pushed into each branch separately so each one can use
 * its own time index. At an identical timestamp the branches are not
 * interchangeable, which gives three cases:
 *
 *  * `same` — this is the cursor's own table: skip past its id too.
 *  * `after` — this source sorts after the cursor's at an equal timestamp, so
 *    its rows at exactly that timestamp are still unread: include them.
 *  * `before` — this source sorts before the cursor's, so anything at that
 *    timestamp was already on a previous page: exclude it.
 */
export type CursorComparison = "same" | "after" | "before"

export function cursorComparisonFor(
  branch: ActivitySource,
  cursorSource: ActivitySource,
): CursorComparison {
  if (branch === cursorSource) return "same"
  // DESC on rank: a *lower* rank sorts after a higher one.
  return ACTIVITY_SOURCE_RANK[branch] < ACTIVITY_SOURCE_RANK[cursorSource] ? "after" : "before"
}

// ---------------------------------------------------------------------------
// The event the screen reads
// ---------------------------------------------------------------------------

export type ActivityActor = {
  id: string | null
  email: string | null
  name: string | null
  role: string | null
  /**
   * True when the reader may not know who this was — an organization-scoped
   * reader looking at an action taken by someone outside their organization.
   * `id`, `email` and `name` are then withheld, not merely unknown. See
   * `lib/activity-log-reach.ts`.
   */
  redacted: boolean
}

export type ActivityEvent = {
  /** `<source>:<row id>` — unique across the union, and names its own table. */
  id: string
  source: ActivitySource
  occurredAt: string
  action: string
  actionLabel: string
  operation: ActivityOperation
  category: ActivityCategory
  severity: ActivitySeverity
  entity: string | null
  entityLabel: string
  entityId: string | null
  actor: ActivityActor
  organizationId: number | null
  organizationName: string | null
  branchId: number | null
  branchName: string | null
  success: boolean
  errorMessage: string | null
  ipAddress: string | null
  userAgent: string | null
  metadata: unknown
}

export function activityEventId(source: ActivitySource, id: number): string {
  return `${source}:${id}`
}

export type ActivityLogPage = {
  items: ActivityEvent[]
  /** Absent when this is the last page. Opaque; pass it back as `cursor`. */
  nextCursor: string | null
  hasMore: boolean
  /** Echoed so the screen can show the window it is actually reading. */
  window: { from: string; to: string }
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/** Keys whose value never belongs in a trail a person reads. */
const SENSITIVE_KEY_PARTS = [
  "password",
  "token",
  "secret",
  "apikey",
  "api_key",
  "otp",
  "pin",
  "authorization",
  "credential",
  "sessionid",
  "cookie",
] as const

export const METADATA_MASK = "***MASKED***"

/**
 * Depth past which nesting is replaced rather than walked, and the most keys or
 * elements kept at one level. A metadata blob is written by many callers and
 * read into a 50-row page; neither a cycle nor a ten-thousand-element array may
 * be able to stall the screen.
 */
export const METADATA_MAX_DEPTH = 8
export const METADATA_MAX_ENTRIES = 200

/**
 * Mask sensitive values and bound the shape.
 *
 * Used on the **write** side, so a secret never enters the trail, and again on
 * the **read** side, because rows written before this existed were not filtered
 * and the screen must not be the thing that finally displays one.
 *
 * `maskSensitiveData` in `lib/error-handler.ts` is not reused here: it spreads
 * with `{...data}`, which turns an array into an object keyed `0`, `1`, `2` —
 * fine for an error context, wrong for an audit payload whose arrays a reader
 * needs to recognise.
 */
export function maskAuditMetadata(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (typeof value !== "object") return value
  if (depth >= METADATA_MAX_DEPTH) return "[truncated]"
  if (seen.has(value)) return "[circular]"
  seen.add(value)

  if (Array.isArray(value)) {
    const kept = value.slice(0, METADATA_MAX_ENTRIES).map((item) => maskAuditMetadata(item, depth + 1, seen))
    if (value.length > METADATA_MAX_ENTRIES) {
      kept.push(`[${value.length - METADATA_MAX_ENTRIES} more]`)
    }
    return kept
  }

  if (value instanceof Date) return value.toISOString()

  const out: Record<string, unknown> = {}
  const keys = Object.keys(value as Record<string, unknown>)
  for (const key of keys.slice(0, METADATA_MAX_ENTRIES)) {
    const lower = key.toLowerCase()
    if (SENSITIVE_KEY_PARTS.some((part) => lower.includes(part))) {
      out[key] = METADATA_MASK
      continue
    }
    out[key] = maskAuditMetadata((value as Record<string, unknown>)[key], depth + 1, seen)
  }
  if (keys.length > METADATA_MAX_ENTRIES) {
    out["…"] = `[${keys.length - METADATA_MAX_ENTRIES} more keys]`
  }
  return out
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/**
 * How much of the trail a reader may see, decided by the server from the
 * caller's own account — never from the request.
 *
 * * `platform` — every tenant and the platform rows that belong to none.
 *   Super Admin.
 * * `organization` — the rows of one tenant, with anyone outside it
 *   anonymised. Head Office, for its own organization.
 *
 * Deliberately a separate thing from the `organizationId` *filter*: the filter
 * is what a caller asked for and is optional; the reach is what the server
 * permits and is required, so loosening one can never loosen the other.
 */
export type ActivityReach =
  | { kind: "platform" }
  | { kind: "organization"; organizationId: number }

/** The filters a request asked for, before the server has fenced them. */
export type ActivityRequestFilters = Omit<ActivityFilters, "reach" | "searchActorIds">

export type ActivityFilters = {
  /** Required: no query is built without saying whose trail it reads. */
  reach: ActivityReach
  from: Date
  to: Date
  limit: number
  cursor: ActivityCursor | null
  sources: readonly ActivitySource[] | null
  operation: ActivityOperation | null
  category: ActivityCategory | null
  action: string | null
  organizationId: number | null
  branchId: number | null
  actorId: string | null
  /** The role shown beside the actor. For an organization reach, only people the reader may identify match. */
  actorRole: ActivityActorRole | null
  success: boolean | null
  search: string | null
  /**
   * Actor ids whose account matched `search`, resolved from `users` **before**
   * the union runs.
   *
   * Only `system_logs` denormalizes the actor's email; `audit_logs` and
   * `group_audit_logs` store an id alone, so a free-text search for a person
   * would find their sign-ins and none of their changes. Resolving the term to
   * ids first — one bounded lookup — makes search mean the same thing on all
   * three, without a join inside the part of the query that has to stay cheap.
   *
   * Filled in by `loadActivityPage`, never by a caller.
   */
  searchActorIds?: readonly string[]
}

/** How many accounts one search term may resolve to before it stops narrowing. */
export const ACTIVITY_SEARCH_ACTOR_LIMIT = 200

export function isActivityOperation(value: unknown): value is ActivityOperation {
  return typeof value === "string" && (ACTIVITY_OPERATIONS as readonly string[]).includes(value)
}

export function isActivityCategory(value: unknown): value is ActivityCategory {
  return typeof value === "string" && (ACTIVITY_CATEGORIES as readonly string[]).includes(value)
}
