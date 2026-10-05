import "server-only"

import { and, asc, eq, inArray, isNull } from "drizzle-orm"

import { branches, orderDeskAssignments, organizations, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import { ORDER_DESK_ROLE } from "@/lib/order-desk-access"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"

/**
 * Super Admin's view of the Order Desk: who is on it, and which managed
 * organizations or branches each person may order for.
 *
 * Only an organization marked `managed_ordering` can be granted, and the
 * reach is re-checked against that flag on every desk request besides
 * (`lib/server/order-desk-scope.ts`), so switching the flag off withdraws the
 * desk at once without anyone having to edit these rows.
 */

export const ORDER_DESK_ASSIGNMENT_AUDIT_ACTION = "UPDATE_ORDER_DESK_ASSIGNMENTS"

export type DeskTeamMember = {
  id: string
  fullName: string | null
  username: string | null
  email: string
  isActive: boolean
  mustChangePassword: boolean
  organizationIds: number[]
  branchIds: number[]
}

export type ManagedOrganization = {
  id: number
  name: string
  code: string | null
  status: string | null
  branches: { id: number; name: string; status: string | null }[]
}

export type DeskTeam = {
  members: DeskTeamMember[]
  managedOrganizations: ManagedOrganization[]
}

/** Bounded like every other list: a desk is a handful of people. */
const DESK_TEAM_LIMIT = 200

export async function loadDeskTeam(): Promise<DeskTeam> {
  const memberRows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      username: users.username,
      email: users.email,
      isActive: users.isActive,
      mustChangePassword: users.mustChangePassword,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(roles.name, ORDER_DESK_ROLE), isNull(users.deletedAt)))
    .orderBy(asc(users.fullName))
    .limit(DESK_TEAM_LIMIT)

  const assignmentRows = memberRows.length === 0
    ? []
    : await db
      .select({
        userId: orderDeskAssignments.userId,
        organizationId: orderDeskAssignments.organizationId,
        branchId: orderDeskAssignments.branchId,
      })
      .from(orderDeskAssignments)
      .where(inArray(orderDeskAssignments.userId, memberRows.map((member) => member.id)))

  const organizationRows = await db
    .select({ id: organizations.id, name: organizations.name, code: organizations.code, status: organizations.status })
    .from(organizations)
    .where(eq(organizations.managedOrdering, true))
    .orderBy(asc(organizations.name))

  const branchRows = organizationRows.length === 0
    ? []
    : await db
      .select({ id: branches.id, name: branches.name, status: branches.status, organizationId: branches.organizationId })
      .from(branches)
      .where(inArray(branches.organizationId, organizationRows.map((organization) => organization.id)))
      .orderBy(asc(branches.name))

  return {
    members: memberRows.map((member) => {
      const own = assignmentRows.filter((row) => row.userId === member.id)
      return {
        ...member,
        organizationIds: own.filter((row) => row.branchId === null).map((row) => row.organizationId),
        branchIds: own.flatMap((row) => (row.branchId === null ? [] : [row.branchId])),
      }
    }),
    managedOrganizations: organizationRows.map((organization) => ({
      ...organization,
      branches: branchRows
        .filter((branch) => branch.organizationId === organization.id)
        .map(({ id, name, status }) => ({ id, name, status })),
    })),
  }
}

export type DeskAssignmentOutcome =
  | { kind: "updated"; organizationIds: number[]; branchIds: number[] }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }

/**
 * Replace one desk user's whole reach. Every organization must be managed,
 * and every branch must belong to a managed organization. A branch of an
 * organization granted whole is redundant and dropped rather than stored twice.
 */
export async function replaceDeskAssignments(input: {
  userId: string
  organizationIds: number[]
  branchIds: number[]
  actor: AuditActor & { id: string }
}): Promise<DeskAssignmentOutcome> {
  return db.transaction(async (tx) => {
    // Serializes two concurrent replacements for the same person.
    const [target] = await tx
      .select({ id: users.id, role: roles.name, deletedAt: users.deletedAt })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.id, input.userId))
      .for("update", { of: users })
      .limit(1)
    if (!target || target.role !== ORDER_DESK_ROLE || target.deletedAt !== null) return { kind: "not-found" }

    const organizationIds = [...new Set(input.organizationIds)]
    if (organizationIds.length > 0) {
      const managed = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(and(inArray(organizations.id, organizationIds), eq(organizations.managedOrdering, true)))
      if (managed.length !== organizationIds.length) {
        return { kind: "invalid", message: "Only organizations marked as managed by the Order Desk can be assigned" }
      }
    }

    const requestedBranchIds = [...new Set(input.branchIds)]
    let branchRows: { id: number; organizationId: number | null }[] = []
    if (requestedBranchIds.length > 0) {
      branchRows = await tx
        .select({ id: branches.id, organizationId: branches.organizationId })
        .from(branches)
        .innerJoin(organizations, eq(organizations.id, branches.organizationId))
        .where(and(inArray(branches.id, requestedBranchIds), eq(organizations.managedOrdering, true)))
      if (branchRows.length !== requestedBranchIds.length) {
        return { kind: "invalid", message: "Only branches of organizations managed by the Order Desk can be assigned" }
      }
    }
    const wholeOrganizations = new Set(organizationIds)
    const singleBranches = branchRows.filter((row) => row.organizationId !== null && !wholeOrganizations.has(row.organizationId))

    const before = await tx
      .select({ organizationId: orderDeskAssignments.organizationId, branchId: orderDeskAssignments.branchId })
      .from(orderDeskAssignments)
      .where(eq(orderDeskAssignments.userId, input.userId))

    await tx.delete(orderDeskAssignments).where(eq(orderDeskAssignments.userId, input.userId))
    const rows = [
      ...organizationIds.map((organizationId) => ({ organizationId, branchId: null as number | null })),
      ...singleBranches.map((row) => ({ organizationId: row.organizationId as number, branchId: row.id as number | null })),
    ]
    if (rows.length > 0) {
      await tx.insert(orderDeskAssignments).values(rows.map((row) => ({
        ...row,
        userId: input.userId,
        createdByUserId: input.actor.id,
      })))
    }

    await recordAuditEvent(tx, {
      action: ORDER_DESK_ASSIGNMENT_AUDIT_ACTION,
      entity: "user",
      entityId: input.userId,
      actor: input.actor,
      before: { assignments: before },
      after: { assignments: rows },
    })

    return {
      kind: "updated",
      organizationIds,
      branchIds: singleBranches.map((row) => row.id),
    }
  })
}
