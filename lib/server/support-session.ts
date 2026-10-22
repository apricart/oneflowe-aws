import { viewerReadRole } from "@/lib/viewer-access"
import "server-only"

import { eq } from "drizzle-orm"

import { users } from "@/db/schema"
import { getRequestScope } from "@/lib/auth"
import { db } from "@/lib/db"
import type { SupportViewer } from "@/lib/support-access"
import { isSupportApricartRole } from "@/lib/support-thread"
import type { SupportAuthor } from "@/lib/server/support-threads"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"
import { isWarehouseRole } from "@/lib/warehouse-access"

/**
 * Turning a session into the facts the support rules need.
 *
 * Scope comes from `getRequestScope()`, which reads the organization and branch
 * from the database rather than from the token, so a person moved to another
 * branch is scoped to the new one on their next request instead of on their
 * next sign-in. Nothing here reads the request.
 */

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/**
 * The viewer, for reads.
 *
 * Takes the session it was handed rather than fetching one, so a handler that
 * has already loaded a session does not load a second. The scope still comes
 * from the token claims here; every write path goes through
 * `resolveSupportAuthor`, which re-reads it from the database.
 */
export function supportViewerFromSession(session: unknown): SupportViewer | null {
  const user = (session as { user?: Record<string, unknown> } | null)?.user
  if (!user) return null

  const userId = typeof user.id === "string" ? user.id : ""
  if (!UUID_PATTERN.test(userId)) return null

  return {
    userId,
    role: typeof user.role === "string" ? user.role : null,
    organizationId: scopeId(user.organizationId),
    branchId: scopeId(user.branchId),
  }
}

/**
 * The caller as a support *reader*, for GET handlers only: an
 * organization-wide Viewer reads its tenant's threads as Head Office does, a
 * branch-pinned one reads none (`null`), and every other caller is exactly
 * `supportViewerFromSession`. Never use it on a write path — the Viewer raises,
 * answers and closes nothing.
 */
export function supportReaderFromSession(session: unknown): SupportViewer | null {
  const viewer = supportViewerFromSession(session)
  if (!viewer) return null
  const role = viewerReadRole(viewer)
  if (role === null) return null
  return { ...viewer, role }
}

/**
 * The viewer with the reach its role's queue is fenced to, read from the
 * database on this request.
 *
 * A warehouse reads the threads of the branches it serves
 * (plans/OF-WAREHOUSE-support-queue.md), so its branches are loaded here —
 * assigned one by one or by city, through the same `loadWarehouseReach` every
 * warehouse endpoint uses, which also re-reads the account and returns nothing
 * for one deactivated or moved out of the role. Every other viewer is returned
 * unchanged. Every support handler calls this; a warehouse viewer that skipped
 * it would carry no reach and read nothing (`supportThreadVisibilityScope`).
 */
export async function withSupportReach(viewer: SupportViewer | null): Promise<SupportViewer | null> {
  if (!viewer || !isWarehouseRole(viewer.role)) return viewer
  return { ...viewer, reachBranchIds: await loadWarehouseReach(db, viewer.userId) }
}

/**
 * The author, for writes.
 *
 * A write needs a tenant that is certainly current and a display name for the
 * audit trail and the notification, so this reads both from the database. A
 * caller with no organization cannot raise a thread — there would be no tenant
 * for the conversation to belong to — which rules out an Apricart administrator
 * *opening* one; they answer threads, they do not raise them against
 * themselves.
 */
export async function resolveSupportAuthor(): Promise<SupportAuthor | null> {
  const scope = await getRequestScope()
  if (!scope?.userId || !scope.role) return null

  const [row] = await db
    .select({
      fullName: users.fullName,
      organizationId: users.organizationId,
      branchId: users.branchId,
    })
    .from(users)
    .where(eq(users.id, scope.userId))
    .limit(1)

  if (!row) return null

  const organizationId = scopeId(row.organizationId)
  if (organizationId === null) return null

  return {
    userId: scope.userId,
    role: scope.role,
    fullName: row.fullName?.trim() || "A colleague",
    organizationId,
    branchId: scopeId(row.branchId),
  }
}

/**
 * The author of a *reply*, which unlike a new thread may come from Apricart.
 *
 * Apricart administrators have no organization of their own, so the thread's
 * organization is used for anything that needs one.
 */
export async function resolveSupportResponder(
  threadOrganizationId: number,
): Promise<SupportAuthor | null> {
  const scope = await getRequestScope()
  if (!scope?.userId || !scope.role) return null

  const [row] = await db
    .select({
      fullName: users.fullName,
      organizationId: users.organizationId,
      branchId: users.branchId,
    })
    .from(users)
    .where(eq(users.id, scope.userId))
    .limit(1)

  if (!row) return null

  return {
    userId: scope.userId,
    role: scope.role,
    fullName: row.fullName?.trim() || (isSupportApricartRole(scope.role) ? "The Apricart team" : "A colleague"),
    organizationId: scopeId(row.organizationId) ?? threadOrganizationId,
    branchId: scopeId(row.branchId),
  }
}

function scopeId(value: unknown): number | null {
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null
}
