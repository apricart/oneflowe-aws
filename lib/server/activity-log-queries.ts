import "server-only"

import { eq, inArray, or, sql } from "drizzle-orm"

import { branches, organizations, roles, users } from "@/db/schema"
import {
  ACTIVITY_SEARCH_ACTOR_LIMIT,
  actionLabel,
  activityEventId,
  categoryOf,
  decodeActivityCursor,
  encodeActivityCursor,
  entityLabel,
  isActivitySource,
  maskAuditMetadata,
  operationOf,
  severityOf,
  type ActivityActor,
  type ActivityEvent,
  type ActivityFilters,
  type ActivityLogPage,
} from "@/lib/activity-log"
import { db } from "@/lib/db"
import { activityPageQuery, type ActivityPageRow } from "@/lib/server/activity-log-sql"

/**
 * Reading the activity log: run the merged page query, then attach the names a
 * reader needs.
 *
 * The union deliberately returns *ids* only. Joining `users`, `organizations`
 * and `branches` inside all three branches would multiply the work of the part
 * that has to stay cheap; instead the page — at most `ACTIVITY_PAGE_SIZE_MAX`
 * rows — is enriched afterwards with three bounded `IN` lookups on primary
 * keys. Cost is flat in the page size, not in the size of the tables.
 */

type Executor = Pick<typeof db, "execute">

/** A uuid, so `emp_42` and other non-uuid principals never reach a uuid column. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value)
}

function toId(value: number | string): number {
  return typeof value === "number" ? value : Number.parseInt(value, 10)
}

function trimmed(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null
  const out = value.trim()
  return out.length > 0 ? out : null
}

/**
 * Names for the ids on this page.
 *
 * `system_logs` already denormalizes the actor's email and role, which is what
 * lets an authentication event keep an identity even after the account is hard
 * deleted — one of the forensic gaps the audit review flagged. Where a row
 * carries only an id, this fills in what the account still says; where the
 * account is gone, the id remains and stands on its own.
 */
async function loadNames(rows: ActivityPageRow[]): Promise<{
  actors: Map<string, { email: string; name: string | null; role: string | null }>
  organizations: Map<number, string>
  branches: Map<number, string>
}> {
  const actorIds = new Set<string>()
  const organizationIds = new Set<number>()
  const branchIds = new Set<number>()

  for (const row of rows) {
    const actorId = trimmed(row.actor_id)
    if (actorId && UUID_PATTERN.test(actorId)) actorIds.add(actorId)
    if (typeof row.organization_id === "number") organizationIds.add(row.organization_id)
    if (typeof row.branch_id === "number") branchIds.add(row.branch_id)
  }

  const [actorRows, organizationRows, branchRows] = await Promise.all([
    actorIds.size > 0
      ? db
          .select({
            id: users.id,
            email: users.email,
            fullName: users.fullName,
            role: roles.name,
          })
          .from(users)
          .leftJoin(roles, eq(roles.id, users.roleId))
          .where(inArray(users.id, [...actorIds]))
      : Promise.resolve([]),
    organizationIds.size > 0
      ? db
          .select({ id: organizations.id, name: organizations.name })
          .from(organizations)
          .where(inArray(organizations.id, [...organizationIds]))
      : Promise.resolve([]),
    branchIds.size > 0
      ? db
          .select({ id: branches.id, name: branches.name })
          .from(branches)
          .where(inArray(branches.id, [...branchIds]))
      : Promise.resolve([]),
  ])

  return {
    actors: new Map(
      actorRows.map((row) => [row.id, { email: row.email, name: row.fullName, role: row.role }]),
    ),
    organizations: new Map(organizationRows.map((row) => [row.id, row.name])),
    branches: new Map(branchRows.map((row) => [row.id, row.name])),
  }
}

function buildActor(
  row: ActivityPageRow,
  actors: Map<string, { email: string; name: string | null; role: string | null }>,
): ActivityActor {
  const id = trimmed(row.actor_id)
  const account = id ? actors.get(id) : undefined
  return {
    id,
    // The row's own copy wins: it is what was true when the action happened,
    // and it survives the account being renamed or deleted.
    email: trimmed(row.actor_email) ?? account?.email ?? null,
    name: account?.name ?? null,
    role: trimmed(row.actor_role) ?? account?.role ?? null,
  }
}

function toEvent(
  row: ActivityPageRow,
  names: Awaited<ReturnType<typeof loadNames>>,
): ActivityEvent | null {
  if (!isActivitySource(row.source)) return null
  const id = toId(row.id)
  if (!Number.isFinite(id)) return null

  const action = trimmed(row.action) ?? "UNKNOWN"
  const success = row.success !== false
  const entity = trimmed(row.entity)

  return {
    id: activityEventId(row.source, id),
    source: row.source,
    occurredAt: toDate(row.occurred_at).toISOString(),
    action,
    actionLabel: actionLabel(action),
    operation: operationOf(action),
    category: categoryOf(action),
    severity: severityOf(action, success),
    entity,
    entityLabel: entityLabel(entity),
    entityId: trimmed(row.entity_id),
    actor: buildActor(row, names.actors),
    organizationId: row.organization_id ?? null,
    organizationName:
      typeof row.organization_id === "number"
        ? names.organizations.get(row.organization_id) ?? null
        : null,
    branchId: row.branch_id ?? null,
    branchName:
      typeof row.branch_id === "number" ? names.branches.get(row.branch_id) ?? null : null,
    success,
    errorMessage: trimmed(row.error_message),
    ipAddress: trimmed(row.ip_address),
    userAgent: trimmed(row.user_agent),
    // Masked on the way out as well as on the way in: rows written before the
    // centralized writer existed were never filtered, and this screen must not
    // be the place a stored secret finally gets displayed.
    metadata: maskAuditMetadata(row.payload),
  }
}

/**
 * The accounts a free-text term names, so a search for a person reaches the two
 * tables that record only their id.
 *
 * One bounded lookup before the union, rather than a join inside all three
 * branches of it. `position(... in upper(...))` rather than `ILIKE` so a term
 * containing `%` or `_` searches for those characters instead of becoming a
 * wildcard, matching how the union itself searches.
 */
async function resolveSearchActors(search: string): Promise<string[]> {
  const needle = search.trim().toUpperCase()
  if (needle.length === 0) return []

  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      or(
        sql`position(${needle} in upper(${users.email})) > 0`,
        sql`position(${needle} in upper(coalesce(${users.fullName}, ''))) > 0`,
        sql`position(${needle} in upper(coalesce(${users.username}, ''))) > 0`,
      ),
    )
    .limit(ACTIVITY_SEARCH_ACTOR_LIMIT)

  return rows.map((row) => row.id)
}

/**
 * One page, newest first.
 *
 * The query asks for `limit + 1` rows; the extra one is how `hasMore` is
 * answered without a `COUNT(*)` over a filtered three-table union.
 */
export async function loadActivityPage(
  filters: ActivityFilters,
  executor: Executor = db,
): Promise<ActivityLogPage> {
  const resolved: ActivityFilters = filters.search
    ? { ...filters, searchActorIds: await resolveSearchActors(filters.search) }
    : filters

  const result = await executor.execute(activityPageQuery(resolved))
  const rows = (Array.isArray(result) ? result : result.rows) as ActivityPageRow[]

  const hasMore = rows.length > filters.limit
  const pageRows = hasMore ? rows.slice(0, filters.limit) : rows

  const names = await loadNames(pageRows)
  const items = pageRows
    .map((row) => toEvent(row, names))
    .filter((event): event is ActivityEvent => event !== null)

  const last = pageRows.at(-1)
  const nextCursor =
    hasMore && last && isActivitySource(last.source)
      ? encodeActivityCursor({
          occurredAtMs: toDate(last.occurred_at).getTime(),
          source: last.source,
          id: toId(last.id),
        })
      : null

  return {
    items,
    nextCursor,
    hasMore: nextCursor !== null,
    window: { from: filters.from.toISOString(), to: filters.to.toISOString() },
  }
}

export { decodeActivityCursor }
