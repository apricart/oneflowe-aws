import "server-only"

import { and, eq, sql } from "drizzle-orm"

import { auditLogs, branches as branchesTable, organizations } from "@/db/schema"
import { db } from "@/lib/db"
import type { BranchRegion } from "@/lib/branch-region"

/**
 * Creating a branch inside a caller's transaction.
 *
 * Moved out of `POST /api/v1/branches` unchanged so the department sign-up's
 * approval (plans/OF-JOIN-department-signup-multi-user.md) creates a branch by
 * exactly the same rules: the per-tenant advisory lock, the case-insensitive
 * duplicate-name refusal, the `{ORG_CODE}-NN` code, and the `CREATE_BRANCH`
 * audit row in the same transaction as the insert.
 *
 * Authorization and the tenant are the caller's: this takes an organization id
 * the caller has already proved, and never reads one from a request.
 */

type TransactionExecutor = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type BranchCreationValues = {
  organizationId: number
  name: string
  province: string
  city: string
  address: string
  costCenterId: string | null
  status: string
  region: BranchRegion | null
}

export type BranchCreationOutcome =
  | { kind: "organization-not-found" }
  | { kind: "duplicate-name" }
  | { kind: "created"; item: typeof branchesTable.$inferSelect }

export async function createBranchInTx(
  tx: TransactionExecutor,
  values: BranchCreationValues,
  actor: { userId: string; role: string },
): Promise<BranchCreationOutcome> {
  const { organizationId, name, province, city, address, costCenterId, status } = values

  // Branch codes are based on the current branch count. Serialize creation
  // within this tenant so concurrent requests cannot choose the same code.
  await tx.execute(sql`
    SELECT pg_advisory_xact_lock(
      hashtext('oneflowe:branch-creation'),
      ${organizationId}::integer
    )
  `)

  const [org] = await tx
    .select({ id: organizations.id, name: organizations.name, code: organizations.code })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)

  if (!org) return { kind: "organization-not-found" }

  const [existingBranchWithName] = await tx
    .select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(
      eq(branchesTable.organizationId, organizationId),
      sql`lower(btrim(${branchesTable.name})) = ${name.toLowerCase()}`,
    ))
    .limit(1)

  if (existingBranchWithName) return { kind: "duplicate-name" }

  // Preserve the existing {ORG_CODE}-{COUNT+1} branch-code format.
  const [{ count: branchCount }] = await tx
    .select({ count: sql<number>`count(*)` })
    .from(branchesTable)
    .where(eq(branchesTable.organizationId, organizationId))

  const nextNumber = (Number(branchCount) + 1).toString().padStart(2, "0")
  const generatedCode = `${org.code}-${nextNumber}`
  const [existingCode] = await tx
    .select({ id: branchesTable.id })
    .from(branchesTable)
    .where(and(
      eq(branchesTable.organizationId, organizationId),
      eq(branchesTable.code, generatedCode),
    ))
    .limit(1)

  const finalCode = existingCode
    ? `${org.code}-${nextNumber}-${Date.now().toString().slice(-4)}`
    : generatedCode

  const [item] = await tx
    .insert(branchesTable)
    .values({
      organizationId,
      name,
      province,
      city,
      address,
      costCenterId: costCenterId || null,
      code: finalCode,
      status,
      region: values.region,
    })
    .returning()

  await tx.insert(auditLogs).values({
    userId: actor.userId,
    organizationId,
    branchId: item.id,
    action: "CREATE_BRANCH",
    entity: "BRANCH",
    entityId: String(item.id),
    metadata: {
      performedByRole: actor.role,
      name: item.name,
      code: item.code,
      status: item.status,
    },
  })

  return { kind: "created", item }
}
