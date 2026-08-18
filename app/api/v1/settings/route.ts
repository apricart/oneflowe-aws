import { db } from "@/lib/db"
import { organizationSettings, auditLogs } from "@/db/schema"
import { eq, and } from "drizzle-orm"
import { ok, err, requireApiRole } from "@/lib/api"
import { NextRequest, NextResponse } from "next/server"
import { handleError } from "@/lib/error-handler"
import { logError } from "@/lib/global-logger"
import { getRequestScope } from "@/lib/auth"
import { getCached, invalidateByPrefix, scopedCacheKey, CACHE_TTL } from "@/lib/cache-utils"
import {
  BUDGET_ALLOCATION_MODE_SETTING_KEY,
  isBudgetAllocationMode,
} from "@/lib/budget-allocation-mode"
import { PRICE_VISIBILITY_SETTING_KEYS, isPriceVisibilitySettingKey } from "@/lib/price-visibility"
import { organizationSettingSchema, validationMessage } from "@/lib/server/mutation-validation"
import {
  SESSION_IDLE_TIMEOUT_MINUTES_MAX,
  SESSION_IDLE_TIMEOUT_MINUTES_MIN,
} from "@/lib/session-policy"

// Valid setting keys
const VALID_SETTING_KEYS = new Set([
  'default_currency',
  'tax_rate',
  'auto_approve_orders',
  'order_approval_threshold',
  'require_mfa',
  'session_timeout_minutes',
  'low_stock_threshold',
  'enable_notifications',
  BUDGET_ALLOCATION_MODE_SETTING_KEY,
  ...PRICE_VISIBILITY_SETTING_KEYS
])

/**
 * Validate setting key
 */
function isValidSettingKey(key: string): boolean {
  return VALID_SETTING_KEYS.has(key)
}

async function invalidateSettingCaches(key: string) {
  await invalidateByPrefix('settings')

  if (isPriceVisibilitySettingKey(key)) {
    await invalidateByPrefix('branch-inv')
    await invalidateByPrefix('inv:branch-products')
    await invalidateByPrefix('inv:org-products')
  }

  if (key === BUDGET_ALLOCATION_MODE_SETTING_KEY) {
    await invalidateByPrefix('organizations')
    await invalidateByPrefix('branch-inv')
    await invalidateByPrefix('budgets')
    await invalidateByPrefix('analytics')
  }
}

function getSettingAccessError(scope: Awaited<ReturnType<typeof getRequestScope>>, organizationId: number, key: string) {
  if (isPriceVisibilitySettingKey(key) && scope?.role !== "SUPER_ADMIN") {
    return "Only Super Admin can modify price visibility"
  }
  if (scope?.role === "HEAD_OFFICE" && organizationId !== scope.organizationId) {
    return "Forbidden: Cannot modify settings for other organizations"
  }
  if (key === BUDGET_ALLOCATION_MODE_SETTING_KEY && scope?.role !== "SUPER_ADMIN") {
    return "Only Super Admin can set budget allocation mode"
  }
  return null
}

function getNumericSettingError(key: string, value: unknown) {
  if (key === "tax_rate" && (typeof value !== "number" || value < 0 || value > 1)) {
    return "tax_rate must be a number between 0 and 1"
  }
  if (key === "order_approval_threshold" && (typeof value !== "number" || value < 0)) {
    return "order_approval_threshold must be a non-negative number"
  }
  if (
    key === "session_timeout_minutes" &&
    (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < SESSION_IDLE_TIMEOUT_MINUTES_MIN ||
      value > SESSION_IDLE_TIMEOUT_MINUTES_MAX
    )
  ) {
    return `session_timeout_minutes must be an integer between ${SESSION_IDLE_TIMEOUT_MINUTES_MIN} and ${SESSION_IDLE_TIMEOUT_MINUTES_MAX}`
  }
  if (key === "low_stock_threshold" && (typeof value !== "number" || value < 0)) {
    return "low_stock_threshold must be a non-negative number"
  }
  return null
}

function getTypedSettingError(key: string, value: unknown) {
  const booleanSetting = ['auto_approve_orders', 'require_mfa', 'enable_notifications'].includes(key)
    || isPriceVisibilitySettingKey(key)
  if (booleanSetting && typeof value !== "boolean") return `${key} must be a boolean`
  if (key === "default_currency" && (typeof value !== "string" || value.length !== 3)) {
    return "default_currency must be a 3-letter currency code"
  }
  if (key === BUDGET_ALLOCATION_MODE_SETTING_KEY && !isBudgetAllocationMode(value)) {
    return "budget_allocation_mode must be either money or quantity"
  }
  return null
}

function getSettingValidationError(organizationId: number, key: string, value: unknown) {
  if (!organizationId) return "organizationId is required"
  if (!key || typeof key !== "string") return "key is required and must be a string"
  if (typeof organizationId !== "number" || organizationId <= 0) return "organizationId must be a positive number"
  if (!isValidSettingKey(key)) {
    return `Invalid setting key: ${key}. Must be one of: ${Array.from(VALID_SETTING_KEYS).join(', ')}`
  }
  if (value === undefined) return "value is required"
  return getNumericSettingError(key, value) || getTypedSettingError(key, value)
}

/**
 * GET /api/v1/settings - Fetch organization settings
 */
export async function GET(req: NextRequest) {
  const authErr = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (authErr) return authErr

  try {
    const { searchParams } = req.nextUrl
    let organizationIdParam = searchParams.get("organizationId")

    // BOLA: HEAD_OFFICE must be scoped to their own organization
    const scope = await getRequestScope()
    if (scope?.role === "HEAD_OFFICE") {
      organizationIdParam = scope.organizationId ? String(scope.organizationId) : null
      if (!organizationIdParam) return err("Organization context required", 400)
    }

    if (organizationIdParam) {
      // Validate organization ID
      const organizationId = Number.parseInt(organizationIdParam, 10)
      if (Number.isNaN(organizationId) || organizationId <= 0) {
        return err("Invalid organization ID", 400)
      }

      const cacheKey = scopedCacheKey('settings', { orgId: organizationId })

      const settings = await getCached(cacheKey, () =>
        db
          .select()
          .from(organizationSettings)
          .where(eq(organizationSettings.organizationId, organizationId)),
        CACHE_TTL.SETTINGS
      )

      return ok({ data: settings })
    }

    // Return all settings (SUPER_ADMIN only path)
    const cacheKeyAll = 'cache:settings:all'
    const allSettings = await getCached(cacheKeyAll, () =>
      db.select().from(organizationSettings),
      CACHE_TTL.SETTINGS
    )
    return ok({ data: allSettings })
  } catch (e: any) {
    logError(e, 'SETTINGS_GET')
    const { status, ...errorBody } = handleError(e, 'Settings API')
    return NextResponse.json(errorBody, { status })
  }
}

/**
 * POST /api/v1/settings - Create or update setting
 */
export async function POST(req: NextRequest) {
  const authErr = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (authErr) return authErr

  try {
    const rawBody = await req.json().catch(() => null)
    const parsedBody = organizationSettingSchema.safeParse(rawBody)
    if (!parsedBody.success) return err(validationMessage(parsedBody.error), 400)
    const { organizationId, key, value } = parsedBody.data

    // BOLA: HEAD_OFFICE must only modify their own org's settings
    const scope = await getRequestScope()
    const accessError = getSettingAccessError(scope, organizationId, key)
    if (accessError) return err(accessError, 403)
    const validationError = getSettingValidationError(organizationId, key, value)
    if (validationError) return err(validationError, 400)

    // Check if setting already exists
    const existing = await db
      .select()
      .from(organizationSettings)
      .where(
        and(
          eq(organizationSettings.organizationId, organizationId),
          eq(organizationSettings.key, key)
        )
      )
      .limit(1)

    const result = await db.transaction(async (tx) => {
      const [saved] = await tx
        .insert(organizationSettings)
        .values({ organizationId, key, value })
        .onConflictDoUpdate({
          target: [organizationSettings.organizationId, organizationSettings.key],
          set: { value, updatedAt: new Date() },
        })
        .returning()

      await tx.insert(auditLogs).values({
        action: existing.length > 0 ? "UPDATE_SETTING" : "CREATE_SETTING",
        entity: "organization_settings",
        entityId: saved.id.toString(),
        userId: scope?.userId,
        organizationId,
        metadata: {
          key,
          value,
          previousValue: existing[0]?.value ?? null,
        },
      })

      return saved
    })

    // Invalidate settings and every dependent tenant-scoped read cache.
    await invalidateSettingCaches(key)

    return ok({
      data: result,
      message: existing.length > 0 ? "Setting updated successfully" : "Setting created successfully"
    })
  } catch (error: any) {
    if (error?.name === 'SyntaxError') {
      return err("Invalid JSON in request body", 400)
    }
    logError(error, 'SETTINGS_POST')
    return err("Failed to save setting", 500)
  }
}

/**
 * DELETE /api/v1/settings - Delete setting
 */
export async function DELETE(req: NextRequest) {
  const authErr = await requireApiRole(["SUPER_ADMIN"])
  if (authErr) return authErr

  try {
    const scope = await getRequestScope()
    const { searchParams } = req.nextUrl
    const idParam = searchParams.get("id")

    if (!idParam) {
      return err("Setting id is required", 400)
    }

    // Validate ID
    const id = Number.parseInt(idParam, 10)
    if (Number.isNaN(id) || id <= 0) {
      return err("Invalid setting id", 400)
    }

    // Check if setting exists
    const existing = await db
      .select()
      .from(organizationSettings)
      .where(eq(organizationSettings.id, id))
      .limit(1)

    if (existing.length === 0) {
      return err("Setting not found", 404)
    }

    const [deleted] = await db
      .delete(organizationSettings)
      .where(eq(organizationSettings.id, id))
      .returning()

    // Log the action
    try {
      await db.insert(auditLogs).values({
        action: "DELETE_SETTING",
        entity: "organization_settings",
        entityId: id.toString(),
        userId: scope?.userId,
        organizationId: deleted.organizationId,
        metadata: { key: deleted.key, previousValue: deleted.value }
      })
    } catch (auditError) {
      // Log but don't fail the request
      logError(auditError, 'SETTINGS_AUDIT_LOG')
    }

    // DELETE must invalidate the same dependent caches as an update. Without
    // this, a removed price-visibility or budget-mode setting could remain
    // effective until its cache TTL elapsed.
    await invalidateSettingCaches(deleted.key)

    return ok({
      message: "Setting deleted successfully",
      deletedKey: deleted.key
    })
  } catch (error: any) {
    logError(error, 'SETTINGS_DELETE')
    return err("Failed to delete setting", 500)
  }
}
