import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { db } from "@/lib/db"
import {
  BUDGET_ALLOCATION_MODE_SETTING_KEY,
  isBudgetAllocationMode,
} from "@/lib/budget-allocation-mode"
import {
  organizations,
  branches,
  users,
  orders,
  headOffices,
  employeeCredentials,
  organizationSettings,
  orgMetrics,
  sessions,
  auditLogs,
  notifications,
  organizationProducts,
  organizationInventory,
  categories,
  products,
  skus,
  inventory,
  suppliers,
  budgets,
  groups,
  systemLogs,
  groupAuditLogs
} from "@/db/schema"
import { eq, count, and, ne, isNull, isNotNull } from "drizzle-orm"
import { organizationUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { getRequestScope } from "@/lib/auth"

type OrganizationUpdateInput = ReturnType<typeof organizationUpdateSchema.parse>

async function buildOrganizationPatch(body: OrganizationUpdateInput, organizationId: number) {
  const patch: Record<string, unknown> = {}
  if (body.name !== undefined) {
    const name = String(body.name).trim()
    const exists = await db.select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.name, name), ne(organizations.id, organizationId)))
      .limit(1)
    if (exists.length > 0) return { response: error(`Organization with name '${name}' already exists`, 400) }
    patch.name = name
  }
  if (body.code !== undefined) {
    const code = String(body.code).trim().toUpperCase()
    const exists = await db.select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.code, code), ne(organizations.id, organizationId)))
      .limit(1)
    if (exists.length > 0) return { response: error(`Organization with code '${code}' already exists`, 400) }
    patch.code = code
  }
  if (body.status !== undefined) {
    const status = String(body.status).toLowerCase()
    const validStatuses = ["active", "inactive", "suspended"]
    if (!validStatuses.includes(status)) {
      return { response: error(`Status must be one of: ${validStatuses.join(", ")}`, 400) }
    }
    patch.status = status
  }
  if (body.orderApproverRole !== undefined) patch.orderApproverRole = body.orderApproverRole

  const budgetAllocationMode = body.budgetAllocationMode === undefined
    ? undefined
    : String(body.budgetAllocationMode)
  if (budgetAllocationMode !== undefined && !isBudgetAllocationMode(budgetAllocationMode)) {
    return { response: error("Budget allocation mode must be either money or quantity", 400) }
  }
  patch.updatedAt = new Date()
  return { patch, budgetAllocationMode }
}

export async function GET(
  _: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"])
  if (err) return err
  const params = await props.params
  const { id } = params

  // BOLA Protection
  const orgId = Number(id)
  const { verifyResourceAccess } = await import("@/lib/auth")
  const hasAccess = await verifyResourceAccess(orgId)
  if (!hasAccess) return error("Forbidden: You do not have access to this organization", 403)

  const [item] = await db.select().from(organizations).where(eq(organizations.id, orgId))
  if (!item) return error("Not found", 404)
  return ok({ item })
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN"])
  if (err) return err
  const rawBody = await readJson<unknown>(req)
  if (!rawBody) return error("Invalid body", 400)
  const parsedBody = organizationUpdateSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const body = parsedBody.data
  try {
    const params = await props.params
    const { id } = params
    const orgId = Number(id)
    if (!Number.isInteger(orgId) || orgId <= 0) return error("Invalid organization ID", 400)
    const scope = await getRequestScope()
    if (!scope?.userId) return error("Invalid session data", 401)
    const prepared = await buildOrganizationPatch(body, orgId)
    if (prepared.response) return prepared.response
    const { patch, budgetAllocationMode } = prepared
    const transactionResult = await db.transaction(async (tx) => {
      // Serialize a policy change with in-flight approval/rejection decisions.
      const [existingOrganization] = await tx
        .select({
          id: organizations.id,
          orderApproverRole: organizations.orderApproverRole,
        })
        .from(organizations)
        .where(eq(organizations.id, orgId))
        .for("update")
        .limit(1)

      if (!existingOrganization) return null

      const [updatedOrganization] = await tx
        .update(organizations)
        .set(patch)
        .where(eq(organizations.id, orgId))
        .returning()

      if (budgetAllocationMode !== undefined) {
        await tx
          .insert(organizationSettings)
          .values({
            organizationId: orgId,
            key: BUDGET_ALLOCATION_MODE_SETTING_KEY,
            value: budgetAllocationMode,
          })
          .onConflictDoUpdate({
            target: [organizationSettings.organizationId, organizationSettings.key],
            set: { value: budgetAllocationMode, updatedAt: new Date() },
          })
      }

      if (
        body.orderApproverRole !== undefined
        && body.orderApproverRole !== existingOrganization.orderApproverRole
      ) {
        await tx.insert(auditLogs).values({
          userId: scope.userId,
          organizationId: orgId,
          action: "UPDATE_ORDER_APPROVER_ROLE",
          entity: "organization",
          entityId: String(orgId),
          metadata: {
            previousOrderApproverRole: existingOrganization.orderApproverRole,
            orderApproverRole: body.orderApproverRole,
          },
        })
      }

      return updatedOrganization
    })
    if (!transactionResult) return error("Organization not found", 404)
    const item = transactionResult

    // Invalidate organizations cache so GET returns fresh data immediately
    await invalidateByPrefix('organizations')
    await invalidateByPrefix('settings')
    if (budgetAllocationMode !== undefined) {
      await invalidateByPrefix('branch-inv')
      await invalidateByPrefix('budgets')
      await invalidateByPrefix('analytics')
    }

    return ok({
      item: {
        ...item,
        ...(budgetAllocationMode !== undefined ? { budgetAllocationMode } : {}),
      },
    })
  } catch (e: any) {
    console.error("Update organization failed:", e)
    return error("Update failed", 400)
  }
}

export async function DELETE(
  _: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN"])
  if (err) return err
  const params = await props.params
  const { id } = params
  const orgId = Number(id)

  try {
    // 0. Check if it exists
    const [existing] = await db.select().from(organizations).where(eq(organizations.id, orgId))
    if (!existing) return error("Organization not found", 404)

    // 1. Tier 1: Check for Critical Blockers (Data the user must handle manually)
    // These tables contain core business entities that shouldn't be auto-deleted.

    const [branchCount] = await db.select({ val: count() }).from(branches).where(eq(branches.organizationId, orgId))
    if (branchCount.val > 0) {
      return error(`Cannot delete: This company has ${branchCount.val} branch(es). Please delete all branches before deleting the company.`, 400)
    }

    const [userCount] = await db.select({ val: count() }).from(users).where(
      and(
        eq(users.organizationId, orgId),
        isNull(users.deletedAt)
      )
    )
    if (userCount.val > 0) {
      return error(`Cannot delete: This company has ${userCount.val} user(s). Please delete all users before deleting the company.`, 400)
    }

    const [orderCount] = await db.select({ val: count() }).from(orders).where(eq(orders.organizationId, orgId))
    if (orderCount.val > 0) {
      return error(`Cannot delete: Historical order records were found. Organizations with financial transaction history cannot be deleted.`, 400)
    }

    const [groupCount] = await db.select({ val: count() }).from(groups).where(and(eq(groups.organizationId, orgId), ne(groups.status, 'deleted')))
    if (groupCount.val > 0) {
      return error(`Cannot delete: This organization has ${groupCount.val} active group(s) defined. Please delete the organization's groups first.`, 400)
    }

    const [hoCount] = await db.select({ val: count() }).from(headOffices).where(eq(headOffices.organizationId, orgId))
    if (hoCount.val > 0) {
      return error(`Cannot delete: A Head Office record exists for this organization. Please remove it first.`, 400)
    }

    // 2. Tier 2: Auto-Cleanup Non-Critical Metadata/System Data
    // These tables contain logs, settings, and transitive associations that can be safely auto-purged.
    await db.transaction(async (tx) => {
      // System and Audit Logs
      await tx.delete(auditLogs).where(eq(auditLogs.organizationId, orgId))
      await tx.delete(systemLogs).where(eq(systemLogs.organizationId, orgId))
      await tx.delete(groupAuditLogs).where(eq(groupAuditLogs.organizationId, orgId))
      await tx.delete(notifications).where(eq(notifications.organizationId, orgId))
      await tx.delete(sessions).where(eq(sessions.organizationId, orgId))

      // Configuration and Metrics
      await tx.delete(organizationSettings).where(eq(organizationSettings.organizationId, orgId))
      await tx.delete(orgMetrics).where(eq(orgMetrics.organizationId, orgId))

      // Catalog and Inventory Associations
      await tx.delete(inventory).where(eq(inventory.organizationId, orgId))
      await tx.delete(organizationInventory).where(eq(organizationInventory.organizationId, orgId))
      await tx.delete(organizationProducts).where(eq(organizationProducts.organizationId, orgId))

      // Local Product Definitions (categories/products are often org-scoped)
      await tx.delete(skus).where(eq(skus.organizationId, orgId))
      await tx.delete(products).where(eq(products.organizationId, orgId))
      await tx.delete(categories).where(eq(categories.organizationId, orgId))

      // Operational Data
      await tx.delete(suppliers).where(eq(suppliers.organizationId, orgId))
      await tx.delete(budgets).where(eq(budgets.organizationId, orgId))
      await tx.delete(employeeCredentials).where(eq(employeeCredentials.organizationId, orgId))
      await tx.delete(groups).where(eq(groups.organizationId, orgId))

      // 3. Release FK references from soft-deleted users so the org can be dropped
      await tx.update(users).set({ organizationId: null }).where(
        and(eq(users.organizationId, orgId), isNotNull(users.deletedAt))
      )

      // 4. Final Step: Delete the Organization
      await tx.delete(organizations).where(eq(organizations.id, orgId))
    })

    // 4. Invalidate caches
    await invalidateByPrefix('organizations')
    await invalidateByPrefix('branches')

    return ok({ ok: true })
  } catch (e: any) {
    console.error("Delete organization failed:", e)

    const errorCode = String(e.code || e.originalError?.code || "")
    const errorMessage = String(e.message || "").toLowerCase()

    // Catch-all for any remaining foreign key constraints
    if (errorCode === "23503" || errorMessage.includes("foreign key") || errorMessage.includes("violates")) {
      return error("Cannot delete: A database dependency (foreign key) is still blocking deletion. Ensure all branches, users, and groups are removed.", 400)
    }

    return error("Failed to delete organization", 500)
  }
}
