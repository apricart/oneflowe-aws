import "server-only"

import { and, asc, eq, inArray, sql } from "drizzle-orm"

import {
  branchDeliveryAddresses,
  branches,
  organizationJoinRequestAddresses,
  organizationJoinRequestApprovers,
  organizationJoinRequestBranches,
  organizationJoinRequests,
  organizations,
  roles as rolesTable,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  deliveryAddressLabelKey,
  normalizeDeliveryAddressLabel,
} from "@/lib/delivery-address"
import {
  type ApproverCandidate,
  type ApproverResolution,
  type ApproverResolutionKind,
  RECORDED_RESOLUTION,
  planApproverResolution,
  sameResolution,
} from "@/lib/join-approver-resolution"
import {
  DEPARTMENT_SIGNUP_FORM_VERSION,
  type InitiatorRole,
  type SignupApprover,
  approverListError,
  deriveNameFromEmail,
  deriveUsernameFromEmail,
  initiatorRoleForBranchCount,
  joinUsesApprovalLevels,
  normalizeCrc,
} from "@/lib/join-department-signup"
import {
  type ApprovalLevel,
  type ApprovalLevelBand,
  approvalLevelBands,
} from "@/lib/order-approval-levels"
import { generateRandomPassword, hashPassword } from "@/lib/password"
import { assertUniqueUserFields, normalizeEmail } from "@/lib/user-uniqueness"
import { usernameExists } from "@/lib/user-username-uniqueness"
import { createBranchInTx } from "@/lib/server/branch-creation"
import {
  addBranchesToScope,
  replaceMultiBranchScope,
  resolveScopedBranchIds,
} from "@/lib/server/multi-branch-scope"
import {
  MAX_PENDING_REQUESTS_PER_ORGANIZATION,
  identityConflictReason,
  type JoinRequestFailure,
} from "@/lib/server/organization-join"
import { loadOrganizationApprovalLevels } from "@/lib/server/order-approval-levels"
import { loadApprovalLevelContext, writeApprovalLevelInTx } from "@/lib/server/user-approval-level"

/**
 * The department sign-up: the join form of an organization with order approval
 * levels on (plans/OF-JOIN-department-signup-multi-user.md).
 *
 * One request names a person (the order initiator), their branches (existing
 * ones, or CRC numbers to create), their delivery addresses, and one financial
 * approver per level. Nothing exists until Head Office approves, and the
 * approval creates the whole package in one transaction or nothing.
 *
 * The same two tenant rules as the standard join hold here: the organization
 * comes from the code (public paths) or the Head Office session (managed
 * paths), never from a request; and every branch id is re-checked against it
 * when stored and again inside the approval.
 */

type Executor = Pick<typeof db, "select">
type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

/* ── The organization's settings ─────────────────────────────────────────── */

export type DepartmentJoinSettings = {
  orderApprovalRequired: boolean
  orderApprovalLevelsEnabled: boolean
  orderApproverRole: string | null
  emailDomain: string | null
  levels: ApprovalLevel[]
}

export async function loadDepartmentJoinSettings(
  executor: Executor,
  organizationId: number,
): Promise<DepartmentJoinSettings | null> {
  const [organization] = await executor
    .select({
      orderApprovalRequired: organizations.orderApprovalRequired,
      orderApprovalLevelsEnabled: organizations.orderApprovalLevelsEnabled,
      orderApproverRole: organizations.orderApproverRole,
      emailDomain: organizations.emailDomain,
    })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  if (!organization) return null
  return { ...organization, levels: await loadOrganizationApprovalLevels(executor, organizationId) }
}

/** Whether this organization's join page is the department sign-up. */
export function usesDepartmentSignup(settings: DepartmentJoinSettings): boolean {
  return joinUsesApprovalLevels({
    orderApprovalRequired: settings.orderApprovalRequired,
    orderApprovalLevelsEnabled: settings.orderApprovalLevelsEnabled,
    levelCount: settings.levels.length,
  })
}

export function departmentSignupBands(settings: DepartmentJoinSettings): ApprovalLevelBand[] {
  return approvalLevelBands(settings.levels.map((level) => level.maxAmountCents))
}

/* ── Submitting ──────────────────────────────────────────────────────────── */

export type DepartmentJoinSubmission = {
  organizationId: number
  firstName: string
  lastName: string
  email: string
  username: string
  passwordHash: string
  phone: string
  employeeId: string
  ipExtension: string
  department: string
  branches: Array<{ branchId: number } | { crc: string }>
  addresses: string[]
  approvers: SignupApprover[]
  approvalLevelsSnapshot: ApprovalLevelBand[]
  submittedIp: string | null
  submittedUserAgent: string | null
}

/**
 * The typed CRCs that belong to exactly one active branch of the organization,
 * as that branch. A CRC shared by several branches stays a CRC, for Head Office
 * to map at review.
 */
async function matchCrcsToBranches(organizationId: number, crcs: string[]): Promise<Map<string, number>> {
  const matched = new Map<string, number>()
  if (crcs.length === 0) return matched
  const rows = await db
    .select({ id: branches.id, crc: sql<string>`upper(btrim(${branches.costCenterId}))` })
    .from(branches)
    .where(and(
      eq(branches.organizationId, organizationId),
      eq(branches.status, "active"),
      inArray(sql`upper(btrim(${branches.costCenterId}))`, crcs),
    ))
  const byCrc = new Map<string, number[]>()
  for (const row of rows) byCrc.set(row.crc, [...(byCrc.get(row.crc) ?? []), row.id])
  for (const [crc, ids] of byCrc) if (ids.length === 1) matched.set(crc, ids[0])
  return matched
}

/**
 * Store a department sign-up. Approver emails are **never looked up** here:
 * the answer to a public caller must not reveal whether a colleague has an
 * account. Head Office sees who they are at review.
 *
 * A typed CRC that belongs to exactly one active branch of the organization is
 * stored as that branch; the CRC itself never leaves the server, and the
 * caller's answer is the same either way.
 */
export async function createDepartmentJoinRequest(
  submission: DepartmentJoinSubmission,
): Promise<{ id: number } | JoinRequestFailure> {
  const { organizationId } = submission

  const pickedIds = [...new Set(submission.branches.flatMap((entry) => ("branchId" in entry ? [entry.branchId] : [])))]
  const typedCrcs = [...new Set(submission.branches.flatMap((entry) => ("crc" in entry ? [normalizeCrc(entry.crc)] : [])))]

  if (pickedIds.length > 0) {
    const found = await db
      .select({ id: branches.id })
      .from(branches)
      .where(and(
        eq(branches.organizationId, organizationId),
        eq(branches.status, "active"),
        inArray(branches.id, pickedIds),
      ))
    if (found.length !== pickedIds.length) {
      return { kind: "scope", message: "A branch you chose is not available in this organization", status: 400 }
    }
  }

  const matchedByCrc = await matchCrcsToBranches(organizationId, typedCrcs)
  const existingIds = [...new Set([...pickedIds, ...matchedByCrc.values()])]
  const newCrcs = typedCrcs.filter((crc) => !matchedByCrc.has(crc))
  const branchCount = existingIds.length + newCrcs.length
  const role = initiatorRoleForBranchCount(branchCount)

  const [{ pendingCount }] = await db
    .select({ pendingCount: sql<number>`count(*)::int` })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.organizationId, organizationId),
      eq(organizationJoinRequests.status, "pending"),
    ))
  if (pendingCount >= MAX_PENDING_REQUESTS_PER_ORGANIZATION) {
    return {
      kind: "limit",
      message: "This organization already has the maximum number of requests waiting. Contact its head office.",
      status: 409,
    }
  }

  if (await identityConflictReason({
    organizationId,
    email: submission.email,
    username: submission.username,
    phone: submission.phone,
    employeeId: submission.employeeId,
  })) {
    return { kind: "identity", message: "identity conflict", status: 409 }
  }

  try {
    return await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(organizationJoinRequests)
        .values({
          organizationId,
          formVersion: DEPARTMENT_SIGNUP_FORM_VERSION,
          requestedRole: role,
          requestedBranchId: role === "ORDER_PORTAL" && existingIds.length === 1 ? existingIds[0] : null,
          requestedGroupIds: [],
          requestedBranchIds: existingIds,
          firstName: submission.firstName,
          lastName: submission.lastName,
          email: submission.email,
          username: submission.username,
          phone: submission.phone,
          employeeId: submission.employeeId,
          department: submission.department,
          ipExtension: submission.ipExtension,
          termsAcceptedAt: new Date(),
          approvalLevelsSnapshot: submission.approvalLevelsSnapshot,
          passwordHash: submission.passwordHash,
          submittedIp: submission.submittedIp,
          submittedUserAgent: submission.submittedUserAgent,
        })
        .returning({ id: organizationJoinRequests.id })

      await tx.insert(organizationJoinRequestBranches).values([
        ...existingIds.map((existingBranchId) => ({ requestId: created.id, organizationId, existingBranchId })),
        ...newCrcs.map((costCenterId) => ({ requestId: created.id, organizationId, costCenterId })),
      ])
      await tx.insert(organizationJoinRequestApprovers).values(submission.approvers.map((approver) => ({
        requestId: created.id,
        organizationId,
        level: approver.level,
        email: normalizeEmail(approver.email),
        designation: approver.designation.trim(),
      })))
      await tx.insert(organizationJoinRequestAddresses).values(submission.addresses.map((address) => ({
        requestId: created.id,
        organizationId,
        address: address.trim(),
      })))
      return { id: created.id }
    })
  } catch (caughtError: any) {
    // The partial unique indexes on a pending email/username decide a race
    // between two simultaneous submissions, as on the standard form.
    const code = String(caughtError?.code ?? caughtError?.cause?.code ?? "")
    if (code === "23505") return { kind: "identity", message: "identity conflict", status: 409 }
    throw caughtError
  }
}

/* ── Reading a request back ──────────────────────────────────────────────── */

type StoredRequestBranch = {
  id: number
  existingBranchId: number | null
  costCenterId: string | null
  resolvedBranchId: number | null
}

type StoredApprover = {
  id: number
  level: number
  email: string
  designation: string
  resolution: string | null
  approverUserId: string | null
}

type StoredAddress = { id: number; address: string; branchId: number | null }

async function loadRequestChildren(executor: Executor, requestId: number) {
  const [requestBranches, approvers, addresses] = await Promise.all([
    executor
      .select({
        id: organizationJoinRequestBranches.id,
        existingBranchId: organizationJoinRequestBranches.existingBranchId,
        costCenterId: organizationJoinRequestBranches.costCenterId,
        resolvedBranchId: organizationJoinRequestBranches.resolvedBranchId,
      })
      .from(organizationJoinRequestBranches)
      .where(eq(organizationJoinRequestBranches.requestId, requestId))
      .orderBy(asc(organizationJoinRequestBranches.id)),
    executor
      .select({
        id: organizationJoinRequestApprovers.id,
        level: organizationJoinRequestApprovers.level,
        email: organizationJoinRequestApprovers.email,
        designation: organizationJoinRequestApprovers.designation,
        resolution: organizationJoinRequestApprovers.resolution,
        approverUserId: organizationJoinRequestApprovers.approverUserId,
      })
      .from(organizationJoinRequestApprovers)
      .where(eq(organizationJoinRequestApprovers.requestId, requestId))
      .orderBy(asc(organizationJoinRequestApprovers.level)),
    executor
      .select({
        id: organizationJoinRequestAddresses.id,
        address: organizationJoinRequestAddresses.address,
        branchId: organizationJoinRequestAddresses.branchId,
      })
      .from(organizationJoinRequestAddresses)
      .where(eq(organizationJoinRequestAddresses.requestId, requestId))
      .orderBy(asc(organizationJoinRequestAddresses.id)),
  ])
  return {
    requestBranches: requestBranches as StoredRequestBranch[],
    approvers: approvers as StoredApprover[],
    addresses: addresses as StoredAddress[],
  }
}

/**
 * Every non-deleted account at each email, in any organization — an address in
 * another tenant is a reason to refuse, so it has to be seen. `lock` takes the
 * rows `FOR UPDATE`, in id order, inside the approval.
 */
async function loadApproverCandidates(
  executor: Executor | TransactionExecutor,
  emails: string[],
  lock: boolean,
): Promise<Map<string, ApproverCandidate[]>> {
  const result = new Map<string, ApproverCandidate[]>(emails.map((email) => [email, []]))
  if (emails.length === 0) return result

  const query = executor
    .select({
      userId: users.id,
      email: sql<string>`lower(${users.email})`,
      organizationId: users.organizationId,
      role: rolesTable.name,
      isActive: users.isActive,
      level: users.orderApprovalLevel,
      branchId: users.branchId,
    })
    .from(users)
    .innerJoin(rolesTable, eq(users.roleId, rolesTable.id))
    .where(and(
      inArray(sql`lower(${users.email})`, emails),
      sql`${users.deletedAt} IS NULL`,
    ))
    .orderBy(asc(users.id))
  const rows = lock ? await query.for("update", { of: users }) : await query

  for (const row of rows) {
    const scopedBranchIds = row.role === "GROUP_USER" || row.role === "GROUP_ORDER_PORTAL"
      ? await resolveScopedBranchIds(executor as TransactionExecutor, row.userId)
      : []
    result.get(row.email)?.push({
      userId: row.userId,
      organizationId: row.organizationId,
      role: row.role,
      isActive: row.isActive,
      level: row.level,
      branchId: row.branchId,
      scopedBranchIds,
    })
  }
  return result
}

/* ── Head Office's review ────────────────────────────────────────────────── */

export type DepartmentJoinReview = {
  id: number
  status: string
  person: {
    firstName: string
    lastName: string
    email: string
    username: string
    usernameTaken: boolean
    phone: string | null
    employeeId: string | null
    department: string | null
    ipExtension: string | null
  }
  /** What the initiator will be, from the branches as they stand now. */
  initiatorRole: InitiatorRole
  branches: Array<{
    requestBranchId: number
    kind: "existing" | "new"
    branchId: number | null
    name: string | null
    costCenterId: string | null
  }>
  addresses: Array<{ requestAddressId: number; address: string; branchId: number | null }>
  approvers: Array<{
    level: number
    email: string
    designation: string
    band: ApprovalLevelBand | null
    resolution: ApproverResolution
    /** Who the existing account is, when there is one in this organization. */
    existingName: string | null
    /** The recorded outcome, once decided. */
    recordedResolution: string | null
  }>
  /** The organization's current switch, for the D7 notice. */
  approvalLevelsApply: boolean
  decisionReason: string | null
  decidedAt: Date | null
  createdAt: Date
}

/**
 * One department sign-up with the preview of what approving it would do.
 * Head Office of `organizationId` only; anything else reads as not found. The
 * password hash, IP and user agent are never selected.
 */
export async function loadDepartmentJoinReview(input: {
  requestId: number
  organizationId: number
  deciderUserId: string
}): Promise<DepartmentJoinReview | null> {
  const [stored] = await db
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
      decisionReason: organizationJoinRequests.decisionReason,
      decidedAt: organizationJoinRequests.decidedAt,
      createdAt: organizationJoinRequests.createdAt,
    })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.id, input.requestId),
      eq(organizationJoinRequests.organizationId, input.organizationId),
      eq(organizationJoinRequests.formVersion, DEPARTMENT_SIGNUP_FORM_VERSION),
    ))
    .limit(1)
  if (!stored) return null

  const settings = await loadDepartmentJoinSettings(db, input.organizationId)
  if (!settings) return null
  const children = await loadRequestChildren(db, stored.id)

  const branchIds = children.requestBranches.flatMap((row) => [row.existingBranchId, row.resolvedBranchId])
    .filter((id): id is number => id !== null)
  const branchNames = new Map<number, string>()
  if (branchIds.length > 0) {
    const rows = await db
      .select({ id: branches.id, name: branches.name })
      .from(branches)
      .where(and(eq(branches.organizationId, input.organizationId), inArray(branches.id, branchIds)))
    for (const row of rows) branchNames.set(row.id, row.name)
  }

  const existingBranchIds = children.requestBranches
    .map((row) => row.existingBranchId ?? row.resolvedBranchId)
    .filter((id): id is number => id !== null)
  const newBranchCount = children.requestBranches.filter((row) => row.existingBranchId === null && row.resolvedBranchId === null).length

  const emails = children.approvers.map((approver) => approver.email)
  const candidates = await loadApproverCandidates(db, emails, false)
  const nameRows = emails.length === 0 ? [] : await db
    .select({ email: sql<string>`lower(${users.email})`, firstName: users.firstName, lastName: users.lastName })
    .from(users)
    .where(and(
      eq(users.organizationId, input.organizationId),
      inArray(sql`lower(${users.email})`, emails),
      sql`${users.deletedAt} IS NULL`,
    ))
  const names = new Map(nameRows.map((row) => [row.email, `${row.firstName ?? ""} ${row.lastName ?? ""}`.trim() || null]))

  const organization = {
    orderApprovalRequired: settings.orderApprovalRequired,
    orderApprovalLevelsEnabled: settings.orderApprovalLevelsEnabled,
    orderApproverRole: settings.orderApproverRole,
    levelCount: settings.levels.length,
  }
  const bands = departmentSignupBands(settings)

  return {
    id: stored.id,
    status: stored.status,
    person: {
      firstName: stored.firstName,
      lastName: stored.lastName,
      email: stored.email,
      username: stored.username,
      usernameTaken: stored.status === "pending" ? await usernameExists(stored.username) : false,
      phone: stored.phone,
      employeeId: stored.employeeId,
      department: stored.department,
      ipExtension: stored.ipExtension,
    },
    initiatorRole: initiatorRoleForBranchCount(children.requestBranches.length),
    branches: children.requestBranches.map((row) => {
      const branchId = row.existingBranchId ?? row.resolvedBranchId
      return {
        requestBranchId: row.id,
        kind: row.existingBranchId === null ? "new" as const : "existing" as const,
        branchId,
        name: branchId === null ? null : branchNames.get(branchId) ?? null,
        costCenterId: row.costCenterId,
      }
    }),
    addresses: children.addresses.map((row) => ({
      requestAddressId: row.id,
      address: row.address,
      branchId: row.branchId,
    })),
    approvers: children.approvers.map((approver) => ({
      level: approver.level,
      email: approver.email,
      designation: approver.designation,
      band: bands[approver.level - 1] ?? null,
      resolution: planApproverResolution({
        level: approver.level,
        organizationId: input.organizationId,
        organization,
        candidates: candidates.get(approver.email) ?? [],
        initiatorBranchIds: existingBranchIds,
        newBranchCount,
        deciderUserId: input.deciderUserId,
      }),
      existingName: names.get(approver.email) ?? null,
      recordedResolution: approver.resolution,
    })),
    approvalLevelsApply: usesDepartmentSignup(settings),
    decisionReason: stored.decisionReason,
    decidedAt: stored.decidedAt,
    createdAt: stored.createdAt,
  }
}

/** The form version of a request in this organization, or null if there is none. */
export async function readJoinRequestFormVersion(requestId: number, organizationId: number): Promise<number | null> {
  const [row] = await db
    .select({ formVersion: organizationJoinRequests.formVersion })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.id, requestId),
      eq(organizationJoinRequests.organizationId, organizationId),
    ))
    .limit(1)
  return row?.formVersion ?? null
}

/* ── Replacing one approver before deciding ──────────────────────────────── */

export type JoinFailure = { ok: false; message: string; status: number }

/**
 * Head Office naming a different approver for one level of a pending request,
 * held to the same rules as the applicant: the organization's domain, a
 * different person per level, never the initiator.
 */
export async function replaceDepartmentJoinApprover(input: {
  requestId: number
  organizationId: number
  approver: SignupApprover
}): Promise<{ ok: true; previousEmail: string } | JoinFailure> {
  return db.transaction(async (tx) => {
    const [stored] = await tx
      .select({ id: organizationJoinRequests.id, status: organizationJoinRequests.status, email: organizationJoinRequests.email })
      .from(organizationJoinRequests)
      .where(and(
        eq(organizationJoinRequests.id, input.requestId),
        eq(organizationJoinRequests.organizationId, input.organizationId),
        eq(organizationJoinRequests.formVersion, DEPARTMENT_SIGNUP_FORM_VERSION),
      ))
      .for("update")
      .limit(1)
    if (!stored) return { ok: false as const, message: "Join request not found", status: 404 }
    if (stored.status !== "pending") {
      return { ok: false as const, message: `This request has already been ${stored.status}.`, status: 409 }
    }

    const settings = await loadDepartmentJoinSettings(tx, input.organizationId)
    const { approvers } = await loadRequestChildren(tx, stored.id)
    const current = approvers.find((approver) => approver.level === input.approver.level)
    if (!current || !settings?.emailDomain) {
      return { ok: false as const, message: `This request has no Level ${input.approver.level} approver.`, status: 400 }
    }

    const email = normalizeEmail(input.approver.email)
    const next = approvers.map((approver) => approver.level === current.level
      ? { level: approver.level, email, designation: input.approver.designation }
      : { level: approver.level, email: approver.email, designation: approver.designation })
    const refusal = approverListError({
      initiatorEmail: stored.email,
      approvers: next,
      levelCount: approvers.length,
      emailDomain: settings.emailDomain,
    })
    if (refusal) return { ok: false as const, message: refusal, status: 400 }

    await tx
      .update(organizationJoinRequestApprovers)
      .set({ email, designation: input.approver.designation.trim() })
      .where(eq(organizationJoinRequestApprovers.id, current.id))
    await tx
      .update(organizationJoinRequests)
      .set({ updatedAt: new Date() })
      .where(eq(organizationJoinRequests.id, stored.id))
    return { ok: true as const, previousEmail: current.email }
  })
}

/* ── Deciding ────────────────────────────────────────────────────────────── */

/** Thrown inside the approval to roll the whole package back with an answer. */
class JoinDecisionAbort extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export type DepartmentJoinDecisionInput = {
  requestId: number
  organizationId: number
  actor: { userId: string; role: string }
  decision: "approve" | "reject"
  reason: string | null
  username?: string
  newBranches?: Array<{
    requestBranchId: number
    mapToBranchId?: number
    name?: string
    province?: string
    city?: string
    address?: string
  }>
  addressBranches?: Array<{ requestAddressId: number; requestBranchId: number }>
  expectedResolutions?: Array<{ level: number; kind: ApproverResolutionKind; userId: string | null }>
}

export type NewApproverCredentials = {
  email: string
  firstName: string
  username: string
  temporaryPassword: string
}

export type DepartmentJoinDecisionOutcome =
  | {
      ok: true
      decision: "approve" | "reject"
      requestId: number
      createdUserId: string | null
      email: string
      firstName: string
      username: string
      role: InitiatorRole
      organizationName: string
      branchIds: number[]
      createdBranchIds: number[]
      approvers: Array<{ level: number; email: string; resolution: string; userId: string | null; addedBranchIds: number[] }>
      /** Only for the welcome emails; never returned to the caller or logged. */
      newApproverCredentials: NewApproverCredentials[]
      /** Existing approvers given a level or branches, for the notice email. */
      notifiedApprovers: Array<{ email: string; firstName: string; level: number }>
    }
  | JoinFailure

async function roleIds(names: string[]): Promise<Map<string, number>> {
  const rows = await db.select({ id: rolesTable.id, name: rolesTable.name }).from(rolesTable).where(inArray(rolesTable.name, names))
  return new Map(rows.map((row) => [row.name, row.id]))
}

/** A free username for a new approver: the email's local part, else `<local>.<orgcode>`. */
async function freeApproverUsername(email: string, organizationCode: string): Promise<string> {
  const base = deriveUsernameFromEmail(email)
  if (!(await usernameExists(base))) return base
  const qualified = `${base}.${organizationCode.toLowerCase()}`
  if (!(await usernameExists(qualified))) return qualified
  throw new JoinDecisionAbort(409, `No free username for ${email}. Create that approver from the Users screen first.`)
}

type StoredDepartmentRequest = {
  id: number
  status: string
  firstName: string
  lastName: string
  email: string
  username: string
  phone: string | null
  employeeId: string | null
  department: string | null
  ipExtension: string | null
  passwordHash: string
  requestedRole: string
}

/** Everything one approval works with, passed between its steps. */
type DecisionContext = {
  tx: TransactionExecutor
  input: DepartmentJoinDecisionInput
  organizationCode: string
  decidedAt: Date
}

async function lockDepartmentRequest(tx: TransactionExecutor, input: DepartmentJoinDecisionInput) {
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
      passwordHash: organizationJoinRequests.passwordHash,
      requestedRole: organizationJoinRequests.requestedRole,
    })
    .from(organizationJoinRequests)
    .where(and(
      eq(organizationJoinRequests.id, input.requestId),
      eq(organizationJoinRequests.organizationId, input.organizationId),
      eq(organizationJoinRequests.formVersion, DEPARTMENT_SIGNUP_FORM_VERSION),
    ))
    .for("update")
    .limit(1)

  if (!stored) throw new JoinDecisionAbort(404, "Join request not found")
  if (stored.status !== "pending") throw new JoinDecisionAbort(409, `This request has already been ${stored.status}.`)
  return stored as StoredDepartmentRequest
}

async function activeBranchInOrganization(tx: TransactionExecutor, branchId: number, organizationId: number) {
  const [live] = await tx
    .select({ id: branches.id })
    .from(branches)
    .where(and(
      eq(branches.id, branchId),
      eq(branches.organizationId, organizationId),
      eq(branches.status, "active"),
    ))
    .limit(1)
  return live?.id ?? null
}

/**
 * Step 1: every request branch becomes a real branch id — an existing branch
 * re-checked, a CRC mapped onto an existing branch or created.
 */
async function resolveRequestBranches(
  context: DecisionContext,
  requestBranches: StoredRequestBranch[],
): Promise<{ branchByRequestBranch: Map<number, number>; createdBranchIds: number[] }> {
  const { tx, input } = context
  const branchByRequestBranch = new Map<number, number>()
  const createdBranchIds: number[] = []

  for (const row of requestBranches) {
    if (row.existingBranchId !== null) {
      if (await activeBranchInOrganization(tx, row.existingBranchId, input.organizationId) === null) {
        throw new JoinDecisionAbort(409, "One of the requested branches is no longer active.")
      }
      branchByRequestBranch.set(row.id, row.existingBranchId)
      continue
    }

    const choice = input.newBranches?.find((entry) => entry.requestBranchId === row.id)
    if (!choice) throw new JoinDecisionAbort(400, `Give the details of the new branch for CRC ${row.costCenterId}.`)
    const resolvedId = choice.mapToBranchId === undefined
      ? await createRequestedBranch(context, row, choice)
      : await activeBranchInOrganization(tx, choice.mapToBranchId, input.organizationId)
    if (resolvedId === null) throw new JoinDecisionAbort(400, "That branch is not available in your organization.")
    if (choice.mapToBranchId === undefined) createdBranchIds.push(resolvedId)

    branchByRequestBranch.set(row.id, resolvedId)
    await tx
      .update(organizationJoinRequestBranches)
      .set({ resolvedBranchId: resolvedId })
      .where(eq(organizationJoinRequestBranches.id, row.id))
  }
  return { branchByRequestBranch, createdBranchIds }
}

async function createRequestedBranch(
  context: DecisionContext,
  row: StoredRequestBranch,
  choice: NonNullable<DepartmentJoinDecisionInput["newBranches"]>[number],
): Promise<number> {
  if (!choice.name || !choice.province || !choice.city || !choice.address) {
    throw new JoinDecisionAbort(400, `Give the name, province, city and address of the new branch for CRC ${row.costCenterId}.`)
  }
  const creation = await createBranchInTx(context.tx, {
    organizationId: context.input.organizationId,
    name: choice.name,
    province: choice.province,
    city: choice.city,
    address: choice.address,
    costCenterId: row.costCenterId,
    status: "active",
    region: null,
  }, context.input.actor)
  if (creation.kind === "duplicate-name") {
    throw new JoinDecisionAbort(409, `A branch named "${choice.name}" already exists in your organization.`)
  }
  if (creation.kind !== "created") throw new JoinDecisionAbort(404, "Organization not found")
  return creation.item.id
}

/**
 * Step 2: each approver judged on the branches as they now are, and held to
 * what Head Office reviewed. A different account or a different kind of change
 * than the review showed is a 409, never a silent write.
 */
function assertReviewedResolutions(
  input: DepartmentJoinDecisionInput,
  plans: Array<{ approver: StoredApprover; plan: ApproverResolution }>,
): void {
  for (const { approver, plan } of plans) {
    if (plan.kind === "blocked") throw new JoinDecisionAbort(409, `Level ${approver.level} (${approver.email}): ${plan.reason}`)
    const expected = input.expectedResolutions?.find((entry) => entry.level === approver.level)
    const reviewed = expected
      ? (expected.userId === null ? { kind: expected.kind } : { kind: expected.kind, userId: expected.userId }) as ApproverResolution
      : null
    if (!reviewed || !sameResolution(reviewed, plan)) {
      throw new JoinDecisionAbort(409, `Level ${approver.level} changed since you reviewed this request. Open it again before approving.`)
    }
  }
}

/** Step 3: the initiator, with the role its branch count gives it. */
async function createInitiator(
  context: DecisionContext,
  stored: StoredDepartmentRequest,
  role: InitiatorRole,
  roleId: number,
  branchIds: number[],
): Promise<{ id: string; username: string }> {
  const { tx, input } = context
  const username = input.username ?? stored.username
  if (await usernameExists(username)) {
    throw new JoinDecisionAbort(409, `The username ${username} has since been taken. Choose another.`)
  }
  try {
    await assertUniqueUserFields({ email: stored.email, phone: stored.phone, employeeId: stored.employeeId })
  } catch (uniqueError: any) {
    throw new JoinDecisionAbort(409, uniqueError?.message ?? "These details have since been registered")
  }

  const [initiator] = await tx
    .insert(users)
    .values({
      email: stored.email,
      username,
      passwordHash: stored.passwordHash,
      roleId,
      firstName: stored.firstName,
      lastName: stored.lastName,
      fullName: `${stored.firstName} ${stored.lastName}`.trim(),
      phone: stored.phone,
      employeeId: stored.employeeId,
      department: stored.department,
      ipExtension: stored.ipExtension,
      organizationId: input.organizationId,
      branchId: role === "ORDER_PORTAL" ? branchIds[0] : null,
      mfaEnabled: false,
      isActive: true,
      budgetAllocationEnabled: false,
      // The applicant chose this password; there is nothing to rotate.
      mustChangePassword: false,
    })
    .returning({ id: users.id })
  if (role === "GROUP_ORDER_PORTAL") {
    await replaceMultiBranchScope(tx, {
      userId: initiator.id,
      organizationId: input.organizationId,
      groupIds: [],
      branchIds,
      createdByUserId: input.actor.userId,
    })
  }
  return { id: initiator.id, username }
}

/** Step 4: the delivery addresses, approved at the branch Head Office chose. */
async function writeRequestAddresses(
  context: DecisionContext,
  addresses: StoredAddress[],
  branchByRequestBranch: Map<number, number>,
  branchIds: number[],
  initiatorId: string,
): Promise<void> {
  const { tx, input } = context
  for (const address of addresses) {
    const assigned = input.addressBranches?.find((entry) => entry.requestAddressId === address.id)
    const branchId = assigned
      ? branchByRequestBranch.get(assigned.requestBranchId)
      : (branchIds.length === 1 ? branchIds[0] : undefined)
    if (branchId === undefined) throw new JoinDecisionAbort(400, `Choose the branch for the address "${address.address}".`)

    const label = normalizeDeliveryAddressLabel(address.address).slice(0, 120).trim()
    const [written] = await tx
      .insert(branchDeliveryAddresses)
      .values({
        organizationId: input.organizationId,
        branchId,
        label,
        labelKey: deliveryAddressLabelKey(label),
        address: address.address,
        status: "approved",
        requestReason: "Department sign-up",
        requestedByUserId: initiatorId,
        decidedByUserId: input.actor.userId,
        decidedAt: context.decidedAt,
      })
      // The same address already live at that branch is kept as it is.
      .onConflictDoNothing()
      .returning({ id: branchDeliveryAddresses.id })
    await tx
      .update(organizationJoinRequestAddresses)
      .set({ branchId, deliveryAddressId: written?.id ?? null })
      .where(eq(organizationJoinRequestAddresses.id, address.id))
  }
}

type AppliedApprover = {
  userId: string | null
  addedBranchIds: number[]
  credentials?: NewApproverCredentials
  notify?: boolean
}

/** A new approver: a Group User with a temporary password, the branches and the level. */
async function createApprover(
  context: DecisionContext,
  approver: StoredApprover,
  branchIds: number[],
  groupUserRoleId: number,
): Promise<AppliedApprover> {
  const { tx, input } = context
  const username = await freeApproverUsername(approver.email, context.organizationCode)
  const name = deriveNameFromEmail(approver.email)
  const temporaryPassword = generateRandomPassword(16)
  const [created] = await tx
    .insert(users)
    .values({
      email: approver.email,
      username,
      passwordHash: await hashPassword(temporaryPassword),
      roleId: groupUserRoleId,
      firstName: name.firstName,
      lastName: name.lastName,
      fullName: `${name.firstName} ${name.lastName}`.trim(),
      designation: approver.designation,
      organizationId: input.organizationId,
      branchId: null,
      mfaEnabled: false,
      isActive: true,
      budgetAllocationEnabled: false,
      // An administrator's process chose this password, so it is rotated at
      // first sign-in, as for every account made by POST /api/v1/users.
      mustChangePassword: true,
    })
    .returning({ id: users.id })

  await addBranchesToScope(tx, {
    userId: created.id,
    organizationId: input.organizationId,
    branchIds,
    createdByUserId: input.actor.userId,
  })
  await assignLevel(context, approver.level, { userId: created.id, role: "GROUP_USER", level: null })
  return {
    userId: created.id,
    addedBranchIds: branchIds,
    credentials: { email: approver.email, firstName: name.firstName, username, temporaryPassword },
  }
}

async function assignLevel(
  context: DecisionContext,
  level: number,
  target: { userId: string; role: string; level: number | null },
): Promise<void> {
  const written = await writeApprovalLevelInTx(context.tx, {
    target: { ...target, organizationId: context.input.organizationId },
    level,
    actor: context.input.actor,
  })
  if (written.kind === "refused") throw new JoinDecisionAbort(409, `Level ${level}: ${written.message}`)
}

/** Step 5: one approver, as its resolution says. */
async function applyApprover(
  context: DecisionContext,
  approver: StoredApprover,
  plan: ApproverResolution,
  candidate: ApproverCandidate | undefined,
  branchIds: number[],
  groupUserRoleId: number,
): Promise<AppliedApprover> {
  if (plan.kind === "create") return createApprover(context, approver, branchIds, groupUserRoleId)
  if (plan.kind === "covered") return { userId: plan.userId, addedBranchIds: [] }
  if ((plan.kind !== "assign" && plan.kind !== "extend") || !candidate) return { userId: null, addedBranchIds: [] }

  if (candidate.role === "GROUP_USER" && plan.addBranchIds.length > 0) {
    await addBranchesToScope(context.tx, {
      userId: plan.userId,
      organizationId: context.input.organizationId,
      branchIds: plan.addBranchIds,
      createdByUserId: context.input.actor.userId,
    })
  }
  if (plan.kind === "assign") {
    await assignLevel(context, approver.level, { userId: plan.userId, role: candidate.role, level: candidate.level })
  }
  return { userId: plan.userId, addedBranchIds: plan.addBranchIds, notify: true }
}

async function approveDepartmentRequest(
  context: DecisionContext,
  stored: StoredDepartmentRequest,
  roleIdByName: Map<string, number>,
) {
  const { tx, input } = context
  const children = await loadRequestChildren(tx, stored.id)
  const candidates = await loadApproverCandidates(tx, children.approvers.map((approver) => approver.email), true)
  const organization = await loadApprovalLevelContext(tx, input.organizationId, true)
  if (!organization) throw new JoinDecisionAbort(404, "Organization not found")

  const { branchByRequestBranch, createdBranchIds } = await resolveRequestBranches(context, children.requestBranches)
  const branchIds = [...new Set(branchByRequestBranch.values())]
  const role = initiatorRoleForBranchCount(branchIds.length)
  const roleId = roleIdByName.get(role)
  const groupUserRoleId = roleIdByName.get("GROUP_USER")
  if (!roleId || !groupUserRoleId) throw new JoinDecisionAbort(500, "Roles are not set up")

  const plans = children.approvers.map((approver) => ({
    approver,
    plan: planApproverResolution({
      level: approver.level,
      organizationId: input.organizationId,
      organization,
      candidates: candidates.get(approver.email) ?? [],
      initiatorBranchIds: branchIds,
      newBranchCount: 0,
      deciderUserId: input.actor.userId,
    }),
  }))
  assertReviewedResolutions(input, plans)

  const initiator = await createInitiator(context, stored, role, roleId, branchIds)
  await writeRequestAddresses(context, children.addresses, branchByRequestBranch, branchIds, initiator.id)

  const newApproverCredentials: NewApproverCredentials[] = []
  const notifiedApprovers: Array<{ email: string; firstName: string; level: number }> = []
  const approverSummary: Array<{ level: number; email: string; resolution: string; userId: string | null; addedBranchIds: number[] }> = []
  for (const { approver, plan } of plans) {
    const candidate = (candidates.get(approver.email) ?? [])[0]
    // Blocked plans were refused by assertReviewedResolutions above.
    if (plan.kind === "blocked") throw new JoinDecisionAbort(409, plan.reason)
    const recorded = RECORDED_RESOLUTION[plan.kind]
    const applied = await applyApprover(context, approver, plan, candidate, branchIds, groupUserRoleId)
    if (applied.credentials) newApproverCredentials.push(applied.credentials)
    if (applied.notify) {
      notifiedApprovers.push({ email: approver.email, firstName: deriveNameFromEmail(approver.email).firstName, level: approver.level })
    }
    await tx
      .update(organizationJoinRequestApprovers)
      .set({ resolution: recorded, approverUserId: applied.userId })
      .where(eq(organizationJoinRequestApprovers.id, approver.id))
    approverSummary.push({
      level: approver.level,
      email: approver.email,
      resolution: recorded,
      userId: applied.userId,
      addedBranchIds: applied.addedBranchIds,
    })
  }

  await tx
    .update(organizationJoinRequests)
    .set({
      status: "approved",
      decisionReason: input.reason,
      decidedByUserId: input.actor.userId,
      decidedAt: context.decidedAt,
      createdUserId: initiator.id,
      // What was granted, not only what was asked for.
      requestedRole: role,
      requestedBranchId: role === "ORDER_PORTAL" ? branchIds[0] : null,
      requestedBranchIds: branchIds,
      username: initiator.username,
      updatedAt: context.decidedAt,
    })
    .where(eq(organizationJoinRequests.id, stored.id))

  return {
    createdUserId: initiator.id,
    username: initiator.username,
    role,
    branchIds,
    createdBranchIds,
    approvers: approverSummary,
    newApproverCredentials,
    notifiedApprovers,
  }
}

/**
 * Approve or reject one department sign-up, in one transaction.
 *
 * Locks, in the order the existing writers take them so none can deadlock:
 * the request `FOR UPDATE`, the approvers' existing accounts `FOR UPDATE` (id
 * order, as `setUserApprovalLevel` locks its target first), the organization
 * `FOR SHARE` (`loadApprovalLevelContext`, as every level assignment does), and
 * the per-tenant branch-creation lock. Anything that fails after the first
 * write throws, so the package is created whole or not at all.
 */
export async function decideDepartmentJoinRequest(
  input: DepartmentJoinDecisionInput,
): Promise<DepartmentJoinDecisionOutcome> {
  const [organization] = await db
    .select({ name: organizations.name, code: organizations.code })
    .from(organizations)
    .where(eq(organizations.id, input.organizationId))
    .limit(1)
  if (!organization) return { ok: false, message: "Organization not found", status: 404 }
  const roleIdByName = await roleIds(["ORDER_PORTAL", "GROUP_ORDER_PORTAL", "GROUP_USER"])

  try {
    return await db.transaction(async (tx) => {
      const context: DecisionContext = {
        tx,
        input,
        organizationCode: organization.code ?? String(input.organizationId),
        decidedAt: new Date(),
      }
      const stored = await lockDepartmentRequest(tx, input)
      const base = {
        ok: true as const,
        requestId: stored.id,
        email: stored.email,
        firstName: stored.firstName,
        organizationName: organization.name,
      }

      if (input.decision === "reject") {
        await tx
          .update(organizationJoinRequests)
          .set({
            status: "rejected",
            decisionReason: input.reason,
            decidedByUserId: input.actor.userId,
            decidedAt: context.decidedAt,
            updatedAt: context.decidedAt,
          })
          .where(eq(organizationJoinRequests.id, stored.id))
        return {
          ...base,
          decision: "reject" as const,
          createdUserId: null,
          username: stored.username,
          role: stored.requestedRole as InitiatorRole,
          branchIds: [],
          createdBranchIds: [],
          approvers: [],
          newApproverCredentials: [],
          notifiedApprovers: [],
        }
      }

      return { ...base, decision: "approve" as const, ...(await approveDepartmentRequest(context, stored, roleIdByName)) }
    })
  } catch (caughtError) {
    if (caughtError instanceof JoinDecisionAbort) {
      return { ok: false, message: caughtError.message, status: caughtError.status }
    }
    throw caughtError
  }
}
