import "server-only"

import { and, asc, eq, inArray, isNull } from "drizzle-orm"

import { apricartExecutiveAssignments, organizations, roles, users } from "@/db/schema"
import { db } from "@/lib/db"
import {
  APRICART_EXECUTIVE_ASSIGNMENT_AUDIT_ACTION,
  APRICART_EXECUTIVE_ROLE,
} from "@/lib/apricart-executive-access"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"

/**
 * Super Admin's view of who approves Order Desk orders: every Apricart
 * Executive, and the organizations each one approves for.
 *
 * Any organization may be assigned. Approval reach does not depend on the
 * organization being managed or active (`resolveExecutiveApprovalReach`), so
 * the list offers every organization and marks which ones the desk works for.
 * See plans/OF-EXEC-APPROVAL-executive-approves-desk-orders.md.
 */

export type ExecutiveTeamMember = {
  id: string
  fullName: string | null
  username: string | null
  email: string
  isActive: boolean
  organizationIds: number[]
}

export type AssignableOrganization = {
  id: number
  name: string
  code: string | null
  status: string | null
  managedOrdering: boolean
}

export type ExecutiveTeam = {
  members: ExecutiveTeamMember[]
  organizations: AssignableOrganization[]
}

/** Bounded like every other list: a handful of directors, a few dozen tenants. */
const EXECUTIVE_TEAM_LIMIT = 200
const ORGANIZATION_LIMIT = 500

export async function loadExecutiveTeam(): Promise<ExecutiveTeam> {
  const memberRows = await db
    .select({
      id: users.id,
      fullName: users.fullName,
      username: users.username,
      email: users.email,
      isActive: users.isActive,
    })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(eq(roles.name, APRICART_EXECUTIVE_ROLE), isNull(users.deletedAt)))
    .orderBy(asc(users.fullName))
    .limit(EXECUTIVE_TEAM_LIMIT)

  const [assignmentRows, organizationRows] = await Promise.all([
    memberRows.length === 0
      ? []
      : db
        .select({ userId: apricartExecutiveAssignments.userId, organizationId: apricartExecutiveAssignments.organizationId })
        .from(apricartExecutiveAssignments)
        .where(inArray(apricartExecutiveAssignments.userId, memberRows.map((member) => member.id))),
    db
      .select({
        id: organizations.id,
        name: organizations.name,
        code: organizations.code,
        status: organizations.status,
        managedOrdering: organizations.managedOrdering,
      })
      .from(organizations)
      .orderBy(asc(organizations.name))
      .limit(ORGANIZATION_LIMIT),
  ])

  return {
    members: memberRows.map((member) => ({
      ...member,
      organizationIds: assignmentRows
        .filter((row) => row.userId === member.id)
        .map((row) => row.organizationId)
        .sort((a, b) => a - b),
    })),
    organizations: organizationRows,
  }
}

export type ExecutiveAssignmentOutcome =
  | { kind: "updated"; organizationIds: number[] }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }

/**
 * Replace the organizations one executive approves for, in one transaction,
 * audited with the before and after. The target must be an undeleted Apricart
 * Executive (otherwise "not found", so this cannot probe other accounts), and
 * every organization must exist.
 */
export async function replaceExecutiveAssignments(input: {
  userId: string
  organizationIds: number[]
  actor: AuditActor & { id: string }
}): Promise<ExecutiveAssignmentOutcome> {
  return db.transaction(async (tx) => {
    // Serializes two concurrent replacements for the same person.
    const [target] = await tx
      .select({ id: users.id, role: roles.name, deletedAt: users.deletedAt })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.id, input.userId))
      .for("update", { of: users })
      .limit(1)
    if (!target || target.role !== APRICART_EXECUTIVE_ROLE || target.deletedAt !== null) return { kind: "not-found" }

    const organizationIds = [...new Set(input.organizationIds)].sort((a, b) => a - b)
    if (organizationIds.length > 0) {
      const existing = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(inArray(organizations.id, organizationIds))
      if (existing.length !== organizationIds.length) {
        return { kind: "invalid", message: "One or more organizations do not exist" }
      }
    }

    const before = await tx
      .select({ organizationId: apricartExecutiveAssignments.organizationId })
      .from(apricartExecutiveAssignments)
      .where(eq(apricartExecutiveAssignments.userId, input.userId))

    // A decision in flight holds FOR SHARE on the row it relies on, so a
    // removal here waits for it to commit rather than racing past it.
    await tx.delete(apricartExecutiveAssignments).where(eq(apricartExecutiveAssignments.userId, input.userId))
    if (organizationIds.length > 0) {
      await tx.insert(apricartExecutiveAssignments).values(organizationIds.map((organizationId) => ({
        userId: input.userId,
        organizationId,
        createdByUserId: input.actor.id,
      })))
    }

    await recordAuditEvent(tx, {
      action: APRICART_EXECUTIVE_ASSIGNMENT_AUDIT_ACTION,
      entity: "user",
      entityId: input.userId,
      actor: input.actor,
      before: { organizationIds: before.map((row) => row.organizationId).sort((a, b) => a - b) },
      after: { organizationIds },
    })

    return { kind: "updated", organizationIds }
  })
}
