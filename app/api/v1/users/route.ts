import { ok,error,readJson,requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { users as usersTable,roles as rolesTable,systemLogs,employeeCredentials,branches,organizations } from "@/db/schema"
import { and,desc,eq,ne,isNull } from "drizzle-orm"
import { getRequestScope } from "@/lib/auth"
import { headers } from "next/headers"
import { hashPassword } from "@/lib/password"
import { getCached,invalidateByPrefix,scopedCacheKey,CACHE_TTL } from "@/lib/cache-utils"
import { assertUniqueUserFields,normalizeEmail,normalizeOptionalText,UserUniqueFieldError } from "@/lib/user-uniqueness"
import { sendWelcomeEmail } from "@/lib/email"
import { userCreateSchema,validationMessage } from "@/lib/server/mutation-validation"
import { canAssignRole } from "@/lib/server/user-access-policy"
import { withRateLimit } from "@/lib/rate-limiter"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"

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


export async function GET(req: Request) {
  const err = await requireApiRole(USER_MANAGEMENT_ROLES)
  if (err) return err
  const { searchParams } = new URL(req.url)
  const organizationId = searchParams.get("organizationId")
  const shouldRefresh = searchParams.has("refresh")
  const scope = await getRequestScope()
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
        employeeId: usersTable.employeeId,
        imprestHolder: usersTable.imprestHolder,
        contactPerson: usersTable.contactPerson,
        address: usersTable.address,
      })
      .from(usersTable)
      .leftJoin(rolesTable, eq(usersTable.roleId, rolesTable.id))
      .where(and(...conditions))
      .orderBy(desc(usersTable.createdAt))
      .limit(500)

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
      employeeId: r.employeeId || null,
      imprestHolder: r.imprestHolder || null,
      contactPerson: r.contactPerson || null,
      address: r.address || null,
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
  // Get the current user's role to determine what roles they can create
  const scope = await getRequestScope()
  const currentUserRole = scope?.role

  if (scope?.userId) {
    const rateLimit = await withRateLimit("sensitive", scope.userId)
    if (rateLimit) return rateLimit
  }

  if (!currentUserRole || !canAssignRole(currentUserRole, role)) {
    console.error("[SECURITY] Role assignment denied:", { role, currentUserRole })
    return error("You cannot assign this role", 403)
  }

  // Additional validation for HEAD_OFFICE users
  if (currentUserRole === "HEAD_OFFICE") {
    // HEAD_OFFICE can only create users within their own organization
    if (organizationId !== scope?.organizationId) {
      return error("You can only create users within your own organization", 403)
    }
  }

  if (role === "HEAD_OFFICE") {
    if (!organizationId) return error("organizationId required for HEAD_OFFICE", 400)
  }
  if (role === "BRANCH_ADMIN" || role === "ORDER_PORTAL") {
    if (!organizationId || !branchId) {
      return error("organizationId and branchId required for BRANCH_ADMIN and ORDER_PORTAL", 400)
    }
  }

  if (organizationId) {
    const [organization] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.id, organizationId))
      .limit(1)
    if (!organization) return error("Invalid organization", 400)
  }

  if (branchId) {
    const [branch] = await db
      .select({ id: branches.id, organizationId: branches.organizationId })
      .from(branches)
      .where(eq(branches.id, branchId))
      .limit(1)
    if (branch?.organizationId !== organizationId) {
      return error("Branch does not belong to the selected organization", 400)
    }
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
    const [existingUsernameUser] = await db
      .select({ id: usersTable.id })
      .from(usersTable)
      .where(eq(usersTable.username, username))
      .limit(1)

    const [existingUsernameEmp] = await db
      .select({ id: employeeCredentials.id })
      .from(employeeCredentials)
      .where(eq(employeeCredentials.username, username))
      .limit(1)

    if (existingUsernameUser || existingUsernameEmp) {
      return error("Username already exists. Please choose a different username.", 400)
    }

    await assertUniqueUserFields({ email, phone, employeeId })

    const [item] = await db
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
        organizationId,
        branchId,
        fullName: `${firstName} ${lastName}`,
        employeeId,
        imprestHolder: input.imprestHolder ?? null,
        contactPerson: input.contactPerson ?? null,
        location: input.location ?? null,
        address: input.address ?? null,
        mustChangePassword: true,
      })
      .returning()

    const createdUser = item

    // Audit Log
    try {
      const headersList = await headers()
      const userAgent = headersList.get("user-agent")
      const forwardedFor = headersList.get("x-forwarded-for")
      const ip = forwardedFor ? forwardedFor.split(',')[0] : "unknown"

      await db.insert(systemLogs).values({
        userId: scope?.userId,
        userRole: currentUserRole,
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
          createdUserBranchId: branchId
        },
        ipAddress: ip,
        userAgent: userAgent,
        success: true
      })
    } catch (logErr) {
      console.error("[DEBUG] Failed to write audit log:", logErr)
    }

    // Send welcome email with credentials (non-blocking — never fail user creation over email)
    const loginUrl = getLoginUrl(req.url)
    sendWelcomeEmail(createdUser.email, createdUser.firstName || "", username, password, loginUrl).catch((emailErr) => {
      console.error("[USERS_API] Failed to send welcome email:", emailErr)
    })

    // Invalidate users cache so lists refresh immediately
    await invalidateByPrefix('users')

    const { passwordHash: _passwordHash, ...safeCreatedUser } = createdUser
    return ok({ item: safeCreatedUser }, { status: 201 })
  } catch (err: any) {
    if (err instanceof UserUniqueFieldError) {
      return error(err.message, 400)
    }

    // Catch validation errors from password hashing or unique constraints
    const errorCode = String(err.code || err.cause?.code || "")
    const errorMsg = String(err.message || "").toLowerCase()
    const detail = String(err.detail || err.cause?.detail || "").toLowerCase()

    if (errorCode === '23505' || errorMsg.includes('unique constraint') || detail.includes('already exists')) {
      if (detail.includes('username')) return error("Username already exists. Please choose a different username.", 400)
      if (detail.includes('employee_id')) return error("Internal ID (Employee ID) already exists.", 400)
      if (detail.includes('email')) return error("Email address already exists.", 400)
      if (detail.includes('phone')) return error("Phone number already exists.", 400)
      return error("Unique field conflict: " + detail, 400)
    }

    // Pass through validation errors as 400
    if (errorMsg.includes("invalid password") || errorMsg.includes("must contain")) {
      return error(err.message, 400)
    }

    // Only log actual unexpected errors
    console.error("[USERS_API] Unexpected error creating user:", err)
    return error(err.message || "Failed to create user", 500)
  }
}
