import "server-only"

import { and, eq, inArray, or, sql } from "drizzle-orm"

import {
  branches,
  groups,
  userBranchAssignments,
  userGroupAssignments,
} from "@/db/schema"
import { db } from "@/lib/db"
import type { SystemRole } from "@/lib/server/mutation-validation"

/**
 * Multi-branch scope: the shared mechanism behind the two group-based roles.
 *
 * Ordinary tenant roles are pinned to a single branch. These roles instead act
 * across a set of branches which is the union of:
 *   * every branch belonging to an assigned group (resolved live, so group
 *     membership changes flow through without touching the user), and
 *   * every individually assigned branch.
 *
 * GROUP_ORDER_PORTAL places orders for that set; GROUP_USER additionally
 * approves and rejects them. Everything here is keyed by userId and pinned to
 * organizationId, and no other role ever has rows in these tables, so none of
 * it can change the behaviour of SUPER_ADMIN, HEAD_OFFICE, BRANCH_ADMIN, or
 * ORDER_PORTAL.
 */
export const GROUP_ORDER_PORTAL_ROLE = "GROUP_ORDER_PORTAL" as const
export const GROUP_USER_ROLE = "GROUP_USER" as const

/** Every role whose reach is defined by group/branch assignments. */
export const MULTI_BRANCH_SCOPE_ROLES = [
  GROUP_ORDER_PORTAL_ROLE,
  GROUP_USER_ROLE,
] as const

export type MultiBranchScopeRole = (typeof MULTI_BRANCH_SCOPE_ROLES)[number]

export function usesMultiBranchScope(role: unknown): role is MultiBranchScopeRole {
  return typeof role === "string"
    && MULTI_BRANCH_SCOPE_ROLES.includes(role as MultiBranchScopeRole)
}

/** Only this role may approve or reject orders across its assigned branches. */
export function isGroupApproverRole(role: unknown): boolean {
  return role === GROUP_USER_ROLE
}

export type MultiBranchScopeInput = {
  organizationId: number | null
  groupIds: number[]
  branchIds: number[]
}

export type ScopeValidationFailure = { message: string; status: number }

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Validate a requested scope against the tenant it is being created in.
 * Returns a failure describing the first problem, or null when the scope is
 * usable. Never partially applies anything — callers persist only on null.
 */
export async function validateMultiBranchScope({
  organizationId,
  groupIds,
  branchIds,
}: MultiBranchScopeInput): Promise<ScopeValidationFailure | null> {
  if (!organizationId) {
    return { message: "organizationId is required for this role", status: 400 }
  }
  if (groupIds.length === 0 && branchIds.length === 0) {
    return {
      message: "Assign at least one group or one branch to this user",
      status: 400,
    }
  }

  if (groupIds.length > 0) {
    const validGroups = await db
      .select({ id: groups.id })
      .from(groups)
      .where(and(
        inArray(groups.id, groupIds),
        eq(groups.organizationId, organizationId),
        sql`${groups.status} IS DISTINCT FROM 'deleted'`,
      ))
    if (validGroups.length !== groupIds.length) {
      return {
        message: "One or more selected groups do not belong to the selected organization",
        status: 400,
      }
    }
  }

  if (branchIds.length > 0) {
    const validBranches = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(
        inArray(branches.id, branchIds),
        eq(branches.organizationId, organizationId),
      ))
    if (validBranches.length !== branchIds.length) {
      return {
        message: "One or more selected branches do not belong to the selected organization",
        status: 400,
      }
    }
  }

  return null
}

/**
 * Reject scope input supplied for a role that has no multi-branch concept, so
 * a stray payload can never quietly widen an ordinary user's reach.
 */
export function rejectScopeForSingleBranchRole(
  role: SystemRole,
  groupIds: number[],
  branchIds: number[],
): ScopeValidationFailure | null {
  if (usesMultiBranchScope(role)) return null
  if (groupIds.length === 0 && branchIds.length === 0) return null
  return {
    message: "Group and branch assignments apply only to the group-based roles",
    status: 400,
  }
}

/** Replace a user's entire scope. Caller supplies the transaction. */
export async function replaceMultiBranchScope(
  tx: DbClient,
  {
    userId,
    organizationId,
    groupIds,
    branchIds,
    createdByUserId,
  }: {
    userId: string
    organizationId: number
    groupIds: number[]
    branchIds: number[]
    createdByUserId?: string | null
  },
): Promise<void> {
  await tx.delete(userGroupAssignments).where(eq(userGroupAssignments.userId, userId))
  await tx.delete(userBranchAssignments).where(eq(userBranchAssignments.userId, userId))

  if (groupIds.length > 0) {
    await tx.insert(userGroupAssignments).values(
      groupIds.map((groupId) => ({
        userId,
        groupId,
        organizationId,
        createdByUserId: createdByUserId ?? null,
      })),
    )
  }
  if (branchIds.length > 0) {
    await tx.insert(userBranchAssignments).values(
      branchIds.map((branchId) => ({
        userId,
        branchId,
        organizationId,
        createdByUserId: createdByUserId ?? null,
      })),
    )
  }
}

/** Remove every assignment for a user (role change off a group role, deletion). */
export async function clearMultiBranchScope(tx: DbClient, userId: string): Promise<void> {
  await tx.delete(userGroupAssignments).where(eq(userGroupAssignments.userId, userId))
  await tx.delete(userBranchAssignments).where(eq(userBranchAssignments.userId, userId))
}

export type MultiBranchScope = {
  groups: { id: number; name: string }[]
  branches: { id: number; name: string; groupId: number | null }[]
}

/** The raw assignments, for display on the user management screens. */
export async function getMultiBranchScope(userId: string): Promise<MultiBranchScope> {
  const [assignedGroups, assignedBranches] = await Promise.all([
    db
      .select({ id: groups.id, name: groups.name })
      .from(userGroupAssignments)
      .innerJoin(groups, eq(userGroupAssignments.groupId, groups.id))
      .where(eq(userGroupAssignments.userId, userId))
      .orderBy(groups.name),
    db
      .select({ id: branches.id, name: branches.name, groupId: branches.groupId })
      .from(userBranchAssignments)
      .innerJoin(branches, eq(userBranchAssignments.branchId, branches.id))
      .where(eq(userBranchAssignments.userId, userId))
      .orderBy(branches.name),
  ])

  return { groups: assignedGroups, branches: assignedBranches }
}

/** Just the assigned ids, for revalidating an existing scope during an edit. */
export async function getMultiBranchScopeIds(
  userId: string,
): Promise<{ groupIds: number[]; branchIds: number[] }> {
  const [assignedGroups, assignedBranches] = await Promise.all([
    db
      .select({ groupId: userGroupAssignments.groupId })
      .from(userGroupAssignments)
      .where(eq(userGroupAssignments.userId, userId)),
    db
      .select({ branchId: userBranchAssignments.branchId })
      .from(userBranchAssignments)
      .where(eq(userBranchAssignments.userId, userId)),
  ])

  return {
    groupIds: assignedGroups.map((row) => row.groupId),
    branchIds: assignedBranches.map((row) => row.branchId),
  }
}

/**
 * The effective branch set: assigned groups resolved to their current member
 * branches, unioned with the individually assigned branches.
 *
 * An empty result means "no access" and must never be widened into "all
 * branches" by a caller. Accepts a transaction so an authorization decision can
 * read the scope inside the same transaction that performs the write.
 */
export async function resolveScopedBranchIds(
  client: DbClient,
  userId: string,
): Promise<number[]> {
  const rows = await client
    .selectDistinct({ id: branches.id })
    .from(branches)
    // Each join re-asserts the tenant the assignment was written under, so a
    // row that somehow referenced another tenant's branch contributes nothing.
    .leftJoin(
      userGroupAssignments,
      and(
        eq(userGroupAssignments.groupId, branches.groupId),
        eq(userGroupAssignments.userId, userId),
        eq(userGroupAssignments.organizationId, branches.organizationId),
      ),
    )
    .leftJoin(
      userBranchAssignments,
      and(
        eq(userBranchAssignments.branchId, branches.id),
        eq(userBranchAssignments.userId, userId),
        eq(userBranchAssignments.organizationId, branches.organizationId),
      ),
    )
    .where(
      or(
        sql`${userGroupAssignments.id} IS NOT NULL`,
        sql`${userBranchAssignments.id} IS NOT NULL`,
      ),
    )

  return rows.map((row: { id: number }) => row.id)
}

/**
 * The groups a multi-branch user reaches: those it was assigned directly, plus
 * the groups its individually assigned branches belong to.
 *
 * Used for filter lists only — every read is still restricted by the branch
 * scope above, so this can narrow what a user is offered but never widen what
 * it can retrieve. An empty result means no groups, never all groups.
 */
export async function resolveScopedGroupIds(
  client: DbClient,
  userId: string,
): Promise<number[]> {
  const rows = await client
    .selectDistinct({ id: groups.id })
    .from(groups)
    // Both routes to a group re-assert the tenant the assignment was written
    // under, matching how the branch scope is resolved.
    .leftJoin(
      userGroupAssignments,
      and(
        eq(userGroupAssignments.groupId, groups.id),
        eq(userGroupAssignments.userId, userId),
        eq(userGroupAssignments.organizationId, groups.organizationId),
      ),
    )
    .leftJoin(branches, eq(branches.groupId, groups.id))
    .leftJoin(
      userBranchAssignments,
      and(
        eq(userBranchAssignments.branchId, branches.id),
        eq(userBranchAssignments.userId, userId),
        eq(userBranchAssignments.organizationId, branches.organizationId),
      ),
    )
    .where(
      or(
        sql`${userGroupAssignments.id} IS NOT NULL`,
        sql`${userBranchAssignments.id} IS NOT NULL`,
      ),
    )

  return rows.map((row: { id: number }) => row.id)
}

/** True when the user may act on the given branch. Never true without an assignment. */
export async function canUseScopedBranch(
  userId: string,
  branchId: number | null | undefined,
): Promise<boolean> {
  if (!branchId) return false
  const allowed = await resolveScopedBranchIds(db, userId)
  return allowed.includes(branchId)
}
