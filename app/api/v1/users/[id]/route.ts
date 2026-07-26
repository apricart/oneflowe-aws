import { type NextRequest } from "next/server"
import { db } from "@/lib/db"
import { users, roles, systemLogs, mfaCodes, orders, groups, auditLogs, notifications, employeeCredentials, sessions, groupAuditLogs } from "@/db/schema"
import { eq, or, count } from "drizzle-orm"
import { hashPassword } from "@/lib/password"
import { ok, error, requireApiRole, readJson } from "@/lib/api"
import { getRequestScope } from "@/lib/auth"
import { invalidateByPrefix } from "@/lib/cache-utils"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"
import { headers } from "next/headers"
import { assertUniqueUserFields, normalizeEmail, normalizeOptionalText, UserUniqueFieldError } from "@/lib/user-uniqueness"
import { systemRoleSchema, userProfileUpdateSchema, validationMessage } from "@/lib/server/mutation-validation"
import { canManageUser } from "@/lib/server/user-access-policy"

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  try {
    const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
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
    const nextUsername = input.username !== undefined ? input.username.toLowerCase() : currentUsername

    if (input.username !== undefined && !nextUsername) {
      return error("Username is required", 400)
    }

    // Check uniqueness if username changed
    if (input.username !== undefined) {
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, nextUsername))
        .limit(1)
      if (existing && existing.id !== id) {
        return error("Username already in use by another user", 400)
      }

      const [employeeUsernameMatch] = await db
        .select({ id: employeeCredentials.id })
        .from(employeeCredentials)
        .where(eq(employeeCredentials.username, nextUsername))
        .limit(1)
      if (employeeUsernameMatch) {
        return error("Username already in use by another user", 400)
      }
    }

    const currentEmail = normalizeEmail(targetUser.email)
    const nextEmail = input.email !== undefined ? normalizeEmail(input.email) : currentEmail
    const nextPhone = input.phone !== undefined ? normalizeOptionalText(input.phone) : undefined
    const nextEmployeeId = input.employeeId !== undefined ? normalizeOptionalText(input.employeeId) : undefined

    if (input.email !== undefined && !nextEmail) {
      return error("Email is required", 400)
    }

    const uniqueFieldsToValidate: {
      email?: string | null
      phone?: string | null
      employeeId?: string | null
    } = {}

    if (input.email !== undefined) uniqueFieldsToValidate.email = nextEmail
    if (input.phone !== undefined) uniqueFieldsToValidate.phone = nextPhone
    if (input.employeeId !== undefined) uniqueFieldsToValidate.employeeId = nextEmployeeId

    if (Object.keys(uniqueFieldsToValidate).length > 0) {
      await assertUniqueUserFields(uniqueFieldsToValidate, id)
    }

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
    if (isSecurityChange) {
      await db.delete(sessions).where(eq(sessions.userId, id))
    }

    // Audit Log (optional)
    try {
      const logScope = await getRequestScope()
      const headersList = await headers()
      const userAgent = headersList.get("user-agent")
      const forwardedFor = headersList.get("x-forwarded-for")
      const ip = forwardedFor ? forwardedFor.split(',')[0] : "unknown"

      await db.insert(systemLogs).values({
        userId: logScope?.userId,
        userRole: logScope?.role,
        organizationId: logScope?.organizationId,
        branchId: logScope?.branchId || undefined,
        action: "USER_UPDATE",
        resourceType: "user",
        resourceId: id,
        details: {
          patchKeys: Object.keys(input),
          sessionsInvalidated: isSecurityChange
        },
        ipAddress: ip,
        userAgent: userAgent,
        success: true
      })
    } catch (logErr) {
      console.error("[API/Users] Audit Log Error:", logErr)
    }

    // Invalidate users cache so lists refresh immediately in production
    await invalidateByPrefix('users')

    return ok({ success: true })
  } catch (criticalErr: any) {
    const errorMessage = criticalErr.message || "Failed to update user"

    if (criticalErr instanceof UserUniqueFieldError) {
      return error(criticalErr.message, 400)
    }

    console.error("[API/Users] ERROR IN PATCH:", criticalErr)

    if (criticalErr.code === '23505' || errorMessage.includes('unique constraint') || errorMessage.includes('already exists')) {
      const detail = String(criticalErr.detail || criticalErr.cause?.detail || "").toLowerCase()
      if (detail.includes('username')) return error("Username already in use by another user", 400)
      if (detail.includes('employee_id')) return error("Internal ID (Employee ID) already exists.", 400)
      if (detail.includes('email')) return error("Email address already exists.", 400)
      if (detail.includes('phone')) return error("Phone number already exists.", 400)
      return error("Unique field conflict: " + detail, 400)
    }

    const isValidationError = errorMessage.includes("Invalid password") ||
      errorMessage.includes("already exists") ||
      errorMessage.includes("Password") ||
      errorMessage.includes("unique constraint") ||
      errorMessage.includes("violates") ||
      errorMessage.includes("foreign key") ||
      errorMessage.includes("linked") ||
      errorMessage.includes("Cannot") ||
      criticalErr.code === "23505" ||
      criticalErr.code === "23503"

    return error(errorMessage, isValidationError ? 400 : 500)
  }
}

export async function DELETE(
  req: NextRequest,
  props: { params: Promise<{ id: string }> }
) {
  const err = await requireApiRole(["SUPER_ADMIN", "HEAD_OFFICE"])
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

    // Dependency checks - Block deletion if critical data exists
    const {
      branches,
      orders,
      refunds,
      restockRequests,
      groups,
      globalProducts: globalProductsTable,
      organizationInventory: orgInventory,
      branchInventory: branchInv,
      productAssignments: prodAssign,
      modifiers: modsTable
    } = await import("@/db/schema")

    // Check for critical dependencies before attempting deletion
    const [
      adminCount,
      orderCount,
      refundCount,
      restockCount,
      groupCount,
      productCount,
      userCreds,
      orgInvCount,
      branchInvCount,
      prodAssignCount,
      modCount
    ] = await Promise.all([
      // 1. Check if user is an admin for any branches
      db.select({ val: count() }).from(branches).where(eq(branches.adminUserId, id)),

      // 2. Check for orders involvement
      db.select({ val: count() }).from(orders).where(
        or(
          eq(orders.createdByUserId, id),
          eq(orders.approvedByUserId, id),
          eq(orders.rejectedByUserId, id),
          eq(orders.fulfilledByUserId, id),
          eq(orders.refundedByUserId, id)
        )
      ),

      // 3. Check for refunds involvement
      db.select({ val: count() }).from(refunds).where(
        or(
          eq(refunds.requestedByUserId, id),
          eq(refunds.processedByUserId, id)
        )
      ),

      // 4. Check for restock requests
      db.select({ val: count() }).from(restockRequests).where(
        or(
          eq(restockRequests.requestedByUserId, id),
          eq(restockRequests.reviewedByUserId, id)
        )
      ),

      // 5. Check for groups created
      db.select({ val: count() }).from(groups).where(eq(groups.createdByUserId, id)),

      // 6. Check for master products created
      db.select({ val: count() }).from(globalProductsTable).where(eq(globalProductsTable.createdByUserId, id)),

      // 7. Check for employee credentials created
      db.select({ count: count() }).from(employeeCredentials).where(eq(employeeCredentials.createdByUserId, id)),

      // 8. Check for inventory assignments
      db.select({ val: count() }).from(orgInventory).where(eq(orgInventory.assignedByUserId, id)),
      db.select({ val: count() }).from(branchInv).where(eq(branchInv.assignedByUserId, id)),
      db.select({ val: count() }).from(prodAssign).where(eq(prodAssign.performedByUserId, id)),

      // 9. Check for modifiers created
      db.select({ val: count() }).from(modsTable).where(eq(modsTable.createdByUserId, id))
    ])

    // Decide between hard delete and soft delete
    const hasHistory = orderCount[0].val > 0 ||
      refundCount[0].val > 0 ||
      restockCount[0].val > 0 ||
      productCount[0].val > 0 ||
      userCreds[0].count > 0 ||
      groupCount[0].val > 0 ||
      orgInvCount[0].val > 0 ||
      branchInvCount[0].val > 0 ||
      prodAssignCount[0].val > 0 ||
      modCount[0].val > 0

    // Return error messages ONLY for critical active roles that MUST be reassigned
    if (adminCount[0].val > 0) {
      return error(`Cannot delete: This user is assigned as the administrator for ${adminCount[0].val} branch(es). Please reassign branch administration before deleting.`, 400)
    }

    if (hasHistory) {
      console.log(`[API/Users] User ${id} has historical records. Performing soft-delete...`)

      // Perform soft-delete
      await db.update(users).set({
        deletedAt: new Date(),
        isActive: false,
        // Append timestamp to email to free up the original email for a new account
        email: `deleted_${Date.now()}_${targetUser.email}`
      }).where(eq(users.id, id))

      // Clean up non-critical data
      console.log(`[API/Users] Cleaning up non-critical sessions/MFA for soft-deleted user ${id}...`)
      await Promise.all([
        db.delete(mfaCodes).where(eq(mfaCodes.userId, id)),
        db.delete(sessions).where(eq(sessions.userId, id)),
        db.delete(notifications).where(eq(notifications.userId, id))
      ])
    } else {
      // Clean up all dependencies before hard deletion
      console.log(`[API/Users] Cleaning up all dependencies for hard-delete of user ${id}...`)

      try {
        await Promise.all([
          db.delete(mfaCodes).where(eq(mfaCodes.userId, id)),
          db.delete(sessions).where(eq(sessions.userId, id)),
          db.delete(notifications).where(eq(notifications.userId, id)),
          db.delete(groupAuditLogs).where(eq(groupAuditLogs.performedByUserId, id)),
          db.update(auditLogs).set({ userId: null }).where(eq(auditLogs.userId, id)),
          db.update(systemLogs).set({ userId: null }).where(eq(systemLogs.userId, id))
        ])
        console.log(`[API/Users] Successfully cleaned up dependencies for user ${id}`)
      } catch (cleanupErr: any) {
        console.error("[API/Users] Error during dependency cleanup:", cleanupErr)
        return error(`Failed to clean up user dependencies: ${cleanupErr.message}. Please contact support.`, 500)
      }

      // Then delete the user from the database
      await db.delete(users).where(eq(users.id, id))
    }

    // Drop the cached session-validation result so the deleted user's
    // sessions die on their next session check (covers soft and hard delete)
    await invalidateSessionValidationCache(id)

    // Invalidate users cache
    await invalidateByPrefix('users')

    // Audit Log
    try {
      const logScope = await getRequestScope()
      const headersList = await headers()
      const userAgent = headersList.get("user-agent")
      const forwardedFor = headersList.get("x-forwarded-for")
      const ip = forwardedFor ? forwardedFor.split(',')[0] : "unknown"

      await db.insert(systemLogs).values({
        userId: logScope?.userId,
        userRole: logScope?.role,
        organizationId: logScope?.organizationId,
        branchId: undefined,
        action: "USER_DELETE",
        resourceType: "user",
        resourceId: id,
        details: {
          deletedUserId: id
        },
        ipAddress: ip,
        userAgent: userAgent,
        success: true
      })
    } catch (logErr) {
      console.error("Failed to write audit log:", logErr)
    }

    return ok({ success: true })
  } catch (err: any) {
    console.error("[API/Users] CRITICAL ERROR IN DELETE:", {
      message: err.message,
      code: err.code,
      constraint: err.constraint,
      detail: err.detail,
      stack: err.stack
    })

    // Handle foreign key constraints commonly encountered when deleting users
    const errorMessage = err.message?.toLowerCase() || ""
    const errorCode = err.code || ""

    if (errorCode === "23503" || errorMessage.includes("foreign key") || errorMessage.includes("violates")) {
      // Check which table is causing the FK violation from error details
      const detail = err.detail?.toLowerCase() || ""

      if (detail.includes("mfa_codes") || detail.includes("mfacodes")) {
        return error("Cannot delete: This user has active MFA codes. Please deactivate MFA first or contact support.", 400)
      }
      if (detail.includes("sessions")) {
        return error("Cannot delete: This user has active sessions. Please wait for sessions to expire or deactivate the user instead.", 400)
      }
      if (detail.includes("notifications")) {
        return error("Cannot delete: This user has notification history. To preserve system integrity, please deactivate the user instead.", 400)
      }
      if (detail.includes("audit_logs") || detail.includes("auditlogs")) {
        return error("Cannot delete: This user has audit log entries. To preserve system history, please deactivate the user instead.", 400)
      }

      // Generic FK error for any other tables
      return error("Cannot delete: This user is linked to other system records (sessions, notifications, or audit logs). To preserve system history and data integrity, please deactivate the user instead of deleting.", 400)
    }

    const isValidationError = errorMessage.includes("foreign key") ||
      errorMessage.includes("violates") ||
      errorMessage.includes("unique constraint") ||
      errorMessage.includes("Cannot delete") ||
      errorMessage.includes("history") ||
      errorMessage.includes("linked") ||
      errorMessage.includes("Please reassign") ||
      err.code === "23503" ||
      err.code === "23505"

    return error(errorMessage, isValidationError ? 400 : 500)
  }
}
