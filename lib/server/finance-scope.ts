import "server-only"

import { and, asc, eq, inArray, isNull } from "drizzle-orm"

import { financeOrganizationAssignments, organizations, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  FINANCE_ORGANIZATION_AUDIT_ACTION,
  FINANCE_ROLE,
  fenceFinanceOrganizationIds,
  isFinanceRole,
  resolveFinanceReach,
  type FinanceOrganizationFence,
} from "@/lib/finance-access"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"

/**
 * The rows the Finance reach rule (`resolveFinanceReach`) judges, read from the
 * database every time — never from the session. The account row is re-read
 * too, so a Finance account that was deactivated, deleted or moved to another
 * role reaches nothing while an old token is still in flight.
 * See plans/OF-FINANCE-finance-role.md.
 */

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

type LoadOptions = {
  /**
   * Take a FOR SHARE lock on the assignment rows. Used inside a writing
   * transaction so a Super Admin withdrawing the organization waits for the
   * write in flight instead of racing past it.
   */
  lock?: boolean
}

/** The organizations this Finance account reads. Empty means none. */
export async function loadFinanceOrganizationIds(
  client: DbClient,
  userId: string,
  options: LoadOptions = {},
): Promise<number[]> {
  const [account] = await client
    .select({ role: roles.name, isActive: users.isActive, deletedAt: users.deletedAt })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .limit(1)
  if (!account || account.role !== FINANCE_ROLE) return []

  const assignmentQuery = client
    .select({ organizationId: financeOrganizationAssignments.organizationId })
    .from(financeOrganizationAssignments)
    .where(eq(financeOrganizationAssignments.userId, userId))
  const assignments = options.lock ? await assignmentQuery.for("share") : await assignmentQuery

  return resolveFinanceReach({
    account: { role: account.role, isActive: account.isActive, deleted: account.deletedAt !== null },
    assignedOrganizationIds: assignments.map((row) => row.organizationId),
  })
}

/**
 * How a read handler scopes this caller.
 *
 *   * `null` — the caller is not Finance; the handler carries on unchanged.
 *   * `{ ok: true, organizationIds }` — Finance, fenced. The handler continues
 *     as Super Admin with exactly these organizations as its filter; the list
 *     is never empty.
 *   * `{ ok: false, ... }` — Finance with no reach, or asking outside it:
 *     answer with that status.
 */
export async function resolveFinanceReadScope(input: {
  role: unknown
  userId: unknown
  requestedOrganizationIds?: readonly unknown[]
}): Promise<FinanceOrganizationFence | null> {
  if (!isFinanceRole(input.role)) return null
  if (typeof input.userId !== "string" || input.userId.length === 0) {
    return fenceFinanceOrganizationIds([])
  }
  const assigned = await loadFinanceOrganizationIds(db, input.userId)
  return fenceFinanceOrganizationIds(assigned, input.requestedOrganizationIds ?? [])
}

/**
 * Whether a Finance caller reaches one organization — for the handlers that
 * read or change one order. Always false for anyone else; those handlers keep
 * their own rule for every other role.
 */
export async function financeReachesOrganization(
  client: DbClient,
  userId: unknown,
  organizationId: unknown,
  options: LoadOptions = {},
): Promise<boolean> {
  if (typeof userId !== "string" || userId.length === 0) return false
  const target = Number(organizationId)
  if (!Number.isSafeInteger(target) || target <= 0) return false
  const assigned = await loadFinanceOrganizationIds(client, userId, options)
  return assigned.includes(target)
}

/** Each Finance account's organizations, for the Users directory. */
export async function loadFinanceOrganizationsForUsers(userIds: readonly string[]): Promise<Map<string, number[]>> {
  const result = new Map<string, number[]>()
  if (userIds.length === 0) return result
  const rows = await db
    .select({ userId: financeOrganizationAssignments.userId, organizationId: financeOrganizationAssignments.organizationId })
    .from(financeOrganizationAssignments)
    .where(inArray(financeOrganizationAssignments.userId, [...userIds]))
    .orderBy(asc(financeOrganizationAssignments.organizationId))
  for (const row of rows) {
    result.set(row.userId, [...(result.get(row.userId) ?? []), row.organizationId])
  }
  return result
}

/** Thrown inside a transaction when a requested organization does not exist. */
export class FinanceOrganizationsInvalidError extends Error {}

/**
 * Write one Finance account's organizations inside the caller's transaction,
 * replacing whatever it had, and audit the before and after with it. Every
 * organization must exist; the caller has already locked the user row.
 */
export async function writeFinanceOrganizationsInTx(
  tx: DbClient,
  input: { userId: string; organizationIds: readonly number[]; actor: AuditActor & { id: string } },
): Promise<number[]> {
  const organizationIds = [...new Set(input.organizationIds)].sort((a, b) => a - b)
  if (organizationIds.length > 0) {
    const existing = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(inArray(organizations.id, organizationIds))
    if (existing.length !== organizationIds.length) {
      throw new FinanceOrganizationsInvalidError("One or more organizations do not exist")
    }
  }

  const before = await tx
    .select({ organizationId: financeOrganizationAssignments.organizationId })
    .from(financeOrganizationAssignments)
    .where(eq(financeOrganizationAssignments.userId, input.userId))

  await tx.delete(financeOrganizationAssignments).where(eq(financeOrganizationAssignments.userId, input.userId))
  if (organizationIds.length > 0) {
    await tx.insert(financeOrganizationAssignments).values(organizationIds.map((organizationId) => ({
      userId: input.userId,
      organizationId,
      createdByUserId: input.actor.id,
    })))
  }

  await recordAuditEvent(tx, {
    action: FINANCE_ORGANIZATION_AUDIT_ACTION,
    entity: "user",
    entityId: input.userId,
    actor: input.actor,
    before: { organizationIds: before.map((row) => row.organizationId).sort((a, b) => a - b) },
    after: { organizationIds },
  })

  return organizationIds
}

export type FinanceOrganizationsOutcome =
  | { kind: "updated"; organizationIds: number[] }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }

/**
 * Replace the organizations one Finance account reads, in one transaction.
 * The target must be an undeleted Finance account (otherwise "not found", so
 * this cannot probe other accounts).
 */
export async function replaceFinanceOrganizations(input: {
  userId: string
  organizationIds: readonly number[]
  actor: AuditActor & { id: string }
}): Promise<FinanceOrganizationsOutcome> {
  try {
    return await db.transaction(async (tx) => {
      // Serializes two concurrent replacements for the same person.
      const [target] = await tx
        .select({ id: users.id, role: roles.name })
        .from(users)
        .innerJoin(roles, eq(users.roleId, roles.id))
        .where(and(eq(users.id, input.userId), isNull(users.deletedAt)))
        .for("update", { of: users })
        .limit(1)
      if (!target || !isFinanceRole(target.role)) return { kind: "not-found" } as const

      const organizationIds = await writeFinanceOrganizationsInTx(tx, input)
      return { kind: "updated", organizationIds } as const
    })
  } catch (caught) {
    if (caught instanceof FinanceOrganizationsInvalidError) return { kind: "invalid", message: caught.message }
    throw caught
  }
}
