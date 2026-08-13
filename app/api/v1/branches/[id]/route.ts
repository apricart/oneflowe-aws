import { ok, error, readJson, requireApiRole } from "@/lib/api"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { db } from "@/lib/db"
import { branches, groups } from "@/db/schema"
import { and, eq, ne, sql } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { branchUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"

async function hasDuplicateBranchName(currentBranch: any, branchId: number, requestedName: unknown) {
  if (requestedName === undefined) return false
  const newName = String(requestedName).trim()
  if (!newName) return false
  const duplicateCandidates = await db
    .select({
      id: branches.id,
      name: branches.name,
      externalSource: branches.externalSource,
      externalId: branches.externalId,
    })
    .from(branches)
    .where(and(
      eq(branches.organizationId, currentBranch.organizationId),
      sql`lower(btrim(${branches.name})) = ${newName.toLowerCase()}`,
      ne(branches.id, branchId),
    ))
  const currentHasExternalIdentity = Boolean(currentBranch.externalSource && currentBranch.externalId)
  return duplicateCandidates.some((candidate) => {
    if (!currentHasExternalIdentity) return true
    const isDistinctSiblingFromSameSource = candidate.externalSource === currentBranch.externalSource
      && candidate.externalId
      && candidate.externalId !== currentBranch.externalId
      && candidate.name.trim() !== newName
    return !isDistinctSiblingFromSameSource
  })
}

function getTextFieldUpdate(value: unknown, minimumLength: number, maximumLength: number, label: string) {
  const normalized = String(value || "").trim()
  if (normalized && (normalized.length < minimumLength || normalized.length > maximumLength)) {
    return { error: `${label} must be between ${minimumLength} and ${maximumLength} characters` }
  }
  return { value: normalized || null }
}

function buildBranchPatch(body: any) {
  const patch: any = {}
  if (body.name !== undefined) patch.name = String(body.name)
  const fields = [
    ["province", 2, 100, "Branch province"],
    ["city", 2, 100, "Branch city"],
    ["address", 5, 500, "Branch address"],
  ] as const
  for (const [key, minimum, maximum, label] of fields) {
    if (body[key] === undefined) continue
    const result = getTextFieldUpdate(body[key], minimum, maximum, label)
    if (result.error) return { patch, error: result.error }
    patch[key] = result.value
  }
  if (body.costCenterId !== undefined) {
    const costCenterId = String(body.costCenterId || "").trim()
    if (costCenterId.length > 128) return { patch, error: "Cost center ID must be 128 characters or less" }
    patch.costCenterId = costCenterId || null
  }
  if (body.status !== undefined) {
    const normalized = String(body.status).toLowerCase()
    const validStatuses = ['active', 'inactive', 'suspended']
    if (!validStatuses.includes(normalized)) {
      return { patch, error: `Status must be one of: ${validStatuses.join(', ')}` }
    }
    patch.status = normalized
  }
  if (body.groupId !== undefined) patch.groupId = body.groupId === null ? null : Number(body.groupId)
  patch.updatedAt = new Date()
  return { patch }
}

async function validateBranchGroup(groupId: number | null | undefined, organizationId: number) {
  if (!groupId) return true
  const [group] = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(
      eq(groups.id, groupId),
      eq(groups.organizationId, organizationId),
      ne(groups.status, "deleted"),
    ))
    .limit(1)
  return Boolean(group)
}

export async function GET(
  _: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE", "BRANCH_ADMIN"])
  if (err) return err
  const params = await props.params
  const { id } = params
  const [item] = await db
    .select({
      id: branches.id,
      organizationId: branches.organizationId,
      name: branches.name,
      province: branches.province,
      city: branches.city,
      address: branches.address,
      costCenterId: branches.costCenterId,
      adminUserId: branches.adminUserId,
      code: branches.code,
      status: branches.status,
      groupId: branches.groupId,
      baselineBudgetCents: branches.baselineBudgetCents,
      createdAt: branches.createdAt,
      updatedAt: branches.updatedAt,
    })
    .from(branches)
    .where(eq(branches.id, Number(id)))
  if (!item) return error("Not found", 404)

  // BOLA Protection: verify user has access to this branch's organization
  const { verifyResourceAccess } = await import("@/lib/auth")
  const hasAccess = await verifyResourceAccess(item.organizationId, item.id)
  if (!hasAccess) return error("Forbidden: You do not have access to this branch", 403)

  return ok({ item })
}

export async function PATCH(
  req: Request,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
  if (err) return err
  const rawBody = await readJson<unknown>(req)
  if (!rawBody) return error("Invalid body", 400)
  const parsedBody = branchUpdateSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
  const body = parsedBody.data
  try {
    const params = await props.params
    const { id } = params

    const scope = await getRequestScope()

    const [currentBranch] = await db
      .select({
        organizationId: branches.organizationId,
        externalSource: branches.externalSource,
        externalId: branches.externalId,
      })
      .from(branches)
      .where(eq(branches.id, Number(id)))
    if (!currentBranch) return error("Not found", 404)

    if (scope?.role === "HEAD_OFFICE") {
      if (!scope.organizationId || scope.organizationId !== currentBranch.organizationId) {
        return error("Forbidden", 403)
      }
    }

    if (await hasDuplicateBranchName(currentBranch, Number(id), body.name)) {
      return error("A branch with this name already exists in this organization.", 409)
    }
    if (!await validateBranchGroup(body.groupId, currentBranch.organizationId)) {
      return error("Group does not belong to this organization", 400)
    }
    const patchResult = buildBranchPatch(body)
    if (patchResult.error) return error(patchResult.error, 400)
    const patch = patchResult.patch
    const [item] = await db.update(branches).set(patch).where(eq(branches.id, Number(id))).returning()

    // Invalidate branches and groups cache so GET returns fresh data immediately
    await invalidateByPrefix('branches')
    await invalidateByPrefix('groups')

    return ok({ item })
  } catch (e: any) {
    const databaseError = e?.cause ?? e
    const databaseCode = databaseError?.code ?? e?.code
    const databaseConstraint = databaseError?.constraint ?? e?.constraint
    if (databaseCode === "23505" && [
      "branches_org_name_normalized_unmapped_uq",
      "branches_org_name_exact_uq",
      "branches_org_name_identity_guard",
    ].includes(databaseConstraint)) {
      return error("A branch with this name already exists in this organization.", 409)
    }
    console.error("Update branch failed:", e)
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
  const branchId = Number(id)

  try {
    // 0. Check if exists
    const [existing] = await db.select().from(branches).where(eq(branches.id, branchId))
    if (!existing) return error("Branch not found", 404)

    // Already inactive
    if (existing.status === 'inactive') {
      return error("Branch is already inactive", 400)
    }

    // Soft-delete: mark as inactive instead of hard-deleting
    // All historical data (budgets, orders, audit logs, etc.) is preserved
    const [updated] = await db.update(branches)
      .set({
        status: 'inactive',
        updatedAt: new Date(),
      })
      .where(eq(branches.id, branchId))
      .returning()

    // Invalidate caches
    await invalidateByPrefix('branches')

    return ok({
      ok: true,
      message: "Branch deactivated successfully. All historical data has been preserved.",
      item: updated
    })

  } catch (e: any) {
    console.error("Delete branch failed:", e)
    return error("Failed to deactivate branch", 500)
  }
}

