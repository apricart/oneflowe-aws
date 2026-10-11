import bcrypt from "bcryptjs"
import { eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool, type PoolClient } from "pg"

import {
  branchInventory,
  branches,
  budgets,
  globalProducts,
  groups,
  organizationInventory,
  organizations,
  roles,
  userBranchAssignments,
  userGroupAssignments,
  users,
} from "../../../db/schema"

import { E2E_PASSWORD } from "./environment"

/**
 * An isolated tenant per feature spec, and a teardown that cannot miss a table.
 *
 * Every spec that writes builds its own organization, keyed by a short feature
 * key, so one journey's orders, budgets or switches can never leak into another
 * spec's assertions — and the role smoke tenant, which the deployment gate runs
 * against, is never touched.
 *
 * ```text
 *   key "addr"
 *     organization  "E2E addr Org"   (code E2E_ADDR)
 *     users         e2e-addr-<user key>, plus e2e-addr-superadmin outside it
 *     products      E2E-ADDR-<n>
 * ```
 *
 * The teardown does not list tables. It reads the database's own foreign keys
 * and removes every row that hangs off the tenant, its users and its products,
 * however many hops away — an order's items, a thread's messages, a budget's
 * add-ons, the notification a status change wrote. A hand-written child-first
 * list has to be extended every time a feature adds a table, and the first sign
 * that it was not is the *next* run failing on a foreign key before a single
 * test starts. This one cannot fall behind the schema.
 *
 * Built on its own pool from the URL the caller already validated, never
 * `@/lib/db`, for the reasons given in `seed.ts`.
 */

type SeedDb = ReturnType<typeof drizzle>

export type TenantRole =
  | "HEAD_OFFICE"
  | "BRANCH_ADMIN"
  | "ORDER_PORTAL"
  | "GROUP_ORDER_PORTAL"
  | "GROUP_USER"
  | "VIEWER"

export interface TenantUserSpec {
  key: string
  role: TenantRole
  /** Pins the user to one branch (single-branch roles, or a pinned Viewer). */
  branch?: string
  /** Group roles: the groups whose branches they act for. */
  groups?: string[]
  /** Group roles: individual branches outside any assigned group. */
  branches?: string[]
  budgetAllocationEnabled?: boolean
  mustChangePassword?: boolean
  fullName?: string
}

export interface TenantProductSpec {
  /** Suffix of the product code: `E2E-<KEY>-<code>`. */
  code: string
  name: string
  priceCents: number
  stock?: number
  /** Branch keys the product is orderable at; every branch when omitted. */
  branches?: string[]
}

export interface TenantSpec {
  key: string
  organization?: {
    budgetsEnabled?: boolean
    orderApprovalRequired?: boolean
    orderApproverRole?: string
    blockOrderingOnUnpaidInvoices?: boolean
    blockOrderingOnUnacknowledgedDeliveries?: boolean
    emailDomain?: string | null
    /** "Managed by Apricart Order Desk"; off unless a spec asks. */
    managedOrdering?: boolean
  }
  groups?: string[]
  branches: Array<{
    key: string
    group?: string
    /** This month's allocation; no budget row is written when omitted. */
    budgetCents?: number
    city?: string
    address?: string
  }>
  users: TenantUserSpec[]
  products?: TenantProductSpec[]
}

export interface Tenant {
  key: string
  organizationId: number
  organizationName: string
  superAdmin: { id: string; username: string }
  branches: Record<string, { id: number; name: string }>
  groups: Record<string, { id: number; name: string }>
  users: Record<string, { id: string; username: string; email: string }>
  products: Record<string, { globalProductId: number; organizationInventoryId: number; productCode: string; name: string }>
}

export function tenantNames(key: string) {
  return {
    organization: `E2E ${key} Org`,
    code: `E2E_${key.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`,
    userPrefix: `e2e-${key}-`,
    productPrefix: `E2E-${key.toUpperCase()}-`,
    branch: (branchKey: string) => `E2E ${key} ${branchKey}`,
    group: (groupKey: string) => `E2E ${key} ${groupKey}`,
    username: (userKey: string) => `e2e-${key}-${userKey}`,
  }
}

/** The UTC `YYYY-MM` the order engine holds budget against. */
export function currentBudgetPeriod(now = new Date()): string {
  return now.toISOString().slice(0, 7)
}

export async function withTenantDb<T>(databaseUrl: string, work: (db: SeedDb) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    return await work(drizzle(pool))
  } finally {
    await pool.end()
  }
}

/** Raw SQL against the test database, for the assertions a spec reads back. */
export async function queryTestDb<Row extends Record<string, unknown>>(
  databaseUrl: string,
  text: string,
  values: unknown[] = [],
): Promise<Row[]> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  try {
    const result = await pool.query(text, values)
    return result.rows as Row[]
  } finally {
    await pool.end()
  }
}

async function roleId(db: SeedDb, name: string): Promise<number> {
  const [existing] = await db.select({ id: roles.id }).from(roles).where(eq(roles.name, name)).limit(1)
  if (existing) return existing.id
  const [created] = await db
    .insert(roles)
    .values({ name, description: "Created by the Playwright suite" })
    .returning({ id: roles.id })
  return created.id
}

interface SeedContext {
  db: SeedDb
  spec: TenantSpec
  names: ReturnType<typeof tenantNames>
  tenant: Tenant
  passwordHash: string
}

function personRow(
  passwordHash: string,
  username: string,
  role: number,
  organizationId: number | null,
  branchId: number | null,
  extra: Partial<TenantUserSpec> = {},
) {
  const fullName = extra.fullName ?? `E2E ${username}`
  const parts = fullName.split(/\s+/)
  return {
    email: `${username}@example.test`,
    username,
    passwordHash,
    roleId: role,
    organizationId,
    branchId,
    fullName,
    firstName: parts.slice(0, -1).join(" ") || parts[0],
    lastName: parts.length > 1 ? parts.at(-1) ?? "User" : "User",
    isActive: true,
    budgetAllocationEnabled: extra.budgetAllocationEnabled ?? false,
    mfaEnabled: false,
    mustChangePassword: extra.mustChangePassword ?? false,
  }
}

async function seedCompany(
  db: SeedDb,
  spec: TenantSpec,
  names: ReturnType<typeof tenantNames>,
  passwordHash: string,
): Promise<Tenant> {
  const superAdminUsername = names.username("superadmin")
  const [superAdmin] = await db
    .insert(users)
    .values(personRow(passwordHash, superAdminUsername, await roleId(db, "SUPER_ADMIN"), null, null, {
      fullName: `E2E ${spec.key} Super Admin`,
    }))
    .returning({ id: users.id })

  const org = spec.organization ?? {}
  const [organization] = await db
    .insert(organizations)
    .values({
      name: names.organization,
      code: names.code,
      status: "active",
      budgetsEnabled: org.budgetsEnabled ?? true,
      orderApprovalRequired: org.orderApprovalRequired ?? true,
      orderApproverRole: org.orderApproverRole ?? "BRANCH_ADMIN",
      blockOrderingOnUnpaidInvoices: org.blockOrderingOnUnpaidInvoices ?? false,
      blockOrderingOnUnacknowledgedDeliveries: org.blockOrderingOnUnacknowledgedDeliveries ?? false,
      emailDomain: org.emailDomain ?? null,
      managedOrdering: org.managedOrdering ?? false,
    })
    .returning({ id: organizations.id })

  return {
    key: spec.key,
    organizationId: organization.id,
    organizationName: names.organization,
    superAdmin: { id: superAdmin.id, username: superAdminUsername },
    branches: {},
    groups: {},
    users: {},
    products: {},
  }
}

async function seedGroups({ db, spec, names, tenant }: SeedContext): Promise<void> {
  for (const groupKey of spec.groups ?? []) {
    const [group] = await db
      .insert(groups)
      .values({
        organizationId: tenant.organizationId,
        name: names.group(groupKey),
        status: "active",
        createdByUserId: tenant.superAdmin.id,
      })
      .returning({ id: groups.id })
    tenant.groups[groupKey] = { id: group.id, name: names.group(groupKey) }
  }
}

async function seedBranches({ db, spec, names, tenant }: SeedContext): Promise<void> {
  const period = currentBudgetPeriod()
  for (const branchSpec of spec.branches) {
    const name = names.branch(branchSpec.key)
    const [branch] = await db
      .insert(branches)
      .values({
        organizationId: tenant.organizationId,
        name,
        code: `${names.code}_${branchSpec.key.toUpperCase()}`,
        status: "active",
        city: branchSpec.city ?? "Karachi",
        address: branchSpec.address ?? `${branchSpec.key} Road`,
        province: "Sindh",
        groupId: branchSpec.group ? tenant.groups[branchSpec.group].id : null,
        baselineBudgetCents: branchSpec.budgetCents ?? 0,
      })
      .returning({ id: branches.id })
    tenant.branches[branchSpec.key] = { id: branch.id, name }

    if (branchSpec.budgetCents === undefined) continue
    await db.insert(budgets).values({
      organizationId: tenant.organizationId,
      branchId: branch.id,
      period,
      amountAllocatedCents: branchSpec.budgetCents,
      amountSpentCents: 0,
      amountHeldCents: 0,
      amountCreditedCents: 0,
    })
  }
}

async function seedUsers({ db, spec, names, tenant, passwordHash }: SeedContext): Promise<void> {
  for (const userSpec of spec.users) {
    const username = names.username(userSpec.key)
    const [user] = await db
      .insert(users)
      .values(personRow(
        passwordHash,
        username,
        await roleId(db, userSpec.role),
        tenant.organizationId,
        userSpec.branch ? tenant.branches[userSpec.branch].id : null,
        userSpec,
      ))
      .returning({ id: users.id })
    tenant.users[userSpec.key] = { id: user.id, username, email: `${username}@example.test` }

    const assignment = {
      userId: user.id,
      organizationId: tenant.organizationId,
      createdByUserId: tenant.superAdmin.id,
    }
    for (const groupKey of userSpec.groups ?? []) {
      await db.insert(userGroupAssignments).values({ ...assignment, groupId: tenant.groups[groupKey].id })
    }
    for (const branchKey of userSpec.branches ?? []) {
      await db.insert(userBranchAssignments).values({ ...assignment, branchId: tenant.branches[branchKey].id })
    }
  }
}

async function seedProducts({ db, spec, names, tenant }: SeedContext): Promise<void> {
  for (const productSpec of spec.products ?? []) {
    const productCode = `${names.productPrefix}${productSpec.code}`
    const [product] = await db
      .insert(globalProducts)
      .values({
        productCode,
        name: productSpec.name,
        basePrice: productSpec.priceCents,
        stockQuantity: productSpec.stock ?? 100_000,
        unit: "piece",
        status: "active",
        createdByUserId: tenant.superAdmin.id,
      })
      .returning({ id: globalProducts.id })

    const [inventory] = await db
      .insert(organizationInventory)
      .values({
        organizationId: tenant.organizationId,
        globalProductId: product.id,
        assignedByUserId: tenant.superAdmin.id,
        isActive: true,
      })
      .returning({ id: organizationInventory.id })

    for (const branchKey of productSpec.branches ?? spec.branches.map((branch) => branch.key)) {
      await db.insert(branchInventory).values({
        branchId: tenant.branches[branchKey].id,
        organizationId: tenant.organizationId,
        organizationInventoryId: inventory.id,
        assignedByUserId: tenant.superAdmin.id,
        isVisible: true,
        isActive: true,
      })
    }

    tenant.products[productSpec.code] = {
      globalProductId: product.id,
      organizationInventoryId: inventory.id,
      productCode,
      name: productSpec.name,
    }
  }
}

export async function seedTenant(databaseUrl: string, spec: TenantSpec): Promise<Tenant> {
  // A crashed previous run leaves its rows behind; start from nothing so every
  // count a spec asserts on is exact.
  await destroyTenant(databaseUrl, spec.key)

  const names = tenantNames(spec.key)
  return withTenantDb(databaseUrl, async (db) => {
    const passwordHash = await bcrypt.hash(E2E_PASSWORD, 10)
    const tenant = await seedCompany(db, spec, names, passwordHash)
    const context: SeedContext = { db, spec, names, tenant, passwordHash }
    await seedGroups(context)
    await seedBranches(context)
    await seedUsers(context)
    await seedProducts(context)
    return tenant
  })
}

interface ForeignKey {
  child: string
  childColumn: string
  parent: string
  parentColumn: string
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

/**
 * Delete the tenant keyed `key` and everything that references it.
 *
 * Roots: every organization named `E2E <key> …`, every user whose username carries the key's
 * prefix (the Super Admin lives outside the organization), and every product
 * whose code carries the key's product prefix. From those, every row reachable
 * by following foreign keys *downwards* — children, never parents, so a shared
 * row such as a role is never reached.
 */
export async function destroyTenant(databaseUrl: string, key: string): Promise<void> {
  const names = tenantNames(key)
  const pool = new Pool({ connectionString: databaseUrl, max: 1 })
  const client = await pool.connect()
  try {
    await purge(client, [
      // `E2E <key> …` — the seeded company, and any a spec created through the UI.
      { table: "organizations", where: "name LIKE $1", values: [`E2E ${key} %`] },
      { table: "users", where: "username LIKE $1", values: [`${names.userPrefix}%`] },
      { table: "global_products", where: "product_code LIKE $1", values: [`${names.productPrefix}%`] },
    ])
  } finally {
    client.release()
    await pool.end()
  }
}

async function loadForeignKeys(client: PoolClient): Promise<ForeignKey[]> {
  const { rows } = await client.query<{
    child: string
    child_column: string
    parent: string
    parent_column: string
  }>(`
    SELECT cc.relname AS child, ca.attname AS child_column,
           pc.relname AS parent, pa.attname AS parent_column
      FROM pg_constraint c
      JOIN pg_class cc ON cc.oid = c.conrelid
      JOIN pg_namespace cn ON cn.oid = cc.relnamespace AND cn.nspname = 'public'
      JOIN pg_class pc ON pc.oid = c.confrelid
      JOIN pg_attribute ca ON ca.attrelid = c.conrelid AND ca.attnum = c.conkey[1]
      JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
     WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
  `)
  return rows.map((row) => ({
    child: row.child,
    childColumn: row.child_column,
    parent: row.parent,
    parentColumn: row.parent_column,
  }))
}

async function tablesWithId(client: PoolClient): Promise<Set<string>> {
  const { rows } = await client.query<{ table_name: string }>(`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'id'
  `)
  return new Set(rows.map((row) => row.table_name))
}

interface Reachable {
  /** Every row to remove, as ids per table (text, so serial and uuid keys share one form). */
  byId: Map<string, Set<string>>
  /** Rows in tables without an `id` column, named by the column that points at a parent. */
  keyless: Array<{ table: string; column: string; values: string[] }>
}

/** The values of the column a foreign key points at, for the given parent rows. */
async function referencedValues(client: PoolClient, fk: ForeignKey, parentIds: string[]): Promise<string[]> {
  const { rows } = await client.query<{ value: string | null }>(
    `SELECT ${quoteIdent(fk.parentColumn)}::text AS value FROM ${quoteIdent(fk.parent)} WHERE id::text = ANY($1::text[])`,
    [parentIds],
  )
  return rows.map((row) => row.value).filter((value): value is string => value !== null)
}

/** Every row reachable downwards from the roots, by following foreign keys to their children. */
async function collectReachable(
  client: PoolClient,
  roots: Array<{ table: string; where: string; values: unknown[] }>,
): Promise<Reachable> {
  const foreignKeys = await loadForeignKeys(client)
  const hasId = await tablesWithId(client)
  const reachable: Reachable = { byId: new Map(), keyless: [] }
  const queue: string[] = []

  const add = (table: string, ids: string[]) => {
    const set = reachable.byId.get(table) ?? new Set<string>()
    const before = set.size
    for (const id of ids) set.add(id)
    reachable.byId.set(table, set)
    if (set.size !== before) queue.push(table)
  }

  for (const root of roots) {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id::text AS id FROM ${quoteIdent(root.table)} WHERE ${root.where}`,
      root.values,
    )
    add(root.table, rows.map((row) => row.id))
  }

  const expanded = new Map<string, number>()
  while (queue.length > 0) {
    const table = queue.shift()!
    const ids = [...(reachable.byId.get(table) ?? [])]
    if (expanded.get(table) === ids.length) continue
    expanded.set(table, ids.length)

    for (const fk of foreignKeys.filter((candidate) => candidate.parent === table)) {
      const values = await referencedValues(client, fk, ids)
      if (values.length === 0) continue
      if (!hasId.has(fk.child)) {
        reachable.keyless.push({ table: fk.child, column: fk.childColumn, values })
        continue
      }
      const { rows } = await client.query<{ id: string }>(
        `SELECT id::text AS id FROM ${quoteIdent(fk.child)} WHERE ${quoteIdent(fk.childColumn)}::text = ANY($1::text[])`,
        [values],
      )
      add(fk.child, rows.map((row) => row.id))
    }
  }
  return reachable
}

/**
 * Delete what was collected. No dependency order is computed: each pass deletes
 * whatever no longer has a referencing row, and the next pass picks up what
 * that freed. Each statement runs on its own, so a refusal costs one pass, not
 * the whole teardown.
 */
async function deleteReachable(client: PoolClient, reachable: Reachable): Promise<void> {
  for (const row of reachable.keyless) {
    await client.query(
      `DELETE FROM ${quoteIdent(row.table)} WHERE ${quoteIdent(row.column)}::text = ANY($1::text[])`,
      [row.values],
    )
  }

  let remaining = [...reachable.byId.entries()].filter(([, ids]) => ids.size > 0)
  for (let pass = 0; remaining.length > 0 && pass < 25; pass += 1) {
    const blocked: typeof remaining = []
    let lastError: unknown = null
    for (const [table, ids] of remaining) {
      try {
        await client.query(`DELETE FROM ${quoteIdent(table)} WHERE id::text = ANY($1::text[])`, [[...ids]])
      } catch (error) {
        if ((error as { code?: string }).code !== "23503") throw error
        lastError = error
        blocked.push([table, ids])
      }
    }
    if (blocked.length === remaining.length) {
      throw new Error(`E2E teardown is stuck on ${blocked.map(([table]) => table).join(", ")}: ${String(lastError)}`)
    }
    remaining = blocked
  }
}

async function purge(
  client: PoolClient,
  roots: Array<{ table: string; where: string; values: unknown[] }>,
): Promise<void> {
  await deleteReachable(client, await collectReachable(client, roots))
}
