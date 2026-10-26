import "server-only"

import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm"

import {
  branches,
  organizations,
  roles,
  users,
  warehouseAssignments,
  warehouseCityAssignments,
  warehouseCityOrganizations,
} from "@/db/schema"
import { db } from "@/lib/db"
import {
  WAREHOUSE_ASSIGNMENT_AUDIT_ACTION,
  WAREHOUSE_CITY_ASSIGNMENT_AUDIT_ACTION,
  WAREHOUSE_CITY_MAX_PER_USER,
  WAREHOUSE_CITY_ORGANIZATION_AUDIT_ACTION,
  WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER,
  WAREHOUSE_ROLE,
} from "@/lib/warehouse-access"
import { recordAuditEvent, type AuditActor } from "@/lib/server/activity-audit"
import { branchCityKeySql, branchCityLabelSql } from "@/lib/server/branch-city-key"

/**
 * Super Admin's view of the warehouse: every warehouse account and the branches
 * each one serves, plus every branch that can be assigned.
 *
 * Reach is branches — never an organization — assigned one by one, or as
 * whole cities of chosen organizations: a branch opened later in an assigned
 * city of a chosen organization is served at once, any other only once it is
 * assigned. See plans/OF-WAREHOUSE-warehouse-fulfilment-role.md,
 * plans/OF-WAREHOUSE-city-assignments.md and
 * plans/OF-WAREHOUSE-city-assignments-by-organization.md.
 */

export type WarehouseTeamMember = {
  id: string
  fullName: string | null
  username: string | null
  email: string
  isActive: boolean
  /** Branches assigned one by one. */
  branchIds: number[]
  /** Whole cities assigned, as normalised keys. */
  cityKeys: string[]
  /** The organizations those cities apply to; none means the cities reach nothing. */
  cityOrganizationIds: number[]
}

export type WarehouseAssignableOrganization = { id: number; name: string; code: string | null; status: string | null }

export type WarehouseAssignableBranch = {
  id: number
  organizationId: number
  name: string
  city: string | null
  /** The normalised city, computed in SQL; null when the branch has none. */
  cityKey: string | null
  status: string | null
}

/**
 * One city, across every organization; `label` is its most common spelling.
 * `organizations` breaks the branch count down by organization, so the dialog
 * can narrow the list to the chosen organizations without the branch list.
 */
export type WarehouseAssignableCity = {
  key: string
  label: string
  branchCount: number
  organizationCount: number
  organizations: Array<{ organizationId: number; branchCount: number }>
}

export type WarehouseTeam = {
  members: WarehouseTeamMember[]
  organizations: WarehouseAssignableOrganization[]
  branches: WarehouseAssignableBranch[]
  cities: WarehouseAssignableCity[]
}

/** Bounded like every other list. */
const WAREHOUSE_TEAM_LIMIT = 200
const ORGANIZATION_LIMIT = 500
const BRANCH_LIMIT = 5000
const CITY_LIMIT = 2000
const CITY_ORGANIZATION_LIMIT = 10000

export async function loadWarehouseTeam(): Promise<WarehouseTeam> {
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
    .where(and(eq(roles.name, WAREHOUSE_ROLE), isNull(users.deletedAt)))
    .orderBy(asc(users.fullName))
    .limit(WAREHOUSE_TEAM_LIMIT)

  const memberIds = memberRows.map((member) => member.id)
  const cityKey = branchCityKeySql(branches.city)
  const [
    assignmentRows,
    cityAssignmentRows,
    cityOrganizationRows,
    organizationRows,
    branchRows,
    cityRows,
    cityOrganizationCountRows,
  ] = await Promise.all([
    memberIds.length === 0
      ? []
      : db
        .select({ userId: warehouseAssignments.userId, branchId: warehouseAssignments.branchId })
        .from(warehouseAssignments)
        .where(inArray(warehouseAssignments.userId, memberIds)),
    memberIds.length === 0
      ? []
      : db
        .select({ userId: warehouseCityAssignments.userId, cityKey: warehouseCityAssignments.cityKey })
        .from(warehouseCityAssignments)
        .where(inArray(warehouseCityAssignments.userId, memberIds)),
    memberIds.length === 0
      ? []
      : db
        .select({ userId: warehouseCityOrganizations.userId, organizationId: warehouseCityOrganizations.organizationId })
        .from(warehouseCityOrganizations)
        .where(inArray(warehouseCityOrganizations.userId, memberIds)),
    db
      .select({ id: organizations.id, name: organizations.name, code: organizations.code, status: organizations.status })
      .from(organizations)
      .orderBy(asc(organizations.name))
      .limit(ORGANIZATION_LIMIT),
    db
      .select({
        id: branches.id,
        organizationId: branches.organizationId,
        name: branches.name,
        city: branches.city,
        cityKey: sql<string | null>`nullif(${cityKey}, '')`,
        status: branches.status,
      })
      .from(branches)
      .orderBy(asc(branches.name))
      .limit(BRANCH_LIMIT),
    // Aggregated here, one row per city, so the list is complete however many
    // branches there are — never derived in the browser from the capped list.
    db
      .select({
        key: sql<string>`${cityKey}`,
        label: sql<string>`mode() within group (order by ${branchCityLabelSql(branches.city)})`,
        branchCount: sql<number>`count(*)::int`,
        organizationCount: sql<number>`count(distinct ${branches.organizationId})::int`,
      })
      .from(branches)
      .where(ne(cityKey, ""))
      .groupBy(cityKey)
      .limit(CITY_LIMIT),
    db
      .select({
        key: sql<string>`${cityKey}`,
        organizationId: branches.organizationId,
        branchCount: sql<number>`count(*)::int`,
      })
      .from(branches)
      .where(ne(cityKey, ""))
      .groupBy(cityKey, branches.organizationId)
      .limit(CITY_ORGANIZATION_LIMIT),
  ])

  const organizationsByCity = new Map<string, WarehouseAssignableCity["organizations"]>()
  for (const row of cityOrganizationCountRows) {
    const list = organizationsByCity.get(row.key) ?? []
    list.push({ organizationId: row.organizationId, branchCount: row.branchCount })
    organizationsByCity.set(row.key, list)
  }

  return {
    members: memberRows.map((member) => ({
      ...member,
      branchIds: assignmentRows
        .filter((row) => row.userId === member.id)
        .map((row) => row.branchId)
        .sort((a, b) => a - b),
      cityKeys: cityAssignmentRows
        .filter((row) => row.userId === member.id)
        .map((row) => row.cityKey)
        .sort((a, b) => a.localeCompare(b)),
      cityOrganizationIds: cityOrganizationRows
        .filter((row) => row.userId === member.id)
        .map((row) => row.organizationId)
        .sort((a, b) => a - b),
    })),
    organizations: organizationRows,
    branches: branchRows,
    cities: withAssignedCities(
      cityRows.map((row) => ({
        ...row,
        organizations: (organizationsByCity.get(row.key) ?? []).sort((a, b) => a.organizationId - b.organizationId),
      })),
      cityAssignmentRows.map((row) => row.cityKey),
    ),
  }
}

/**
 * Every city with a branch, plus any assigned city that has none left (its
 * branches renamed or moved) so Super Admin can still see and withdraw it.
 */
function withAssignedCities(rows: WarehouseAssignableCity[], assignedKeys: string[]): WarehouseAssignableCity[] {
  const known = new Set(rows.map((row) => row.key))
  const orphaned = [...new Set(assignedKeys)]
    .filter((key) => !known.has(key))
    .map((key) => ({ key, label: key, branchCount: 0, organizationCount: 0, organizations: [] }))
  return [...rows, ...orphaned].sort((a, b) => a.label.localeCompare(b.label))
}

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Row-locks the target account and confirms it is an undeleted warehouse
 * account. Every change to one person's reach takes this lock first, so two
 * changes for the same person serialize and the caps hold. False is answered
 * as "not found", so no route can probe other accounts with it.
 */
async function lockWarehouseTarget(tx: Transaction, userId: string): Promise<boolean> {
  const [target] = await tx
    .select({ role: roles.name, deletedAt: users.deletedAt })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(eq(users.id, userId))
    .for("update", { of: users })
    .limit(1)
  return Boolean(target && target.role === WAREHOUSE_ROLE && target.deletedAt === null)
}

export type WarehouseAssignmentOutcome =
  | { kind: "updated"; branchIds: number[] }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }

/**
 * Replace the branches one warehouse user serves **in one organization**, in
 * one transaction, audited with the before and after. Branches in other
 * organizations are untouched. The target must be an undeleted warehouse
 * account (otherwise "not found", so this cannot probe other accounts), the
 * organization must exist, and every branch must belong to it.
 */
export async function replaceWarehouseBranches(input: {
  userId: string
  organizationId: number
  branchIds: number[]
  actor: AuditActor & { id: string }
}): Promise<WarehouseAssignmentOutcome> {
  return db.transaction(async (tx) => {
    // Serializes two concurrent replacements for the same person.
    if (!(await lockWarehouseTarget(tx, input.userId))) return { kind: "not-found" }

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

    const before = organizationBranchIds.length === 0
      ? []
      : (await tx
        .select({ branchId: warehouseAssignments.branchId })
        .from(warehouseAssignments)
        .where(and(
          eq(warehouseAssignments.userId, input.userId),
          inArray(warehouseAssignments.branchId, organizationBranchIds),
        )))
        .map((row) => row.branchId)
        .sort((a, b) => a - b)

    // A write in flight holds FOR SHARE on the row it relies on, so a removal
    // here waits for it to commit rather than racing past it.
    if (organizationBranchIds.length > 0) {
      await tx.delete(warehouseAssignments).where(and(
        eq(warehouseAssignments.userId, input.userId),
        inArray(warehouseAssignments.branchId, organizationBranchIds),
      ))
    }
    if (branchIds.length > 0) {
      await tx.insert(warehouseAssignments).values(branchIds.map((branchId) => ({
        userId: input.userId,
        branchId,
        createdByUserId: input.actor.id,
      })))
    }

    await recordAuditEvent(tx, {
      action: WAREHOUSE_ASSIGNMENT_AUDIT_ACTION,
      entity: "user",
      entityId: input.userId,
      actor: input.actor,
      organizationId: input.organizationId,
      before: { branchIds: before },
      after: { branchIds },
    })

    return { kind: "updated", branchIds }
  })
}

export type WarehouseCityOutcome =
  | { kind: "updated"; city: { key: string; label: string }; assigned: boolean; branchCount: number }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }
  | { kind: "limit" }

/**
 * Assign or withdraw one whole city for one warehouse user, in one
 * transaction, audited with the before and after. Idempotent: assigning an
 * assigned city or withdrawing one that is not assigned changes and records
 * nothing.
 *
 * The city is matched by its key in SQL (`branchCityKeySql`), so any spelling
 * of it names the same city. A city reaches only the branches of the
 * organizations chosen for the user (`setWarehouseCityOrganization`), so
 * assigning needs at least one branch in it now **in one of those
 * organizations** — choose the organizations first; a city none of them has is
 * a typo, not a plan. Withdrawing needs nothing, so a city whose branches have
 * all been renamed, or whose organization was withdrawn, can still be removed.
 * The target must be an undeleted warehouse account ("not found" otherwise, so
 * this cannot probe other accounts). See plans/OF-WAREHOUSE-city-assignments.md
 * and plans/OF-WAREHOUSE-city-assignments-by-organization.md.
 */
export async function setWarehouseCity(input: {
  userId: string
  city: string
  assigned: boolean
  actor: AuditActor & { id: string }
}): Promise<WarehouseCityOutcome> {
  return db.transaction(async (tx) => {
    // Serializes two concurrent changes for the same person, so the cap holds.
    if (!(await lockWarehouseTarget(tx, input.userId))) return { kind: "not-found" }

    const cityKey = branchCityKeySql(branches.city)
    const requestedKey = branchCityKeySql(input.city)
    // The city's branches in the user's chosen organizations: the ones it reaches.
    const [match] = await tx
      .select({
        key: sql<string>`${cityKey}`,
        label: sql<string>`mode() within group (order by ${branchCityLabelSql(branches.city)})`,
        branchCount: sql<number>`count(*)::int`,
      })
      .from(branches)
      .innerJoin(warehouseCityOrganizations, and(
        eq(warehouseCityOrganizations.userId, input.userId),
        eq(warehouseCityOrganizations.organizationId, branches.organizationId),
      ))
      .where(and(eq(cityKey, requestedKey), ne(cityKey, "")))
      .groupBy(cityKey)
      .limit(1)

    const before = (await tx
      .select({ cityKey: warehouseCityAssignments.cityKey })
      .from(warehouseCityAssignments)
      .where(eq(warehouseCityAssignments.userId, input.userId)))
      .map((row) => row.cityKey)
      .sort((a, b) => a.localeCompare(b))

    let city: { key: string; label: string }
    let changed: boolean
    if (input.assigned) {
      if (!match) return { kind: "invalid", message: "No branch of the chosen organizations is in that city" }
      city = { key: match.key, label: match.label }
      changed = !before.includes(match.key)
      if (changed && before.length >= WAREHOUSE_CITY_MAX_PER_USER) return { kind: "limit" }
      if (changed) {
        await tx.insert(warehouseCityAssignments)
          .values({ userId: input.userId, cityKey: match.key, createdByUserId: input.actor.id })
          .onConflictDoNothing()
      }
    } else {
      // A write in flight holds FOR SHARE on this row, so the removal waits for it.
      const removed = await tx.delete(warehouseCityAssignments)
        .where(and(eq(warehouseCityAssignments.userId, input.userId), eq(warehouseCityAssignments.cityKey, requestedKey)))
        .returning({ cityKey: warehouseCityAssignments.cityKey })
      changed = removed.length > 0
      const key = removed[0]?.cityKey ?? match?.key ?? input.city
      city = { key, label: match?.label ?? key }
    }

    const branchCount = match?.branchCount ?? 0
    if (changed) {
      const after = input.assigned
        ? [...before, city.key].sort((a, b) => a.localeCompare(b))
        : before.filter((key) => key !== city.key)
      await recordAuditEvent(tx, {
        action: WAREHOUSE_CITY_ASSIGNMENT_AUDIT_ACTION,
        entity: "user",
        entityId: input.userId,
        actor: input.actor,
        // A city spans the chosen organizations and changes with them: no single one.
        before: { cityKeys: before },
        after: { cityKeys: after },
        context: { city: city.key, assigned: input.assigned, branchCount },
      })
    }

    return { kind: "updated", city, assigned: input.assigned, branchCount }
  })
}

export type WarehouseCityOrganizationOutcome =
  | { kind: "updated"; organizationId: number; assigned: boolean; organizationIds: number[] }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }
  | { kind: "limit" }

/**
 * Choose or withdraw one organization a warehouse user's cities apply to, in
 * one transaction, audited with the before and after on that organization.
 * Idempotent: choosing a chosen organization or withdrawing one that is not
 * chosen changes and records nothing.
 *
 * The organization grants nothing by itself — the user's cities reach the
 * branches of the chosen organizations only — and withdrawing it leaves the
 * cities assigned, because they may still serve another organization. The
 * target is row-locked exactly as `setWarehouseCity` locks it, so a city and
 * an organization change for the same person serialize. See
 * plans/OF-WAREHOUSE-city-assignments-by-organization.md.
 */
export async function setWarehouseCityOrganization(input: {
  userId: string
  organizationId: number
  assigned: boolean
  actor: AuditActor & { id: string }
}): Promise<WarehouseCityOrganizationOutcome> {
  return db.transaction(async (tx) => {
    if (!(await lockWarehouseTarget(tx, input.userId))) return { kind: "not-found" }

    const before = (await tx
      .select({ organizationId: warehouseCityOrganizations.organizationId })
      .from(warehouseCityOrganizations)
      .where(eq(warehouseCityOrganizations.userId, input.userId)))
      .map((row) => row.organizationId)
      .sort((a, b) => a - b)

    let changed: boolean
    if (input.assigned) {
      const [organization] = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, input.organizationId))
        .limit(1)
      if (!organization) return { kind: "invalid", message: "The organization does not exist" }
      changed = !before.includes(input.organizationId)
      if (changed && before.length >= WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER) return { kind: "limit" }
      if (changed) {
        await tx.insert(warehouseCityOrganizations)
          .values({ userId: input.userId, organizationId: input.organizationId, createdByUserId: input.actor.id })
          .onConflictDoNothing()
      }
    } else {
      // A write in flight holds FOR SHARE on this row, so the removal waits for it.
      const removed = await tx.delete(warehouseCityOrganizations)
        .where(and(
          eq(warehouseCityOrganizations.userId, input.userId),
          eq(warehouseCityOrganizations.organizationId, input.organizationId),
        ))
        .returning({ organizationId: warehouseCityOrganizations.organizationId })
      changed = removed.length > 0
    }

    const after = input.assigned
      ? [...new Set([...before, input.organizationId])].sort((a, b) => a - b)
      : before.filter((id) => id !== input.organizationId)
    if (changed) {
      const cityKeys = (await tx
        .select({ cityKey: warehouseCityAssignments.cityKey })
        .from(warehouseCityAssignments)
        .where(eq(warehouseCityAssignments.userId, input.userId)))
        .map((row) => row.cityKey)
        .sort((a, b) => a.localeCompare(b))
      await recordAuditEvent(tx, {
        action: WAREHOUSE_CITY_ORGANIZATION_AUDIT_ACTION,
        entity: "user",
        entityId: input.userId,
        actor: input.actor,
        organizationId: input.organizationId,
        before: { organizationIds: before },
        after: { organizationIds: after },
        context: { organizationId: input.organizationId, assigned: input.assigned, cityKeys },
      })
    }

    return { kind: "updated", organizationId: input.organizationId, assigned: input.assigned, organizationIds: after }
  })
}

export type WarehouseBulkOutcome<Item> =
  | { kind: "updated"; assigned: boolean; changed: Item[]; after: Item[] }
  | { kind: "not-found" }
  | { kind: "invalid"; message: string }
  | { kind: "limit" }

/**
 * "Select all" / "Unselect all" for the organizations a warehouse user's cities
 * apply to: `setWarehouseCityOrganization` for several organizations, in one
 * transaction under the same lock, all or nothing. An organization already in
 * the wanted state changes nothing. Each organization that does change gets the
 * audit row a single tick would have written, in id order, so the trail — and
 * each tenant's own activity log — reads exactly as if they had been ticked one
 * by one. See plans/OF-WAREHOUSE-city-bulk-select.md.
 */
export async function setWarehouseCityOrganizations(input: {
  userId: string
  organizationIds: number[]
  assigned: boolean
  actor: AuditActor & { id: string }
}): Promise<WarehouseBulkOutcome<number>> {
  return db.transaction(async (tx) => {
    if (!(await lockWarehouseTarget(tx, input.userId))) return { kind: "not-found" }

    const requested = [...new Set(input.organizationIds)].sort((a, b) => a - b)
    const before = (await tx
      .select({ organizationId: warehouseCityOrganizations.organizationId })
      .from(warehouseCityOrganizations)
      .where(eq(warehouseCityOrganizations.userId, input.userId)))
      .map((row) => row.organizationId)
      .sort((a, b) => a - b)

    let changed: number[]
    if (input.assigned) {
      const existing = await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(inArray(organizations.id, requested))
      if (existing.length !== requested.length) return { kind: "invalid", message: "One or more organizations do not exist" }
      changed = requested.filter((id) => !before.includes(id))
      if (before.length + changed.length > WAREHOUSE_CITY_ORGANIZATION_MAX_PER_USER) return { kind: "limit" }
      if (changed.length > 0) {
        await tx.insert(warehouseCityOrganizations)
          .values(changed.map((organizationId) => ({ userId: input.userId, organizationId, createdByUserId: input.actor.id })))
          .onConflictDoNothing()
      }
    } else {
      // A write in flight holds FOR SHARE on these rows, so the removal waits for it.
      changed = (await tx.delete(warehouseCityOrganizations)
        .where(and(
          eq(warehouseCityOrganizations.userId, input.userId),
          inArray(warehouseCityOrganizations.organizationId, requested),
        ))
        .returning({ organizationId: warehouseCityOrganizations.organizationId }))
        .map((row) => row.organizationId)
        .sort((a, b) => a - b)
    }

    let current = before
    if (changed.length > 0) {
      const cityKeys = (await tx
        .select({ cityKey: warehouseCityAssignments.cityKey })
        .from(warehouseCityAssignments)
        .where(eq(warehouseCityAssignments.userId, input.userId)))
        .map((row) => row.cityKey)
        .sort((a, b) => a.localeCompare(b))
      for (const organizationId of changed) {
        const next = input.assigned
          ? [...current, organizationId].sort((a, b) => a - b)
          : current.filter((id) => id !== organizationId)
        await recordAuditEvent(tx, {
          action: WAREHOUSE_CITY_ORGANIZATION_AUDIT_ACTION,
          entity: "user",
          entityId: input.userId,
          actor: input.actor,
          organizationId,
          before: { organizationIds: current },
          after: { organizationIds: next },
          context: { organizationId, assigned: input.assigned, cityKeys, bulk: true },
        })
        current = next
      }
    }

    return { kind: "updated", assigned: input.assigned, changed, after: current }
  })
}

/**
 * "Assign all" / "Unassign all" for cities: `setWarehouseCity` for several
 * cities at once, in one transaction under the same lock, all or nothing. Each
 * city is normalised in SQL by `branchCityKeySql`, as a single one is. A city
 * newly assigned must have a branch in the chosen organizations, exactly as one
 * ticked alone must; one already assigned is left as it is, so "Assign all"
 * over a list that still shows a city outside the chosen organizations does not
 * fail on it. Each city that changes gets the audit row a single tick would
 * have written. See plans/OF-WAREHOUSE-city-bulk-select.md.
 */
export async function setWarehouseCities(input: {
  userId: string
  cities: string[]
  assigned: boolean
  actor: AuditActor & { id: string }
}): Promise<WarehouseBulkOutcome<string>> {
  return db.transaction(async (tx) => {
    if (!(await lockWarehouseTarget(tx, input.userId))) return { kind: "not-found" }

    const listed = sql`unnest(ARRAY[${sql.join(input.cities.map((city) => sql`${city}`), sql`, `)}]::text[])`
    const requested = (await tx.execute<{ key: string }>(sql`
      SELECT DISTINCT ${branchCityKeySql(sql`listed.name`)} AS key
      FROM ${listed} AS listed(name)
    `)).rows
      .map((row) => row.key)
      .filter((key) => key !== "")
      .sort((a, b) => a.localeCompare(b))
    if (requested.length === 0) return { kind: "invalid", message: "Name at least one city" }

    const cityKey = branchCityKeySql(branches.city)
    // Each city's branches in the user's chosen organizations: the ones it reaches.
    const matches = new Map((await tx
      .select({ key: sql<string>`${cityKey}`, branchCount: sql<number>`count(*)::int` })
      .from(branches)
      .innerJoin(warehouseCityOrganizations, and(
        eq(warehouseCityOrganizations.userId, input.userId),
        eq(warehouseCityOrganizations.organizationId, branches.organizationId),
      ))
      .where(inArray(cityKey, requested))
      .groupBy(cityKey))
      .map((row) => [row.key, row.branchCount]))

    const before = (await tx
      .select({ cityKey: warehouseCityAssignments.cityKey })
      .from(warehouseCityAssignments)
      .where(eq(warehouseCityAssignments.userId, input.userId)))
      .map((row) => row.cityKey)
      .sort((a, b) => a.localeCompare(b))

    let changed: string[]
    if (input.assigned) {
      changed = requested.filter((key) => !before.includes(key))
      if (changed.some((key) => !matches.has(key))) {
        return { kind: "invalid", message: "No branch of the chosen organizations is in one or more of those cities" }
      }
      if (before.length + changed.length > WAREHOUSE_CITY_MAX_PER_USER) return { kind: "limit" }
      if (changed.length > 0) {
        await tx.insert(warehouseCityAssignments)
          .values(changed.map((key) => ({ userId: input.userId, cityKey: key, createdByUserId: input.actor.id })))
          .onConflictDoNothing()
      }
    } else {
      // A write in flight holds FOR SHARE on these rows, so the removal waits for it.
      changed = (await tx.delete(warehouseCityAssignments)
        .where(and(eq(warehouseCityAssignments.userId, input.userId), inArray(warehouseCityAssignments.cityKey, requested)))
        .returning({ cityKey: warehouseCityAssignments.cityKey }))
        .map((row) => row.cityKey)
        .sort((a, b) => a.localeCompare(b))
    }

    let current = before
    for (const key of changed) {
      const next = input.assigned
        ? [...current, key].sort((a, b) => a.localeCompare(b))
        : current.filter((existing) => existing !== key)
      await recordAuditEvent(tx, {
        action: WAREHOUSE_CITY_ASSIGNMENT_AUDIT_ACTION,
        entity: "user",
        entityId: input.userId,
        actor: input.actor,
        // A city spans the chosen organizations and changes with them: no single one.
        before: { cityKeys: current },
        after: { cityKeys: next },
        context: { city: key, assigned: input.assigned, branchCount: matches.get(key) ?? 0, bulk: true },
      })
      current = next
    }

    return { kind: "updated", assigned: input.assigned, changed, after: current }
  })
}
