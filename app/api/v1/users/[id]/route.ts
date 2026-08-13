import { type NextRequest } from "next/server"
import { db } from "@/lib/db"
import { users,roles,systemLogs,mfaCodes,auditLogs,notifications,employeeCredentials,sessions,groupAuditLogs } from "@/db/schema"
import { eq,or,count } from "drizzle-orm"
import { hashPassword } from "@/lib/password"
import { ok,error,requireApiRole,readJson } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"
import { headers } from "next/headers"
import { assertUniqueUserFields,normalizeEmail,normalizeOptionalText,UserUniqueFieldError } from "@/lib/user-uniqueness"
import { systemRoleSchema,userProfileUpdateSchema,validationMessage } from "@/lib/server/mutation-validation"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"
import { canManageUser } from "@/lib/server/user-access-policy"

async function getUsernameUpdateError(inputUsername: string | undefined, currentUsername: string, userId: string) {
  const nextUsername = inputUsername !== undefined ? inputUsername.toLowerCase() : currentUsername
  if (inputUsername !== undefined && !nextUsername) return { nextUsername, message: "Username is required" }
  if (inputUsername === undefined) return { nextUsername }
  const [[existing], [employeeMatch]] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.username, nextUsername)).limit(1),
    db.select({ id: employeeCredentials.id }).from(employeeCredentials).where(eq(employeeCredentials.username, nextUsername)).limit(1),
  ])
  if ((existing && existing.id !== userId) || employeeMatch) {
    return { nextUsername, message: "Username already in use by another user" }
  }
  return { nextUsername }
}

async function writeUserUpdateAudit(userId: string, input: unknown, sessionsInvalidated: boolean) {
  try {
    const logScope = await getRequestScope()
    const headersList = await headers()
    const forwardedFor = headersList.get("x-forwarded-for")
    await db.insert(systemLogs).values({
      userId: logScope?.userId,
      userRole: logScope?.role,
      organizationId: logScope?.organizationId,
      branchId: logScope?.branchId || undefined,
      action: "USER_UPDATE",
      resourceType: "user",
      resourceId: userId,
      details: { patchKeys: Object.keys(input as object), sessionsInvalidated },
      ipAddress: forwardedFor ? forwardedFor.split(',')[0] : "unknown",
      userAgent: headersList.get("user-agent"),
      success: true,
    })
  } catch (auditError) {
    console.error("[API/Users] Audit Log Error:", auditError)
  }
}

function getUniqueUserUpdateMessage(detail: string) {
  if (detail.includes('username')) return "Username already in use by another user"
  if (detail.includes('employee_id')) return "Internal ID (Employee ID) already exists."
  if (detail.includes('email')) return "Email address already exists."
  if (detail.includes('phone')) return "Phone number already exists."
  return "Unique field conflict: " + detail
}

function isUserUpdateValidationError(caughtError: any, errorMessage: string) {
  const validationFragments = [
    "Invalid password", "already exists", "Password", "unique constraint",
    "violates", "foreign key", "linked", "Cannot",
  ]
  return validationFragments.some((fragment) => errorMessage.includes(fragment))
    || ["23505", "23503"].includes(caughtError.code)
}

function handleUserUpdateError(caughtError: any) {
  const errorMessage = caughtError.message || "Failed to update user"
  if (caughtError instanceof UserUniqueFieldError) return error(caughtError.message, 400)
  const isUniqueConflict = caughtError.code === '23505'
    || errorMessage.includes('unique constraint')
    || errorMessage.includes('already exists')
  if (isUniqueConflict) {
    const detail = String(caughtError.detail || caughtError.cause?.detail || "").toLowerCase()
    return error(getUniqueUserUpdateMessage(detail), 400)
  }
  console.error("[API/Users] ERROR IN PATCH:", caughtError)
  return error(errorMessage, isUserUpdateValidationError(caughtError, errorMessage) ? 400 : 500)
}

async function getUserDeletionDependencies(userId: string) {
  const schema = await import("@/db/schema")
  const results = await Promise.all([
    db.select({ val: count() }).from(schema.branches).where(eq(schema.branches.adminUserId, userId)),
    db.select({ val: count() }).from(schema.orders).where(or(
      eq(schema.orders.createdByUserId, userId),
      eq(schema.orders.approvedByUserId, userId),
      eq(schema.orders.rejectedByUserId, userId),
      eq(schema.orders.fulfilledByUserId, userId),
      eq(schema.orders.refundedByUserId, userId),
    )),
    db.select({ val: count() }).from(schema.refunds).where(or(
      eq(schema.refunds.requestedByUserId, userId),
      eq(schema.refunds.processedByUserId, userId),
    )),
    db.select({ val: count() }).from(schema.restockRequests).where(or(
      eq(schema.restockRequests.requestedByUserId, userId),
      eq(schema.restockRequests.reviewedByUserId, userId),
    )),
    db.select({ val: count() }).from(schema.groups).where(eq(schema.groups.createdByUserId, userId)),
    db.select({ val: count() }).from(schema.globalProducts).where(eq(schema.globalProducts.createdByUserId, userId)),
    db.select({ val: count() }).from(employeeCredentials).where(eq(employeeCredentials.createdByUserId, userId)),
    db.select({ val: count() }).from(schema.organizationInventory).where(eq(schema.organizationInventory.assignedByUserId, userId)),
    db.select({ val: count() }).from(schema.branchInventory).where(eq(schema.branchInventory.assignedByUserId, userId)),
    db.select({ val: count() }).from(schema.productAssignments).where(eq(schema.productAssignments.performedByUserId, userId)),
    db.select({ val: count() }).from(schema.modifiers).where(eq(schema.modifiers.createdByUserId, userId)),
  ])
  const counts = results.map((result) => Number(result[0]?.val || 0))
  return { adminCount: counts[0], hasHistory: counts.slice(1).some((value) => value > 0) }
}

async function softDeleteUser(userId: string, email: string) {
  await db.update(users).set({
    deletedAt: new Date(),
    isActive: false,
    email: `deleted_${Date.now()}_${email}`,
  }).where(eq(users.id, userId))
  await Promise.all([
    db.delete(mfaCodes).where(eq(mfaCodes.userId, userId)),
    db.delete(sessions).where(eq(sessions.userId, userId)),
    db.delete(notifications).where(eq(notifications.userId, userId)),
  ])
}

async function hardDeleteUser(userId: string) {
  try {
    await Promise.all([
      db.delete(mfaCodes).where(eq(mfaCodes.userId, userId)),
      db.delete(sessions).where(eq(sessions.userId, userId)),
      db.delete(notifications).where(eq(notifications.userId, userId)),
      db.delete(groupAuditLogs).where(eq(groupAuditLogs.performedByUserId, userId)),
      db.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, userId)),
      db.update(systemLogs).set({ userId: null }).where(eq(systemLogs.userId, userId)),
    ])
  } catch (cleanupError: any) {
    throw new Error(`Failed to clean up user dependencies: ${cleanupError.message}. Please contact support.`, { cause: cleanupError })
  }
  await db.delete(users).where(eq(users.id, userId))
}

async function writeUserDeletionAudit(userId: string) {
  try {
    const logScope = await getRequestScope()
    const headersList = await headers()
    const forwardedFor = headersList.get("x-forwarded-for")
    await db.insert(systemLogs).values({
      userId: logScope?.userId,
      userRole: logScope?.role,
      organizationId: logScope?.organizationId,
      branchId: undefined,
      action: "USER_DELETE",
      resourceType: "user",
      resourceId: userId,
      details: { deletedUserId: userId },
      ipAddress: forwardedFor ? forwardedFor.split(',')[0] : "unknown",
      userAgent: headersList.get("user-agent"),
      success: true,
    })
  } catch (auditError) {
    console.error("Failed to write audit log:", auditError)
  }
}

function getForeignKeyDeletionMessage(detail: string) {
  if (detail.includes("mfa_codes") || detail.includes("mfacodes")) {
    return "Cannot delete: This user has active MFA codes. Please deactivate MFA first or contact support."
  }
  if (detail.includes("sessions")) {
    return "Cannot delete: This user has active sessions. Please wait for sessions to expire or deactivate the user instead."
  }
  if (detail.includes("notifications")) {
    return "Cannot delete: This user has notification history. To preserve system integrity, please deactivate the user instead."
  }
  if (detail.includes("audit_logs") || detail.includes("auditlogs")) {
    return "Cannot delete: This user has audit log entries. To preserve system history, please deactivate the user instead."
  }
  return "Cannot delete: This user is linked to other system records (sessions, notifications, or audit logs). To preserve system history and data integrity, please deactivate the user instead of deleting."
}

function handleUserDeletionError(caughtError: any) {
  console.error("[API/Users] CRITICAL ERROR IN DELETE:", caughtError)
  const errorMessage = caughtError.message?.toLowerCase() || ""
  const foreignKeyError = caughtError.code === "23503"
    || errorMessage.includes("foreign key")
    || errorMessage.includes("violates")
  if (foreignKeyError) {
    return error(getForeignKeyDeletionMessage(caughtError.detail?.toLowerCase() || ""), 400)
  }
  const validationFragments = [
    "unique constraint", "cannot delete", "history", "linked", "please reassign",
  ]
  const isValidationError = validationFragments.some((fragment) => errorMessage.includes(fragment))
    || caughtError.code === "23505"
  return error(errorMessage, isValidationError ? 400 : 500)
}

function getUserProfileValues(input: any, targetUser: any, nextUsername: string) {
  const currentEmail = normalizeEmail(targetUser.email)
  const nextEmail = input.email !== undefined ? normalizeEmail(input.email) : currentEmail
  const nextPhone = input.phone !== undefined ? normalizeOptionalText(input.phone) : undefined
  const nextEmployeeId = input.employeeId !== undefined ? normalizeOptionalText(input.employeeId) : undefined
  const uniqueFields: { email?: string | null; phone?: string | null; employeeId?: string | null } = {}
  if (input.email !== undefined) uniqueFields.email = nextEmail
  if (input.phone !== undefined) uniqueFields.phone = nextPhone
  if (input.employeeId !== undefined) uniqueFields.employeeId = nextEmployeeId
  return {
    currentEmail,
    nextEmail,
    nextPhone,
    nextEmployeeId,
    uniqueFields,
    emailActuallyChanged: input.email !== undefined && nextEmail !== currentEmail,
    usernameActuallyChanged: input.username !== undefined
      && nextUsername !== String(targetUser.username || "").trim().toLowerCase(),
    fullName: input.firstName !== undefined || input.lastName !== undefined
      ? `${input.firstName ?? targetUser.firstName ?? ""} ${input.lastName ?? targetUser.lastName ?? ""}`.trim()
      : undefined,
  }
}

function getUniqueProfileFields(input: any, nextEmail: string | null, nextPhone: string | null | undefined, nextEmployeeId: string | null | undefined) {
  const fields: { email?: string | null; phone?: string | null; employeeId?: string | null } = {}
  if (input.email !== undefined) fields.email = nextEmail
  if (input.phone !== undefined) fields.phone = nextPhone
  if (input.employeeId !== undefined) fields.employeeId = nextEmployeeId
  return fields
}

async function updateUserProfile(userId: string, input: any, targetUser: any, nextUsername: string) {
  const values = getUserProfileValues(input, targetUser, nextUsername)
  if (input.email !== undefined && !values.nextEmail) return "Email is required"
  if (Object.keys(values.uniqueFields).length > 0) {
    await assertUniqueUserFields(values.uniqueFields, userId)
  }
  const isSecurityChange = Boolean(input.password)
  await db.update(users).set({
    email: values.emailActuallyChanged ? values.nextEmail : undefined,
    username: values.usernameActuallyChanged ? nextUsername : undefined,
    firstName: input.firstName,
    lastName: input.lastName,
    phone: input.phone !== undefined ? values.nextPhone : undefined,
    employeeId: input.employeeId !== undefined ? values.nextEmployeeId : undefined,
    imprestHolder: input.imprestHolder,
    contactPerson: input.contactPerson,
    location: input.location,
    address: input.address,
    fullName: values.fullName,
    passwordHash: input.password ? await hashPassword(input.password) : undefined,
    sessionVersion: isSecurityChange ? targetUser.sessionVersion + 1 : undefined,
    updatedAt: new Date(),
  }).where(eq(users.id, userId))
  await invalidateSessionValidationCache(userId)
  if (isSecurityChange) await db.delete(sessions).where(eq(sessions.userId, userId))
  await writeUserUpdateAudit(userId, input, isSecurityChange)
  await invalidateByPrefix('users')
  return null
}

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const err = await requireApiRole(USER_MANAGEMENT_ROLES)
    if (err) return err
    const params = await props.params
    const { id } = params
    const rawBody = await readJson<unknown>(req)
    if (!rawBody) return error("Invalid body", 400)
    const parsedBody = userProfileUpdateSchema.safeParse(rawBody)
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
    const input = parsedBody.data

    // Check if HEAD_OFFICE user can edit this user (BOLA Protection)
    const { verifyResourceAccess } = await import("@/lib/auth")
    const [targetUser] = await db.select({
      organizationId: users.organizationId,
      branchId: users.branchId,
      email: users.email,
      username: users.username,
      firstName: users.firstName,
      lastName: users.lastName,
      sessionVersion: users.sessionVersion,
      role: roles.name
    }).from(users).innerJoin(roles, eq(users.roleId, roles.id)).where(eq(users.id, id)).limit(1)
    if (!targetUser) return error("User not found", 404)

    const scope = await getRequestScope()
    const parsedTargetRole = systemRoleSchema.safeParse(targetUser.role)
    if (!scope || !parsedTargetRole.success || !canManageUser(scope.role, parsedTargetRole.data)) {
      return error("You cannot manage a user at this privilege level", 403)
    }

    const hasAccess = await verifyResourceAccess(targetUser.organizationId)
    if (!hasAccess) return error("Unauthorized to assign user to this resource", 403)

    const currentUsername = String(targetUser.username || "").trim().toLowerCase()
    const usernameUpdate = await getUsernameUpdateError(input.username, currentUsername, id)
    if (usernameUpdate.message) return error(usernameUpdate.message, 400)
    const nextUsername = usernameUpdate.nextUsername

    const updateResponse = await (async () => {
    const currentEmail = normalizeEmail(targetUser.email)
    const nextEmail = input.email !== undefined ? normalizeEmail(input.email) : currentEmail
    const nextPhone = input.phone !== undefined ? normalizeOptionalText(input.phone) : undefined
    const nextEmployeeId = input.employeeId !== undefined ? normalizeOptionalText(input.employeeId) : undefined

    if (!nextEmail) return error("Email is required", 400)

    const uniqueFieldsToValidate = getUniqueProfileFields(input, nextEmail, nextPhone, nextEmployeeId)

    await assertUniqueUserFields(uniqueFieldsToValidate, id)

    // Determine if email actually changed (avoid unnecessary session invalidation)
    const emailActuallyChanged = input.email !== undefined && nextEmail !== currentEmail
    const usernameActuallyChanged = input.username !== undefined && nextUsername !== currentUsername

    // Update full name if first or last name changed
    const fullName = input.firstName !== undefined || input.lastName !== undefined
      ? `${input.firstName ?? targetUser.firstName ?? ""} ${input.lastName ?? targetUser.lastName ?? ""}`.trim()
      : undefined

    // Update password if provided
    const passwordHash = input.password ? await hashPassword(input.password) : undefined

    // Only password changes should invalidate the current session.
    const isSecurityChange = !!input.password
    const sessionVersion = isSecurityChange ? targetUser.sessionVersion + 1 : undefined
    if (isSecurityChange) {
      console.log(`[API/Users] Password changed for user ${id}. Incrementing session version...`)
    }

    // Execute update (includes sessionVersion bump if needed — single atomic write)
    await db.update(users).set({
      email: emailActuallyChanged ? nextEmail : undefined,
      username: usernameActuallyChanged ? nextUsername : undefined,
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone !== undefined ? nextPhone : undefined,
      employeeId: input.employeeId !== undefined ? nextEmployeeId : undefined,
      imprestHolder: input.imprestHolder,
      contactPerson: input.contactPerson,
      location: input.location,
      address: input.address,
      fullName,
      passwordHash,
      sessionVersion,
      updatedAt: new Date(),
    }).where(eq(users.id, id))

    // Drop the cached session-validation result so deactivation/password
    // changes take effect on the target user's next session check
    await invalidateSessionValidationCache(id)

    // Also delete physical sessions if they exist (for database-bound sessions if used)
    const deleteSessions = isSecurityChange
      ? db.delete(sessions).where(eq(sessions.userId, id))
      : Promise.resolve()
    await deleteSessions

    await writeUserUpdateAudit(id, input, isSecurityChange)

    // Invalidate users cache so lists refresh immediately in production
    await invalidateByPrefix('users')
    return null
    })()
    if (updateResponse) return updateResponse

    return ok({ success: true })
  } catch (caughtError: any) {
    return handleUserUpdateError(caughtError)
  }
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(USER_MANAGEMENT_ROLES)
  if (err) return err
  const params = await props.params
  const { id } = params

  try {
    const scope = await getRequestScope()
    if (scope?.userId === id) {
      return error("Cannot delete: You cannot delete your own account while logged in.", 400)
    }

    const { verifyResourceAccess } = await import("@/lib/auth")
    const [targetUser] = await db.select({
      organizationId: users.organizationId,
      email: users.email,
      role: roles.name,
    }).from(users).innerJoin(roles, eq(users.roleId, roles.id)).where(eq(users.id, id)).limit(1)
    if (!targetUser) return error("User not found", 404)

    const parsedTargetRole = systemRoleSchema.safeParse(targetUser.role)
    if (!scope || !parsedTargetRole.success || !canManageUser(scope.role, parsedTargetRole.data)) {
      return error("You cannot delete a user at this privilege level", 403)
    }

    const hasAccess = await verifyResourceAccess(targetUser.organizationId)
    if (!hasAccess) return error("Forbidden: You do not have access to this user", 403)

    const dependencies = await getUserDeletionDependencies(id)
    if (dependencies.adminCount > 0) {
      return error(`Cannot delete: This user is assigned as the administrator for ${dependencies.adminCount} branch(es). Please reassign branch administration before deleting.`, 400)
    }
    if (dependencies.hasHistory) await softDeleteUser(id, targetUser.email)
    else await hardDeleteUser(id)

    // Drop the cached session-validation result so the deleted user's
    // sessions die on their next session check (covers soft and hard delete)
    await invalidateSessionValidationCache(id)

    // Invalidate users cache
    await invalidateByPrefix('users')

    await writeUserDeletionAudit(id)

    return ok({ success: true })
  } catch (caughtError: any) {
    return handleUserDeletionError(caughtError)
  }
}
