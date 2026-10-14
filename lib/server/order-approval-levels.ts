import "server-only"

import { asc, eq } from "drizzle-orm"

import { organizationApprovalLevels, organizations } from "@/db/schema"
import { db } from "@/lib/db"
import {
  ORDER_APPROVAL_LEVELS_AUDIT_ACTION,
  approvalLevelsChanged,
  toApprovalLevels,
  type ApprovalLevel,
  type ApprovalLevelsState,
} from "@/lib/order-approval-levels"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"

/**
 * The only writer of an organization's order approval levels and of
 * `organizations.order_approval_levels_enabled` after creation
 * (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md).
 *
 * Validation happens before anything reaches here — `orderApprovalLevelsSchema`
 * runs `approvalLevelsError` on every request — so these functions take amounts
 * that are already known to be well formed and strictly increasing.
 */

type Executor = Pick<typeof db, "select">
type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

/** The stored levels, Level 1 first. */
export async function loadOrganizationApprovalLevels(
  executor: Executor,
  organizationId: number,
): Promise<ApprovalLevel[]> {
  return executor
    .select({
      level: organizationApprovalLevels.level,
      maxAmountCents: organizationApprovalLevels.maxAmountCents,
    })
    .from(organizationApprovalLevels)
    .where(eq(organizationApprovalLevels.organizationId, organizationId))
    .orderBy(asc(organizationApprovalLevels.level))
}

/** The switch and the levels together, or null for an unknown organization. */
export async function readOrganizationApprovalLevels(
  organizationId: number,
): Promise<ApprovalLevelsState | null> {
  const [organization] = await db
    .select({ enabled: organizations.orderApprovalLevelsEnabled })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  if (!organization) return null

  return {
    enabled: organization.enabled,
    levels: await loadOrganizationApprovalLevels(db, organizationId),
  }
}

/**
 * Replace the whole set. Levels are positional, so a partial update could
 * only ever leave a gap or a duplicate; delete-then-insert inside the caller's
 * transaction cannot.
 */
export async function replaceOrganizationApprovalLevels(
  tx: TransactionExecutor,
  params: { organizationId: number; amountsCents: readonly number[]; actorUserId: string | null },
): Promise<void> {
  await tx
    .delete(organizationApprovalLevels)
    .where(eq(organizationApprovalLevels.organizationId, params.organizationId))

  if (params.amountsCents.length === 0) return

  await tx.insert(organizationApprovalLevels).values(
    toApprovalLevels(params.amountsCents).map((level) => ({
      organizationId: params.organizationId,
      level: level.level,
      maxAmountCents: level.maxAmountCents,
      createdBy: params.actorUserId,
    })),
  )
}

export type SaveApprovalLevelsOutcome =
  | { kind: "not-found" }
  | { kind: "saved"; changed: boolean; state: ApprovalLevelsState }

/**
 * Super Admin saving an organization's levels from Edit Organization.
 *
 * One transaction, with the organization row locked `FOR UPDATE` before the
 * current state is read, so two saves cannot interleave and the audit's
 * "before" is exactly what was replaced. A save that changes nothing writes no
 * rows and no audit entry — the Edit dialog saves this section every time.
 *
 * `amountsCents` undefined leaves the stored levels alone; the switch is still
 * written. That is how switching off keeps the levels for later.
 */
export async function saveOrganizationApprovalLevels(input: {
  organizationId: number
  enabled: boolean
  amountsCents?: readonly number[]
  actor: AuditActor
}): Promise<SaveApprovalLevelsOutcome> {
  return db.transaction(async (tx) => {
    const [organization] = await tx
      .select({ enabled: organizations.orderApprovalLevelsEnabled })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for("update")
      .limit(1)
    if (!organization) return { kind: "not-found" as const }

    const before: ApprovalLevelsState = {
      enabled: organization.enabled,
      levels: await loadOrganizationApprovalLevels(tx, input.organizationId),
    }
    const after: ApprovalLevelsState = {
      enabled: input.enabled,
      levels: input.amountsCents === undefined ? before.levels : toApprovalLevels(input.amountsCents),
    }

    if (!approvalLevelsChanged(before, { enabled: input.enabled, amountsCents: input.amountsCents })) {
      return { kind: "saved" as const, changed: false, state: before }
    }

    if (before.enabled !== after.enabled) {
      await tx
        .update(organizations)
        .set({ orderApprovalLevelsEnabled: after.enabled, updatedAt: new Date() })
        .where(eq(organizations.id, input.organizationId))
    }

    if (input.amountsCents !== undefined) {
      await replaceOrganizationApprovalLevels(tx, {
        organizationId: input.organizationId,
        amountsCents: input.amountsCents,
        actorUserId: input.actor.id,
      })
    }

    await recordAuditEvent(tx, {
      action: ORDER_APPROVAL_LEVELS_AUDIT_ACTION,
      entity: "organization",
      entityId: input.organizationId,
      actor: input.actor,
      organizationId: input.organizationId,
      before,
      after,
    })

    return { kind: "saved" as const, changed: true, state: after }
  })
}
