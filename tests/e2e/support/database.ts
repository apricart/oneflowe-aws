import path from "node:path"

import bcrypt from "bcryptjs"
import { drizzle } from "drizzle-orm/node-postgres"
import { migrate } from "drizzle-orm/node-postgres/migrator"
import { Pool, type PoolClient, type QueryResultRow } from "pg"

import {
  E2E_ADMIN_BRANCH,
  E2E_BRANCH,
  E2E_BUDGET_CENTS,
  E2E_ORGANIZATION,
  E2E_PASSWORD,
  E2E_PRODUCT,
  E2E_SECONDARY_BRANCH,
  E2E_SECONDARY_ORGANIZATION,
  E2E_SECONDARY_PRODUCT,
  E2E_USERS,
} from "./fixtures"
import { loadE2EEnvironment } from "./environment"

function createPool() {
  const { testDatabaseUrl } = loadE2EEnvironment()
  const url = new URL(testDatabaseUrl)

  return new Pool({
    connectionString: testDatabaseUrl,
    ssl: url.hostname.includes("supabase")
      ? { rejectUnauthorized: false }
      : undefined,
    max: 5,
    connectionTimeoutMillis: 30_000,
    statement_timeout: 120_000,
    allowExitOnIdle: true,
  })
}

async function one<T extends QueryResultRow>(
  client: PoolClient,
  text: string,
  values: unknown[] = [],
): Promise<T> {
  const result = await client.query<T>(text, values)
  if (result.rows.length !== 1) {
    throw new Error(`E2E database setup expected one row but received ${result.rows.length}.`)
  }
  return result.rows[0]
}

async function upsertOrganization(
  client: PoolClient,
  input: { code: string; name: string },
) {
  return one<{ id: number }>(
    client,
    `
      INSERT INTO organizations (name, code, status, created_at, updated_at)
      VALUES ($1, $2, 'active', NOW(), NOW())
      ON CONFLICT (code) DO UPDATE
      SET name = EXCLUDED.name, status = 'active', updated_at = NOW()
      RETURNING id
    `,
    [input.name, input.code],
  )
}

async function upsertBranch(
  client: PoolClient,
  organizationId: number,
  input: { code: string; name: string },
) {
  const existing = await client.query<{ id: number }>(
    "SELECT id FROM branches WHERE organization_id = $1 AND code = $2 LIMIT 1",
    [organizationId, input.code],
  )

  if (existing.rows[0]) {
    return one<{ id: number }>(
      client,
      `
        UPDATE branches
        SET name = $2, status = 'active', baseline_budget_cents = $3, updated_at = NOW()
        WHERE id = $1
        RETURNING id
      `,
      [existing.rows[0].id, input.name, E2E_BUDGET_CENTS],
    )
  }

  return one<{ id: number }>(
    client,
    `
      INSERT INTO branches (
        organization_id, name, code, status, baseline_budget_cents,
        province, city, address, created_at, updated_at
      )
      VALUES ($1, $2, $3, 'active', $4, 'Sindh', 'Karachi', 'E2E test address', NOW(), NOW())
      RETURNING id
    `,
    [organizationId, input.name, input.code, E2E_BUDGET_CENTS],
  )
}

async function upsertUser(
  client: PoolClient,
  input: {
    username: string
    email: string
    fullName: string
    roleId: number
    passwordHash: string
    organizationId: number | null
    branchId: number | null
  },
) {
  return one<{ id: string }>(
    client,
    `
      INSERT INTO users (
        username, email, full_name, password_hash, role_id, is_active,
        organization_id, branch_id, mfa_enabled, session_version,
        must_change_password, deleted_at, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, FALSE, 1, FALSE, NULL, NOW(), NOW())
      ON CONFLICT (username) DO UPDATE
      SET email = EXCLUDED.email,
          full_name = EXCLUDED.full_name,
          password_hash = EXCLUDED.password_hash,
          role_id = EXCLUDED.role_id,
          is_active = TRUE,
          organization_id = EXCLUDED.organization_id,
          branch_id = EXCLUDED.branch_id,
          mfa_enabled = FALSE,
          must_change_password = FALSE,
          deleted_at = NULL,
          session_version = users.session_version + 1,
          updated_at = NOW()
      RETURNING id
    `,
    [
      input.username,
      input.email,
      input.fullName,
      input.passwordHash,
      input.roleId,
      input.organizationId,
      input.branchId,
    ],
  )
}

async function upsertGlobalProduct(
  client: PoolClient,
  input: {
    code: string
    name: string
    priceCents: number
    startingStock: number
    createdByUserId: string
  },
) {
  const existing = await client.query<{ id: number }>(
    `
      SELECT id
      FROM global_products
      WHERE product_code = $1 AND deleted_at IS NULL
      LIMIT 1
    `,
    [input.code],
  )

  if (existing.rows[0]) {
    return one<{ id: number }>(
      client,
      `
        UPDATE global_products
        SET name = $2,
            description = 'Deterministic Playwright fixture',
            base_price_cents = $3,
            stock_quantity = $4,
            unit = 'pack',
            status = 'active',
            allow_decimal_quantity = FALSE,
            quantity_step = 1,
            discount_active = FALSE,
            discount_type = NULL,
            discount_value_cents = NULL,
            created_by_user_id = $5,
            updated_at = NOW()
        WHERE id = $1
        RETURNING id
      `,
      [
        existing.rows[0].id,
        input.name,
        input.priceCents,
        input.startingStock,
        input.createdByUserId,
      ],
    )
  }

  return one<{ id: number }>(
    client,
    `
      INSERT INTO global_products (
        product_code, name, description, base_price_cents, stock_quantity,
        unit, status, allow_decimal_quantity, quantity_step, discount_active,
        created_by_user_id, created_at, updated_at
      )
      VALUES ($1, $2, 'Deterministic Playwright fixture', $3, $4, 'pack',
              'active', FALSE, 1, FALSE, $5, NOW(), NOW())
      RETURNING id
    `,
    [
      input.code,
      input.name,
      input.priceCents,
      input.startingStock,
      input.createdByUserId,
    ],
  )
}

async function assignProduct(
  client: PoolClient,
  input: {
    organizationId: number
    branchId: number
    globalProductId: number
    assignedByUserId: string
  },
) {
  const organizationInventory = await one<{ id: number }>(
    client,
    `
      INSERT INTO organization_inventory (
        organization_id, global_product_id, assigned_by_user_id, is_active,
        custom_price_cents, deleted_at, assigned_at, updated_at
      )
      VALUES ($1, $2, $3, TRUE, NULL, NULL, NOW(), NOW())
      ON CONFLICT (organization_id, global_product_id) DO UPDATE
      SET assigned_by_user_id = EXCLUDED.assigned_by_user_id,
          is_active = TRUE,
          custom_price_cents = NULL,
          deleted_at = NULL,
          updated_at = NOW()
      RETURNING id
    `,
    [
      input.organizationId,
      input.globalProductId,
      input.assignedByUserId,
    ],
  )

  await client.query(
    `
      INSERT INTO branch_inventory (
        branch_id, organization_id, organization_inventory_id,
        assigned_by_user_id, is_visible, is_active, deleted_at,
        assigned_at, updated_at
      )
      VALUES ($1, $2, $3, $4, TRUE, TRUE, NULL, NOW(), NOW())
      ON CONFLICT (branch_id, organization_inventory_id) DO UPDATE
      SET organization_id = EXCLUDED.organization_id,
          assigned_by_user_id = EXCLUDED.assigned_by_user_id,
          is_visible = TRUE,
          is_active = TRUE,
          deleted_at = NULL,
          updated_at = NOW()
    `,
    [
      input.branchId,
      input.organizationId,
      organizationInventory.id,
      input.assignedByUserId,
    ],
  )
}

async function seedFixtures(client: PoolClient) {
  const passwordHash = await bcrypt.hash(E2E_PASSWORD, 10)
  const roleIds = new Map<string, number>()
  const rolePermissions: Record<string, Record<string, boolean>> = {
    SUPER_ADMIN: { "system:full_access": true },
    HEAD_OFFICE: { "org:view": true, "order:view": true, "financial:view_budgets": true },
    BRANCH_ADMIN: { "order:view": true, "order:approve": true, "inventory:view": true },
    ORDER_PORTAL: { "order:create": true, "order:view_own": true, "inventory:view": true },
  }

  for (const roleName of ["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"]) {
    const role = await one<{ id: number }>(
      client,
      `
        INSERT INTO roles (name, description, permissions, created_at, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW(), NOW())
        ON CONFLICT (name) DO UPDATE
        SET permissions = EXCLUDED.permissions, updated_at = NOW()
        RETURNING id
      `,
      [
        roleName,
        `Playwright fixture role ${roleName}`,
        JSON.stringify(rolePermissions[roleName]),
      ],
    )
    roleIds.set(roleName, role.id)
  }

  const organization = await upsertOrganization(client, E2E_ORGANIZATION)
  const secondaryOrganization = await upsertOrganization(
    client,
    E2E_SECONDARY_ORGANIZATION,
  )
  const shopBranch = await upsertBranch(client, organization.id, E2E_BRANCH)
  const adminBranch = await upsertBranch(client, organization.id, E2E_ADMIN_BRANCH)
  const secondaryBranch = await upsertBranch(
    client,
    secondaryOrganization.id,
    E2E_SECONDARY_BRANCH,
  )

  const superAdmin = await upsertUser(client, {
    username: E2E_USERS.superAdmin,
    email: "e2e.superadmin@example.test",
    fullName: "E2E Super Admin",
    roleId: roleIds.get("SUPER_ADMIN")!,
    passwordHash,
    organizationId: null,
    branchId: null,
  })
  await upsertUser(client, {
    username: E2E_USERS.headOffice,
    email: "e2e.headoffice@example.test",
    fullName: "E2E Head Office",
    roleId: roleIds.get("HEAD_OFFICE")!,
    passwordHash,
    organizationId: organization.id,
    branchId: null,
  })
  await upsertUser(client, {
    username: E2E_USERS.branchAdmin,
    email: "e2e.branchadmin@example.test",
    fullName: "E2E Branch Admin",
    roleId: roleIds.get("BRANCH_ADMIN")!,
    passwordHash,
    organizationId: organization.id,
    branchId: adminBranch.id,
  })
  const orderPortal = await upsertUser(client, {
    username: E2E_USERS.orderPortal,
    email: "e2e.orderportal@example.test",
    fullName: "E2E Order Portal",
    roleId: roleIds.get("ORDER_PORTAL")!,
    passwordHash,
    organizationId: organization.id,
    branchId: shopBranch.id,
  })

  const previousOrders = await client.query<{ id: number }>(
    "SELECT id FROM orders WHERE created_by_user_id = $1",
    [orderPortal.id],
  )
  const previousOrderIds = previousOrders.rows.map((row) => row.id)
  if (previousOrderIds.length > 0) {
    await client.query(
      "DELETE FROM refund_items WHERE refund_id IN (SELECT id FROM refunds WHERE order_id = ANY($1::int[]))",
      [previousOrderIds],
    )
    await client.query("DELETE FROM refunds WHERE order_id = ANY($1::int[])", [
      previousOrderIds,
    ])
    await client.query("DELETE FROM order_items WHERE order_id = ANY($1::int[])", [
      previousOrderIds,
    ])
    await client.query("DELETE FROM orders WHERE id = ANY($1::int[])", [
      previousOrderIds,
    ])
  }
  await client.query("DELETE FROM system_logs WHERE user_id = $1", [orderPortal.id])

  for (const setting of [
    ["hide_prices_for_order_portal", false],
    ["hide_prices_for_branch_admin", false],
    ["budget_allocation_mode", "amount"],
  ] as const) {
    await client.query(
      `
        INSERT INTO organization_settings (organization_id, key, value, updated_at)
        VALUES ($1, $2, $3::jsonb, NOW())
        ON CONFLICT (organization_id, key) DO UPDATE
        SET value = EXCLUDED.value, updated_at = NOW()
      `,
      [organization.id, setting[0], JSON.stringify(setting[1])],
    )
  }

  const product = await upsertGlobalProduct(client, {
    ...E2E_PRODUCT,
    createdByUserId: superAdmin.id,
  })
  const secondaryProduct = await upsertGlobalProduct(client, {
    ...E2E_SECONDARY_PRODUCT,
    createdByUserId: superAdmin.id,
  })

  await assignProduct(client, {
    organizationId: organization.id,
    branchId: shopBranch.id,
    globalProductId: product.id,
    assignedByUserId: superAdmin.id,
  })
  await assignProduct(client, {
    organizationId: secondaryOrganization.id,
    branchId: secondaryBranch.id,
    globalProductId: secondaryProduct.id,
    assignedByUserId: superAdmin.id,
  })

  const period = new Date().toISOString().slice(0, 7)
  await client.query(
    `
      INSERT INTO budgets (
        organization_id, branch_id, period, amount_allocated_cents,
        amount_spent_cents, amount_held_cents, amount_credited_cents,
        created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, 0, 0, 0, NOW(), NOW())
      ON CONFLICT (branch_id, period) DO UPDATE
      SET organization_id = EXCLUDED.organization_id,
          amount_allocated_cents = EXCLUDED.amount_allocated_cents,
          amount_spent_cents = 0,
          amount_held_cents = 0,
          amount_credited_cents = 0,
          updated_at = NOW()
    `,
    [organization.id, shopBranch.id, period, E2E_BUDGET_CENTS],
  )
  await client.query(
    `
      INSERT INTO invoice_sequences (organization_id, last_value, created_at, updated_at)
      VALUES ($1, 0, NOW(), NOW())
      ON CONFLICT (organization_id) DO UPDATE
      SET last_value = 0, updated_at = NOW()
    `,
    [organization.id],
  )
}

export async function migrateAndSeedE2EDatabase() {
  const pool = createPool()
  try {
    const db = drizzle(pool)
    await migrate(db, {
      migrationsFolder: path.resolve(process.cwd(), "drizzle"),
    })

    const client = await pool.connect()
    try {
      await client.query("BEGIN")
      await seedFixtures(client)
      await client.query("COMMIT")
    } catch (error) {
      await client.query("ROLLBACK")
      throw error
    } finally {
      client.release()
    }
  } finally {
    await pool.end()
  }
}

export async function queryE2E<T extends QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<T[]> {
  const pool = createPool()
  try {
    const result = await pool.query<T>(text, values)
    return result.rows
  } finally {
    await pool.end()
  }
}
