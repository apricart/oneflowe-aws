import { ok, error, readJson, requireApiRole } from "@/lib/api"
export const dynamic = 'force-dynamic'
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { branches as branchesTable, organizations } from "@/db/schema"
import { and, desc, eq, sql, inArray } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { logError } from "@/lib/global-logger"
import { getCached, invalidateByPrefix, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import { branchCreateSchema, validationMessage } from "@/lib/server/mutation-validation"

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
    const err = await requireApiRole(["SUPER_ADMIN"])
    if (err) return err

    const rawBody = await readJson<unknown>(req)
    const parsedBody = branchCreateSchema.safeParse(rawBody)
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
    const body = parsedBody.data

    // Validate required fields
    if (!body?.organizationId) {
      return error("Organization ID is required", 400)
    }

    // Validate organizationId type
    const organizationId = Number(body.organizationId)
    if (!Number.isInteger(organizationId) || organizationId <= 0) {
      return error("Organization ID must be a positive integer", 400)
    }

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

    // Verify organization exists and get its code
    const [org] = await db
      .select({ id: organizations.id, name: organizations.name, code: organizations.code })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)

    if (!org) {
      return error(`Organization with ID ${organizationId} not found`, 404)
    }

    // Check for duplicate branch name within the same organization (case-insensitive)
    const [existingBranchWithName] = await db
      .select({ id: branchesTable.id })
      .from(branchesTable)
      .where(and(
        eq(branchesTable.organizationId, organizationId),
        sql`lower(${branchesTable.name}) = ${name.toLowerCase()}`
      ))
      .limit(1)

    if (existingBranchWithName) {
      return error("A branch with this name already exists in this organization.", 409)
    }

    // Auto-generate code if not provided or to ensure standardization
    // Format: {ORG_CODE}-{COUNT+1}
    const [{ count: branchCount }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(branchesTable)
      .where(eq(branchesTable.organizationId, organizationId))

    const nextNumber = (Number(branchCount) + 1).toString().padStart(2, '0')
    const generatedCode = `${org.code}-${nextNumber}`

    // Double check for duplicate code (just in case of race conditions)
    const existing = await db
      .select({ id: branchesTable.id })
      .from(branchesTable)
      .where(and(
        eq(branchesTable.organizationId, organizationId),
        eq(branchesTable.code, generatedCode)
      ))
      .limit(1)

    let finalCode = generatedCode
    if (existing.length > 0) {
      // If collision, add a timestamp or more padding
      finalCode = `${org.code}-${nextNumber}-${Date.now().toString().slice(-4)}`
    }

    // Insert branch
    const [item] = await db
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

    // Invalidate branches cache
    await invalidateByPrefix('branches')

    return ok({
      item,
      message: "Branch created successfully"
    }, { status: 201 })

  } catch (e: any) {
    // Handle database constraint violations
    if (e.code === '23505') { // Unique violation
      return error("Branch with this code already exists in this organization", 409)
    }

    if (e.code === '23503') { // Foreign key violation
      return error("Referenced organization does not exist", 404)
    }

    logError(e, 'BRANCHES_POST')
    logError(e, 'BRANCHES_POST')
    const { status, ...errorBody } = handleError(e, 'BRANCHES_POST')
    return NextResponse.json(errorBody, { status })
  }
}
