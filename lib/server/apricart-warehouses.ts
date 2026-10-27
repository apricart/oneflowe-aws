import "server-only"

import { and, asc, count, eq, inArray, isNull, ne, sql } from "drizzle-orm"

import {
  apricartExecutiveAssignments,
  apricartWarehouseMemberBranches,
  apricartWarehouseMemberships,
  apricartWarehouses,
  branches,
  branchFulfillmentRoutes,
  orders,
  organizations,
  roles,
  users,
  warehouseRouteRules,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  APRICART_WAREHOUSE_MAX,
  APRICART_WAREHOUSE_MEMBER_MAX,
  CREATE_APRICART_WAREHOUSE_AUDIT_ACTION,
  UPDATE_APRICART_WAREHOUSE_AUDIT_ACTION,
  UPDATE_APRICART_WAREHOUSE_MEMBERS_AUDIT_ACTION,
  UPDATE_APRICART_WAREHOUSE_MEMBER_SCOPE_AUDIT_ACTION,
  UPDATE_BRANCH_FULFILLMENT_ROUTES_AUDIT_ACTION,
  UPDATE_WAREHOUSE_ROUTE_RULES_AUDIT_ACTION,
  UNROUTED_ORDER_LIST_LIMIT,
  WAREHOUSE_MEMBER_ROLES,
  WAREHOUSE_ROUTE_RULE_MAX,
  classifyBranchCoverage,
  executiveCoverageGaps,
  responsibilityForRole,
  summarizeCoverage,
  type ApricartWarehouseStatus,
  type BranchCoverage,
  type BranchCoverageKind,
  type WarehouseMemberScope,
  type WarehouseResponsibility,
} from "@/lib/apricart-warehouses"
import { WAREHOUSE_ROLE } from "@/lib/warehouse-access"
import { WAREHOUSE_ORDER_OWNERSHIP, readsWarehouseMembership, type WarehouseOrderOwnershipMode } from "@/lib/warehouse-ownership-policy"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { branchCityKeySql, branchCityLabelSql } from "@/lib/server/branch-city-key"
import { branchWarehouseSql, countStrandedBranches } from "@/lib/server/branch-warehouse"
import { loadWarehouseReach } from "@/lib/server/warehouse-scope"

/**
 * Super Admin's configuration of Apricart's warehouses: the warehouses, who
 * works at each, and which warehouse each branch's new orders default to.
 *
 * Routes and the coverage report are configuration only. Membership is read
 * for one thing: an order Super Admin transferred to a warehouse is worked by
 * that warehouse's active operators (`lib/server/order-warehouse-transfer.ts`).
 * So the two writes that could strand such an order — deactivating the
 * warehouse, removing its last active operator — are refused while it holds an
 * open one. Configuring a warehouse moves no other order and no account's
 * branch reach. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
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
  members: Array<{
    userId: string
    responsibility: WarehouseResponsibility
    branchScope: WarehouseMemberScope
    /** For a `SELECTED` operator: the branches it works, ascending. */
    selectedBranchIds: number[]
  }>
  /** Branches put in this warehouse by hand. */
  routedBranchCount: number
  /** Organization or organization-and-city rules naming this warehouse. */
  ruleCount: number
  /** Active branches in this warehouse now, by manual route or rule. */
  branchCount: number
  /** Organizations it holds branches in that none of its active executive members may approve for. */
  executiveGapOrganizationIds: number[]
}

export type WarehouseRouteRuleView = {
  id: number
  warehouseId: number
  organizationId: number
  /** Null: every branch of the organization. */
  cityKey: string | null
  /** How the city is spelt on the organization's branches, or null. */
  cityLabel: string | null
  /** Active branches of the organization this rule matches today (before manual routes). */
  branchCount: number
}

export type UnroutedOrderView = {
  id: number
  tid: string
  organizationId: number
  branchId: number
  status: string
  fulfillmentStatus: string | null
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
  /** Where warehouse accounts' branches come from today (`lib/warehouse-ownership-policy.ts`). */
  ownershipMode: WarehouseOrderOwnershipMode
  warehouses: ApricartWarehouse[]
  accounts: WarehouseMemberAccount[]
  /** Branches put in a warehouse by hand. */
  routes: Array<{ branchId: number; warehouseId: number }>
  rules: WarehouseRouteRuleView[]
  /** Every (organization, city) with an active branch, for the rule picker. */
  cityOptions: Array<{ organizationId: number; cityKey: string; label: string; branchCount: number }>
  /** The live warehouse of every active branch that is in one. */
  branchWarehouses: Array<{ branchId: number; warehouseId: number }>
  /** Open orders, not transferred, whose branch is in no warehouse. */
  unrouted: { count: number; orders: UnroutedOrderView[] }
  coverage: { summary: Record<BranchCoverageKind, number>; branches: BranchCoverageEntry[] }
}

const ACCOUNT_LIMIT = 400
const BRANCH_LIMIT = 5000
const ROUTE_LIMIT = 10000
/** Reach is read one account at a time, a few at once, so the pool is never flooded. */
const REACH_CONCURRENCY = 4

/**
 * Each account's reach from its own assignments — the "branch" mode, whatever
 * mode is in force — which is what the coverage report compares warehouses with.
 */
async function loadReachByAccount(accountIds: string[]): Promise<Map<string, number[]>> {
  const reach = new Map<string, number[]>()
  for (let start = 0; start < accountIds.length; start += REACH_CONCURRENCY) {
    const chunk = accountIds.slice(start, start + REACH_CONCURRENCY)
    const results = await Promise.all(chunk.map((id) => loadWarehouseReach(db, id, { mode: "branch" })))
    chunk.forEach((id, index) => reach.set(id, results[index]))
  }
  return reach
}

const OPEN_ORDER_STATUS_SQL = sql`UPPER(${orders.status}) IN ('PENDING', 'APPROVED')`

/** The rule list, each with the active branches of its organization (and city) it matches. */
async function loadRuleViews(): Promise<WarehouseRouteRuleView[]> {
  const rows = await db
    .select({
      id: warehouseRouteRules.id,
      warehouseId: warehouseRouteRules.warehouseId,
      organizationId: warehouseRouteRules.organizationId,
      cityKey: warehouseRouteRules.cityKey,
      cityLabel: sql<string | null>`(
        SELECT min(${branchCityLabelSql(sql`b."city"`)}) FROM "branches" b
        WHERE b."organization_id" = ${warehouseRouteRules.organizationId}
          AND ${branchCityKeySql(sql`b."city"`)} = ${warehouseRouteRules.cityKey}
      )`,
      branchCount: sql<number>`(
        SELECT count(*)::int FROM "branches" b
        WHERE b."organization_id" = ${warehouseRouteRules.organizationId} AND b."status" = 'active'
          AND (${warehouseRouteRules.cityKey} IS NULL OR ${branchCityKeySql(sql`b."city"`)} = ${warehouseRouteRules.cityKey})
      )`,
    })
    .from(warehouseRouteRules)
    .orderBy(asc(warehouseRouteRules.organizationId), asc(warehouseRouteRules.cityKey))
    .limit(WAREHOUSE_ROUTE_RULE_MAX)
  return rows.map((row) => ({ ...row, branchCount: Number(row.branchCount) }))
}

async function loadUnroutedOrders(): Promise<ApricartWarehouseConfiguration["unrouted"]> {
  const condition = and(
    OPEN_ORDER_STATUS_SQL,
    isNull(orders.fulfillmentWarehouseId),
    sql`${branchWarehouseSql()} IS NULL`,
  )
  const [[{ total }], rows] = await Promise.all([
    db.select({ total: count() }).from(orders).innerJoin(branches, eq(branches.id, orders.branchId)).where(condition),
    db
      .select({
        id: orders.id,
        tid: orders.tid,
        organizationId: orders.organizationId,
        branchId: orders.branchId,
        status: orders.status,
        fulfillmentStatus: orders.fulfillmentStatus,
      })
      .from(orders)
      .innerJoin(branches, eq(branches.id, orders.branchId))
      .where(condition)
      .orderBy(asc(orders.id))
      .limit(UNROUTED_ORDER_LIST_LIMIT),
  ])
  return {
    count: Number(total),
    orders: rows.flatMap((row) => row.organizationId === null
      ? []
      : [{ ...row, organizationId: row.organizationId, tid: String(row.tid ?? row.id), status: String(row.status ?? "") }]),
  }
}

export async function loadApricartWarehouseConfiguration(): Promise<ApricartWarehouseConfiguration> {
  const [warehouseRows, membershipRows, accountRows, routeRows, branchRows, selectionRows, rules, cityOptionRows, unrouted] = await Promise.all([
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
        id: apricartWarehouseMemberships.id,
        warehouseId: apricartWarehouseMemberships.warehouseId,
        userId: apricartWarehouseMemberships.userId,
        responsibility: apricartWarehouseMemberships.responsibility,
        branchScope: apricartWarehouseMemberships.branchScope,
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
      .select({
        id: branches.id,
        organizationId: branches.organizationId,
        warehouseId: sql<number | null>`${branchWarehouseSql()}`,
      })
      .from(branches)
      .where(eq(branches.status, "active"))
      .orderBy(asc(branches.id))
      .limit(BRANCH_LIMIT),
    db
      .select({ membershipId: apricartWarehouseMemberBranches.membershipId, branchId: apricartWarehouseMemberBranches.branchId })
      .from(apricartWarehouseMemberBranches)
      .limit(ROUTE_LIMIT),
    loadRuleViews(),
    db
      .select({
        organizationId: branches.organizationId,
        cityKey: sql<string>`${branchCityKeySql(branches.city)}`,
        label: sql<string>`min(${branchCityLabelSql(branches.city)})`,
        branchCount: sql<number>`count(*)::int`,
      })
      .from(branches)
      .where(and(eq(branches.status, "active"), sql`coalesce(${branchCityKeySql(branches.city)}, '') <> ''`))
      .groupBy(branches.organizationId, sql`${branchCityKeySql(branches.city)}`)
      .limit(BRANCH_LIMIT),
    loadUnroutedOrders(),
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

  // Each active branch's warehouse now — by manual route or rule — which is
  // what the report compares today's account reach with.
  const liveBranches = branchRows.flatMap((branch) => branch.organizationId === null
    ? []
    : [{ id: branch.id, organizationId: branch.organizationId, warehouseId: branch.warehouseId === null ? null : Number(branch.warehouseId) }])
  const coverageEntries: BranchCoverageEntry[] = liveBranches.map((branch) => {
    const servingAccountIds = (servingByBranch.get(branch.id) ?? []).sort((a, b) => a.localeCompare(b))
    return {
      branchId: branch.id,
      organizationId: branch.organizationId,
      servingAccountIds,
      ...classifyBranchCoverage({
        routeWarehouseId: branch.warehouseId,
        servingAccountIds,
        operatorWarehouses,
      }),
    }
  })

  const executiveIds = [...new Set(membershipRows
    .filter((row) => row.responsibility === "EXECUTIVE" && activeAccountIds.has(row.userId))
    .map((row) => row.userId))]
  const executiveAssignmentRows = executiveIds.length === 0
    ? []
    : await db
      .select({ userId: apricartExecutiveAssignments.userId, organizationId: apricartExecutiveAssignments.organizationId })
      .from(apricartExecutiveAssignments)
      .where(inArray(apricartExecutiveAssignments.userId, executiveIds))

  const selectedByMembership = new Map<number, number[]>()
  for (const row of selectionRows) {
    selectedByMembership.set(row.membershipId, [...(selectedByMembership.get(row.membershipId) ?? []), row.branchId])
  }

  return {
    ownershipMode: WAREHOUSE_ORDER_OWNERSHIP,
    warehouses: warehouseRows.map((warehouse) => {
      const members = membershipRows
        .filter((row) => row.warehouseId === warehouse.id)
        .map((row) => ({
          userId: row.userId,
          responsibility: row.responsibility as WarehouseResponsibility,
          branchScope: row.branchScope as WarehouseMemberScope,
          selectedBranchIds: (selectedByMembership.get(row.id) ?? []).sort((a, b) => a - b),
        }))
      const inWarehouse = liveBranches.filter((branch) => branch.warehouseId === warehouse.id)
      const executiveMembers = members
        .filter((member) => member.responsibility === "EXECUTIVE" && activeAccountIds.has(member.userId))
        .map((member) => member.userId)
      return {
        ...warehouse,
        status: warehouse.status as ApricartWarehouseStatus,
        members,
        routedBranchCount: routeRows.filter((row) => row.warehouseId === warehouse.id).length,
        ruleCount: rules.filter((rule) => rule.warehouseId === warehouse.id).length,
        branchCount: inWarehouse.length,
        executiveGapOrganizationIds: executiveCoverageGaps({
          routedOrganizationIds: inWarehouse.map((branch) => branch.organizationId),
          executiveOrganizationIds: executiveMembers.map((userId) => executiveAssignmentRows
            .filter((row) => row.userId === userId)
            .map((row) => row.organizationId)),
        }),
      }
    }),
    accounts,
    routes: routeRows,
    rules,
    cityOptions: cityOptionRows.flatMap((row) => row.organizationId === null || !row.cityKey
      ? []
      : [{ organizationId: row.organizationId, cityKey: row.cityKey, label: row.label, branchCount: Number(row.branchCount) }]),
    branchWarehouses: liveBranches.flatMap((branch) => branch.warehouseId === null ? [] : [{ branchId: branch.id, warehouseId: branch.warehouseId }]),
    unrouted,
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
      const [{ ruled }] = await tx
        .select({ ruled: count() })
        .from(warehouseRouteRules)
        .where(eq(warehouseRouteRules.warehouseId, input.warehouseId))
      if (routed > 0 || ruled > 0) {
        return { kind: "conflict", message: "Move this warehouse's branches to another warehouse before deactivating it" }
      }
      if (await countOpenTransferredOrders(tx, input.warehouseId) > 0) {
        return { kind: "conflict", message: "Orders transferred to this warehouse are still open — transfer them elsewhere before deactivating it" }
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

/** Orders transferred to this warehouse that still need it: pending or approved, not yet fulfilled. */
async function countOpenTransferredOrders(tx: Transaction, warehouseId: number): Promise<number> {
  const [{ open }] = await tx
    .select({ open: count() })
    .from(orders)
    .where(and(
      eq(orders.fulfillmentWarehouseId, warehouseId),
      sql`UPPER(${orders.status}) IN ('PENDING', 'APPROVED')`,
    ))
  return Number(open)
}

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

/**
 * Whether removing this account leaves the warehouse's open transferred orders
 * with no active operator. Checked under the warehouse's FOR UPDATE, which a
 * transfer onto the warehouse waits on (it takes FOR SHARE).
 */
async function strandsTransferredOrders(tx: Transaction, input: { warehouseId: number; userId: string }): Promise<boolean> {
  const [{ others }] = await tx
    .select({ others: count() })
    .from(apricartWarehouseMemberships)
    .innerJoin(users, eq(users.id, apricartWarehouseMemberships.userId))
    .innerJoin(roles, eq(roles.id, users.roleId))
    .where(and(
      eq(apricartWarehouseMemberships.warehouseId, input.warehouseId),
      eq(apricartWarehouseMemberships.responsibility, "WAREHOUSE_OPERATOR"),
      ne(apricartWarehouseMemberships.userId, input.userId),
      eq(roles.name, WAREHOUSE_ROLE),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
  return Number(others) === 0 && await countOpenTransferredOrders(tx, input.warehouseId) > 0
}

async function removeMember(tx: Transaction, input: { warehouseId: number; userId: string }): Promise<"changed" | "unchanged" | WarehouseMemberOutcome> {
  if (await strandsTransferredOrders(tx, input)) {
    return {
      kind: "conflict",
      message: "This is the last active operator of a warehouse with open transferred orders — add another operator or transfer the orders first",
    }
  }
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
  | { kind: "conflict"; message: string }

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
  mode?: WarehouseOrderOwnershipMode
}): Promise<WarehouseMemberOutcome> {
  try {
    return await setApricartWarehouseMemberInTx(input)
  } catch (error) {
    if (error instanceof StrandedBranchesError) return { kind: "conflict", message: error.message }
    throw error
  }
}

async function setApricartWarehouseMemberInTx(input: {
  warehouseId: number
  userId: string
  assigned: boolean
  actor: Actor
  mode?: WarehouseOrderOwnershipMode
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

    // Removing an operator can leave branches nobody works once membership decides.
    const checkStrands = input.assigned
      ? async () => {}
      : await strandGuard(tx, [input.warehouseId], input.mode ?? WAREHOUSE_ORDER_OWNERSHIP)
    const change = input.assigned
      ? await addMember(tx, { ...input, responsibility, isActive: Boolean(account.isActive), memberCount: before.length, alreadyMember: before.includes(input.userId) })
      : await removeMember(tx, input)
    if (change !== "changed" && change !== "unchanged") return change
    await checkStrands()

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

// ---------------------------------------------------------------------------
// Phase 2: rules, member scope, and the strand guard.
// See plans/OF-WAREHOUSE-order-ownership-and-transfer.md (phase 2).
// ---------------------------------------------------------------------------

/** Thrown inside a transaction to roll back a change that would strand branches. */
class StrandedBranchesError extends Error {}

const STRANDED_MESSAGE =
  "This would leave branches in a warehouse that no active operator works — add an operator or widen a scope first"

async function strandedCounts(tx: Transaction, warehouseIds: readonly number[]): Promise<Map<number, number>> {
  const counts = new Map<number, number>()
  for (const warehouseId of [...new Set(warehouseIds)].sort((a, b) => a - b)) {
    counts.set(warehouseId, await countStrandedBranches(tx, warehouseId))
  }
  return counts
}

/**
 * While membership decides who works an order, a change may not raise the
 * number of active branches nobody works in any warehouse it touches. Branches
 * stranded before the change do not block it. In the "branch" mode nothing
 * reads membership, so nothing is checked: `check:warehouse-ownership` is the
 * gate before the switch.
 */
async function strandGuard(
  tx: Transaction,
  warehouseIds: readonly number[],
  mode: WarehouseOrderOwnershipMode,
): Promise<() => Promise<void>> {
  if (!readsWarehouseMembership(mode)) return async () => {}
  const before = await strandedCounts(tx, warehouseIds)
  return async () => {
    const after = await strandedCounts(tx, warehouseIds)
    for (const [warehouseId, stranded] of after) {
      if (stranded > (before.get(warehouseId) ?? 0)) throw new StrandedBranchesError(STRANDED_MESSAGE)
    }
  }
}

/** The city key of a typed or listed city, computed in SQL only; null when blank. */
async function cityKeyOf(tx: Transaction, city: string): Promise<string | null> {
  const [row] = (await tx.execute<{ key: string | null }>(sql`SELECT ${branchCityKeySql(city)} AS key`)).rows
  const key = row?.key ?? null
  return key && key.trim() !== "" ? key : null
}

export type RouteRuleOutcome =
  | {
    kind: "updated"
    changed: boolean
    rule: { warehouseId: number; organizationId: number; cityKey: string | null }
    assigned: boolean
    movedFromWarehouseId: number | null
  }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string }
  | { kind: "limit" }

const RULE_RACE_MESSAGE = "This rule changed while it was being saved — reload and try again"

/**
 * Put every branch of an organization — or of an organization in one city —
 * in this warehouse, or take that rule away. A rule another warehouse holds
 * moves here, and the audit row says where from; both warehouses are locked,
 * in id order. Removing only ever removes this warehouse's own rule.
 * Idempotent. Audited `UPDATE_WAREHOUSE_ROUTE_RULES` inside the change.
 */
export async function setWarehouseRouteRule(input: {
  warehouseId: number
  organizationId: number
  /** Null: every branch of the organization. Any spelling: the key is computed in SQL. */
  city: string | null
  assigned: boolean
  actor: Actor
  mode?: WarehouseOrderOwnershipMode
}): Promise<RouteRuleOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
      if (!organization) return { kind: "invalid", message: "The organization does not exist" } as const

      const cityKey = input.city === null ? null : await cityKeyOf(tx, input.city)
      if (input.city !== null && cityKey === null) return { kind: "invalid", message: "Name a city" } as const

      const holder = () => tx
        .select({ id: warehouseRouteRules.id, warehouseId: warehouseRouteRules.warehouseId })
        .from(warehouseRouteRules)
        .where(and(
          eq(warehouseRouteRules.organizationId, input.organizationId),
          cityKey === null ? isNull(warehouseRouteRules.cityKey) : eq(warehouseRouteRules.cityKey, cityKey),
        ))
        .limit(1)
      const [initial] = await holder()

      // Both warehouses, in id order, so two moves between them cannot deadlock;
      // the reach takes them FOR SHARE, so in-flight warehouse writes finish first.
      const lockIds = [...new Set([input.warehouseId, ...(initial ? [initial.warehouseId] : [])])].sort((a, b) => a - b)
      const locked = await tx
        .select({ id: apricartWarehouses.id, status: apricartWarehouses.status })
        .from(apricartWarehouses)
        .where(inArray(apricartWarehouses.id, lockIds))
        .orderBy(asc(apricartWarehouses.id))
        .for("update")
      const target = locked.find((warehouse) => warehouse.id === input.warehouseId)
      if (!target) return { kind: "not-found" } as const

      const [existing] = await holder().for("update")
      if ((existing?.warehouseId ?? null) !== (initial?.warehouseId ?? null)) {
        return { kind: "conflict", message: RULE_RACE_MESSAGE } as const
      }

      const rule = { warehouseId: input.warehouseId, organizationId: input.organizationId, cityKey }
      const unchanged = { kind: "updated", changed: false, rule, assigned: input.assigned, movedFromWarehouseId: null } as const
      if (input.assigned && existing?.warehouseId === input.warehouseId) return unchanged
      if (!input.assigned && existing?.warehouseId !== input.warehouseId) return unchanged
      if (input.assigned && target.status !== "ACTIVE") {
        return { kind: "conflict", message: "An inactive warehouse cannot take new branches" } as const
      }

      const checkStrands = await strandGuard(tx, lockIds, input.mode ?? WAREHOUSE_ORDER_OWNERSHIP)
      let movedFromWarehouseId: number | null = null
      if (input.assigned && existing) {
        movedFromWarehouseId = existing.warehouseId
        await tx.update(warehouseRouteRules).set({ warehouseId: input.warehouseId }).where(eq(warehouseRouteRules.id, existing.id))
      } else if (input.assigned) {
        const [{ total }] = await tx.select({ total: count() }).from(warehouseRouteRules)
        if (total >= WAREHOUSE_ROUTE_RULE_MAX) return { kind: "limit" } as const
        await tx.insert(warehouseRouteRules).values({ ...rule, createdByUserId: input.actor.id })
      } else if (existing) {
        await tx.delete(warehouseRouteRules).where(eq(warehouseRouteRules.id, existing.id))
      }
      await checkStrands()

      await recordAuditEvent(tx, {
        action: UPDATE_WAREHOUSE_ROUTE_RULES_AUDIT_ACTION,
        entity: "apricart_warehouse",
        entityId: input.warehouseId,
        actor: input.actor,
        organizationId: input.organizationId,
        before: { warehouseId: existing?.warehouseId ?? null },
        after: { warehouseId: input.assigned ? input.warehouseId : null },
        context: { organizationId: input.organizationId, cityKey, assigned: input.assigned, movedFromWarehouseId },
      })
      return { kind: "updated", changed: true, rule, assigned: input.assigned, movedFromWarehouseId } as const
    })
  } catch (error) {
    if (error instanceof StrandedBranchesError) return { kind: "conflict", message: error.message }
    if (isUniqueViolation(error)) return { kind: "conflict", message: RULE_RACE_MESSAGE }
    throw error
  }
}

export type MemberScopeOutcome =
  | { kind: "updated"; changed: boolean; userId: string; branchScope: WarehouseMemberScope; selectedBranchIds: number[] }
  | { kind: "not-found" }
  | { kind: "member-not-found" }
  | { kind: "invalid"; message: string }
  | { kind: "conflict"; message: string }

/**
 * Which of the warehouse's branches one operator works: all of them, or — one
 * organization at a time, so the body stays under the WAF's 8 KB — a
 * selection. Every selected branch must be in this warehouse now. Audited
 * `UPDATE_APRICART_WAREHOUSE_MEMBER_SCOPE` inside the change.
 */
export async function setWarehouseMemberScope(input: {
  warehouseId: number
  userId: string
  scope: WarehouseMemberScope
  /** For `SELECTED`: the organization whose part of the selection this replaces. */
  organizationId?: number
  branchIds?: readonly number[]
  actor: Actor
  mode?: WarehouseOrderOwnershipMode
}): Promise<MemberScopeOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const [warehouse] = await tx
        .select({ id: apricartWarehouses.id })
        .from(apricartWarehouses)
        .where(eq(apricartWarehouses.id, input.warehouseId))
        .for("update")
        .limit(1)
      if (!warehouse) return { kind: "not-found" } as const

      const [membership] = await tx
        .select({
          id: apricartWarehouseMemberships.id,
          responsibility: apricartWarehouseMemberships.responsibility,
          branchScope: apricartWarehouseMemberships.branchScope,
        })
        .from(apricartWarehouseMemberships)
        .where(and(
          eq(apricartWarehouseMemberships.warehouseId, input.warehouseId),
          eq(apricartWarehouseMemberships.userId, input.userId),
        ))
        .for("update")
        .limit(1)
      if (!membership) return { kind: "member-not-found" } as const
      if (membership.responsibility !== "WAREHOUSE_OPERATOR") {
        return { kind: "invalid", message: "Only an operator works selected branches; an executive is always all" } as const
      }

      const selection = async () => (await tx
        .select({ branchId: apricartWarehouseMemberBranches.branchId })
        .from(apricartWarehouseMemberBranches)
        .where(eq(apricartWarehouseMemberBranches.membershipId, membership.id)))
        .map((row) => row.branchId)
        .sort((a, b) => a - b)
      const before = await selection()

      if (input.scope === "ALL" && membership.branchScope === "ALL" && before.length === 0) {
        return { kind: "updated", changed: false, userId: input.userId, branchScope: "ALL", selectedBranchIds: [] } as const
      }
      const organizationId = input.organizationId
      const branchIds = [...new Set(input.branchIds ?? [])].sort((a, b) => a - b)
      if (input.scope === "SELECTED") {
        if (organizationId === undefined) return { kind: "invalid", message: "Name the organization" } as const
        const inWarehouse = branchIds.length === 0
          ? []
          : await tx
            .select({ id: branches.id })
            .from(branches)
            .where(and(
              inArray(branches.id, branchIds),
              eq(branches.organizationId, organizationId),
              sql`${branchWarehouseSql()} = ${input.warehouseId}`,
            ))
        if (inWarehouse.length !== branchIds.length) {
          return { kind: "invalid", message: "Every selected branch must be one of this organization's branches in this warehouse" } as const
        }
      }

      const checkStrands = await strandGuard(tx, [input.warehouseId], input.mode ?? WAREHOUSE_ORDER_OWNERSHIP)
      if (input.scope === "ALL") {
        await tx.delete(apricartWarehouseMemberBranches).where(eq(apricartWarehouseMemberBranches.membershipId, membership.id))
      } else {
        await tx.delete(apricartWarehouseMemberBranches).where(and(
          eq(apricartWarehouseMemberBranches.membershipId, membership.id),
          sql`${apricartWarehouseMemberBranches.branchId} IN (SELECT b."id" FROM "branches" b WHERE b."organization_id" = ${organizationId})`,
        ))
        if (branchIds.length > 0) {
          await tx.insert(apricartWarehouseMemberBranches)
            .values(branchIds.map((branchId) => ({ membershipId: membership.id, branchId, createdByUserId: input.actor.id })))
        }
      }
      await tx.update(apricartWarehouseMemberships)
        .set({ branchScope: input.scope })
        .where(eq(apricartWarehouseMemberships.id, membership.id))
      const after = await selection()
      await checkStrands()

      const changed = membership.branchScope !== input.scope || before.join(",") !== after.join(",")
      if (changed) {
        await recordAuditEvent(tx, {
          action: UPDATE_APRICART_WAREHOUSE_MEMBER_SCOPE_AUDIT_ACTION,
          entity: "apricart_warehouse",
          entityId: input.warehouseId,
          actor: input.actor,
          ...(organizationId === undefined ? {} : { organizationId }),
          before: { branchScope: membership.branchScope, branchIds: before },
          after: { branchScope: input.scope, branchIds: after },
          context: { userId: input.userId },
        })
      }
      return { kind: "updated", changed, userId: input.userId, branchScope: input.scope, selectedBranchIds: after } as const
    })
  } catch (error) {
    if (error instanceof StrandedBranchesError) return { kind: "conflict", message: error.message }
    throw error
  }
}
