import "server-only"

import { and, eq, inArray, or, sql, type SQL } from "drizzle-orm"

import { branches, organizations, roles, users } from "@/db/schema"
import {
  ACTIVITY_SEARCH_ACTOR_LIMIT,
  actionLabel,
  activityEventId,
  categoryOf,
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
  type ActivityReach,
} from "@/lib/activity-log"
import {
  classifyActivityActor,
  redactActorMetadata,
  redactedActor,
  visibleEntityId,
} from "@/lib/activity-log-reach"
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
 *
 * For an organization reach (Head Office) the SQL is already fenced to the
 * tenant; this module adds the rest of the rule in
 * `plans/OF-AUDIT-head-office-activity-log.md` — people are resolved only
 * within the tenant, and anyone outside it is anonymised before the row leaves
 * the server (`lib/activity-log-reach.ts`).
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
type ActorAccount = {
  email: string
  name: string | null
  role: string | null
  organizationId: number | null
}

type PageNames = {
  actors: Map<string, ActorAccount>
  organizations: Map<number, string>
  branches: Map<number, string>
}

async function loadNames(rows: ActivityPageRow[]): Promise<PageNames> {
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
            // Read so an organization reader can be told whether this person
            // is one of theirs — never sent to the client as such.
            organizationId: users.organizationId,
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
      actorRows.map((row) => [
        row.id,
        { email: row.email, name: row.fullName, role: row.role, organizationId: row.organizationId },
      ]),
    ),
    organizations: new Map(organizationRows.map((row) => [row.id, row.name])),
    branches: new Map(branchRows.map((row) => [row.id, row.name])),
  }
}

function buildActor(row: ActivityPageRow, account: ActorAccount | undefined): ActivityActor {
  const id = trimmed(row.actor_id)
  return {
    id,
    // The row's own copy wins: it is what was true when the action happened,
    // and it survives the account being renamed or deleted.
    email: trimmed(row.actor_email) ?? account?.email ?? null,
    name: account?.name ?? null,
    role: trimmed(row.actor_role) ?? account?.role ?? null,
    redacted: false,
  }
}

function toEvent(row: ActivityPageRow, names: PageNames, reach: ActivityReach): ActivityEvent | null {
  if (!isActivitySource(row.source)) return null
  const id = toId(row.id)
  if (!Number.isFinite(id)) return null

  const actorId = trimmed(row.actor_id)
  const account = actorId ? names.actors.get(actorId) : undefined
  const actor = buildActor(row, account)
  const standing = classifyActivityActor(
    {
      actorId,
      actorEmail: trimmed(row.actor_email),
      rowRole: trimmed(row.actor_role),
      account: account ? { organizationId: account.organizationId, role: account.role } : null,
    },
    reach,
  )
  // Address and device are shown only beside a person the reader may
  // identify; for anyone else, or for no one, they are the platform's.
  const showOrigin = standing === "visible"
  // Masked on the way out as well as on the way in: rows written before the
  // centralized writer existed were never filtered, and this screen must not
  // be the place a stored secret finally gets displayed.
  const masked = maskAuditMetadata(row.payload)

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
    entityId: visibleEntityId(entity, trimmed(row.entity_id), standing),
    actor: standing === "outside" ? redactedActor(actor) : actor,
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
    ipAddress: showOrigin ? trimmed(row.ip_address) : null,
    userAgent: showOrigin ? trimmed(row.user_agent) : null,
    metadata: standing === "visible" ? masked : redactActorMetadata(masked),
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
async function resolveSearchActors(search: string, reach: ActivityReach): Promise<string[]> {
  const needle = search.trim().toUpperCase()
  if (needle.length === 0) return []

  const matches: SQL | undefined = or(
    sql`position(${needle} in upper(${users.email})) > 0`,
    sql`position(${needle} in upper(coalesce(${users.fullName}, ''))) > 0`,
    sql`position(${needle} in upper(coalesce(${users.username}, ''))) > 0`,
  )

  // An organization reader finds only their own organization's people. Without
  // this the lookup would range over every tenant's accounts and Apricart's —
  // K-Electric and K-E-Demo share email addresses, so "the same person" is not
  // even a safe assumption across tenants.
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(
      reach.kind === "organization"
        ? and(matches, eq(users.organizationId, reach.organizationId))
        : matches,
    )
    .limit(ACTIVITY_SEARCH_ACTOR_LIMIT)

  return rows.map((row) => row.id)
}

/**
 * Whether an `actorId` filter names someone the reader may ask about.
 *
 * The fence already keeps every row inside the tenant, but a filter on an
 * outside actor's id would still answer "did this person act here?" about
 * someone the page then anonymises. So an organization reader may filter only
 * by an account of their own organization that is not platform staff — or by a
 * non-uuid principal (an employee login), which has no account to be outside
 * of and is confined to the tenant's rows by the fence.
 */
async function actorFilterIsWithinReach(actorId: string | null, reach: ActivityReach): Promise<boolean> {
  if (actorId === null || reach.kind === "platform") return true
  if (!UUID_PATTERN.test(actorId)) return true

  const [account] = await db
    .select({ organizationId: users.organizationId, role: roles.name })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.roleId))
    .where(eq(users.id, actorId))
    .limit(1)

  if (!account) return false
  return (
    classifyActivityActor({ actorId, actorEmail: null, rowRole: null, account }, reach) === "visible"
  )
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
  const window = { from: filters.from.toISOString(), to: filters.to.toISOString() }

  if (!(await actorFilterIsWithinReach(filters.actorId, filters.reach))) {
    return { items: [], nextCursor: null, hasMore: false, window }
  }

  const resolved: ActivityFilters = filters.search
    ? { ...filters, searchActorIds: await resolveSearchActors(filters.search, filters.reach) }
    : filters

  const result = await executor.execute(activityPageQuery(resolved))
  const rows = (Array.isArray(result) ? result : result.rows) as ActivityPageRow[]

  const hasMore = rows.length > filters.limit
  const pageRows = hasMore ? rows.slice(0, filters.limit) : rows

  const names = await loadNames(pageRows)
  const items = pageRows
    .map((row) => toEvent(row, names, filters.reach))
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
    window,
  }
}

export { decodeActivityCursor } from "@/lib/activity-log"
