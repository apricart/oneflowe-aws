import "server-only"

import { sql, type SQL } from "drizzle-orm"

import { roles, users } from "@/db/schema"
import {
  ACTIVITY_SOURCE_RANK,
  CATEGORY_RULES,
  OPERATION_RULES,
  UNCLASSIFIED,
  cursorComparisonFor,
  type ActionRule,
  type ActivityCursor,
  type ActivityFilters,
  type ActivityReach,
  type ActivitySource,
} from "@/lib/activity-log"
import { PLATFORM_ACTOR_ROLE_NAMES } from "@/lib/activity-log-reach"

/**
 * The SQL half of the activity log: one merged, keyset-paginated read across
 * `audit_logs`, `system_logs` and `group_audit_logs`.
 *
 * Two things here are load-bearing.
 *
 * **The classification is generated, not restated.** `operationCaseSql` and
 * `categoryCaseSql` build their `CASE` from `ACTION_RULES` in
 * `lib/activity-log.ts` — the same ordered table the TypeScript classifier
 * walks. The operation is both the badge on a row and a filter that selects
 * rows, so a second hand-written copy of the rules would eventually disagree
 * with the labels it filters on, and the screen would drop rows while showing
 * a filter that claims to include them.
 *
 * **The cursor predicate is pushed into each branch.** Each branch then scans
 * its own time index (`audit_created_action_idx`, `system_logs_timestamp_idx`,
 * `group_audit_timestamp_idx`), orders and limits to the page size on its own,
 * and the union merges three short sorted streams. The global newest *n* rows
 * are necessarily within the newest *n* of each table, so the per-branch limit
 * loses nothing — and nothing here needs `OFFSET`, which on a table that grows
 * without bound costs a scan of everything it skips.
 *
 * **The tenant fence is in every branch.** `filters.reach` is required, and an
 * organization reach adds `organization_id = $org` to all three branches
 * before any caller-supplied filter — see `plans/OF-AUDIT-head-office-activity-log.md`.
 *
 * Every value reaching the database is a bound parameter. The only text
 * assembled in code is structural — table names, column names and the rule
 * values from `ACTION_RULES` — and even the rule values go in as parameters,
 * so no part of this file concatenates a caller's input into SQL.
 *
 * A row whose timestamp is null cannot be placed in a chronological view and
 * so is not returned. `audit_logs.created_at` and `group_audit_logs.created_at`
 * are nullable with a default; in practice only a hand-written row lacks one.
 */

// ---------------------------------------------------------------------------
// Classification, generated from ACTION_RULES
// ---------------------------------------------------------------------------

/**
 * The test for one rule against an already-upper-cased action expression.
 *
 * `position`/`left`/`right` rather than `LIKE`, deliberately: `_` is a LIKE
 * wildcard and nearly every action string in this application contains one, so
 * a `LIKE 'AUTH\_%'` here would need escaping that is easy to get subtly wrong.
 */
function ruleTestSql<T>(rule: ActionRule<T>, upperAction: SQL): SQL {
  switch (rule.kind) {
    case "exact":
      return sql`${upperAction} = ${rule.value}`
    case "prefix":
      return sql`left(${upperAction}, ${rule.value.length}) = ${rule.value}`
    case "suffix":
      return sql`right(${upperAction}, ${rule.value.length}) = ${rule.value}`
    case "contains":
      return sql`position(${rule.value} in ${upperAction}) > 0`
  }
}

/**
 * A `CASE` over one rule table. `CASE` takes the first arm that matches, which
 * is precisely what `matchActionRule` does in TypeScript — so generating the
 * arms in table order is what makes the two agree, rather than a promise that
 * they were written to.
 */
function classificationCaseSql<T extends string>(
  upperAction: SQL,
  rules: readonly ActionRule<T>[],
  fallback: T,
): SQL {
  const branches: SQL[] = rules.map(
    (rule) => sql`when ${ruleTestSql(rule, upperAction)} then ${rule.result}`,
  )
  return sql`(case ${sql.join(branches, sql` `)} else ${fallback} end)`
}

export function operationCaseSql(upperAction: SQL): SQL {
  return classificationCaseSql(upperAction, OPERATION_RULES, UNCLASSIFIED.operation)
}

export function categoryCaseSql(upperAction: SQL): SQL {
  return classificationCaseSql(upperAction, CATEGORY_RULES, UNCLASSIFIED.category)
}

// ---------------------------------------------------------------------------
// One branch of the union
// ---------------------------------------------------------------------------

/**
 * How one source's rows are addressed. Collected here rather than spread
 * through three near-identical query builders, so a column that moves is
 * changed once and the three branches cannot drift into different shapes.
 */
type SourceShape = {
  source: ActivitySource
  table: string
  alias: string
  /** The chronological column. `system_logs` calls it `timestamp`. */
  time: string
  action: string
  /** Null where the source has no such column; the branch selects a typed NULL. */
  entity: string | null
  entityId: string | null
  /** A literal entity name for a source whose rows are all one kind of thing. */
  entityLiteral: string | null
  actorId: string
  actorRole: string | null
  actorEmail: string | null
  organizationId: string
  branchId: string | null
  payload: string
  ipAddress: string | null
  userAgent: string | null
  /** Null where every row of the source is a success by construction. */
  success: string | null
  errorMessage: string | null
}

const SOURCE_SHAPES: readonly SourceShape[] = [
  {
    source: "audit",
    table: "audit_logs",
    alias: "al",
    time: "created_at",
    action: "action",
    entity: "entity",
    entityId: "entity_id",
    entityLiteral: null,
    actorId: "user_id",
    actorRole: null,
    actorEmail: null,
    organizationId: "organization_id",
    branchId: "branch_id",
    payload: "metadata",
    // `audit_logs` has no IP or user-agent column. `recordAuditEvent` puts both
    // in `metadata`, so they are read back out of it rather than migrating an
    // append-only table that already holds millions of rows without them.
    ipAddress: null,
    userAgent: null,
    success: null,
    errorMessage: null,
  },
  {
    source: "system",
    table: "system_logs",
    alias: "sl",
    time: "timestamp",
    action: "action",
    entity: "resource_type",
    entityId: "resource_id",
    entityLiteral: null,
    actorId: "user_id",
    actorRole: "user_role",
    actorEmail: "user_email",
    organizationId: "organization_id",
    branchId: "branch_id",
    payload: "details",
    ipAddress: "ip_address",
    userAgent: "user_agent",
    success: "success",
    errorMessage: "error_message",
  },
  {
    source: "group",
    table: "group_audit_logs",
    alias: "gal",
    time: "created_at",
    action: "action",
    entity: null,
    entityId: "group_id",
    entityLiteral: "group",
    actorId: "performed_by_user_id",
    actorRole: "performed_by_role",
    actorEmail: null,
    organizationId: "organization_id",
    branchId: null,
    payload: "metadata",
    ipAddress: null,
    userAgent: null,
    success: null,
    errorMessage: null,
  },
]

export function sourceShapeOf(source: ActivitySource): SourceShape {
  const shape = SOURCE_SHAPES.find((candidate) => candidate.source === source)
  if (!shape) throw new Error(`No shape defined for activity source "${source}"`)
  return shape
}

/** `al."created_at"` — identifiers only, all of them constants in this file. */
function column(shape: SourceShape, name: string): SQL {
  return sql.raw(`${shape.alias}."${name}"`)
}

/**
 * The keyset predicate for this branch.
 *
 * The page is ordered `occurred_at DESC, source_rank DESC, id DESC`. At an
 * identical timestamp the three sources are not interchangeable, so which rows
 * of *this* branch are still unread depends on how its rank compares with the
 * cursor's — see `cursorComparisonFor`.
 */
function cursorPredicate(shape: SourceShape, cursor: ActivityCursor): SQL {
  const at = new Date(cursor.occurredAtMs)
  const time = column(shape, shape.time)
  switch (cursorComparisonFor(shape.source, cursor.source)) {
    case "same":
      return sql`(${time} < ${at} or (${time} = ${at} and ${column(shape, "id")} < ${cursor.id}))`
    case "after":
      return sql`${time} <= ${at}`
    case "before":
      return sql`${time} < ${at}`
  }
}

/**
 * Whether this branch can hold any row the filters ask for.
 *
 * Cheaper and clearer than a `WHERE false`: a branch asked for a branch id it
 * has no column for, or for a failure it records none of, is left out of the
 * union entirely.
 */
export function sourceCanMatch(shape: SourceShape, filters: ActivityFilters): boolean {
  if (filters.sources && !filters.sources.includes(shape.source)) return false
  // Only `system_logs` records an outcome; every row of the other two is a
  // success by construction, so a search for failures cannot be in them.
  if (filters.success === false && shape.success === null) return false
  // `group_audit_logs` has no branch column, so it can never match a branch.
  if (filters.branchId !== null && shape.branchId === null) return false
  return true
}

function branchFilters(shape: SourceShape, filters: ActivityFilters): SQL[] {
  const conditions: SQL[] = []
  const time = column(shape, shape.time)
  const upperAction = sql`upper(${column(shape, shape.action)})`

  // The tenant fence comes first and does not depend on any filter the caller
  // sent. An organization reader's rows are exactly those tagged with that
  // organization, in every source; a row tagged with none (a platform action)
  // fails the equality and is never theirs.
  if (filters.reach.kind === "organization") {
    conditions.push(sql`${column(shape, shape.organizationId)} = ${filters.reach.organizationId}`)
  }

  conditions.push(sql`${time} >= ${filters.from}`, sql`${time} <= ${filters.to}`)

  if (filters.cursor) {
    conditions.push(cursorPredicate(shape, filters.cursor))
  }

  if (filters.organizationId !== null) {
    conditions.push(sql`${column(shape, shape.organizationId)} = ${filters.organizationId}`)
  }

  if (filters.branchId !== null && shape.branchId) {
    conditions.push(sql`${column(shape, shape.branchId)} = ${filters.branchId}`)
  }

  if (filters.actorId !== null) {
    // `system_logs.user_id` is a varchar holding either a user UUID or an
    // employee principal (`emp_42`); the other two are real uuid columns. A
    // cast to text compares both shapes without a malformed-uuid error.
    conditions.push(sql`${column(shape, shape.actorId)}::text = ${filters.actorId}`)
  }

  if (filters.actorRole !== null) {
    conditions.push(actorRolePredicate(shape, filters.actorRole, filters.reach))
  }

  if (filters.success !== null && shape.success) {
    conditions.push(sql`${column(shape, shape.success)} = ${filters.success}`)
  }

  if (filters.action !== null) {
    conditions.push(sql`${upperAction} = ${filters.action.trim().toUpperCase()}`)
  }

  if (filters.operation !== null) {
    conditions.push(sql`${operationCaseSql(upperAction)} = ${filters.operation}`)
  }

  if (filters.category !== null) {
    conditions.push(sql`${categoryCaseSql(upperAction)} = ${filters.category}`)
  }

  if (filters.search !== null) {
    conditions.push(
      searchPredicate(shape, filters.search, filters.searchActorIds ?? [], filters.reach),
    )
  }

  return conditions
}

/** `select users.id::text … where <condition>`: the accounts one arm of the role filter reads. */
function accountIdsWhere(condition: SQL): SQL {
  return sql`select ${users.id}::text from ${users} left join ${roles} on ${roles.id} = ${users.roleId} where ${condition}`
}

/**
 * The actor-role filter, matching exactly the role the **Who** column shows.
 *
 * The screen shows the role the row recorded (`system_logs.user_role`,
 * `group_audit_logs.performed_by_role`), and only where there is none the
 * account's role today (`buildActor` in `lib/server/activity-log-queries.ts`).
 * `audit_logs` records no role, so for it the account is the only answer. The
 * account lookups are uncorrelated `IN` subqueries, which Postgres runs once
 * and hashes, so the per-branch time-index scan stays the shape of the plan.
 *
 * An organization reader sees people outside the tenant anonymised, their role
 * withheld unless it is Super Admin (`lib/activity-log-reach.ts`). A filter
 * that still matched such a row would say what the page hides — "someone with
 * the Warehouse role did this here" — so for that reach a tenant role matches
 * only a person `classifyActivityActor` would show: an account in the tenant
 * that is not platform staff, or, for a principal with no account at all, the
 * role the row itself recorded. An organization reader may name only a tenant
 * role (`applyActivityReach` refuses the rest); were an Apricart role to reach
 * here anyway, this arm matches nothing, since no tenant account holds one.
 */
function actorRolePredicate(shape: SourceShape, role: string, reach: ActivityReach): SQL {
  const actor = sql`${column(shape, shape.actorId)}::text`
  // `trimmed()` on the read side: a blank recorded role falls back to the account's.
  const rowRole = shape.actorRole ? sql`nullif(trim(${column(shape, shape.actorRole)}), '')` : null

  if (reach.kind === "platform") {
    const holders = sql`${actor} in (${accountIdsWhere(sql`${roles.name} = ${role}`)})`
    if (!rowRole) return holders
    return sql`(${rowRole} = ${role} or (${rowRole} is null and ${holders}))`
  }

  const platformRoles = sql.join(PLATFORM_ACTOR_ROLE_NAMES.map((name) => sql`${name}`), sql`, `)
  const tenantHolders = sql`${actor} in (${accountIdsWhere(
    sql`${roles.name} = ${role} and ${users.organizationId} = ${reach.organizationId}`,
  )})`
  if (!rowRole) return tenantHolders

  const tenantPeople = sql`${actor} in (${accountIdsWhere(
    sql`${users.organizationId} = ${reach.organizationId} and (${roles.name} is null or ${roles.name} not in (${platformRoles}))`,
  )})`
  const noAccount = sql`not exists (select 1 from ${users} where ${users.id}::text = ${actor})`
  return sql`((${rowRole} = ${role} and (${tenantPeople} or ${noAccount})) or (${rowRole} is null and ${tenantHolders}))`
}

/**
 * Free text against the columns a reader would recognise: the action, the
 * entity it names, and the actor.
 *
 * `position(... in ...)` again rather than `ILIKE`, so a term containing `%` or
 * `_` searches for those characters instead of becoming a wildcard. Bounded in
 * length by the route before it arrives here.
 */
function searchPredicate(
  shape: SourceShape,
  search: string,
  searchActorIds: readonly string[],
  reach: ActivityReach,
): SQL {
  const needle = search.trim().toUpperCase()
  const targets: SQL[] = [sql`upper(${column(shape, shape.action)})`]

  if (shape.entity) targets.push(sql`upper(coalesce(${column(shape, shape.entity)}, ''))`)
  if (shape.entityId) targets.push(sql`upper(coalesce(${column(shape, shape.entityId)}::text, ''))`)

  // The trail's own actor columns are searched for the whole-platform reader
  // only. An organization reader sees some actors anonymised, and a search
  // that still matched their email or id would answer "does the hidden
  // person's address contain this?" one guess at a time. That reader finds
  // people through `searchActorIds` alone, which `loadActivityPage` resolves
  // within their own organization.
  if (reach.kind === "platform") {
    if (shape.actorEmail) targets.push(sql`upper(coalesce(${column(shape, shape.actorEmail)}, ''))`)
    targets.push(sql`upper(coalesce(${column(shape, shape.actorId)}::text, ''))`)
  }

  const tests = targets.map((target) => sql`position(${needle} in ${target}) > 0`)

  // The accounts whose name or email matched, resolved before the union. This
  // is what lets "headoffice" find that person's category edits in `audit_logs`,
  // which records no email of its own.
  if (searchActorIds.length > 0) {
    const ids = sql.join(searchActorIds.map((id) => sql`${id}`), sql`, `)
    tests.push(sql`${column(shape, shape.actorId)}::text in (${ids})`)
  }

  return sql`(${sql.join(tests, sql` or `)})`
}

/**
 * One parenthesised, ordered, limited branch of the union.
 *
 * Every branch selects the same columns in the same order with the same types —
 * `UNION ALL` matches by position, so a typed `NULL` stands in wherever a
 * source has no such column.
 */
function branchSql(shape: SourceShape, filters: ActivityFilters, perBranchLimit: number): SQL {
  const conditions = branchFilters(shape, filters)
  const entity = shape.entity
    ? column(shape, shape.entity)
    : sql`${shape.entityLiteral}::varchar`
  const entityId = shape.entityId
    ? sql`${column(shape, shape.entityId)}::text`
    : sql`null::text`
  const actorRole = shape.actorRole ? column(shape, shape.actorRole) : sql`null::varchar`
  const actorEmail = shape.actorEmail ? column(shape, shape.actorEmail) : sql`null::varchar`
  const branchId = shape.branchId ? column(shape, shape.branchId) : sql`null::integer`
  const success = shape.success ? column(shape, shape.success) : sql`true`
  const errorMessage = shape.errorMessage ? column(shape, shape.errorMessage) : sql`null::text`
  const payload = column(shape, shape.payload)
  // `metadata->>'ip'` is how `recordAuditEvent` stores what `system_logs` has a
  // column for. `coalesce` lets one branch answer for both shapes.
  const ipAddress = shape.ipAddress
    ? sql`coalesce(${column(shape, shape.ipAddress)}, ${payload}->>'ip')`
    : sql`${payload}->>'ip'`
  const userAgent = shape.userAgent
    ? sql`coalesce(${column(shape, shape.userAgent)}, ${payload}->>'userAgent')`
    : sql`${payload}->>'userAgent'`

  return sql`(
    select
      ${shape.source}::text as source,
      ${ACTIVITY_SOURCE_RANK[shape.source]}::integer as source_rank,
      ${column(shape, "id")} as id,
      ${column(shape, shape.time)} as occurred_at,
      ${column(shape, shape.action)} as action,
      ${entity} as entity,
      ${entityId} as entity_id,
      ${column(shape, shape.actorId)}::text as actor_id,
      ${actorRole} as actor_role,
      ${actorEmail} as actor_email,
      ${column(shape, shape.organizationId)} as organization_id,
      ${branchId} as branch_id,
      ${success} as success,
      ${errorMessage} as error_message,
      ${ipAddress} as ip_address,
      ${userAgent} as user_agent,
      ${payload} as payload
    from ${sql.raw(`${shape.table} ${shape.alias}`)}
    where ${sql.join(conditions, sql` and `)}
    order by ${column(shape, shape.time)} desc, ${column(shape, "id")} desc
    limit ${perBranchLimit}
  )`
}

/**
 * The merged page.
 *
 * `limit + 1` throughout: the extra row is how the caller learns there is a
 * next page without a `COUNT(*)` over a filtered three-table union, which
 * would cost more than the page itself.
 */
export function activityPageQuery(filters: ActivityFilters): SQL {
  const perBranchLimit = filters.limit + 1
  const branches = SOURCE_SHAPES
    .filter((shape) => sourceCanMatch(shape, filters))
    .map((shape) => branchSql(shape, filters, perBranchLimit))

  if (branches.length === 0) {
    // Every source was excluded by the filters. Return the shape with no rows
    // rather than a query with an empty UNION, which is a syntax error.
    return sql`select null where false`
  }

  const union = sql.join(branches, sql` union all `)
  return sql`
    select * from (${union}) as merged
    order by merged.occurred_at desc, merged.source_rank desc, merged.id desc
    limit ${perBranchLimit}
  `
}

/** One row as Postgres returns it, before names and labels are attached. */
export type ActivityPageRow = {
  source: string
  source_rank: number
  id: number | string
  occurred_at: Date | string
  action: string | null
  entity: string | null
  entity_id: string | null
  actor_id: string | null
  actor_role: string | null
  actor_email: string | null
  organization_id: number | null
  branch_id: number | null
  success: boolean | null
  error_message: string | null
  ip_address: string | null
  user_agent: string | null
  payload: unknown
}
