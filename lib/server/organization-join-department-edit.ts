import "server-only"

import { and, eq, inArray, ne, sql } from "drizzle-orm"

import {
  branches,
  organizationJoinRequestAddresses,
  organizationJoinRequestApprovers,
  organizationJoinRequestBranches,
  organizationJoinRequests,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  type JoinEditPersonField,
  changedApproverLevels,
  changedPersonFields,
  planAddressEdit,
  planRequestBranchEdit,
} from "@/lib/join-department-edit"
import {
  DEPARTMENT_SIGNUP_FORM_VERSION,
  type RequestedBranchEntry,
  type RequestedNewBranch,
  type SignupApprover,
  approverListError,
  initiatorRoleForBranchCount,
  requestedNewBranches,
} from "@/lib/join-department-signup"
import { joinEmailDomainRefusal } from "@/lib/organization-join"
import { organizationUsername } from "@/lib/username-prefix"
import { assertUniqueUserFields } from "@/lib/user-uniqueness"
import { usernameExists } from "@/lib/user-username-uniqueness"
import { normalizeJoinSubmissionIdentity } from "@/lib/server/organization-join"
import {
  type JoinFailure,
  loadDepartmentJoinSettings,
  loadRequestChildren,
} from "@/lib/server/organization-join-department"

/**
 * Head Office correcting a pending department sign-up before deciding it
 * (plans/OF-JOIN-department-signup-multi-user.md, "Editing at review").
 *
 * The edited request is held to every rule the applicant's submission was —
 * the organization's email domain, the phone and extension patterns, one
 * distinct approver per level who is not the initiator, branches of this
 * organization only — and to the account rules the approval will apply, so a
 * correction that the approval would refuse is refused now. Nothing exists
 * outside the request until the approval: an edit writes only the request and
 * its own child rows, in one transaction, under the request's `FOR UPDATE`
 * lock (the lock the approval takes first), so an edit and an approval cannot
 * interleave.
 *
 * The password and the acceptance of the terms are not editable: they are the
 * applicant's alone.
 */

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type DepartmentJoinUpdate = {
  firstName: string
  lastName: string
  email: string
  username: string
  phone: string
  ipExtension: string
  employeeId: string
  department: string
  branches: RequestedBranchEntry[]
  addresses: string[]
  approvers: SignupApprover[]
}

export type DepartmentJoinUpdateOutcome =
  | {
      ok: true
      changedFields: JoinEditPersonField[]
      changedApproverLevels: number[]
      branchesChanged: boolean
      addressesChanged: boolean
    }
  | JoinFailure

/** Thrown inside the edit to roll it back with an answer. */
class JoinEditAbort extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

async function lockPendingDepartmentRequest(tx: TransactionExecutor, requestId: number, organizationId: number) {
  const [stored] = await tx
    .select({
      id: organizationJoinRequests.id,
      status: organizationJoinRequests.status,
      firstName: organizationJoinRequests.firstName,
      lastName: organizationJoinRequests.lastName,
      email: organizationJoinRequests.email,
      username: organizationJoinRequests.username,
      phone: organizationJoinRequests.phone,
      employeeId: organizationJoinRequests.employeeId,
      department: organizationJoinRequests.department,
      ipExtension: organizationJoinRequests.ipExtension,
    })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.id, requestId),
      eq(organizationJoinRequests.organizationId, organizationId),
      eq(organizationJoinRequests.formVersion, DEPARTMENT_SIGNUP_FORM_VERSION),
    ))
    .for("update")
    .limit(1)
  if (!stored) throw new JoinEditAbort(404, "Join request not found")
  if (stored.status !== "pending") throw new JoinEditAbort(409, `This request has already been ${stored.status}.`)
  return stored
}

/**
 * The changed identity fields, held to what the approval will require: no
 * account anywhere already holds them, and no other pending request of this
 * organization asks for the same email or username. Only a changed field is
 * checked, so correcting one field never fails on another nobody touched.
 */
async function assertEditedIdentityFree(
  tx: TransactionExecutor,
  input: { requestId: number; organizationId: number },
  next: { email: string; username: string; phone: string | null; employeeId: string | null },
  changed: ReadonlySet<JoinEditPersonField>,
): Promise<void> {
  if (changed.has("username") && await usernameExists(next.username)) {
    throw new JoinEditAbort(409, `The username ${next.username} is already in use. Choose another.`)
  }
  try {
    await assertUniqueUserFields({
      email: changed.has("email") ? next.email : null,
      phone: changed.has("phone") ? next.phone : null,
      employeeId: changed.has("employeeId") ? next.employeeId : null,
    })
  } catch (uniqueError: any) {
    throw new JoinEditAbort(409, uniqueError?.message ?? "These details are already registered to an account.")
  }

  if (!changed.has("email") && !changed.has("username")) return
  const [other] = await tx
    .select({ id: organizationJoinRequests.id })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.organizationId, input.organizationId),
      eq(organizationJoinRequests.status, "pending"),
      ne(organizationJoinRequests.id, input.requestId),
      sql`(${organizationJoinRequests.email} = ${next.email} OR ${organizationJoinRequests.username} = ${next.username})`,
    ))
    .limit(1)
  if (other) throw new JoinEditAbort(409, "Another pending request already uses this email or username.")
}

/** The edited branches as existing branch ids and branches still to create, all of this organization. */
async function resolveEditedBranches(
  tx: TransactionExecutor,
  organizationId: number,
  edited: DepartmentJoinUpdate["branches"],
): Promise<{ existingIds: number[]; newBranches: RequestedNewBranch[] }> {
  const pickedIds = [...new Set(edited.flatMap((entry) => ("branchId" in entry ? [entry.branchId] : [])))]

  if (pickedIds.length > 0) {
    const found = await tx
      .select({ id: branches.id })
      .from(branches)
      .where(and(
        eq(branches.organizationId, organizationId),
        eq(branches.status, "active"),
        inArray(branches.id, pickedIds),
      ))
    if (found.length !== pickedIds.length) {
      throw new JoinEditAbort(400, "A branch you chose is not available in your organization.")
    }
  }

  // As at submission: a typed CRC stays a branch to create, even when an
  // existing branch carries it; the review asks which (plans/OF-JOIN-crc-match-at-review.md).
  return { existingIds: pickedIds, newBranches: requestedNewBranches(edited) }
}

async function writeBranchEdit(
  tx: TransactionExecutor,
  requestId: number,
  organizationId: number,
  current: Array<{ id: number; existingBranchId: number | null; costCenterId: string | null; requestedBranchName: string | null }>,
  next: { existingIds: number[]; newBranches: RequestedNewBranch[] },
): Promise<boolean> {
  const plan = planRequestBranchEdit(current, next)
  if (plan.deleteIds.length > 0) {
    await tx.delete(organizationJoinRequestBranches).where(and(
      eq(organizationJoinRequestBranches.requestId, requestId),
      inArray(organizationJoinRequestBranches.id, plan.deleteIds),
    ))
  }
  const inserts = [
    ...plan.insertExistingIds.map((existingBranchId) => ({ requestId, organizationId, existingBranchId })),
    ...plan.insertNewBranches.map((entry) => ({
      requestId,
      organizationId,
      costCenterId: entry.crc,
      requestedBranchName: entry.name,
    })),
  ]
  if (inserts.length > 0) await tx.insert(organizationJoinRequestBranches).values(inserts)
  for (const rename of plan.renames) {
    await tx
      .update(organizationJoinRequestBranches)
      .set({ requestedBranchName: rename.name })
      .where(and(
        eq(organizationJoinRequestBranches.requestId, requestId),
        eq(organizationJoinRequestBranches.id, rename.id),
      ))
  }
  return plan.deleteIds.length > 0 || inserts.length > 0 || plan.renames.length > 0
}

async function writeAddressEdit(
  tx: TransactionExecutor,
  requestId: number,
  organizationId: number,
  current: Array<{ id: number; address: string }>,
  next: string[],
): Promise<boolean> {
  const plan = planAddressEdit(current, next)
  if (plan.deleteIds.length > 0) {
    await tx.delete(organizationJoinRequestAddresses).where(and(
      eq(organizationJoinRequestAddresses.requestId, requestId),
      inArray(organizationJoinRequestAddresses.id, plan.deleteIds),
    ))
  }
  if (plan.insertAddresses.length > 0) {
    await tx.insert(organizationJoinRequestAddresses).values(
      plan.insertAddresses.map((address) => ({ requestId, organizationId, address })),
    )
  }
  return plan.deleteIds.length > 0 || plan.insertAddresses.length > 0
}

/**
 * The changed levels' rows are replaced rather than updated in place, so two
 * levels may swap approvers without tripping the one-email-per-request index.
 */
async function writeApproverEdit(
  tx: TransactionExecutor,
  requestId: number,
  organizationId: number,
  current: Array<{ level: number; email: string; designation: string }>,
  next: SignupApprover[],
): Promise<number[]> {
  const levels = changedApproverLevels(current, next)
  if (levels.length === 0) return levels
  await tx.delete(organizationJoinRequestApprovers).where(and(
    eq(organizationJoinRequestApprovers.requestId, requestId),
    inArray(organizationJoinRequestApprovers.level, levels),
  ))
  await tx.insert(organizationJoinRequestApprovers).values(next
    .filter((approver) => levels.includes(approver.level))
    .map((approver) => ({
      requestId,
      organizationId,
      level: approver.level,
      email: approver.email.trim().toLowerCase(),
      designation: approver.designation.trim(),
    })))
  return levels
}

/**
 * Replace a pending department sign-up's details with Head Office's edit.
 * Head Office of `organizationId` only; another tenant's request, or a
 * standard one, is not found.
 */
export async function updateDepartmentJoinRequest(input: {
  requestId: number
  organizationId: number
  update: DepartmentJoinUpdate
}): Promise<DepartmentJoinUpdateOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const stored = await lockPendingDepartmentRequest(tx, input.requestId, input.organizationId)
      const settings = await loadDepartmentJoinSettings(tx, input.organizationId)
      if (!settings) throw new JoinEditAbort(404, "Organization not found")

      const identity = normalizeJoinSubmissionIdentity({
        email: input.update.email,
        // An edited username keeps the organization's prefix.
        username: organizationUsername(settings.name, input.update.username),
        phone: input.update.phone,
        employeeId: input.update.employeeId,
      })
      const domainRefusal = joinEmailDomainRefusal(identity.email, settings.emailDomain)
      if (domainRefusal) throw new JoinEditAbort(domainRefusal.status, domainRefusal.message)

      const children = await loadRequestChildren(tx, stored.id)
      const approverRefusal = approverListError({
        initiatorEmail: identity.email,
        approvers: input.update.approvers,
        // The levels the request was made against; the review shows a level
        // the organization has since added or removed.
        levelCount: children.approvers.length,
        emailDomain: settings.emailDomain as string,
      })
      if (approverRefusal) throw new JoinEditAbort(400, approverRefusal)

      const nextPerson = {
        firstName: input.update.firstName.trim(),
        lastName: input.update.lastName.trim(),
        email: identity.email,
        username: identity.username,
        phone: identity.phone,
        ipExtension: input.update.ipExtension.trim(),
        employeeId: identity.employeeId,
        department: input.update.department,
      }
      const changedFields = changedPersonFields(stored, nextPerson)
      await assertEditedIdentityFree(tx, input, nextPerson, new Set(changedFields))

      const nextBranches = await resolveEditedBranches(tx, input.organizationId, input.update.branches)
      const branchCount = nextBranches.existingIds.length + nextBranches.newBranches.length
      const role = initiatorRoleForBranchCount(branchCount)

      const branchesChanged = await writeBranchEdit(tx, stored.id, input.organizationId, children.requestBranches, nextBranches)
      const addressesChanged = await writeAddressEdit(tx, stored.id, input.organizationId, children.addresses, input.update.addresses)
      const approverLevels = await writeApproverEdit(tx, stored.id, input.organizationId, children.approvers, input.update.approvers)

      await tx
        .update(organizationJoinRequests)
        .set({
          ...nextPerson,
          requestedRole: role,
          requestedBranchId: role === "ORDER_PORTAL" && nextBranches.existingIds.length === 1 ? nextBranches.existingIds[0] : null,
          requestedBranchIds: nextBranches.existingIds,
          updatedAt: new Date(),
        })
        .where(eq(organizationJoinRequests.id, stored.id))

      return {
        ok: true as const,
        changedFields,
        changedApproverLevels: approverLevels,
        branchesChanged,
        addressesChanged,
      }
    })
  } catch (caughtError: any) {
    if (caughtError instanceof JoinEditAbort) {
      return { ok: false, message: caughtError.message, status: caughtError.status }
    }
    // The pending email/username indexes decide a race with a new submission.
    const code = String(caughtError?.code ?? caughtError?.cause?.code ?? "")
    if (code === "23505") {
      return { ok: false, message: "Another pending request already uses this email or username.", status: 409 }
    }
    throw caughtError
  }
}
