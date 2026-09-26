import "server-only"

import { headers } from "next/headers"

import { auditLogs } from "@/db/schema"
import { maskAuditMetadata } from "@/lib/activity-log"
import { db } from "@/lib/db"
import { resolveRequestClientIp } from "@/lib/server/request-ip"

/**
 * One way to record a business mutation.
 *
 * An audit review found the trail scattered across three tables and absent
 * from 94 of 135 route files, with the writes that did exist spelling the same
 * event several ways — `CREATE`, `create`, `CREATE_BRANCH`, `import_products` —
 * and several of them "best effort", so the business change could succeed while
 * its own record silently failed.
 *
 * This module is the answer to all three:
 *
 *  * **One table.** Business mutations go to `audit_logs`. Authentication stays
 *    in `system_logs` (`lib/server/auth-audit.ts`) because an authentication
 *    event frequently has no verified tenant and no known account, which that
 *    table's looser columns are built for. Group operations keep
 *    `group_audit_logs`. `GET /api/v1/activity-logs` merges all three, so the
 *    split is an implementation detail rather than something a reader must know.
 *
 *  * **One spelling.** `action` is normalized, so rows stay aggregatable.
 *
 *  * **Not best effort.** `executor` takes the caller's transaction, so the
 *    record commits with the change or neither does. That is a deliberate
 *    trade: a mutation whose audit write fails now fails, where before it
 *    succeeded unrecorded. A silent gap in the trail is the thing being fixed.
 *
 * See `plans/OF-AUDIT-admin-activity-log.md`.
 */

/**
 * Anything with an `insert` — `db`, or a transaction handle from
 * `db.transaction()`. Typed off the real client so a signature change is caught
 * at the call site rather than here.
 */
export type AuditExecutor = Pick<typeof db, "insert">

export type AuditActor = {
  /** The signed-in user's id. Null only for a system-initiated write. */
  id: string | null
  role?: string | null
  email?: string | null
}

export type AuditEvent = {
  /** Normalized before it is stored. `UPDATE_CATEGORY`, `DELETE_SUPPLIER`. */
  action: string
  /** What kind of row this is about. `category`, `supplier`, `branch`. */
  entity: string
  /**
   * The id of **one** row. A bulk write names the rows it reached in
   * `metadata`, never here: `entity_id` is `varchar(128)`, and a comma-joined
   * list overflowed it — and threw, after the business rows were already
   * written — as soon as the list passed about twenty-five ids.
   * `lib/audit-entity-id.test.ts` is the standing control on that.
   */
  entityId: string | number | null
  actor: AuditActor
  organizationId?: number | null
  branchId?: number | null
  /** State before the change. Recorded for an update or a delete. */
  before?: unknown
  /** State after the change. Recorded for a create or an update. */
  after?: unknown
  /** Anything else worth keeping: counts, reasons, the ids a bulk write reached. */
  context?: Record<string, unknown>
}

export const MAX_AUDIT_ACTION_LENGTH = 128
export const MAX_AUDIT_ENTITY_LENGTH = 128
export const MAX_AUDIT_ENTITY_ID_LENGTH = 128
const MAX_USER_AGENT_LENGTH = 512

/**
 * `update category` / `update-Category` / `UPDATE_CATEGORY` all become
 * `UPDATE_CATEGORY`, so one event is one action string however the caller wrote
 * it, and the activity screen's action filter and its counts mean something.
 */
export function normalizeAuditAction(action: string): string {
  const collapsed = action
    .trim()
    .replace(/[\s\-.]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toUpperCase()
  return collapsed.slice(0, MAX_AUDIT_ACTION_LENGTH)
}

/**
 * One id, as text. An array or an object here is a caller trying to name
 * several rows in a column that holds one, so it is refused rather than
 * silently truncated at the column width.
 */
export function normalizeAuditEntityId(entityId: string | number | null | undefined): string | null {
  if (entityId === null || entityId === undefined) return null
  if (typeof entityId === "number") {
    return Number.isFinite(entityId) ? String(entityId) : null
  }
  if (typeof entityId !== "string") {
    throw new TypeError("audit entityId must name a single row; put a list in metadata")
  }
  const trimmed = entityId.trim()
  if (trimmed.length === 0) return null
  if (trimmed.length > MAX_AUDIT_ENTITY_ID_LENGTH) {
    throw new RangeError(
      `audit entityId exceeds ${MAX_AUDIT_ENTITY_ID_LENGTH} characters; put a list of ids in metadata`,
    )
  }
  return trimmed
}

/** Positive integers only: `audit_logs` carries foreign keys on both scope columns. */
function scopeId(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null
  return value
}

/**
 * Where the request came from.
 *
 * `audit_logs` has no column for either, so both go in `metadata` and
 * `lib/server/activity-log-sql.ts` coalesces them with `system_logs`' real
 * columns when it reads. Outside a request scope — a script, a cron sweep —
 * there is nothing to resolve and both stay absent; that must never fail the
 * write.
 */
async function resolveRequestOrigin(): Promise<{ ip?: string; userAgent?: string }> {
  const origin: { ip?: string; userAgent?: string } = {}
  try {
    const ip = await resolveRequestClientIp()
    if (ip) origin.ip = ip.slice(0, 64)
  } catch {
    // No request scope, or an unparseable forwarding header.
  }
  try {
    const headerList = await headers()
    const userAgent = headerList.get("user-agent")?.trim()
    if (userAgent) origin.userAgent = userAgent.slice(0, MAX_USER_AGENT_LENGTH)
  } catch {
    // No request scope.
  }
  return origin
}

/** The row, separated from the insert so it can be unit-tested without a database. */
export async function buildAuditRow(event: AuditEvent): Promise<{
  userId: string | null
  organizationId: number | null
  branchId: number | null
  action: string
  entity: string
  entityId: string | null
  metadata: Record<string, unknown>
}> {
  const origin = await resolveRequestOrigin()

  const metadata: Record<string, unknown> = { ...origin }
  if (event.actor.role) metadata.actorRole = event.actor.role
  if (event.actor.email) metadata.actorEmail = event.actor.email
  if (event.before !== undefined) metadata.before = event.before
  if (event.after !== undefined) metadata.after = event.after
  if (event.context) Object.assign(metadata, event.context)

  return {
    userId: event.actor.id ?? null,
    organizationId: scopeId(event.organizationId),
    branchId: scopeId(event.branchId),
    action: normalizeAuditAction(event.action),
    entity: event.entity.trim().slice(0, MAX_AUDIT_ENTITY_LENGTH),
    entityId: normalizeAuditEntityId(event.entityId),
    // Masked here, on the way in, so no password, token or OTP a caller happens
    // to have in scope can reach a table that is append-only by policy.
    metadata: maskAuditMetadata(metadata) as Record<string, unknown>,
  }
}

/**
 * Record one mutation.
 *
 * Pass the transaction that performs the change:
 *
 * ```ts
 * await db.transaction(async (tx) => {
 *   const [saved] = await tx.insert(categories).values(...).returning()
 *   await recordAuditEvent(tx, { action: "CREATE_CATEGORY", entity: "category",
 *     entityId: saved.id, actor, after: saved })
 * })
 * ```
 *
 * Errors propagate. A caller that genuinely must not fail on an audit write —
 * a background sweep, say — has to say so at its own call site rather than
 * having that decided for every caller here.
 */
export async function recordAuditEvent(executor: AuditExecutor, event: AuditEvent): Promise<void> {
  const row = await buildAuditRow(event)
  await executor.insert(auditLogs).values(row)
}

/**
 * The actor from a NextAuth session.
 *
 * Only ever the session — never a user id, role or email from a request body,
 * which would let a caller sign someone else's name to their own change.
 *
 * `session.user` is typed loosely across this codebase (NextAuth's own type is
 * widened by the callbacks), so this is the one narrow place that reads it and
 * the retrofitted routes do not each repeat the cast.
 */
export function auditActorFromSession(session: unknown): AuditActor {
  const user = (session as { user?: Record<string, unknown> } | null)?.user
  const id = typeof user?.id === "string" && user.id.length > 0 ? user.id : null
  return {
    id,
    role: typeof user?.role === "string" ? user.role : null,
    email: typeof user?.email === "string" ? user.email : null,
  }
}
