import "server-only"

import { and, asc, eq, inArray, isNotNull, isNull } from "drizzle-orm"

import { branches, orders, organizations, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { isOrderDeskRole } from "@/lib/order-desk-access"
import {
  type ApprovalLevelBand,
  type ApprovalLevelOrganization,
  type LevelledDecisionActor,
  approvalLevelBands,
  approvalLevelForAmount,
  approvalLevelUnavailableMessage,
  approvalLevelsActive,
  canDecideLevelledOrder,
  canHoldApprovalLevel,
  reachesBranch,
} from "@/lib/order-approval-levels"
import { loadOrganizationApprovalLevels } from "@/lib/server/order-approval-levels"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"

/**
 * Routing orders by approval level (plans/OF-APPROVAL-LEVELS-route-orders-by-level.md).
 *
 * Every function here is gated on `approvalLevelsActive` for the order's
 * organization, and on the order carrying a level. An organization that does
 * not use approval levels never reaches past that gate, so its orders are
 * created, decided and announced exactly as before.
 */

type Executor = Pick<typeof db, "select">

export type ApprovalLevelSettings = ApprovalLevelOrganization & {
  amountsCents: number[]
  /** `approvalLevelsActive`, for this organization, now. */
  active: boolean
}

/**
 * The organization's switch, approver role and level amounts. `lock` takes the
 * organization row `FOR SHARE`, the lock every order path already holds and
 * the levels save waits on with `FOR UPDATE`.
 */
export async function loadApprovalLevelSettings(
  executor: Executor,
  organizationId: number,
  lock = false,
): Promise<ApprovalLevelSettings | null> {
  const query = executor
    .select({
      orderApprovalRequired: organizations.orderApprovalRequired,
      orderApprovalLevelsEnabled: organizations.orderApprovalLevelsEnabled,
      orderApproverRole: organizations.orderApproverRole,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
  const [organization] = lock ? await query.for("share").limit(1) : await query.limit(1)
  if (!organization) return null

  const amountsCents = (await loadOrganizationApprovalLevels(executor, organizationId)).map((level) => level.maxAmountCents)
  return {
    ...organization,
    amountsCents,
    active: approvalLevelsActive({
      orderApprovalRequired: organization.orderApprovalRequired,
      orderApprovalLevelsEnabled: organization.orderApprovalLevelsEnabled,
      levelCount: amountsCents.length,
    }),
  }
}

/** A user who may decide orders at a level, as the routing reads them. */
type LevelHolderRow = LevelledDecisionActor & { email: string }

/** Every active user of the organization holding a level, with their reach. */
async function loadLevelHolderRows(
  executor: Executor,
  organizationId: number,
  settings: ApprovalLevelOrganization,
  level?: number,
): Promise<LevelHolderRow[]> {
  const eligibleRoles = ["GROUP_USER", settings.orderApproverRole].filter((role): role is string => Boolean(role))
  const rows = await executor
    .select({
      userId: users.id,
      email: users.email,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
      level: users.orderApprovalLevel,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.organizationId, organizationId),
      level === undefined ? isNotNull(users.orderApprovalLevel) : eq(users.orderApprovalLevel, level),
      eq(users.isActive, true),
      isNull(users.deletedAt),
      inArray(roles.name, eligibleRoles),
    ))
    .orderBy(asc(users.id))

  const holders: LevelHolderRow[] = []
  for (const row of rows) {
    if (!canHoldApprovalLevel(row.role, settings)) continue
    const scopedBranchIds = row.role === "GROUP_USER" ? await resolveScopedBranchIds(executor as any, row.userId) : []
    holders.push({ ...row, scopedBranchIds })
  }
  return holders
}

/**
 * Who may decide an order at this level and branch (R3): holders of exactly
 * the level whose reach covers the branch, never the person who raised it.
 */
export async function loadLevelHolders(
  executor: Executor,
  input: {
    organizationId: number
    branchId: number
    level: number
    excludeUserId: string | null
    settings: ApprovalLevelOrganization
  },
): Promise<Array<{ id: string; email: string; role: string }>> {
  const rows = await loadLevelHolderRows(executor, input.organizationId, input.settings, input.level)
  return rows
    .filter((row) => row.userId !== input.excludeUserId && reachesBranch(row, input.branchId))
    .map((row) => ({ id: row.userId, email: row.email, role: row.role }))
}

/* ── Creation and edit ───────────────────────────────────────────────────── */

export const APPROVAL_LEVEL_UNAVAILABLE = "APPROVAL_LEVEL_UNAVAILABLE"

/** An order refused because no one could decide it at its level (R5). */
export class ApprovalLevelUnavailableError extends Error {
  readonly code = APPROVAL_LEVEL_UNAVAILABLE
  constructor(readonly level: number) {
    super(approvalLevelUnavailableMessage(level))
  }
}

export function isApprovalLevelUnavailableError(value: unknown): value is ApprovalLevelUnavailableError {
  return value instanceof ApprovalLevelUnavailableError
}

/**
 * The level a new order waits at (R1, R5, R9), or null when the order is
 * decided as before: approved at creation, entered by the Order Desk, or in
 * an organization not using levels. Called inside the creation transaction,
 * after the initial approval was resolved under the organization's FOR SHARE.
 * Throws `ApprovalLevelUnavailableError` before anything is held.
 */
export async function resolveOrderApprovalLevel(
  tx: Executor,
  input: {
    organizationId: number
    branchId: number
    totalCents: number
    approvalRequired: boolean
    creator: { userId: string; role: unknown }
  },
): Promise<number | null> {
  if (!input.approvalRequired) return null
  if (isOrderDeskRole(input.creator.role)) return null

  const settings = await loadApprovalLevelSettings(tx, input.organizationId, true)
  if (!settings?.active) return null

  const level = approvalLevelForAmount(input.totalCents, settings.amountsCents)
  if (level === null) return null
  const holders = await loadLevelHolders(tx, {
    organizationId: input.organizationId,
    branchId: input.branchId,
    level,
    excludeUserId: input.creator.userId,
    settings,
  })
  if (holders.length === 0) throw new ApprovalLevelUnavailableError(level)
  return level
}

/**
 * The level an edited order waits at (R6). An order without a level keeps
 * none; one in an organization that stopped using levels keeps the one it
 * has. Otherwise it is banded again on its new total, which must have a
 * holder.
 */
export async function rebandEditedOrder(
  tx: Executor,
  input: {
    order: { approvalLevel: number | null; organizationId: number; branchId: number; createdByUserId: string | null }
    totalCents: number
  },
): Promise<{ level: number | null; changed: boolean }> {
  const current = input.order.approvalLevel
  if (current === null) return { level: null, changed: false }

  const settings = await loadApprovalLevelSettings(tx, input.order.organizationId, true)
  if (!settings?.active) return { level: current, changed: false }

  const next = approvalLevelForAmount(input.totalCents, settings.amountsCents)
  if (next === null || next === current) return { level: current, changed: false }

  const holders = await loadLevelHolders(tx, {
    organizationId: input.order.organizationId,
    branchId: input.order.branchId,
    level: next,
    excludeUserId: input.order.createdByUserId,
    settings,
  })
  if (holders.length === 0) throw new ApprovalLevelUnavailableError(next)
  return { level: next, changed: true }
}

/* ── Deciding ────────────────────────────────────────────────────────────── */

export type LevelledDecision =
  | { levelled: false }
  | { levelled: true; level: number; allowed: boolean }

async function loadActor(executor: Executor, userId: string): Promise<LevelledDecisionActor | null> {
  const [actor] = await executor
    .select({
      userId: users.id,
      role: roles.name,
      organizationId: users.organizationId,
      branchId: users.branchId,
      level: users.orderApprovalLevel,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(users.id, userId), eq(users.isActive, true), isNull(users.deletedAt)))
    .limit(1)
  if (!actor) return null
  const scopedBranchIds = actor.role === "GROUP_USER" ? await resolveScopedBranchIds(executor as any, actor.userId) : []
  return { ...actor, scopedBranchIds }
}

/**
 * Whether this order is decided by level now (R3, R4), and if so whether this
 * person may decide it. Read inside the deciding transaction: the organization
 * `FOR SHARE` (so a levels save waits for the decision) and the actor's level
 * and reach as they stand now.
 */
export async function levelledDecisionFor(
  tx: Executor,
  input: {
    order: { approvalLevel: number | null; organizationId: number; branchId: number; createdByUserId: string | null }
    actorUserId: string
  },
): Promise<LevelledDecision> {
  const level = input.order.approvalLevel
  if (level === null) return { levelled: false }
  const settings = await loadApprovalLevelSettings(tx, input.order.organizationId, true)
  if (!settings?.active) return { levelled: false }

  const actor = await loadActor(tx, input.actorUserId)
  const allowed = actor !== null && canDecideLevelledOrder({
    actor,
    order: { ...input.order, approvalLevel: level },
    organization: settings,
  })
  return { levelled: true, level, allowed }
}

/**
 * The claim's level condition: the level a decision was authorized at, or
 * nothing for an order decided as before. Approve, reject and return all add
 * it, so an edit that moved the order to another level between authorizing
 * and claiming turns the decision into a conflict.
 */
export function approvalLevelMatches(approvalLevel: number | null) {
  return approvalLevel === null ? undefined : eq(orders.approvalLevel, approvalLevel)
}

/* ── Screens ─────────────────────────────────────────────────────────────── */

/** What a reader needs to label levelled orders and hide buttons it may not use (R10). */
export type LevelledViewContext = {
  organizationId: number
  organization: ApprovalLevelOrganization
  actor: LevelledDecisionActor | null
}

/**
 * The context for one reader, or null when its organization does not use
 * levels — in which case every order reads exactly as before.
 */
export async function loadLevelledViewContext(viewer: {
  userId: string | null | undefined
  organizationId: number | null | undefined
}): Promise<LevelledViewContext | null> {
  if (!viewer.organizationId) return null
  const settings = await loadApprovalLevelSettings(db, viewer.organizationId)
  if (!settings?.active) return null
  const actor = viewer.userId ? await loadActor(db, viewer.userId) : null
  return { organizationId: viewer.organizationId, organization: settings, actor }
}

/** The flags for one order row: its level, and whether this reader may not decide it because of it. */
export function levelledViewFlags(
  context: LevelledViewContext | null,
  order: { approvalLevel?: number | null; organizationId: number | null; branchId: number; createdByUserId?: string | null },
): { approvalLevel: number | null; levelDecisionLocked: boolean } {
  const level = order.approvalLevel ?? null
  if (!context || level === null || order.organizationId !== context.organizationId) {
    return { approvalLevel: null, levelDecisionLocked: false }
  }
  const allowed = context.actor !== null && canDecideLevelledOrder({
    actor: context.actor,
    order: {
      approvalLevel: level,
      organizationId: order.organizationId,
      branchId: order.branchId,
      createdByUserId: order.createdByUserId ?? null,
    },
    organization: context.organization,
  })
  return { approvalLevel: level, levelDecisionLocked: !allowed }
}

/* ── Coverage ────────────────────────────────────────────────────────────── */

export type ApprovalLevelCoverage = {
  active: boolean
  levels: ApprovalLevelBand[]
  branches: Array<{ id: number; name: string; holders: Record<number, number>; missingLevels: number[] }>
}

/** For each active branch, how many people hold each level there (R11). */
export async function loadApprovalLevelCoverage(organizationId: number): Promise<ApprovalLevelCoverage | null> {
  const settings = await loadApprovalLevelSettings(db, organizationId)
  if (!settings) return null
  const levels = approvalLevelBands(settings.amountsCents)
  if (!settings.active) return { active: false, levels, branches: [] }

  const [branchRows, holders] = await Promise.all([
    db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.organizationId, organizationId), eq(branches.status, "active")))
      .orderBy(asc(branches.name))
      .limit(500),
    loadLevelHolderRows(db, organizationId, settings),
  ])

  return {
    active: true,
    levels,
    branches: branchRows.map((branch) => {
      const counts: Record<number, number> = {}
      for (const band of levels) {
        counts[band.level] = holders.filter((holder) => holder.level === band.level && reachesBranch(holder, branch.id)).length
      }
      return {
        ...branch,
        holders: counts,
        missingLevels: levels.filter((band) => counts[band.level] === 0).map((band) => band.level),
      }
    }),
  }
}
