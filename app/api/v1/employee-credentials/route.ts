import { ok,error,readJson } from "@/lib/api"
import { db } from "@/lib/db"
import { employeeCredentials,auditLogs } from "@/db/schema"
import { and,eq } from "drizzle-orm"
import { hash } from "bcryptjs"
import { NextRequest } from 'next/server'
import { getRequestScope } from "@/lib/auth"
import { assertUniqueUserFields,normalizeEmail,UserUniqueFieldError } from "@/lib/user-uniqueness"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"
import {
  employeeCredentialCreateSchema,
  employeeCredentialUpdateSchema,
  validationMessage,
} from "@/lib/server/mutation-validation"
import { withRateLimit } from "@/lib/rate-limiter"

type ExistingCredential = typeof employeeCredentials.$inferSelect

async function prepareCredentialSecurityUpdate(
  credential: ExistingCredential,
  credentialId: number,
  email: string | undefined,
  password: string | undefined,
) {
  if (email && email !== credential.email) {
    await assertUniqueUserFields({ email }, undefined, credentialId)
  }
  const passwordHash = password ? await hash(password, 10) : undefined
  const securityChange = Boolean(password)
  return {
    passwordHash,
    securityChange,
    sessionVersion: securityChange
      ? (credential.sessionVersion || 0) + 1
      : credential.sessionVersion || 0,
  }
}

async function POST(req: NextRequest) {
  try {
    const rawBody = await readJson<unknown>(req)
    const parsedBody = employeeCredentialCreateSchema.safeParse(rawBody)
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
    const { password, firstName, lastName, mfaEnabled } = parsedBody.data
    const email = normalizeEmail(parsedBody.data.email)

    // Get user scope with proper role and organization/branch info
    const scope = await getRequestScope()
    if (scope?.role !== "BRANCH_ADMIN") {
      return error("Not a branch admin", 403)
    }

    const rateLimit = await withRateLimit("sensitive", scope.userId)
    if (rateLimit) return rateLimit

    const userBranchId = scope.branchId
    const orgId = scope.organizationId

    if (!userBranchId || !orgId) {
      return error("Branch admin must be assigned to a branch", 403)
    }

    await assertUniqueUserFields({ email })

    // Hash password
    const passwordHash = await hash(password, 10)

    // Create employee credential
    const [credential] = await db
      .insert(employeeCredentials)
      .values({
        branchId: userBranchId,
        organizationId: orgId,
        email,
        passwordHash,
        firstName: firstName || "",
        lastName: lastName || "",
        mfaEnabled: mfaEnabled || false,
        createdByUserId: scope.userId,
      })
      .returning()

    // Log action
    await db.insert(auditLogs).values({
      userId: scope.userId,
      organizationId: orgId,
      action: "CREATE_EMPLOYEE_CREDENTIAL",
      entity: "EMPLOYEE_CREDENTIAL",
      entityId: String(credential.id),
      metadata: {
        email,
        branchId: userBranchId,
      },
    })

    return ok({ credential: credential }, { status: 201 })
  } catch (err: any) {
    if (err instanceof UserUniqueFieldError) {
      return error(err.message, 400)
    }
    console.error("POST /employee-credentials error:", err)
    return error("Internal Server Error", 500)
  }
}

async function GET(req: NextRequest) {
  try {
    // Get user scope with proper role and organization/branch info
    const scope = await getRequestScope()
    if (scope?.role !== "BRANCH_ADMIN") {
      return error("Not a branch admin", 403)
    }

    const rateLimit = await withRateLimit("sensitive", scope.userId)
    if (rateLimit) return rateLimit

    const userBranchId = scope.branchId
    const orgId = scope.organizationId

    if (!userBranchId || !orgId) {
      return error("Branch admin must be assigned to a branch", 403)
    }

    const credentials = await db
      .select({
        id: employeeCredentials.id,
        email: employeeCredentials.email,
        firstName: employeeCredentials.firstName,
        lastName: employeeCredentials.lastName,
        mfaEnabled: employeeCredentials.mfaEnabled,
        isActive: employeeCredentials.isActive,
        createdAt: employeeCredentials.createdAt,
      })
      .from(employeeCredentials)
      .where(
        and(
          eq(employeeCredentials.branchId, userBranchId),
          eq(employeeCredentials.organizationId, orgId)
        )
      )
      .limit(500)

    return ok({ credentials: credentials }, { status: 200 })
  } catch (err: any) {
    console.error("GET /employee-credentials error:", err)
    return error("Internal Server Error", 500)
  }
}

async function PUT(req: NextRequest) {
  try {
    const rawBody = await readJson<unknown>(req)
    const parsedBody = employeeCredentialUpdateSchema.safeParse(rawBody)
    if (!parsedBody.success) return error(validationMessage(parsedBody.error), 400)
    const { id, isActive, firstName, lastName, password } = parsedBody.data
    const email = parsedBody.data.email !== undefined ? normalizeEmail(parsedBody.data.email) : undefined

    const credId = typeof id === 'number' ? id : Number.parseInt(id, 10)
    if (Number.isNaN(credId)) {
      return error("Invalid ID format", 400)
    }

    // Get user scope with proper role and organization/branch info
    const scope = await getRequestScope()
    if (scope?.role !== "BRANCH_ADMIN") {
      return error("Not a branch admin", 403)
    }

    const rateLimit = await withRateLimit("sensitive", scope.userId)
    if (rateLimit) return rateLimit

    const userBranchId = scope.branchId
    if (!userBranchId) {
      return error("Branch admin must be assigned to a branch", 403)
    }

    // Verify ownership
    const [cred] = await db
      .select()
      .from(employeeCredentials)
      .where(
        and(
          eq(employeeCredentials.id, credId),
          eq(employeeCredentials.branchId, userBranchId)
        )
      )

    if (!cred) {
      return error("Credential not found", 404)
    }

    const { passwordHash, securityChange, sessionVersion } = await prepareCredentialSecurityUpdate(
      cred,
      credId,
      email,
      password,
    )

    const [updated] = await db
      .update(employeeCredentials)
      .set({
        isActive,
        firstName,
        lastName,
        email: email && email !== cred.email ? email : undefined,
        passwordHash,
        sessionVersion,
      })
      .where(eq(employeeCredentials.id, credId))
      .returning()

    // Drop the cached session-validation result (employee token ids are "emp_<id>")
    if (securityChange) {
      await invalidateSessionValidationCache(`emp_${credId}`)
    }

    return ok({ credential: updated, sessionInvalidated: securityChange }, { status: 200 })
  } catch (err: any) {
    if (err instanceof UserUniqueFieldError) {
      return error(err.message, 400)
    }
    console.error("PUT /employee-credentials error:", err)
    return error("Internal Server Error", 500)
  }
}

async function DELETE(req: NextRequest) {
  try {
    const url = new URL(req.url)
    const id = url.searchParams.get("id")

    if (!id) {
      return error("ID required", 400)
    }

    // Get user scope with proper role and organization/branch info
    const scope = await getRequestScope()
    if (scope?.role !== "BRANCH_ADMIN") {
      return error("Not a branch admin", 403)
    }

    const userBranchId = scope.branchId

    if (!userBranchId) {
      return error("Branch admin must be assigned to a branch", 403)
    }

    const credId = Number.parseInt(id, 10)
    if (Number.isNaN(credId)) {
      return error("Invalid ID format", 400)
    }

    // Verify ownership
    const [cred] = await db
      .select()
      .from(employeeCredentials)
      .where(
        and(
          eq(employeeCredentials.id, credId),
          eq(employeeCredentials.branchId, userBranchId)
        )
      )

    if (!cred) {
      return error("Credential not found", 404)
    }

    await db
      .update(employeeCredentials)
      .set({ isActive: false, deactivatedAt: new Date() })
      .where(eq(employeeCredentials.id, credId))

    // Drop the cached session-validation result so deactivation takes effect
    // on the employee's next session check (employee token ids are "emp_<id>")
    await invalidateSessionValidationCache(`emp_${credId}`)

    return ok({ message: "Credential deactivated" }, { status: 200 })
  } catch (err: any) {
    console.error("DELETE /employee-credentials error:", err)
    return error("Internal Server Error", 500)
  }
}

export { POST, GET, PUT, DELETE };

