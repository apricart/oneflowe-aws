import { ok,error,readJson,requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { users as usersTable,roles as rolesTable,systemLogs,branches,organizations } from "@/db/schema"
import { and,desc,eq,ne,isNull } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { headers } from "next/headers"
import { hashPassword } from "@/lib/password"
import { getCached,invalidateByPrefix,scopedCacheKey,CACHE_TTL } from "@/lib/cache-utils"
import { assertUniqueUserFields,normalizeEmail,normalizeOptionalText,UserUniqueFieldError } from "@/lib/user-uniqueness"
import { sendWelcomeEmail } from "@/lib/email"
import { userCreateSchema,validationMessage } from "@/lib/server/mutation-validation"
import { approvalLevelRefusalForNewUser } from "@/lib/server/user-approval-level"
import { canAssignRole } from "@/lib/server/user-access-policy"
import { isViewerRole, VIEWER_READ_REFUSED, viewerReadScope } from "@/lib/viewer-access"
import { isOrderDeskRole, orderDeskUserShapeError } from "@/lib/order-desk-access"
import { apricartExecutiveUserShapeError, isApricartExecutiveRole } from "@/lib/apricart-executive-access"
import { isWarehouseRole, warehouseUserShapeError } from "@/lib/warehouse-access"
import { withRateLimit } from "@/lib/rate-limiter"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"
import { usernameExists } from "@/lib/user-username-uniqueness"
import type { SystemRole } from "@/lib/server/mutation-validation"
import {
  usesMultiBranchScope,
  rejectScopeForSingleBranchRole,
  replaceMultiBranchScope,
  resolveScopedBranchesForUsers,
  validateMultiBranchScope,
} from "@/lib/server/multi-branch-scope"

function getLoginUrl(requestUrl: string): string {
  const configuredUrl = process.env.NEXTAUTH_URL?.trim()

  if (configuredUrl) {
    try {
      return new URL("/login", configuredUrl).toString()
    } catch {
      console.error("[USERS_API] NEXTAUTH_URL is invalid; using the request origin for the welcome email")
    }
  }

  return new URL("/login", requestUrl).toString()
}

/**
 * Apricart's own staff roles carry no organization and no branch: the Order
 * Desk's reach is the assignments Super Admin grants from Desk team, and
 * management reads every organization. Undefined for any other role.
 */
function apricartStaffShapeError(
  role: SystemRole,
  organizationId: number | null,
  branchId: number | null,
): { message: string; status: number } | null | undefined {
  let shapeError: string | null
  if (isOrderDeskRole(role)) shapeError = orderDeskUserShapeError(organizationId, branchId)
  else if (isApricartExecutiveRole(role)) shapeError = apricartExecutiveUserShapeError(organizationId, branchId)
  else if (isWarehouseRole(role)) shapeError = warehouseUserShapeError(organizationId, branchId)
  else return undefined
  return shapeError ? { message: shapeError, status: 400 } : null
}

/** Which organization/branch fields the requested role requires or forbids. */
function getRoleShapeError(
  role: SystemRole,
  organizationId: number | null,
  branchId: number | null,
) {
  if (role === "HEAD_OFFICE" && !organizationId) {
    return { message: "organizationId required for HEAD_OFFICE", status: 400 }
  }
  // A Viewer always belongs to one tenant. Its branch is optional and decides
  // reach rather than shape: with one it reads that branch alone, without one
  // it reads the whole tenant. `resolveViewerScope` applies the same rule on
  // every endpoint the role is admitted to.
  if (isViewerRole(role) && !organizationId) {
    return { message: "organizationId required for VIEWER", status: 400 }
  }
  // Apricart's own cross-tenant staff: no organization, no branch.
  const staffShape = apricartStaffShapeError(role, organizationId, branchId)
  if (staffShape !== undefined) return staffShape
  if (["BRANCH_ADMIN", "ORDER_PORTAL"].includes(role) && (!organizationId || !branchId)) {
    return { message: "organizationId and branchId required for BRANCH_ADMIN and ORDER_PORTAL", status: 400 }
  }
  // A group-based user is not pinned to one branch — its reach comes from the
  // group/branch assignments validated separately.
  if (usesMultiBranchScope(role)) {
    if (!organizationId) return { message: "organizationId is required for this role", status: 400 }
    if (branchId) {
      return { message: "Group-based users are not assigned a single branch", status: 400 }
    }
  }
  return null
}

/** Confirm the referenced tenant rows exist and belong together. */
async function getTenantReferenceError(organizationId: number | null, branchId: number | null) {
  if (organizationId) {
    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
    if (!organization) return { message: "Invalid organization", status: 400 }
  }
  if (branchId) {
    const [branch] = await db
      .select({ organizationId: branches.organizationId })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1)
    if (branch?.organizationId !== organizationId) {
      return { message: "Branch does not belong to the selected organization", status: 400 }
    }
  }
  return null
}

async function validateUserAssignment(
  currentUserRole: SystemRole | undefined,
  scopeOrganizationId: number | null | undefined,
  role: SystemRole,
  organizationId: number | null,
  branchId: number | null,
) {
  if (!currentUserRole || !canAssignRole(currentUserRole, role)) {
    return { message: "You cannot assign this role", status: 403 }
  }
  if (currentUserRole === "HEAD_OFFICE" && organizationId !== scopeOrganizationId) {
    return { message: "You can only create users within your own organization", status: 403 }
  }
  return getRoleShapeError(role, organizationId, branchId)
    ?? await getTenantReferenceError(organizationId, branchId)
}

/** A requested approval level the role or organization does not admit; rolls the creation back. */
class ApprovalLevelRefusedError extends Error {}

async function writeUserCreationAudit(createdUser: any, scope: any, role: string, organizationId: number | null, branchId: number | null) {
  try {
    const headersList = await headers()
    const forwardedFor = headersList.get("x-forwarded-for")
    await db.insert(systemLogs).values({
      userId: scope?.userId,
      userRole: scope?.role,
      organizationId: scope?.organizationId,
      branchId: branchId || undefined,
      action: "USER_CREATE",
      resourceType: "user",
      resourceId: String(createdUser.id),
      details: {
        createdUserEmail: createdUser.email,
        createdUserUsername: createdUser.username,
        createdUserRole: role,
        createdUserOrgId: organizationId,
        createdUserBranchId: branchId,
        createdUserOrderApprovalLevel: createdUser.orderApprovalLevel ?? null,
      },
      ipAddress: forwardedFor ? forwardedFor.split(',')[0] : "unknown",
      userAgent: headersList.get("user-agent"),
      success: true,
    })
  } catch (auditError) {
    console.error("[DEBUG] Failed to write audit log:", auditError)
  }
}

function handleUserCreationError(caughtError: any) {
  if (caughtError instanceof UserUniqueFieldError) return error(caughtError.message, 400)
  if (caughtError instanceof ApprovalLevelRefusedError) return error(caughtError.message, 400)
  const errorCode = String(caughtError.code || caughtError.cause?.code || "")
  const errorMessage = String(caughtError.message || "").toLowerCase()
  const detail = String(caughtError.detail || caughtError.cause?.detail || "").toLowerCase()
  if (errorCode === '23505' || errorMessage.includes('unique constraint') || detail.includes('already exists')) {
    if (detail.includes('username')) return error("Username already exists. Please choose a different username.", 400)
    if (detail.includes('employee_id')) return error("Internal ID (Employee ID) already exists.", 400)
    if (detail.includes('email')) return error("Email address already exists.", 400)
    if (detail.includes('phone')) return error("Phone number already exists.", 400)
    return error("Unique field conflict: " + detail, 400)
  }
  if (errorMessage.includes("invalid password") || errorMessage.includes("must contain")) {
    return error(caughtError.message, 400)
  }
  console.error("[USERS_API] Unexpected error creating user:", caughtError)
  return error(caughtError.message || "Failed to create user", 500)
}


export async function GET(req: Request) {
  // An organization-wide Viewer reads its tenant's directory as Head Office does.
  const err = await requireApiRole(USER_MANAGEMENT_ROLES, { viewerReadsAsHeadOffice: true })
  if (err) return err
  const { searchParams } = new URL(req.url)
  const organizationId = searchParams.get("organizationId")
  const shouldRefresh = searchParams.has("refresh")
  const scope = viewerReadScope(await getRequestScope())
  if (!scope) return error(VIEWER_READ_REFUSED, 403)
  const scopedOrgId = (() => {
    if (scope?.role === "SUPER_ADMIN") {
      return (organizationId ? Number(organizationId) : undefined)
    }
    return (scope?.organizationId ?? undefined)
  })()

  const cacheKey = scopedCacheKey('users', { orgId: scopedOrgId, role: scope?.role })

  const fetchUsers = async () => {
    const conditions = [ne(rolesTable.name, "SUPER_ADMIN"), isNull(usersTable.deletedAt)]
    if (scopedOrgId) {
      conditions.push(eq(usersTable.organizationId, scopedOrgId))
    }

    const rows = await db
      .select({
        id: usersTable.id,
        email: usersTable.email,
        firstName: usersTable.firstName,
        lastName: usersTable.lastName,
        username: usersTable.username,
        location: usersTable.location,
        phone: usersTable.phone,
        mfaEnabled: usersTable.mfaEnabled,
        organizationId: usersTable.organizationId,
        branchId: usersTable.branchId,
        createdAt: usersTable.createdAt,
        role: rolesTable.name,
        isActive: usersTable.isActive,
        budgetAllocationEnabled: usersTable.budgetAllocationEnabled,
        employeeId: usersTable.employeeId,
        imprestHolder: usersTable.imprestHolder,
        contactPerson: usersTable.contactPerson,
        address: usersTable.address,
        externalSource: usersTable.externalSource,
        orderApprovalLevel: usersTable.orderApprovalLevel,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(and(...conditions))
      .orderBy(desc(usersTable.createdAt))
      .limit(500)

    // A group-based user has no `branch_id`; its branches are its assignments,
    // resolved with the same tenant fences as the order paths, so the
    // directory can show them instead of mislabelling the user "Head Office".
    const scopedBranches = await resolveScopedBranchesForUsers(
      db,
      rows.filter((r: any) => usesMultiBranchScope(r.role)).map((r: any) => r.id),
    )

    return rows.map((r: any) => ({
      id: r.id,
      email: r.email,
      firstName: r.firstName || "",
      lastName: r.lastName || "",
      username: r.username || "",
      location: r.location || null,
      phone: r.phone || null,
      mfaEnabled: !!r.mfaEnabled,
      organizationId: r.organizationId ?? null,
      branchId: r.branchId ?? null,
      createdAt: r.createdAt as any,
      role: r.role || "",
      isActive: !!r.isActive,
      budgetAllocationEnabled: r.role === "GROUP_USER" && r.budgetAllocationEnabled === true,
      employeeId: r.employeeId || null,
      imprestHolder: r.imprestHolder || null,
      contactPerson: r.contactPerson || null,
      address: r.address || null,
      // Present so the admin UI can tell a mirrored account apart: its role is
      // managed by the source system and cannot be switched here.
      externalSource: r.externalSource || null,
      // The level is shown and editable only while the organization admits it
      // (plans/OF-APPROVAL-LEVELS-assign-users-to-levels.md).
      orderApprovalLevel: r.orderApprovalLevel ?? null,
      // Null for every role pinned to (or not using) a single branch.
      assignedBranches: usesMultiBranchScope(r.role) ? (scopedBranches.get(r.id) ?? []) : null,
    }))
  }

  const items = shouldRefresh
    ? await fetchUsers()
    : await getCached(cacheKey, fetchUsers, CACHE_TTL.LISTING)

  return ok({ items })
}

export async function POST(req: Request) {
  console.log("[API/Users] POST /api/v1/users triggered")
  const err = await requireApiRole(USER_MANAGEMENT_ROLES)
  if (err) return err

  const rawBody = await readJson<unknown>(req)
  if (!rawBody) return error("Invalid body", 400)
  const parsedBody = userCreateSchema.safeParse(rawBody)
  if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)

  const input = parsedBody.data
  const firstName = input.firstName
  const lastName = input.lastName
  const email = normalizeEmail(input.email)
  const username = input.username.toLowerCase()
  const password = input.password
  const role = input.role
  const phone = normalizeOptionalText(input.phone)
  const employeeId = normalizeOptionalText(input.employeeId)
  const organizationId = input.organizationId
  const branchId = input.branchId
  const groupIds = input.groupIds ?? []
  const assignedBranchIds = input.branchIds ?? []
  // Get the current user's role to determine what roles they can create
  const scope = await getRequestScope()
  const currentUserRole = scope?.role

  if (scope?.userId) {
    const rateLimit = await withRateLimit("sensitive", scope.userId)
    if (rateLimit) return rateLimit
  }

  const assignmentError = await validateUserAssignment(
    currentUserRole as SystemRole | undefined,
    scope?.organizationId,
    role,
    organizationId,
    branchId,
  )
  if (assignmentError) return error(assignmentError.message, assignmentError.status)

  const strayScopeError = rejectScopeForSingleBranchRole(role, groupIds, assignedBranchIds)
  if (strayScopeError) return error(strayScopeError.message, strayScopeError.status)

  if (usesMultiBranchScope(role)) {
    const scopeError = await validateMultiBranchScope({
      organizationId,
      groupIds,
      branchIds: assignedBranchIds,
    })
    if (scopeError) return error(scopeError.message, scopeError.status)
  }

  const [roleRow] = await db.select().from(rolesTable).where(eq(rolesTable.name, role)).limit(1)
  if (!roleRow) {
    console.error("[DEBUG] Role row not found for name:", role)
    return error("Invalid role", 400)
  }

  // MFA is handled separately through the MFA system
  // No login code generation needed

  try {
    console.log("[USERS_API] Starting user creation for email:", email)
    const passwordHash = await hashPassword(password)
    console.log("[USERS_API] Password hashed successfully")

    // Username uniqueness is enforced by DB unique index and the check-username API
    if (await usernameExists(username)) {
      return error("Username already exists. Please choose a different username.", 400)
    }

    await assertUniqueUserFields({ email, phone, employeeId })

    const [item] = await db.transaction(async (tx) => {
      // Under the organization's FOR SHARE, so the level cannot be removed
      // between this check and the insert.
      const levelRefusal = await approvalLevelRefusalForNewUser(tx, {
        organizationId,
        role,
        level: input.orderApprovalLevel,
      })
      if (levelRefusal) throw new ApprovalLevelRefusedError(levelRefusal)

      const [created] = await tx
        .insert(usersTable)
        .values({
          email,
          username,
          passwordHash,
          roleId: roleRow.id,
          firstName,
          lastName,
          phone,
          mfaEnabled: input.mfaEnabled,
          isActive: input.isActive,
          budgetAllocationEnabled: role === "GROUP_USER" && input.budgetAllocationEnabled === true,
          organizationId,
          branchId,
          fullName: `${firstName} ${lastName}`,
          employeeId,
          imprestHolder: input.imprestHolder ?? null,
          contactPerson: input.contactPerson ?? null,
          location: input.location ?? null,
          address: input.address ?? null,
          mustChangePassword: true,
          orderApprovalLevel: input.orderApprovalLevel,
        })
        .returning()

      // Only the group role writes assignment rows; every other role leaves
      // both tables untouched, exactly as before this feature existed.
      if (usesMultiBranchScope(role) && organizationId) {
        await replaceMultiBranchScope(tx, {
          userId: created.id,
          organizationId,
          groupIds,
          branchIds: assignedBranchIds,
          createdByUserId: scope?.userId ?? null,
        })
      }

      return [created]
    })

    const createdUser = item

    await writeUserCreationAudit(createdUser, scope, role, organizationId, branchId)

    // Send welcome email with credentials (non-blocking — never fail user creation over email)
    const loginUrl = getLoginUrl(req.url)
    sendWelcomeEmail(createdUser.email, createdUser.firstName || "", username, password, loginUrl).catch((emailErr) => {
      console.error("[USERS_API] Failed to send welcome email:", emailErr)
    })

    // Invalidate users cache so lists refresh immediately
    await invalidateByPrefix('users')

    const { passwordHash: _passwordHash, ...safeCreatedUser } = createdUser
    return ok({ item: safeCreatedUser }, { status: 201 })
  } catch (caughtError: any) {
    return handleUserCreationError(caughtError)
  }
}
