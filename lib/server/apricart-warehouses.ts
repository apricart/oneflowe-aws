import "server-only"

import { and, asc, count, eq, inArray, isNull } from "drizzle-orm"

import {
  apricartExecutiveAssignments,
  apricartWarehouseMemberships,
  apricartWarehouses,
  branches,
  branchFulfillmentRoutes,
  organizations,
  roles,
  users,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  APRICART_WAREHOUSE_MAX,
  APRICART_WAREHOUSE_MEMBER_MAX,
  CREATE_APRICART_WAREHOUSE_AUDIT_ACTION,
  UPDATE_APRICART_WAREHOUSE_AUDIT_ACTION,
  UPDATE_APRICART_WAREHOUSE_MEMBERS_AUDIT_ACTION,
  UPDATE_BRANCH_FULFILLMENT_ROUTES_AUDIT_ACTION,
  WAREHOUSE_MEMBER_ROLES,
  classifyBranchCoverage,
  executiveCoverageGaps,
  responsibilityForRole,
  summarizeCoverage,
  type ApricartWarehouseStatus,
  type BranchCoverage,
  type BranchCoverageKind,
  type WarehouseResponsibility,
} from "@/lib/apricart-warehouses"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"

/**
 * Super Admin's configuration of Apricart's warehouses: the warehouses, who
 * works at each, and which warehouse each branch's new orders default to.
 *
 * Configuration only. Nothing here is read by an order, a warehouse account's
 * reach, a notification or a decision — `loadWarehouseReach` and
 * `loadExecutiveApprovalReach` are unchanged — so no existing user's access
 * moves when a warehouse is configured. The coverage report compares the two
 * models for the rollout. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */

type Actor = AuditActor & { id: string }

export type ApricartWarehouse = {
  id: number
  code: string
  name: string
  city: string | null
  address: string | null
  contactPhone: string | null
  status: ApricartWarehouseStatus
  members: Array<{ userId: string; responsibility: WarehouseResponsibility }>
  routedBranchCount: number
  /** Organizations it is routed into that none of its active executive members may approve for. */
  executiveGapOrganizationIds: number[]
}

export type WarehouseMemberAccount = {
  id: string
  fullName: string | null
  username: string | null
  email: string
  isActive: boolean
  responsibility: WarehouseResponsibility
}

export type BranchCoverageEntry = BranchCoverage & {
  branchId: number
  organizationId: number
  /** The active warehouse accounts whose live reach includes the branch. */
  servingAccountIds: string[]
}

export type ApricartWarehouseConfiguration = {
  warehouses: ApricartWarehouse[]
  accounts: WarehouseMemberAccount[]
  routes: Array<{ branchId: number; warehouseId: number }>
  coverage: { summary: Record<BranchCoverageKind, number>; branches: BranchCoverageEntry[] }
}

const ACCOUNT_LIMIT = 400
const BRANCH_LIMIT = 5000
const ROUTE_LIMIT = 10000
/** Reach is read one account at a time, a few at once, so the pool is never flooded. */
const REACH_CONCURRENCY = 4

async function loadReachByAccount(accountIds: string[]): Promise<Map<string, number[]>> {
  const reach = new Map<string, number[]>()
  for (let start = 0; start < accountIds.length; start += REACH_CONCURRENCY) {
    const chunk = accountIds.slice(start, start + REACH_CONCURRENCY)
    const results = await Promise.all(chunk.map((id) => loadWarehouseReach(db, id)))
    chunk.forEach((id, index) => reach.set(id, results[index]))
  }
  return reach
}

export async function loadApricartWarehouseConfiguration(): Promise<ApricartWarehouseConfiguration> {
  const [warehouseRows, membershipRows, accountRows, routeRows, branchRows] = await Promise.all([
    db
      .select({
        id: apricartWarehouses.id,
        code: apricartWarehouses.code,
        name: apricartWarehouses.name,
        city: apricartWarehouses.city,
        address: apricartWarehouses.address,
        contactPhone: apricartWarehouses.contactPhone,
        status: apricartWarehouses.status,
      })
      .from(apricartWarehouses)
      .orderBy(asc(apricartWarehouses.code))
      .limit(APRICART_WAREHOUSE_MAX),
    db
      .select({
        warehouseId: apricartWarehouseMemberships.warehouseId,
        userId: apricartWarehouseMemberships.userId,
        responsibility: apricartWarehouseMemberships.responsibility,
      })
      .from(apricartWarehouseMemberships)
      .limit(APRICART_WAREHOUSE_MAX * APRICART_WAREHOUSE_MEMBER_MAX),
    db
      .select({
        id: users.id,
        fullName: users.fullName,
        username: users.username,
        email: users.email,
        isActive: users.isActive,
        role: roles.name,
      })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(and(inArray(roles.name, [...WAREHOUSE_MEMBER_ROLES]), isNull(users.deletedAt)))
      .orderBy(asc(users.fullName))
      .limit(ACCOUNT_LIMIT),
    db
      .select({ branchId: branchFulfillmentRoutes.branchId, warehouseId: branchFulfillmentRoutes.warehouseId })
      .from(branchFulfillmentRoutes)
      .limit(ROUTE_LIMIT),
    db
      .select({ id: branches.id, organizationId: branches.organizationId })
      .from(branches)
      .where(eq(branches.status, "active"))
      .orderBy(asc(branches.id))
      .limit(BRANCH_LIMIT),
  ])

  const accounts: WarehouseMemberAccount[] = accountRows.flatMap((row) => {
    const responsibility = responsibilityForRole(row.role)
    return responsibility
      ? [{
        id: row.id,
        fullName: row.fullName,
        username: row.username,
        email: row.email,
        isActive: Boolean(row.isActive),
        responsibility,
      }]
      : []
  })
  const activeAccountIds = new Set(accounts.filter((account) => account.isActive).map((account) => account.id))

  // Today's reach, through the one rule that decides it — never a second copy.
  const operatorIds = accounts
    .filter((account) => account.responsibility === "WAREHOUSE_OPERATOR" && account.isActive)
    .map((account) => account.id)
  const reachByAccount = await loadReachByAccount(operatorIds)
  const servingByBranch = new Map<number, string[]>()
  for (const [accountId, branchIds] of reachByAccount) {
    for (const branchId of branchIds) servingByBranch.set(branchId, [...(servingByBranch.get(branchId) ?? []), accountId])
  }

  const operatorWarehouses = new Map<string, number[]>()
  for (const membership of membershipRows) {
    if (membership.responsibility !== "WAREHOUSE_OPERATOR" || !activeAccountIds.has(membership.userId)) continue
    operatorWarehouses.set(membership.userId, [...(operatorWarehouses.get(membership.userId) ?? []), membership.warehouseId])
  }

  const routeByBranch = new Map(routeRows.map((row) => [row.branchId, row.warehouseId]))
  const coverageEntries: BranchCoverageEntry[] = branchRows.flatMap((branch) => {
    if (branch.organizationId === null) return []
    const servingAccountIds = (servingByBranch.get(branch.id) ?? []).sort((a, b) => a.localeCompare(b))
    return [{
      branchId: branch.id,
      organizationId: branch.organizationId,
      servingAccountIds,
      ...classifyBranchCoverage({
        routeWarehouseId: routeByBranch.get(branch.id) ?? null,
        servingAccountIds,
        operatorWarehouses,
      }),
    }]
  })

  const executiveIds = [...new Set(membershipRows
    .filter((row) => row.responsibility === "EXECUTIVE" && activeAccountIds.has(row.userId))
    .map((row) => row.userId))]
  const routedBranchIds = routeRows.map((row) => row.branchId)
  const [executiveAssignmentRows, routedBranchRows] = await Promise.all([
    executiveIds.length === 0
      ? []
      : db
        .select({ userId: apricartExecutiveAssignments.userId, organizationId: apricartExecutiveAssignments.organizationId })
        .from(apricartExecutiveAssignments)
        .where(inArray(apricartExecutiveAssignments.userId, executiveIds)),
    routedBranchIds.length === 0
      ? []
      : db
        .select({ id: branches.id, organizationId: branches.organizationId })
        .from(branches)
        .where(inArray(branches.id, routedBranchIds)),
  ])
  const organizationOfBranch = new Map(routedBranchRows.map((row) => [row.id, row.organizationId]))

  return {
    warehouses: warehouseRows.map((warehouse) => {
      const members = membershipRows
        .filter((row) => row.warehouseId === warehouse.id)
        .map((row) => ({ userId: row.userId, responsibility: row.responsibility as WarehouseResponsibility }))
      const routed = routeRows.filter((row) => row.warehouseId === warehouse.id)
      const executiveMembers = members
        .filter((member) => member.responsibility === "EXECUTIVE" && activeAccountIds.has(member.userId))
        .map((member) => member.userId)
      return {
        ...warehouse,
        status: warehouse.status as ApricartWarehouseStatus,
        members,
        routedBranchCount: routed.length,
        executiveGapOrganizationIds: executiveCoverageGaps({
          routedOrganizationIds: routed.flatMap((row) => {
            const organizationId = organizationOfBranch.get(row.branchId)
            return typeof organizationId === "number" ? [organizationId] : []
          }),
          executiveOrganizationIds: executiveMembers.map((userId) => executiveAssignmentRows
            .filter((row) => row.userId === userId)
            .map((row) => row.organizationId)),
        }),
      }
    }),
    accounts,
    routes: routeRows,
    coverage: { summary: summarizeCoverage(coverageEntries), branches: coverageEntries },
  }
}

/** The Postgres unique violation, however the driver wraps it. */
function isUniqueViolation(exception: unknown): boolean {
  const cause = (exception as { cause?: unknown })?.cause ?? exception
  const code = (cause as { code?: string })?.code ?? (exception as { code?: string })?.code
  return code === "23505"
}

const warehouseColumns = {
  id: apricartWarehouses.id,
  code: apricartWarehouses.code,
  name: apricartWarehouses.name,
  city: apricartWarehouses.city,
  address: apricartWarehouses.address,
  contactPhone: apricartWarehouses.contactPhone,
  status: apricartWarehouses.status,
}

type WarehouseRow = { [K in keyof typeof warehouseColumns]: (typeof apricartWarehouses.$inferSelect)[K] }

export type CreateWarehouseOutcome =
  | { kind: "created"; warehouse: WarehouseRow }
  | { kind: "conflict" }
  | { kind: "limit" }

export async function createApricartWarehouse(input: {
  code: string
  name: string
  city?: string | null
  address?: string | null
  contactPhone?: string | null
  actor: Actor
}): Promise<CreateWarehouseOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [{ total }] = await tx.select({ total: count() }).from(apricartWarehouses)
      if (total >= APRICART_WAREHOUSE_MAX) return { kind: "limit" } as const

      const [warehouse] = await tx
        .insert(apricartWarehouses)
        .values({
          code: input.code,
          name: input.name,
          city: input.city ?? null,
          address: input.address ?? null,
          contactPhone: input.contactPhone ?? null,
          createdByUserId: input.actor.id,
        })
        .returning(warehouseColumns)

      await recordAuditEvent(tx, {
        action: CREATE_APRICART_WAREHOUSE_AUDIT_ACTION,
        entity: "apricart_warehouse",
        entityId: warehouse.id,
        actor: input.actor,
        after: warehouse,
      })
      return { kind: "created", warehouse } as const
    })
  } catch (error) {
    if (isUniqueViolation(error)) return { kind: "conflict" }
    throw error
  }
}

export type UpdateWarehouseOutcome =
  | { kind: "updated"; warehouse: WarehouseRow }
  | { kind: "not-found" }
  | { kind: "conflict"; message: string }

/**
 * Change a warehouse's details or status. Deactivating is refused while any
 * branch still routes to it, so a route never names an inactive warehouse.
 */
export async function updateApricartWarehouse(input: {
  warehouseId: number
  patch: {
    name?: string
    city?: string | null
    address?: string | null
    contactPhone?: string | null
    status?: ApricartWarehouseStatus
  }
  actor: Actor
}): Promise<UpdateWarehouseOutcome> {
  return db.transaction(async (tx) => {
    const [before] = await tx
      .select(warehouseColumns)
      .from(apricartWarehouses)
      .where(eq(apricartWarehouses.id, input.warehouseId))
      .for("update")
      .limit(1)
    if (!before) return { kind: "not-found" }

    const { patch } = input
    if (patch.status === "INACTIVE" && before.status !== "INACTIVE") {
      const [{ routed }] = await tx
        .select({ routed: count() })
        .from(branchFulfillmentRoutes)
        .where(eq(branchFulfillmentRoutes.warehouseId, input.warehouseId))
      if (routed > 0) {
        return { kind: "conflict", message: "Move this warehouse's branches to another warehouse before deactivating it" }
      }
    }

    const changes = {
      ...(patch.name === undefined || patch.name === before.name ? {} : { name: patch.name }),
      ...(patch.city === undefined || patch.city === before.city ? {} : { city: patch.city }),
      ...(patch.address === undefined || patch.address === before.address ? {} : { address: patch.address }),
      ...(patch.contactPhone === undefined || patch.contactPhone === before.contactPhone ? {} : { contactPhone: patch.contactPhone }),
      ...(patch.status === undefined || patch.status === before.status ? {} : { status: patch.status }),
    }
    if (Object.keys(changes).length === 0) return { kind: "updated", warehouse: before }

    const [warehouse] = await tx
      .update(apricartWarehouses)
      .set({ ...changes, updatedAt: new Date() })
      .where(eq(apricartWarehouses.id, input.warehouseId))
      .returning(warehouseColumns)

    await recordAuditEvent(tx, {
      action: UPDATE_APRICART_WAREHOUSE_AUDIT_ACTION,
      entity: "apricart_warehouse",
      entityId: input.warehouseId,
      actor: input.actor,
      before: Object.fromEntries(Object.keys(changes).map((key) => [key, before[key as keyof typeof before]])),
      after: changes,
    })
    return { kind: "updated", warehouse }
  })
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

async function addMember(tx: Transaction, input: {
  warehouseId: number
  userId: string
  responsibility: WarehouseResponsibility
  isActive: boolean
  memberCount: number
  alreadyMember: boolean
  actor: Actor
}): Promise<"changed" | "unchanged" | WarehouseMemberOutcome> {
  if (!input.isActive) return { kind: "invalid", message: "An inactive account cannot be added to a warehouse" }
  if (input.alreadyMember) return "unchanged"
  if (input.memberCount >= APRICART_WAREHOUSE_MEMBER_MAX) return { kind: "limit" }
  await tx.insert(apricartWarehouseMemberships)
    .values({ warehouseId: input.warehouseId, userId: input.userId, responsibility: input.responsibility, createdByUserId: input.actor.id })
    .onConflictDoNothing()
  return "changed"
}

async function removeMember(tx: Transaction, input: { warehouseId: number; userId: string }): Promise<"changed" | "unchanged"> {
  const removed = await tx.delete(apricartWarehouseMemberships)
    .where(and(
      eq(apricartWarehouseMemberships.warehouseId, input.warehouseId),
      eq(apricartWarehouseMemberships.userId, input.userId),
    ))
    .returning({ userId: apricartWarehouseMemberships.userId })
  return removed.length > 0 ? "changed" : "unchanged"
}

export type WarehouseMemberOutcome =
  | { kind: "updated"; userId: string; responsibility: WarehouseResponsibility; assigned: boolean }
  | { kind: "not-found" }
  | { kind: "account-not-found" }
  | { kind: "invalid"; message: string }
  | { kind: "limit" }

/**
 * Add or remove one account at a warehouse. The account must be an undeleted
 * `WAREHOUSE` or `APRICART_EXECUTIVE` account (otherwise "account not found",
 * so this cannot probe other accounts), and active to be added. Its
 * responsibility is taken from its role. Idempotent.
 */
export async function setApricartWarehouseMember(input: {
  warehouseId: number
  userId: string
  assigned: boolean
  actor: Actor
}): Promise<WarehouseMemberOutcome> {
  return db.transaction(async (tx) => {
    // Serializes membership changes at one warehouse, so the cap holds.
    const [warehouse] = await tx
      .select({ id: apricartWarehouses.id })
      .from(apricartWarehouses)
      .where(eq(apricartWarehouses.id, input.warehouseId))
      .for("update")
      .limit(1)
    if (!warehouse) return { kind: "not-found" }

    const [account] = await tx
      .select({ id: users.id, role: roles.name, isActive: users.isActive, deletedAt: users.deletedAt })
      .from(users)
      .innerJoin(roles, eq(users.roleId, roles.id))
      .where(eq(users.id, input.userId))
      .limit(1)
    const responsibility = account && account.deletedAt === null ? responsibilityForRole(account.role) : null
    if (!account || !responsibility) return { kind: "account-not-found" }

    const before = (await tx
      .select({ userId: apricartWarehouseMemberships.userId })
      .from(apricartWarehouseMemberships)
      .where(eq(apricartWarehouseMemberships.warehouseId, input.warehouseId)))
      .map((row) => row.userId)
      .sort((a, b) => a.localeCompare(b))

    const change = input.assigned
      ? await addMember(tx, { ...input, responsibility, isActive: Boolean(account.isActive), memberCount: before.length, alreadyMember: before.includes(input.userId) })
      : await removeMember(tx, input)
    if (change !== "changed" && change !== "unchanged") return change

    if (change === "changed") {
      const after = input.assigned
        ? [...before, input.userId].sort((a, b) => a.localeCompare(b))
        : before.filter((id) => id !== input.userId)
      await recordAuditEvent(tx, {
        action: UPDATE_APRICART_WAREHOUSE_MEMBERS_AUDIT_ACTION,
        entity: "apricart_warehouse",
        entityId: input.warehouseId,
        actor: input.actor,
        before: { userIds: before },
        after: { userIds: after },
        context: { userId: input.userId, responsibility, assigned: input.assigned },
      })
    }
    return { kind: "updated", userId: input.userId, responsibility, assigned: input.assigned }
  })
}

export type BranchRoutesOutcome =
  | { kind: "updated"; branchIds: number[]; moved: Array<{ branchId: number; fromWarehouseId: number }> }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string }

/**
 * Make the branches **of one organization** that default to this warehouse
 * exactly `branchIds`, in one transaction, audited with the before and after.
 * Branches of other organizations are untouched. A listed branch that defaults
 * to another warehouse is moved here, and the audit row says where from. An
 * inactive warehouse may lose branches but take no new one.
 */
export async function replaceBranchFulfillmentRoutes(input: {
  warehouseId: number
  organizationId: number
  branchIds: number[]
  actor: Actor
}): Promise<BranchRoutesOutcome> {
  return db.transaction(async (tx) => {
    // Serialized with deactivation, which counts this warehouse's routes under the same lock.
    const [warehouse] = await tx
      .select({ id: apricartWarehouses.id, status: apricartWarehouses.status })
      .from(apricartWarehouses)
      .where(eq(apricartWarehouses.id, input.warehouseId))
      .for("update")
      .limit(1)
    if (!warehouse) return { kind: "not-found" }

    const [organization] = await tx
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .limit(1)
    if (!organization) return { kind: "invalid", message: "The organization does not exist" }

    const organizationBranchIds = (await tx
      .select({ id: branches.id })
      .from(branches)
      .where(eq(branches.organizationId, input.organizationId)))
      .map((row) => row.id)
    const branchIds = [...new Set(input.branchIds)].sort((a, b) => a - b)
    if (branchIds.some((id) => !organizationBranchIds.includes(id))) {
      return { kind: "invalid", message: "One or more branches do not belong to this organization" }
    }

    const existing = organizationBranchIds.length === 0
      ? []
      : await tx
        .select({ branchId: branchFulfillmentRoutes.branchId, warehouseId: branchFulfillmentRoutes.warehouseId })
        .from(branchFulfillmentRoutes)
        .where(inArray(branchFulfillmentRoutes.branchId, organizationBranchIds))
        .for("update")
    const before = existing
      .filter((row) => row.warehouseId === input.warehouseId)
      .map((row) => row.branchId)
      .sort((a, b) => a - b)
    const added = branchIds.filter((id) => !before.includes(id))
    if (warehouse.status !== "ACTIVE" && added.length > 0) {
      return { kind: "conflict", message: "An inactive warehouse cannot take new branches" }
    }
    const moved = existing
      .filter((row) => row.warehouseId !== input.warehouseId && branchIds.includes(row.branchId))
      .map((row) => ({ branchId: row.branchId, fromWarehouseId: row.warehouseId }))
      .sort((a, b) => a.branchId - b.branchId)

    const removed = before.filter((id) => !branchIds.includes(id))
    if (removed.length > 0) {
      await tx.delete(branchFulfillmentRoutes).where(and(
        eq(branchFulfillmentRoutes.warehouseId, input.warehouseId),
        inArray(branchFulfillmentRoutes.branchId, removed),
      ))
    }
    if (added.length > 0) {
      const now = new Date()
      await tx.insert(branchFulfillmentRoutes)
        .values(added.map((branchId) => ({
          branchId,
          warehouseId: input.warehouseId,
          createdByUserId: input.actor.id,
          updatedByUserId: input.actor.id,
        })))
        .onConflictDoUpdate({
          target: branchFulfillmentRoutes.branchId,
          set: { warehouseId: input.warehouseId, updatedByUserId: input.actor.id, updatedAt: now },
        })
    }

    if (added.length > 0 || removed.length > 0) {
      await recordAuditEvent(tx, {
        action: UPDATE_BRANCH_FULFILLMENT_ROUTES_AUDIT_ACTION,
        entity: "apricart_warehouse",
        entityId: input.warehouseId,
        actor: input.actor,
        organizationId: input.organizationId,
        before: { branchIds: before },
        after: { branchIds },
        context: { moved },
      })
    }
    return { kind: "updated", branchIds, moved }
  })
}
