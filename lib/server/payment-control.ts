import "server-only"

import { and, desc, eq, gt, isNull, lte } from "drizzle-orm"

import { auditLogs, branches, paymentControlExceptions, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  PaymentControlBlockedError,
  exceptionWindowFrom,
  resolvePaymentControl,
  type PaymentControlException,
  type PaymentControlStatus,
} from "@/lib/payment-control-policy"

import { overduePaymentSource } from "./overdue-payment-source"

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0]

export const PAYMENT_CONTROL_EXCEPTION_GRANTED_AUDIT_ACTION = "GRANT_PAYMENT_CONTROL_EXCEPTION"
export const PAYMENT_CONTROL_EXCEPTION_REVOKED_AUDIT_ACTION = "REVOKE_PAYMENT_CONTROL_EXCEPTION"

export type PaymentControlScope = { organizationId: number; branchId: number }

export type PaymentControlExceptionRecord = PaymentControlException & {
  organizationId: number
  branchId: number
  grantedByName: string | null
  revokedByUserId: string | null
  revokeReason: string | null
}

export type BranchPaymentControl = Omit<PaymentControlStatus, "exception"> & {
  exception: PaymentControlExceptionRecord | null
}

const exceptionColumns = {
  id: paymentControlExceptions.id,
  organizationId: paymentControlExceptions.organizationId,
  branchId: paymentControlExceptions.branchId,
  startAt: paymentControlExceptions.startAt,
  expiresAt: paymentControlExceptions.expiresAt,
  revokedAt: paymentControlExceptions.revokedAt,
  grantedByUserId: paymentControlExceptions.grantedByUserId,
  grantedByName: users.fullName,
  reason: paymentControlExceptions.reason,
  revokedByUserId: paymentControlExceptions.revokedByUserId,
  revokeReason: paymentControlExceptions.revokeReason,
}

/**
 * The branch's most recent grant, whatever its liveness. The policy needs to
 * know that one expired or was revoked, not only that none is in force.
 */
export async function loadLatestException(client: DbClient, branchId: number): Promise<PaymentControlExceptionRecord | null> {
  const [row] = await client
    .select(exceptionColumns)
    .from(paymentControlExceptions)
    .leftJoin(users, eq(users.id, paymentControlExceptions.grantedByUserId))
    .where(eq(paymentControlExceptions.branchId, branchId))
    .orderBy(desc(paymentControlExceptions.startAt), desc(paymentControlExceptions.id))
    .limit(1)
  return row ?? null
}

/** A grant in force at `now`: not revoked, started, not yet expired. */
async function loadLiveException(client: DbClient, branchId: number, now: Date): Promise<PaymentControlExceptionRecord | null> {
  const [row] = await client
    .select(exceptionColumns)
    .from(paymentControlExceptions)
    .leftJoin(users, eq(users.id, paymentControlExceptions.grantedByUserId))
    .where(and(
      eq(paymentControlExceptions.branchId, branchId),
      isNull(paymentControlExceptions.revokedAt),
      lte(paymentControlExceptions.startAt, now),
      gt(paymentControlExceptions.expiresAt, now),
    ))
    .orderBy(desc(paymentControlExceptions.expiresAt))
    .limit(1)
  return row ?? null
}

/**
 * The branch's payment-control state at `now`: the overdue summary from the
 * source, the latest exception, and the policy's decision on the two. Every
 * reader — the status route, the order gate, the Head Office panel — comes
 * through here so there is one answer.
 */
export async function resolveBranchPaymentControl(
  client: DbClient,
  scope: PaymentControlScope,
  now: Date = new Date(),
): Promise<BranchPaymentControl> {
  const overdue = await overduePaymentSource(client, scope, now)
  const exception = await loadLatestException(client, scope.branchId)
  const status = resolvePaymentControl({ overdue, exception, now, threshold: overdue.blockThreshold })
  return { ...status, exception }
}

/**
 * The order gate. Called first inside each order-creation transaction, once
 * the branch is authoritative, so the decision is read from committed state
 * at that instant and no order or budget write has happened yet. Throws
 * PaymentControlBlockedError, which the routes map to a stable refusal.
 */
export async function assertBranchMayOrder(tx: Tx, scope: PaymentControlScope, now: Date = new Date()): Promise<BranchPaymentControl> {
  const status = await resolveBranchPaymentControl(tx, scope, now)
  if (!status.orderingAllowed) throw new PaymentControlBlockedError(status)
  return status
}

export type GrantExceptionResult =
  | { kind: "granted"; exception: PaymentControlExceptionRecord; stateBefore: BranchPaymentControl }
  | { kind: "conflict"; exception: PaymentControlExceptionRecord }
  | { kind: "branch_not_found" }

/**
 * Grant a Head Office exception for one branch, for the policy's window from
 * `now`. The branch row is locked first so two simultaneous grants cannot
 * both pass the "one live exception" check. The audit row commits with the
 * grant or not at all.
 */
export async function grantPaymentControlException(
  tx: Tx,
  input: {
    branchId: number
    /** The tenant the caller may act in; `null` for Super Admin. */
    organizationId: number | null
    actor: { userId: string; role: string }
    reason: string | null
    now?: Date
  },
): Promise<GrantExceptionResult> {
  const now = input.now ?? new Date()
  const [branch] = await tx
    .select({ id: branches.id, organizationId: branches.organizationId, name: branches.name })
    .from(branches)
    .where(eq(branches.id, input.branchId))
    .for("update")
  if (!branch) return { kind: "branch_not_found" }
  if (input.organizationId !== null && branch.organizationId !== input.organizationId) return { kind: "branch_not_found" }

  const live = await loadLiveException(tx, branch.id, now)
  if (live) return { kind: "conflict", exception: live }

  const scope = { organizationId: branch.organizationId, branchId: branch.id }
  const stateBefore = await resolveBranchPaymentControl(tx, scope, now)
  const window = exceptionWindowFrom(now)

  const [inserted] = await tx
    .insert(paymentControlExceptions)
    .values({
      organizationId: branch.organizationId,
      branchId: branch.id,
      grantedByUserId: input.actor.userId,
      reason: input.reason,
      startAt: window.startAt,
      expiresAt: window.expiresAt,
    })
    .returning({ id: paymentControlExceptions.id })

  await tx.insert(auditLogs).values({
    userId: input.actor.userId,
    organizationId: branch.organizationId,
    branchId: branch.id,
    action: PAYMENT_CONTROL_EXCEPTION_GRANTED_AUDIT_ACTION,
    entity: "BRANCH",
    entityId: String(branch.id),
    metadata: {
      exceptionId: inserted.id,
      branchName: branch.name,
      actorRole: input.actor.role,
      startAt: window.startAt.toISOString(),
      expiresAt: window.expiresAt.toISOString(),
      reason: input.reason,
      stateBefore: {
        state: stateBefore.state,
        reason: stateBefore.reason,
        overdueCount: stateBefore.overdueCount,
        threshold: stateBefore.threshold,
        orderingAllowed: stateBefore.orderingAllowed,
      },
    },
  })

  const exception = await loadLatestException(tx, branch.id)
  if (!exception || exception.id !== inserted.id) throw new Error("PAYMENT_CONTROL_EXCEPTION_READBACK")
  return { kind: "granted", exception, stateBefore }
}

export type RevokeExceptionResult =
  | { kind: "revoked"; exception: PaymentControlExceptionRecord }
  | { kind: "not_found" }
  | { kind: "already_revoked"; exception: PaymentControlExceptionRecord }
  | { kind: "already_expired"; exception: PaymentControlExceptionRecord }

/**
 * End an exception early. Only a live one can be revoked: an expired one has
 * already stopped, and a revoked one is left as it is so the trail keeps the
 * first revocation's actor and time.
 */
export async function revokePaymentControlException(
  tx: Tx,
  input: {
    exceptionId: number
    organizationId: number | null
    actor: { userId: string; role: string }
    reason: string | null
    now?: Date
  },
): Promise<RevokeExceptionResult> {
  const now = input.now ?? new Date()
  const [row] = await tx
    .select({
      id: paymentControlExceptions.id,
      organizationId: paymentControlExceptions.organizationId,
      branchId: paymentControlExceptions.branchId,
      startAt: paymentControlExceptions.startAt,
      expiresAt: paymentControlExceptions.expiresAt,
      revokedAt: paymentControlExceptions.revokedAt,
    })
    .from(paymentControlExceptions)
    .where(eq(paymentControlExceptions.id, input.exceptionId))
    .for("update")
  if (!row) return { kind: "not_found" }
  if (input.organizationId !== null && row.organizationId !== input.organizationId) return { kind: "not_found" }

  const current = async () => (await loadLatestExceptionById(tx, row.id)) as PaymentControlExceptionRecord
  if (row.revokedAt) return { kind: "already_revoked", exception: await current() }
  if (row.expiresAt.getTime() <= now.getTime()) return { kind: "already_expired", exception: await current() }

  const scope = { organizationId: row.organizationId, branchId: row.branchId }
  const stateBefore = await resolveBranchPaymentControl(tx, scope, now)

  await tx
    .update(paymentControlExceptions)
    .set({ revokedAt: now, revokedByUserId: input.actor.userId, revokeReason: input.reason })
    .where(eq(paymentControlExceptions.id, row.id))

  await tx.insert(auditLogs).values({
    userId: input.actor.userId,
    organizationId: row.organizationId,
    branchId: row.branchId,
    action: PAYMENT_CONTROL_EXCEPTION_REVOKED_AUDIT_ACTION,
    entity: "BRANCH",
    entityId: String(row.branchId),
    metadata: {
      exceptionId: row.id,
      actorRole: input.actor.role,
      revokedAt: now.toISOString(),
      revokeReason: input.reason,
      startAt: row.startAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      stateBefore: {
        state: stateBefore.state,
        reason: stateBefore.reason,
        overdueCount: stateBefore.overdueCount,
        threshold: stateBefore.threshold,
        orderingAllowed: stateBefore.orderingAllowed,
      },
    },
  })

  return { kind: "revoked", exception: await current() }
}

async function loadLatestExceptionById(client: DbClient, id: number): Promise<PaymentControlExceptionRecord | null> {
  const [row] = await client
    .select(exceptionColumns)
    .from(paymentControlExceptions)
    .leftJoin(users, eq(users.id, paymentControlExceptions.grantedByUserId))
    .where(eq(paymentControlExceptions.id, id))
    .limit(1)
  return row ?? null
}
