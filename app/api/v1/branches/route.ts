import { ok, error, readJson, requireApiRole } from "@/lib/api"
export const dynamic = 'force-dynamic'
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { auditLogs, branches as branchesTable, organizations } from "@/db/schema"
import { and, desc, eq, sql, inArray } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { logError } from "@/lib/global-logger"
import { getCached, invalidateByPrefix, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import { branchCreateSchema, validationMessage } from "@/lib/server/mutation-validation"
import {
  BRANCH_CREATION_ROLES,
  resolveBranchCreationAccess,
} from "@/lib/server/branch-creation-access"

/**
 * GET /api/v1/branches - List branches with access control
 */
export async function GET(req: Request) {
  try {
    const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"])
    if (err) return err

    const { searchParams } = new URL(req.url)
    const organizationIdRaw = searchParams.get("organizationId") || undefined
    const groupIdsRaw = searchParams.get("groupIds") || undefined
    const shouldRefresh = searchParams.has("refresh")

    // Validate organization ID parameter (supports single or comma-separated)
    let orgIds: number[] = []
    if (organizationIdRaw) {
      const ids = organizationIdRaw.split(',').map(id => id.trim())
      for (const id of ids) {
        if (!/^\d+$/.test(id)) {
          return error("Invalid organization ID format", 400)
        }
        const n = Number(id)
        if (n <= 0) {
          return error("Organization ID must be positive", 400)
        }
        orgIds.push(n)
      }
    }

    // Validate group IDs parameter
    let groupIds: number[] = []
    if (groupIdsRaw) {
      groupIds = groupIdsRaw.split(',').map(id => Number(id.trim())).filter(id => !isNaN(id) && id > 0)
    }

    const scope = await getRequestScope()

    // Validate scope
    if (!scope?.role) {
      logError(new Error('Missing role in request scope'), 'BRANCHES_GET')
      return error("Invalid session data", 401)
    }

    // Determine which organizations to query based on role
    const scopedOrgIds = scope.role === "SUPER_ADMIN"
      ? orgIds.length ? orgIds : undefined
      : (scope.organizationId ? [scope.organizationId] : undefined)

    const scopedBranchId = scope.role === "BRANCH_ADMIN"
      ? scope.branchId
      : undefined

    // HEAD_OFFICE and BRANCH_ADMIN must have organization context
    if ((scope.role === "HEAD_OFFICE" || scope.role === "BRANCH_ADMIN") && (!scopedOrgIds || scopedOrgIds.length === 0)) {
      return error("Organization context required", 403)
    }

    // BRANCH_ADMIN must have branch context
    if (scope.role === "BRANCH_ADMIN" && !scopedBranchId) {
      return error("Branch context required", 403)
    }

    const cacheKey = scopedCacheKey(
      'branches', 
      { role: scope.role, branchId: scopedBranchId },
      { 
        orgIds: scopedOrgIds?.join(','),
        groupIds: groupIds.join(',')
      }
    )

    const fetchBranches = async () => {
      const items = await db
        .select({
          id: branchesTable.id,
          organizationId: branchesTable.organizationId,
          name: branchesTable.name,
          province: branchesTable.province,
          city: branchesTable.city,
          address: branchesTable.address,
          costCenterId: branchesTable.costCenterId,
          code: branchesTable.code,
          status: branchesTable.status,
          groupId: branchesTable.groupId,
          adminUserId: branchesTable.adminUserId,
          createdAt: branchesTable.createdAt,
          updatedAt: branchesTable.updatedAt,
          groupName: sql<string | null>`(
            SELECT name FROM groups WHERE id = ${branchesTable.groupId}
          )`,
        })
        .from(branchesTable)
        .where(and(
          scopedOrgIds && scopedOrgIds.length > 0 
            ? (scopedOrgIds.length === 1 
                ? eq(branchesTable.organizationId, scopedOrgIds[0]) 
                : inArray(branchesTable.organizationId, scopedOrgIds))
            : undefined,
          groupIds.length > 0 ? inArray(branchesTable.groupId, groupIds) : undefined,
          scopedBranchId ? eq(branchesTable.id, scopedBranchId) : undefined
        ))
        .orderBy(desc(branchesTable.createdAt))
        .limit(500)

      return { items, count: items.length }
    }

    const result = shouldRefresh
      ? await fetchBranches()
      : await getCached(cacheKey, fetchBranches, CACHE_TTL.LISTING)

    return ok(result)
  } catch (e: any) {
    logError(e, 'BRANCHES_GET')
    logError(e, 'BRANCHES_GET')
    const { status, ...errorBody } = handleError(e, 'BRANCHES_GET')
    return NextResponse.json(errorBody, { status })
  }
}

/**
 * POST /api/v1/branches - Create new branch
 */
export async function POST(req: Request) {
  try {
    const err = await requireApiRole(BRANCH_CREATION_ROLES)
    if (err) return err

    const rawBody = await readJson<unknown>(req)
    const parsedBody = branchCreateSchema.safeParse(rawBody)
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
    const body = parsedBody.data

    // Validate required fields
    if (!body?.organizationId) {
      return error("Organization ID is required", 400)
    }

    const requestedOrganizationId = Number(body.organizationId)
    const scope = await getRequestScope()
    if (!scope) return error("Invalid session data", 401)

    // Multi-tenant boundary: Head Office cannot choose a tenant. The effective
    // organization must match the user's current database-backed request scope.
    const access = resolveBranchCreationAccess(scope, requestedOrganizationId)
    if (!access.allowed) return error(access.message, access.status)
    const organizationId = access.organizationId

    // Validate field format and length
    const name = String(body.name || "").trim()
    if (name.length < 2 || name.length > 100) {
      return error("Branch name must be between 2 and 100 characters", 400)
    }

    const province = String(body.province || "").trim()
    if (province.length < 2 || province.length > 100) {
      return error("Branch province must be between 2 and 100 characters", 400)
    }

    const city = String(body.city || "").trim()
    if (city.length < 2 || city.length > 100) {
      return error("Branch city must be between 2 and 100 characters", 400)
    }

    const address = String(body.address || "").trim()
    if (address.length < 5 || address.length > 500) {
      return error("Branch address must be between 5 and 500 characters", 400)
    }

    const costCenterId = String(body.costCenterId || "").trim()
    if (costCenterId.length > 128) {
      return error("Cost center ID must be 128 characters or less", 400)
    }

    // Validate status
    const validStatuses = ['active', 'inactive']
    const status = body.status ? String(body.status).toLowerCase() : 'active'
    if (!validStatuses.includes(status)) {
      return error(`Status must be one of: ${validStatuses.join(', ')}`, 400)
    }

    const creation = await db.transaction(async (tx) => {
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

      if (!org) return { kind: "organization-not-found" } as const

      const [existingBranchWithName] = await tx
        .select({ id: branchesTable.id })
        .from(branchesTable)
        .where(and(
          eq(branchesTable.organizationId, organizationId),
          sql`lower(btrim(${branchesTable.name})) = ${name.toLowerCase()}`,
        ))
        .limit(1)

      if (existingBranchWithName) return { kind: "duplicate-name" } as const

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
        })
        .returning()

      await tx.insert(auditLogs).values({
        userId: scope.userId,
        organizationId,
        branchId: item.id,
        action: "CREATE_BRANCH",
        entity: "BRANCH",
        entityId: String(item.id),
        metadata: {
          performedByRole: scope.role,
          name: item.name,
          code: item.code,
          status: item.status,
        },
      })

      return { kind: "created", item } as const
    })

    if (creation.kind === "organization-not-found") {
      return error(`Organization with ID ${organizationId} not found`, 404)
    }
    if (creation.kind === "duplicate-name") {
      return error("A branch with this name already exists in this organization.", 409)
    }

    // Invalidate branches cache
    await invalidateByPrefix('branches')

    return ok({
      item: creation.item,
      message: "Branch created successfully"
    }, { status: 201 })

  } catch (e: any) {
    const databaseError = e?.cause ?? e
    const databaseCode = databaseError?.code ?? e?.code
    const databaseConstraint = databaseError?.constraint ?? e?.constraint

    // Handle database constraint violations
    if (databaseCode === '23505') { // Unique violation
      if (databaseConstraint === "branches_org_name_normalized_uq") {
        return error("A branch with this name already exists in this organization.", 409)
      }
      return error("Branch with this code already exists in this organization", 409)
    }

    if (databaseCode === '23503') { // Foreign key violation
      return error("Referenced organization does not exist", 404)
    }

    logError(e, 'BRANCHES_POST')
    const { status, ...errorBody } = handleError(e, 'BRANCHES_POST')
    return NextResponse.json(errorBody, { status })
  }
}
