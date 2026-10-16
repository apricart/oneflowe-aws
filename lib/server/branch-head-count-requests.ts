import "server-only"

import { and, desc, eq, inArray, sql } from "drizzle-orm"

import { branchHeadCountRequests, branches, users } from "@/db/schema"
import {
  statusForHeadCountDecision,
  type HeadCountRequestDecision,
  type HeadCountRequestStatus,
} from "@/lib/branch-head-count"
import { db } from "@/lib/db"
import { recordAuditEvent } from "@/lib/server/activity-audit"

/**
 * Reading, raising and deciding branch head-count requests
 * (plans/OF-BRANCH-head-count.md).
 *
 * Every function takes its tenant and branch set from the caller, which
 * resolves both from the session (`lib/server/branch-head-count-scope.ts`).
 * Nothing here reads a session, and an empty branch set returns nothing rather
 * than widening to the tenant.
 *
 * The audit row is written inside the same transaction as the change it
 * records, so a rolled-back approval never claims to have happened.
 */

const requestColumns = {
  id: branchHeadCountRequests.id,
  organizationId: branchHeadCountRequests.organizationId,
  branchId: branchHeadCountRequests.branchId,
  requestedHeadCount: branchHeadCountRequests.requestedHeadCount,
  currentHeadCount: branchHeadCountRequests.currentHeadCount,
  status: branchHeadCountRequests.status,
  requestReason: branchHeadCountRequests.requestReason,
  requestedByUserId: branchHeadCountRequests.requestedByUserId,
  appliedPreviousHeadCount: branchHeadCountRequests.appliedPreviousHeadCount,
  decisionReason: branchHeadCountRequests.decisionReason,
  decidedAt: branchHeadCountRequests.decidedAt,
  createdAt: branchHeadCountRequests.createdAt,
}

export type HeadCountRequestRow = {
  id: number
  organizationId: number
  branchId: number
  branchName: string | null
  /** What the branch holds now, so a reviewer compares against today's figure. */
  branchHeadCount: number | null
  requestedHeadCount: number
  currentHeadCount: number | null
  status: string
  requestReason: string | null
  requestedByUserId: string
  requestedByName: string | null
  appliedPreviousHeadCount: number | null
  decisionReason: string | null
  decidedAt: Date | string | null
  createdAt: Date | string | null
}

/**
 * Which branches a listing covers. "The whole tenant" is a decision only the
 * approver's scope makes; every other caller passes the branches it resolved,
 * and an empty array stays empty.
 */
export type HeadCountRequestListScope =
  | { scope: "tenant" }
  | { scope: "branches"; branchIds: number[] }

function personName(first: string | null, last: string | null): string | null {
  const name = [first, last].map((part) => part?.trim()).filter(Boolean).join(" ")
  return name || null
}

export async function listHeadCountRequests(input: {
  organizationId: number
  branches: HeadCountRequestListScope
  status?: HeadCountRequestStatus
  limit: number
}): Promise<HeadCountRequestRow[]> {
  if (input.branches.scope === "branches" && input.branches.branchIds.length === 0) {
    return []
  }
  const branchPredicate = input.branches.scope === "branches"
    ? [inArray(branchHeadCountRequests.branchId, input.branches.branchIds)]
    : []

  const rows = await db
    .select({
      ...requestColumns,
      branchName: branches.name,
      branchHeadCount: branches.headCount,
      requestedByFirstName: users.firstName,
      requestedByLastName: users.lastName,
    })
    .from(branchHeadCountRequests)
    .innerJoin(
      branches,
      and(
        eq(branches.id, branchHeadCountRequests.branchId),
        eq(branches.organizationId, branchHeadCountRequests.organizationId),
      ),
    )
    .leftJoin(users, eq(users.id, branchHeadCountRequests.requestedByUserId))
    .where(and(
      eq(branchHeadCountRequests.organizationId, input.organizationId),
      ...branchPredicate,
      ...(input.status ? [eq(branchHeadCountRequests.status, input.status)] : []),
    ))
    .orderBy(desc(branchHeadCountRequests.createdAt), desc(branchHeadCountRequests.id))
    .limit(input.limit)

  return rows.map(({ requestedByFirstName, requestedByLastName, ...rest }) => ({
    ...rest,
    requestedByName: personName(requestedByFirstName, requestedByLastName),
  }))
}

export type HeadCountRequestableBranch = { id: number; name: string; headCount: number | null }

/**
 * The branches this caller may raise a request for, named and with today's
 * figure. Takes the already-resolved set, and re-applies the tenant predicate
 * so a stale assignment to a branch in another tenant contributes nothing.
 */
export async function listHeadCountRequestableBranches(input: {
  organizationId: number
  branchIds: number[]
}): Promise<HeadCountRequestableBranch[]> {
  if (input.branchIds.length === 0) return []
  return db
    .select({ id: branches.id, name: branches.name, headCount: branches.headCount })
    .from(branches)
    .where(and(
      inArray(branches.id, input.branchIds),
      eq(branches.organizationId, input.organizationId),
    ))
    .orderBy(branches.name)
}

/** The badge on Head Office's queue, counted apart from the page so a filter cannot stale it. */
export async function countPendingHeadCountRequests(organizationId: number): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(branchHeadCountRequests)
    .where(and(
      eq(branchHeadCountRequests.organizationId, organizationId),
      eq(branchHeadCountRequests.status, "pending"),
    ))
  return row?.count ?? 0
}

export type HeadCountRequestFailure = { ok: false; message: string; status: number }

/** The Postgres unique violation raised by `branch_head_count_requests_pending_uq`. */
function isUniqueViolation(exception: unknown): boolean {
  const cause = (exception as { cause?: unknown })?.cause ?? exception
  const code = (cause as { code?: string })?.code ?? (exception as { code?: string })?.code
  return code === "23505"
}

const ALREADY_PENDING = "This branch already has a head count request waiting for Head Office."

/**
 * Raise a request. Always `pending` — no parameter can make it anything else,
 * which is what stops a requester approving its own figure.
 */
export async function createHeadCountRequest(input: {
  organizationId: number
  branchId: number
  requestedByUserId: string
  requestedByRole: string
  headCount: number
  reason: string | null
}): Promise<{ ok: true; request: HeadCountRequestRow } | HeadCountRequestFailure> {
  try {
    return await db.transaction(async (tx) => {
      const [branch] = await tx
        .select({ id: branches.id, name: branches.name, headCount: branches.headCount })
        .from(branches)
        .where(and(
          eq(branches.id, input.branchId),
          eq(branches.organizationId, input.organizationId),
        ))
        .limit(1)
      if (!branch) {
        return { ok: false as const, message: "Branch not found", status: 404 }
      }

      const [created] = await tx
        .insert(branchHeadCountRequests)
        .values({
          organizationId: input.organizationId,
          branchId: branch.id,
          requestedHeadCount: input.headCount,
          currentHeadCount: branch.headCount,
          // Set here and nowhere else.
          status: "pending",
          requestReason: input.reason,
          requestedByUserId: input.requestedByUserId,
        })
        .returning(requestColumns)

      await recordAuditEvent(tx, {
        action: "REQUEST_BRANCH_HEAD_COUNT",
        entity: "branch_head_count_request",
        entityId: created.id,
        actor: { id: input.requestedByUserId, role: input.requestedByRole },
        organizationId: input.organizationId,
        branchId: branch.id,
        after: { requestedHeadCount: created.requestedHeadCount, currentHeadCount: branch.headCount },
        context: { reasonGiven: Boolean(input.reason) },
      })

      return {
        ok: true as const,
        request: {
          ...created,
          branchName: branch.name,
          branchHeadCount: branch.headCount,
          requestedByName: null,
        },
      }
    })
  } catch (caughtError) {
    if (isUniqueViolation(caughtError)) {
      return { ok: false, message: ALREADY_PENDING, status: 409 }
    }
    throw caughtError
  }
}

export type HeadCountDecisionOutcome =
  | {
    ok: true
    requestId: number
    branchId: number
    status: HeadCountRequestStatus
    headCount: number | null
  }
  | HeadCountRequestFailure

/**
 * Approve or reject one request — **the only path by which a requester's
 * figure reaches `branches.head_count`.**
 *
 * The fence is `(id, organizationId)` in the `WHERE` of the `FOR UPDATE`, so
 * another tenant's request is *not found*, the same answer as one that does
 * not exist. Replay is that lock plus the status check: two administrators
 * deciding at once produce one decision and one 409.
 *
 * On approval the branch row is locked on `(branch_id, organization_id)` and
 * written in the same transaction, and the figure it overwrote is recorded.
 */
export async function decideHeadCountRequest(input: {
  requestId: number
  organizationId: number
  actorUserId: string
  actorRole: string
  decision: HeadCountRequestDecision
  reason: string | null
}): Promise<HeadCountDecisionOutcome> {
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .select({
        id: branchHeadCountRequests.id,
        branchId: branchHeadCountRequests.branchId,
        requestedHeadCount: branchHeadCountRequests.requestedHeadCount,
        status: branchHeadCountRequests.status,
        requestedByUserId: branchHeadCountRequests.requestedByUserId,
      })
      .from(branchHeadCountRequests)
      .where(and(
        eq(branchHeadCountRequests.id, input.requestId),
        eq(branchHeadCountRequests.organizationId, input.organizationId),
      ))
      .for("update")
      .limit(1)

    if (!stored) {
      return { ok: false as const, message: "Head count request not found", status: 404 }
    }
    if (stored.status !== "pending") {
      return {
        ok: false as const,
        message: `This request has already been ${stored.status}.`,
        status: 409,
      }
    }

    const [branch] = await tx
      .select({ id: branches.id, headCount: branches.headCount })
      .from(branches)
      .where(and(
        eq(branches.id, stored.branchId),
        eq(branches.organizationId, input.organizationId),
      ))
      .for("update")
      .limit(1)
    if (!branch) {
      return { ok: false as const, message: "Head count request not found", status: 404 }
    }

    const decidedAt = new Date()
    const status = statusForHeadCountDecision(input.decision)
    const approving = status === "approved"

    if (approving) {
      await tx
        .update(branches)
        .set({ headCount: stored.requestedHeadCount, updatedAt: decidedAt })
        .where(and(
          eq(branches.id, branch.id),
          eq(branches.organizationId, input.organizationId),
        ))
    }

    await tx
      .update(branchHeadCountRequests)
      .set({
        status,
        appliedPreviousHeadCount: approving ? branch.headCount : null,
        decisionReason: input.reason,
        decidedByUserId: input.actorUserId,
        decidedAt,
        updatedAt: decidedAt,
      })
      .where(eq(branchHeadCountRequests.id, stored.id))

    await recordAuditEvent(tx, {
      action: approving ? "APPROVE_BRANCH_HEAD_COUNT" : "REJECT_BRANCH_HEAD_COUNT",
      entity: "branch_head_count_request",
      entityId: stored.id,
      actor: { id: input.actorUserId, role: input.actorRole },
      organizationId: input.organizationId,
      branchId: branch.id,
      before: { headCount: branch.headCount },
      after: { headCount: approving ? stored.requestedHeadCount : branch.headCount },
      context: {
        requestedHeadCount: stored.requestedHeadCount,
        requestedByUserId: stored.requestedByUserId,
        reasonGiven: Boolean(input.reason),
      },
    })

    return {
      ok: true as const,
      requestId: stored.id,
      branchId: branch.id,
      status,
      headCount: approving ? stored.requestedHeadCount : branch.headCount,
    }
  })
}
