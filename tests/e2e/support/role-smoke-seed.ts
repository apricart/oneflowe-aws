import bcrypt from "bcryptjs"
import { and, eq } from "drizzle-orm"
import { drizzle } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import {
  branchInventory,
  branches,
  budgets,
  employeeCredentials,
  globalProducts,
  groups,
  organizationInventory,
  organizations,
  roles,
  userGroupAssignments,
  users,
} from "../../../db/schema"

import { E2E_PASSWORD } from "./environment"

type SeedDb = ReturnType<typeof drizzle>

const FIXTURE_DESCRIPTION = "Created by the Playwright role smoke suite"
const SMOKE_BUDGET_CENTS = 1_000_000_000

export const SMOKE_ORGANIZATION_NAME = "E2E Role Smoke Organization"
export const SMOKE_BRANCH_NAME = "E2E Role Smoke Branch"
export const SMOKE_GROUP_NAME = "E2E Role Smoke Group"
export const SMOKE_PRODUCT_CODE = "E2E-SMOKE-PRODUCT"

export const SMOKE_USERNAMES = {
  superAdmin: "e2e-smoke-superadmin",
  headOffice: "e2e-smoke-headoffice",
  branchAdmin: "e2e-smoke-branchadmin",
  orderPortal: "e2e-smoke-orderportal",
  groupOrderPortal: "e2e-smoke-grouporderportal",
  groupUser: "e2e-smoke-groupuser",
  employee: "e2e-smoke-employee",
} as const

async function withDb<T>(databaseUrl: string, work: (db: SeedDb) => Promise<T>): Promise<T> {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 })
  try {
    return await work(drizzle(pool))
  } finally {
    await pool.end()
  }
}

async function upsertRole(db: SeedDb, name: string): Promise<number> {
  const [role] = await db
    .insert(roles)
    .values({ name, description: FIXTURE_DESCRIPTION })
    .onConflictDoUpdate({
      target: roles.name,
      set: { description: FIXTURE_DESCRIPTION, updatedAt: new Date() },
    })
    .returning({ id: roles.id })
  return role.id
}

async function upsertUser(
  db: SeedDb,
  input: {
    username: string
    fullName: string
    roleId: number
    passwordHash: string
    organizationId: number | null
    branchId: number | null
    budgetAllocationEnabled?: boolean
  },
): Promise<string> {
  // First and last name are derived rather than asked for: the user edit dialog
  // requires both before it will save, so a fixture carrying only `fullName`
  // cannot be edited at all and no UI journey that saves a user can run.
  const nameParts = input.fullName.trim().split(/\s+/)
  const values = {
    email: `${input.username}@example.test`,
    username: input.username,
    fullName: input.fullName,
    firstName: nameParts.slice(0, -1).join(" ") || nameParts[0],
    lastName: nameParts.length > 1 ? nameParts[nameParts.length - 1] : "Smoke",
    passwordHash: input.passwordHash,
    roleId: input.roleId,
    organizationId: input.organizationId,
    branchId: input.branchId,
    isActive: true,
    budgetAllocationEnabled: input.budgetAllocationEnabled ?? false,
    mfaEnabled: false,
    mustChangePassword: false,
    deletedAt: null,
    failedLoginAttempts: 0,
    lastFailedLoginAt: null,
    lockoutUntil: null,
    updatedAt: new Date(),
  }
  const [user] = await db
    .insert(users)
    .values(values)
    .onConflictDoUpdate({ target: users.username, set: values })
    .returning({ id: users.id })
  return user.id
}

async function seedRoleSmokeRows(db: SeedDb): Promise<void> {
  const passwordHash = await bcrypt.hash(E2E_PASSWORD, 10)
  const roleIds = Object.fromEntries(
    await Promise.all(
      [
        "SUPER_ADMIN",
        "HEAD_OFFICE",
        "BRANCH_ADMIN",
        "ORDER_PORTAL",
        "GROUP_ORDER_PORTAL",
        "GROUP_USER",
      ].map(async (name) => [name, await upsertRole(db, name)]),
    ),
  ) as Record<string, number>

  const [organization] = await db
    .insert(organizations)
    .values({
      name: SMOKE_ORGANIZATION_NAME,
      code: "E2E_SMOKE",
      status: "active",
      orderApproverRole: "BRANCH_ADMIN",
    })
    .onConflictDoUpdate({
      target: organizations.name,
      set: {
        code: "E2E_SMOKE",
        status: "active",
        orderApproverRole: "BRANCH_ADMIN",
        privateNetworkLoginEnabled: false,
        updatedAt: new Date(),
      },
    })
    .returning({ id: organizations.id })

  const [existingBranch] = await db
    .select({ id: branches.id })
    .from(branches)
    .where(and(
      eq(branches.organizationId, organization.id),
      eq(branches.name, SMOKE_BRANCH_NAME),
    ))
    .limit(1)
  const [branch] = existingBranch
    ? await db
        .update(branches)
        .set({
          status: "active",
          baselineBudgetCents: SMOKE_BUDGET_CENTS,
          updatedAt: new Date(),
        })
        .where(eq(branches.id, existingBranch.id))
        .returning({ id: branches.id })
    : await db
        .insert(branches)
        .values({
          organizationId: organization.id,
          name: SMOKE_BRANCH_NAME,
          code: "E2E-SMOKE-BRANCH",
          status: "active",
          baselineBudgetCents: SMOKE_BUDGET_CENTS,
        })
        .returning({ id: branches.id })

  const superAdminId = await upsertUser(db, {
    username: SMOKE_USERNAMES.superAdmin,
    fullName: "E2E Smoke Super Admin",
    roleId: roleIds.SUPER_ADMIN,
    passwordHash,
    organizationId: null,
    branchId: null,
  })
  await upsertUser(db, {
    username: SMOKE_USERNAMES.headOffice,
    fullName: "E2E Smoke Head Office",
    roleId: roleIds.HEAD_OFFICE,
    passwordHash,
    organizationId: organization.id,
    branchId: null,
  })
  await upsertUser(db, {
    username: SMOKE_USERNAMES.branchAdmin,
    fullName: "E2E Smoke Branch Admin",
    roleId: roleIds.BRANCH_ADMIN,
    passwordHash,
    organizationId: organization.id,
    branchId: branch.id,
  })
  await upsertUser(db, {
    username: SMOKE_USERNAMES.orderPortal,
    fullName: "E2E Smoke Order Requester",
    roleId: roleIds.ORDER_PORTAL,
    passwordHash,
    organizationId: organization.id,
    branchId: branch.id,
  })
  const groupOrderPortalId = await upsertUser(db, {
    username: SMOKE_USERNAMES.groupOrderPortal,
    fullName: "E2E Smoke Group Requester",
    roleId: roleIds.GROUP_ORDER_PORTAL,
    passwordHash,
    organizationId: organization.id,
    branchId: null,
  })
  const groupUserId = await upsertUser(db, {
    username: SMOKE_USERNAMES.groupUser,
    fullName: "E2E Smoke Group Approver",
    roleId: roleIds.GROUP_USER,
    passwordHash,
    organizationId: organization.id,
    branchId: null,
    budgetAllocationEnabled: true,
  })

  const [employee] = await db
    .insert(employeeCredentials)
    .values({
      branchId: branch.id,
      organizationId: organization.id,
      username: SMOKE_USERNAMES.employee,
      email: `${SMOKE_USERNAMES.employee}@example.test`,
      passwordHash,
      firstName: "E2E Smoke",
      lastName: "Employee",
      mfaEnabled: false,
      isActive: true,
      createdByUserId: superAdminId,
    })
    .onConflictDoUpdate({
      target: employeeCredentials.username,
      set: {
        branchId: branch.id,
        organizationId: organization.id,
        email: `${SMOKE_USERNAMES.employee}@example.test`,
        passwordHash,
        firstName: "E2E Smoke",
        lastName: "Employee",
        mfaEnabled: false,
        isActive: true,
        deactivatedAt: null,
        failedLoginAttempts: 0,
        lastFailedLoginAt: null,
        lockoutUntil: null,
        createdByUserId: superAdminId,
        updatedAt: new Date(),
      },
    })
    .returning({ id: employeeCredentials.id })
  if (!employee) throw new Error("Could not seed the employee smoke-test identity")

  const [existingGroup] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(
      eq(groups.organizationId, organization.id),
      eq(groups.name, SMOKE_GROUP_NAME),
    ))
    .limit(1)
  const [group] = existingGroup
    ? await db
        .update(groups)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(groups.id, existingGroup.id))
        .returning({ id: groups.id })
    : await db
        .insert(groups)
        .values({
          organizationId: organization.id,
          name: SMOKE_GROUP_NAME,
          status: "active",
          createdByUserId: superAdminId,
        })
        .returning({ id: groups.id })

  await db.update(branches).set({ groupId: group.id }).where(eq(branches.id, branch.id))
  await db
    .insert(userGroupAssignments)
    .values([
      {
        userId: groupOrderPortalId,
        groupId: group.id,
        organizationId: organization.id,
        createdByUserId: superAdminId,
      },
      {
        userId: groupUserId,
        groupId: group.id,
        organizationId: organization.id,
        createdByUserId: superAdminId,
      },
    ])
    .onConflictDoNothing()

  const [existingProduct] = await db
    .select({ id: globalProducts.id })
    .from(globalProducts)
    .where(eq(globalProducts.productCode, SMOKE_PRODUCT_CODE))
    .limit(1)
  const [product] = existingProduct
    ? await db
        .update(globalProducts)
        .set({
          name: "E2E Smoke Product",
          basePrice: 25_000,
          stockQuantity: 1_000_000,
          status: "active",
          deletedAt: null,
          updatedAt: new Date(),
        })
        .where(eq(globalProducts.id, existingProduct.id))
        .returning({ id: globalProducts.id })
    : await db
        .insert(globalProducts)
        .values({
          productCode: SMOKE_PRODUCT_CODE,
          name: "E2E Smoke Product",
          basePrice: 25_000,
          stockQuantity: 1_000_000,
          unit: "piece",
          status: "active",
          createdByUserId: superAdminId,
        })
        .returning({ id: globalProducts.id })

  const [inventory] = await db
    .insert(organizationInventory)
    .values({
      organizationId: organization.id,
      globalProductId: product.id,
      assignedByUserId: superAdminId,
      isActive: true,
      customPrice: 25_000,
    })
    .onConflictDoUpdate({
      target: [organizationInventory.organizationId, organizationInventory.globalProductId],
      set: {
        assignedByUserId: superAdminId,
        isActive: true,
        customPrice: 25_000,
        deletedAt: null,
        updatedAt: new Date(),
      },
    })
    .returning({ id: organizationInventory.id })

  await db
    .insert(branchInventory)
    .values({
      branchId: branch.id,
      organizationId: organization.id,
      organizationInventoryId: inventory.id,
      assignedByUserId: superAdminId,
      isVisible: true,
      isActive: true,
    })
    .onConflictDoUpdate({
      target: [branchInventory.branchId, branchInventory.organizationInventoryId],
      set: {
        organizationId: organization.id,
        assignedByUserId: superAdminId,
        isVisible: true,
        isActive: true,
        deletedAt: null,
        updatedAt: new Date(),
      },
    })

  const period = new Date().toISOString().slice(0, 7)
  await db
    .insert(budgets)
    .values({
      organizationId: organization.id,
      branchId: branch.id,
      period,
      amountAllocatedCents: SMOKE_BUDGET_CENTS,
      amountSpentCents: 0,
      amountHeldCents: 0,
      amountCreditedCents: 0,
    })
    .onConflictDoUpdate({
      target: [budgets.branchId, budgets.period],
      set: {
        organizationId: organization.id,
        amountAllocatedCents: SMOKE_BUDGET_CENTS,
        updatedAt: new Date(),
      },
    })
}

/**
 * Seed the stable accounts and catalogue rows used by the deployment smoke run.
 *
 * The CI database is disposable, but this setup is intentionally idempotent and
 * non-destructive so a developer can repeat the suite without deleting rows.
 */
export async function seedRoleSmokeE2E(databaseUrl: string): Promise<void> {
  await withDb(databaseUrl, seedRoleSmokeRows)
}
