import { ok, error, requireApiRole, readJson } from "@/lib/api"
export const dynamic = 'force-dynamic'
import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import { organizationSettings, organizations as orgsTable } from "@/db/schema"
import { and, desc, eq, inArray } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { handleError } from "@/lib/error-handler"
import { logError } from "@/lib/global-logger"
import { getCached, invalidateByPrefix, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import { organizationCreateSchema, validationMessage } from "@/lib/server/mutation-validation"
import {
  BUDGET_ALLOCATION_MODE_SETTING_KEY,
  DEFAULT_BUDGET_ALLOCATION_MODE,
  isBudgetAllocationMode,
  parseBudgetAllocationMode,
} from "@/lib/budget-allocation-mode"
import {
  HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY,
  HIDE_ORDER_PORTAL_PRICES_SETTING_KEY,
} from "@/lib/price-visibility"

/**
 * GET /api/v1/organizations - List organizations
 */
export async function GET() {
  try {
    const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"])
    if (err) return err

    const scope = await getRequestScope()

    // Validate scope data
    if (!scope?.role) {
      logError(new Error('Missing role in request scope'), 'ORGANIZATIONS_GET')
      return error("Invalid session data", 401)
    }

    // SUPER_ADMIN sees all, others see only their organization
    const where = scope.role === "SUPER_ADMIN"
      ? undefined as any
      : scope.organizationId
        ? eq(orgsTable.id, Number(scope.organizationId))
        : undefined as any

    // Validate organizationId for non-SUPER_ADMIN users
    if (scope.role !== "SUPER_ADMIN" && !scope.organizationId) {
      return error("Organization context required", 403)
    }

    const cacheKey = scopedCacheKey('organizations', { role: scope.role, orgId: scope.organizationId })

    const result = await getCached(cacheKey, async () => {
      const items = await db
        .select()
        .from(orgsTable)
        .where(where)
        .orderBy(desc(orgsTable.createdAt))
        .limit(500)

      if (items.length === 0) return { items, count: 0 }

      const budgetModeSettings = await db
        .select({
          organizationId: organizationSettings.organizationId,
          value: organizationSettings.value,
        })
        .from(organizationSettings)
        .where(and(
          inArray(organizationSettings.organizationId, items.map((item) => item.id)),
          eq(organizationSettings.key, BUDGET_ALLOCATION_MODE_SETTING_KEY),
        ))

      const budgetModeByOrgId = new Map(
        budgetModeSettings.map((setting) => [
          setting.organizationId,
          parseBudgetAllocationMode(setting.value),
        ])
      )

      return {
        items: items.map((item) => ({
          ...item,
          budgetAllocationMode: budgetModeByOrgId.get(item.id) ?? DEFAULT_BUDGET_ALLOCATION_MODE,
        })),
        count: items.length,
      }
    }, CACHE_TTL.LISTING)

    return ok(result)
  } catch (e: any) {
    logError(e, 'ORGANIZATIONS_GET')
    logError(e, 'ORGANIZATIONS_GET')
    const { status, ...errorBody } = handleError(e, 'ORGANIZATIONS_GET')
    return NextResponse.json(errorBody, { status })
  }
}

/**
 * POST /api/v1/organizations - Create new organization
 */
export async function POST(req: Request) {
  try {
    const err = await requireApiRole(["SUPER_ADMIN"]) // Only Super Admin can create organizations
    if (err) return err

    const rawBody = await readJson<unknown>(req)
    const parsedBody = organizationCreateSchema.safeParse(rawBody)
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
    const body = parsedBody.data

    // Validate required fields
    if (!body?.name || typeof body.name !== 'string') {
      return error("Organization name is required and must be a string", 400)
    }

    if (!body?.code || typeof body.code !== 'string') {
      return error("Organization code is required and must be a string", 400)
    }

    // Validate field lengths
    const name = String(body.name).trim()
    const code = String(body.code).trim().toUpperCase()

    if (name.length < 2 || name.length > 100) {
      return error("Organization name must be between 2 and 100 characters", 400)
    }

    if (code.length < 2 || code.length > 20) {
      return error("Organization code must be between 2 and 20 characters", 400)
    }

    // Validate code format (alphanumeric and underscores only)
    if (!/^[A-Z0-9_]+$/.test(code)) {
      return error("Organization code must contain only uppercase letters, numbers, and underscores", 400)
    }

    // Validate status if provided
    const validStatuses = ['active', 'inactive', 'suspended']
    const status = body.status ? String(body.status).toLowerCase() : 'active'

    if (!validStatuses.includes(status)) {
      return error(`Status must be one of: ${validStatuses.join(', ')}`, 400)
    }

    const budgetAllocationMode = body.budgetAllocationMode === undefined
      ? DEFAULT_BUDGET_ALLOCATION_MODE
      : String(body.budgetAllocationMode)

    if (!isBudgetAllocationMode(budgetAllocationMode)) {
      return error("Budget allocation mode must be either money or quantity", 400)
    }

    const priceVisibility = body.priceVisibility && typeof body.priceVisibility === "object"
      ? body.priceVisibility
      : {}
    const hideBranchAdminPrices = priceVisibility.hideBranchAdminPrices === undefined
      ? false
      : priceVisibility.hideBranchAdminPrices
    const hideOrderPortalPrices = priceVisibility.hideOrderPortalPrices === undefined
      ? false
      : priceVisibility.hideOrderPortalPrices

    if (typeof hideBranchAdminPrices !== "boolean") {
      return error("hideBranchAdminPrices must be a boolean", 400)
    }

    if (typeof hideOrderPortalPrices !== "boolean") {
      return error("hideOrderPortalPrices must be a boolean", 400)
    }

    // Check for duplicate name
    const existingName = await db
      .select({ id: orgsTable.id })
      .from(orgsTable)
      .where(eq(orgsTable.name, name))
      .limit(1)

    if (existingName.length > 0) {
      return error(`Organization with name '${name}' already exists`, 400)
    }

    // Check for duplicate code
    const existingCode = await db
      .select({ id: orgsTable.id })
      .from(orgsTable)
      .where(eq(orgsTable.code, code))
      .limit(1)

    if (existingCode.length > 0) {
      return error(`Organization with code '${code}' already exists`, 400)
    }

    const item = await db.transaction(async (tx) => {
      const [createdOrganization] = await tx
        .insert(orgsTable)
        .values({
          name,
          code,
          status
        })
        .returning()

      await tx.insert(organizationSettings).values([
        {
          organizationId: createdOrganization.id,
          key: BUDGET_ALLOCATION_MODE_SETTING_KEY,
          value: budgetAllocationMode,
        },
        {
          organizationId: createdOrganization.id,
          key: HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY,
          value: hideBranchAdminPrices,
        },
        {
          organizationId: createdOrganization.id,
          key: HIDE_ORDER_PORTAL_PRICES_SETTING_KEY,
          value: hideOrderPortalPrices,
        },
      ])

      return createdOrganization
    })

    // Invalidate organizations cache
    await invalidateByPrefix('organizations')
    await invalidateByPrefix('settings')

    return ok({
      item: {
        ...item,
        budgetAllocationMode,
      },
      message: "Organization created successfully"
    }, { status: 201 })

  } catch (e: any) {
    // Handle database constraint violations
    if (e.code === '23505') { // Unique violation
      return error("Organization with this code already exists", 409)
    }

    logError(e, 'ORGANIZATIONS_POST')
    logError(e, 'ORGANIZATIONS_POST')
    const { status, ...errorBody } = handleError(e, 'ORGANIZATIONS_POST')
    return NextResponse.json(errorBody, { status })
  }
}
