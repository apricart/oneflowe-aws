import "server-only"

import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql } from "drizzle-orm"

import { emailOutbox } from "@/db/schema"
import { db } from "@/lib/db"

/**
 * The transactional machinery behind `email_outbox`, shared by every kind of
 * mail the application queues.
 *
 * This was lifted out of `lib/server/order-notifications.ts` unchanged when
 * support threads started using the same table. Nothing here knows what a
 * message is *about*: claiming a batch, counting attempts, backing off and
 * retiring a row are the same whether the row is an order lifecycle event or a
 * reply on a support thread. What each row means is decided by the deliverer
 * the caller passes in.
 */

export const MAX_DELIVERY_ATTEMPTS = 5
const PROCESSING_TIMEOUT_MS = 10 * 60 * 1000
const RETRY_DELAYS_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 12 * 60 * 60_000]

export type DeliveryOutcome = "sent" | "retried" | "failed" | "skipped"
export type ClaimedOutboxRow = typeof emailOutbox.$inferSelect & { attempts: number }

export function retryTime(attempts: number): Date {
  const delay = RETRY_DELAYS_MS[Math.min(Math.max(attempts - 1, 0), RETRY_DELAYS_MS.length - 1)]
  return new Date(Date.now() + delay)
}

/**
 * A delivery failure recorded against the row, with the provider's own wording
 * flattened to one line and bounded. It is never returned to a caller.
 */
export function safeDeliveryError(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : "Unknown email delivery error"
  return message.replace(/[\r\n]+/g, " ").slice(0, 1000)
}

/** Retires a claimed row that can never be delivered — a bad payload, a recipient who lost the scope. */
export async function markSkipped(id: number, reason: string): Promise<void> {
  await db.update(emailOutbox).set({
    status: "SKIPPED",
    processingStartedAt: null,
    lastError: reason,
    updatedAt: new Date(),
  }).where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "PROCESSING")))
}

/** Records a successful send against the claimed row. */
export async function markSent(id: number, input: {
  recipientEmail: string
  providerMessageId: string | null
}): Promise<void> {
  await db.update(emailOutbox).set({
    recipientEmail: input.recipientEmail,
    status: "SENT",
    processingStartedAt: null,
    sentAt: new Date(),
    providerMessageId: input.providerMessageId,
    lastError: null,
    updatedAt: new Date(),
  }).where(and(eq(emailOutbox.id, id), eq(emailOutbox.status, "PROCESSING")))
}

/**
 * Records a failed send, returning the row to the queue with a backoff or
 * retiring it once the attempt budget is spent.
 */
export async function markFailedAttempt(row: ClaimedOutboxRow, error: unknown): Promise<DeliveryOutcome> {
  const terminal = row.attempts >= MAX_DELIVERY_ATTEMPTS
  await db.update(emailOutbox).set({
    status: terminal ? "FAILED" : "PENDING",
    processingStartedAt: null,
    nextAttemptAt: terminal ? null : retryTime(row.attempts),
    lastError: safeDeliveryError(error),
    updatedAt: new Date(),
  }).where(and(eq(emailOutbox.id, row.id), eq(emailOutbox.status, "PROCESSING")))
  return terminal ? "failed" : "retried"
}

export type OutboxRunResult = {
  claimed: number
  sent: number
  retried: number
  failed: number
  skipped: number
}

/**
 * Claims a batch of due rows and delivers each one.
 *
 * The claim is a single transaction taking `FOR UPDATE SKIP LOCKED`, so two
 * workers running at once take disjoint batches rather than sending the same
 * message twice. Rows that have exhausted their attempts are retired in the
 * same transaction, before the batch is taken, so they cannot be re-claimed
 * forever.
 */
export async function runEmailOutbox(
  deliver: (row: ClaimedOutboxRow) => Promise<DeliveryOutcome>,
  options?: { eventKeys?: string[]; limit?: number },
): Promise<OutboxRunResult> {
  const eventKeys = Array.from(new Set((options?.eventKeys || []).filter(Boolean))).slice(0, 100)
  const limit = Math.min(Math.max(Math.floor(options?.limit || 25), 1), 50)
  const now = new Date()
  const staleBefore = new Date(now.getTime() - PROCESSING_TIMEOUT_MS)

  const claimed = await db.transaction(async (tx) => {
    const eligibility = or(
      and(
        eq(emailOutbox.status, "PENDING"),
        or(isNull(emailOutbox.nextAttemptAt), lte(emailOutbox.nextAttemptAt, now)),
      ),
      and(
        eq(emailOutbox.status, "PROCESSING"),
        or(isNull(emailOutbox.processingStartedAt), lte(emailOutbox.processingStartedAt, staleBefore)),
      ),
    )

    await tx.update(emailOutbox).set({
      status: "FAILED",
      processingStartedAt: null,
      nextAttemptAt: null,
      lastError: "Delivery worker stopped after the maximum number of attempts",
      updatedAt: now,
    }).where(and(
      gte(emailOutbox.attempts, MAX_DELIVERY_ATTEMPTS),
      or(
        eq(emailOutbox.status, "PENDING"),
        and(
          eq(emailOutbox.status, "PROCESSING"),
          or(isNull(emailOutbox.processingStartedAt), lte(emailOutbox.processingStartedAt, staleBefore)),
        ),
      ),
    ))

    const conditions = [eligibility, lt(emailOutbox.attempts, MAX_DELIVERY_ATTEMPTS)]
    if (eventKeys.length > 0) conditions.push(inArray(emailOutbox.eventKey, eventKeys))

    const rows = await tx
      .select()
      .from(emailOutbox)
      .where(and(...conditions))
      .orderBy(asc(emailOutbox.createdAt))
      .limit(limit)
      .for("update", { skipLocked: true })

    if (rows.length === 0) return []
    const ids = rows.map((row) => row.id)
    await tx.update(emailOutbox).set({
      status: "PROCESSING",
      processingStartedAt: now,
      attempts: sql`${emailOutbox.attempts} + 1`,
      updatedAt: now,
    }).where(inArray(emailOutbox.id, ids))

    return rows.map((row) => ({ ...row, attempts: row.attempts + 1 }))
  })

  const outcomes: Record<DeliveryOutcome, number> = { sent: 0, retried: 0, failed: 0, skipped: 0 }
  for (const row of claimed) {
    outcomes[await deliver(row)]++
  }

  return { claimed: claimed.length, ...outcomes }
}
