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
import {
  resolveScopedBranchIds,
  usesMultiBranchScope,
} from "@/lib/server/multi-branch-scope"

type BranchCreateInput = ReturnType<typeof branchCreateSchema.parse>
type RequestScope = NonNullable<Awaited<ReturnType<typeof getRequestScope>>>

function parseOrganizationIds(raw: string | undefined) {
  if (!raw) return { ids: [] as number[] }
  const ids: number[] = []
  for (const value of raw.split(",").map((id) => id.trim())) {
    if (!/^\d+$/.test(value)) return { ids, response: error("Invalid organization ID format", 400) }
    const id = Number(value)
    if (id <= 0) return { ids, response: error("Organization ID must be positive", 400) }
    ids.push(id)
  }
  return { ids }
}

const parseGroupIds = (raw: string | undefined) => (
  raw
    ? raw.split(",").map((id) => Number(id.trim())).filter((id) => !Number.isNaN(id) && id > 0)
    : []
)

const getScopedOrganizationIds = (scope: RequestScope, requestedIds: number[]) => {
  if (scope.role === "SUPER_ADMIN") return requestedIds.length > 0 ? requestedIds : undefined
  return scope.organizationId ? [scope.organizationId] : undefined
}

const getBranchQueryCondition = (
  organizationIds: number[] | undefined,
  groupIds: number[],
  branchId: number | null | undefined,
  assignedBranchIds?: number[] | null,
) => {
  let organizationCondition
  if (organizationIds?.length === 1) {
    organizationCondition = eq(branchesTable.organizationId, organizationIds[0])
  } else if (organizationIds && organizationIds.length > 1) {
    organizationCondition = inArray(branchesTable.organizationId, organizationIds)
  }

  return and(
    organizationCondition,
    // A multi-branch role only ever lists the branches assigned to it. The
    // caller refuses an empty assignment set before reaching this point, so
    // this narrows the query and never removes a restriction.
    assignedBranchIds ? inArray(branchesTable.id, assignedBranchIds) : undefined,
    groupIds.length > 0 ? inArray(branchesTable.groupId, groupIds) : undefined,
    branchId ? eq(branchesTable.id, branchId) : undefined,
  )
}

function validateBranchFields(body: BranchCreateInput) {
  const values = {
    name: String(body.name || "").trim(),
    province: String(body.province || "").trim(),
    city: String(body.city || "").trim(),
    address: String(body.address || "").trim(),
    costCenterId: String(body.costCenterId || "").trim(),
    status: body.status ? String(body.status).toLowerCase() : "active",
  }
  if (values.name.length < 2 || values.name.length > 100) {
    return { response: error("Branch name must be between 2 and 100 characters", 400) }
  }
  if (values.province.length < 2 || values.province.length > 100) {
    return { response: error("Branch province must be between 2 and 100 characters", 400) }
  }
  if (values.city.length < 2 || values.city.length > 100) {
    return { response: error("Branch city must be between 2 and 100 characters", 400) }
  }
  if (values.address.length < 5 || values.address.length > 500) {
    return { response: error("Branch address must be between 5 and 500 characters", 400) }
  }
  if (values.costCenterId.length > 128) {
    return { response: error("Cost center ID must be 128 characters or less", 400) }
  }
  if (!["active", "inactive"].includes(values.status)) {
    return { response: error("Status must be one of: active, inactive", 400) }
  }
  return { values }
}

function getBranchConstraintResponse(exception: any) {
  const databaseError = exception?.cause ?? exception
  const databaseCode = databaseError?.code ?? exception?.code
  const databaseConstraint = databaseError?.constraint ?? exception?.constraint
  if (databaseCode === "23505") {
    const nameConstraints = new Set([
      "branches_org_name_normalized_uq",
      "branches_org_name_normalized_unmapped_uq",
      "branches_org_name_exact_uq",
      "branches_org_name_identity_guard",
    ])
    return nameConstraints.has(databaseConstraint)
      ? error("A branch with this name already exists in this organization.", 409)
      : error("Branch with this code already exists in this organization", 409)
  }
  return databaseCode === "23503"
    ? error("Referenced organization does not exist", 404)
    : null
}

/**
 * GET /api/v1/branches - List branches with access control
 */
export async function GET(req: Request) {
  try {
    const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "GROUP_USER", "ORDER_PORTAL"])
    if (err) return err

    const { searchParams } = new URL(req.url)
    const organizationIdRaw = searchParams.get("organizationId") || undefined
    const groupIdsRaw = searchParams.get("groupIds") || undefined
    const shouldRefresh = searchParams.has("refresh")

    // Validate organization ID parameter (supports single or comma-separated)
    const organizationIds = parseOrganizationIds(organizationIdRaw)
    if (organizationIds.response) return organizationIds.response
    const orgIds = organizationIds.ids

    // Validate group IDs parameter
    const groupIds = parseGroupIds(groupIdsRaw)

    const scope = await getRequestScope()

    // Validate scope
    if (!scope?.role) {
      logError(new Error('Missing role in request scope'), 'BRANCHES_GET')
      return error("Invalid session data", 401)
    }

    // Determine which organizations to query based on role
    const scopedOrgIds = getScopedOrganizationIds(scope, orgIds)

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

    // A multi-branch role has no branch of its own; its reach is the resolved
    // assignment set, and an empty set is refused rather than listing the
    // tenant. Every other role keeps `null` here and is unaffected.
    const assignedBranchIds = usesMultiBranchScope(scope.role)
      ? await resolveScopedBranchIds(db, scope.userId)
      : null
    if (assignedBranchIds && assignedBranchIds.length === 0) {
      return error("Branch context required", 403)
    }
    if (assignedBranchIds && !scope.organizationId) {
      return error("Organization context required", 403)
    }

    const cacheKey = scopedCacheKey(
      'branches',
      { role: scope.role, branchId: scopedBranchId },
      {
        orgIds: scopedOrgIds?.join(','),
        groupIds: groupIds.join(','),
        // Two approvers in one tenant hold different assignments, so the cache
        // entry has to be keyed by the resolved set as well as by the role.
        assignedBranchIds: assignedBranchIds?.join(','),
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
        .where(getBranchQueryCondition(scopedOrgIds, groupIds, scopedBranchId, assignedBranchIds))
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

    const validated = validateBranchFields(body)
    if (validated.response) return validated.response
    const { name, province, city, address, costCenterId, status } = validated.values!

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
    const constraintResponse = getBranchConstraintResponse(e)
    if (constraintResponse) return constraintResponse

    logError(e, 'BRANCHES_POST')
    const { status, ...errorBody } = handleError(e, 'BRANCHES_POST')
    return NextResponse.json(errorBody, { status })
  }
}
