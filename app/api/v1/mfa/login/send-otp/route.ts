import { NextRequest } from "next/server"
import { ok, error, readJson } from "@/lib/api"
import { generateAndSendOTP } from "@/lib/mfa"
import { createHash } from "node:crypto"
import {
  checkRateLimit,
  getClientIdentifier,
  rateLimitResponse,
} from "@/lib/rate-limiter"

const genericResponse = () => ok({
  message: "If MFA is enabled for this account, a verification code has been sent.",
})

export async function POST(req: NextRequest) {
  try {
    const body = await readJson<any>(req)

    if (!body) return error("Invalid request body", 400)

    const { username, type = 'LOGIN' } = body
    if (!username) {
      return error("Username or email is required", 400)
    }
    if (type !== "LOGIN") {
      return error("Unsupported MFA request type", 400)
    }
    const identifier = String(username).trim().toLowerCase()
    const clientIdentifier = await getClientIdentifier()
    const accountIdentifier = `account:${createHash("sha256").update(identifier).digest("hex").slice(0, 32)}`
    const [clientLimit, accountLimit] = await Promise.all([
      checkRateLimit(clientIdentifier, "otpSend"),
      checkRateLimit(accountIdentifier, "otpSend"),
    ])
    if (!clientLimit.allowed || !accountLimit.allowed) {
      return rateLimitResponse(Math.max(clientLimit.resetIn, accountLimit.resetIn))
    }

    const { db } = await import("@/lib/db")
    const { users, employeeCredentials } = await import("@/db/schema")
    const { eq, and, isNull, sql, or } = await import("drizzle-orm")

    // 1. Try Users table
    let [user]: any[] = await db
      .select({
        id: users.id,
        email: users.email,
        mfaEnabled: users.mfaEnabled
      })
      .from(users)
      .where(and(or(eq(users.username, identifier), sql`lower(${users.email}) = ${identifier}`), isNull(users.deletedAt)))
      .limit(1)

    // 2. Try Employee Credentials table
    if (!user) {
      const [emp] = await db
        .select({
          id: employeeCredentials.id,
          email: employeeCredentials.email, // Use email as target for sending OTP
          mfaEnabled: employeeCredentials.mfaEnabled
        })
        .from(employeeCredentials)
        .where(or(eq(employeeCredentials.username, identifier), sql`lower(${employeeCredentials.email}) = ${identifier}`))
        .limit(1)
      
      if (emp) {
        user = { ...emp, id: `emp_${emp.id}` } as any
      }
    }

    if (!user) {
      return genericResponse()
    }

    if (!user.mfaEnabled) {
      return genericResponse()
    }

    const result = await generateAndSendOTP(user.id, user.email, type)
    if (!result.success) {
      console.warn("[MFA] Login OTP request was not completed", {
        account: accountIdentifier,
      })
    }
    return genericResponse()

  } catch (err) {
    console.error("Error sending OTP:", err)
    return genericResponse()
  }
}
