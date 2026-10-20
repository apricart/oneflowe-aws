import "server-only"

import { and, eq, sql } from "drizzle-orm"

import { branches } from "@/db/schema"
import type { db } from "@/lib/db"
import {
  normalizeBranchHierarchyRole,
  planBranchHierarchyChange,
  type BranchHierarchy,
  type BranchHierarchyInput,
} from "@/lib/branch-hierarchy"

/**
 * The database half of the parent / child branch label
 * (plans/OF-BRANCH-parent-child-label.md): the checks that need the parent's
 * row and the children's count, run inside the caller's transaction so they
 * see what the write will see.
 *
 * The organization is always the branch's own, which the caller has already
 * proved; a parent id is never resolved in any other tenant.
 */

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type HierarchyRefusal = { status: 400 | 409; message: string }

export const PARENT_NOT_FOUND_MESSAGE = "Parent branch not found in this organization"
export const PARENT_NOT_A_PARENT_MESSAGE = "The chosen branch is not a parent branch"
export const PARENT_HAS_CHILDREN_MESSAGE =
  "This branch still has child branches. Move them to another parent or make them standalone first."
export const HIERARCHY_CONFLICT_MESSAGE = "The branch hierarchy changed while saving. Reload and try again."

/**
 * Why `parentBranchId` cannot be a parent in `organizationId`, or null. Takes
 * the parent's row `FOR SHARE`, so a concurrent re-type of that parent waits
 * for this transaction (and the `branches_hierarchy_guard` trigger re-checks).
 * Another tenant's branch reads exactly as a missing one.
 */
export async function parentBranchRefusal(
  tx: TransactionExecutor,
  organizationId: number,
  parentBranchId: number,
): Promise<HierarchyRefusal | null> {
  const [parent] = await tx
    .select({ hierarchyRole: branches.hierarchyRole })
    .from(branches)
    .where(and(eq(branches.id, parentBranchId), eq(branches.organizationId, organizationId)))
    .limit(1)
    .for("share")
  if (!parent) return { status: 400, message: PARENT_NOT_FOUND_MESSAGE }
  if (normalizeBranchHierarchyRole(parent.hierarchyRole) !== "PARENT") {
    return { status: 400, message: PARENT_NOT_A_PARENT_MESSAGE }
  }
  return null
}

async function hasChildBranches(tx: TransactionExecutor, branchId: number): Promise<boolean> {
  const [child] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(eq(branches.parentBranchId, branchId))
    .limit(1)
  return Boolean(child)
}

export type HierarchyUpdateOutcome =
  | { kind: "unchanged" }
  | { kind: "change"; next: BranchHierarchy }
  | { kind: "refused"; refusal: HierarchyRefusal }

/**
 * What an edit does to one branch's hierarchy, decided against that branch's
 * row locked `FOR UPDATE` in this transaction — never against a copy read
 * before it. The caller writes `next` only on `change`.
 */
export async function planBranchHierarchyUpdateInTx(
  tx: TransactionExecutor,
  branchId: number,
  requested: BranchHierarchyInput,
): Promise<HierarchyUpdateOutcome> {
  if (requested.hierarchyRole === undefined && requested.parentBranchId === undefined) {
    return { kind: "unchanged" }
  }

  const [current] = await tx
    .select({
      organizationId: branches.organizationId,
      hierarchyRole: branches.hierarchyRole,
      parentBranchId: branches.parentBranchId,
    })
    .from(branches)
    .where(eq(branches.id, branchId))
    .limit(1)
    .for("update")
  if (!current) return { kind: "refused", refusal: { status: 409, message: HIERARCHY_CONFLICT_MESSAGE } }

  const plan = planBranchHierarchyChange(
    branchId,
    { hierarchyRole: normalizeBranchHierarchyRole(current.hierarchyRole), parentBranchId: current.parentBranchId },
    requested,
  )
  if (plan.kind === "unchanged") return plan
  if (plan.kind === "refused") return { kind: "refused", refusal: { status: 400, message: plan.message } }

  if (plan.demotesParent && await hasChildBranches(tx, branchId)) {
    return { kind: "refused", refusal: { status: 409, message: PARENT_HAS_CHILDREN_MESSAGE } }
  }
  if (plan.checksParent && plan.next.parentBranchId !== null) {
    const refusal = await parentBranchRefusal(tx, current.organizationId, plan.next.parentBranchId)
    if (refusal) return { kind: "refused", refusal }
  }
  return { kind: "change", next: plan.next }
}

const HIERARCHY_CONSTRAINTS = new Set([
  "branches_hierarchy_guard",
  "branches_hierarchy_parent_ck",
  "branches_hierarchy_role_ck",
  "branches_parent_org_fk",
])

/**
 * The database refused a hierarchy the route had already checked: a write
 * raced it. Mapped to 409 rather than a generic failure.
 */
export function isBranchHierarchyConstraintError(exception: unknown): boolean {
  const candidate = exception as { cause?: { code?: string; constraint?: string }; code?: string; constraint?: string } | null
  const databaseError = candidate?.cause ?? candidate
  const constraint = databaseError?.constraint ?? candidate?.constraint
  return typeof constraint === "string" && HIERARCHY_CONSTRAINTS.has(constraint)
}

/**
 * The parent's name, for a read whose FROM is the unaliased `branches` table;
 * same organization by `branches_parent_org_fk`. The outer column is named in
 * full on purpose: Drizzle leaves a single-table select's columns unqualified,
 * and inside this subquery a bare `parent_branch_id` would be the parent's own.
 */
export const parentBranchNameSql = sql<string | null>`(
  SELECT parent.name FROM branches AS parent
  WHERE parent.id = ${sql.identifier("branches")}.${sql.identifier("parent_branch_id")}
)`
