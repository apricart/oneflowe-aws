import { db } from "@/lib/db"
import { users, sessions } from "@/db/schema"
import { eq } from "drizzle-orm"
import { hashPassword } from "@/lib/password"
import { ok, error, readJson } from "@/lib/api"
import { getCurrentUser } from "@/lib/auth"
import { invalidateSessionValidationCache } from "@/lib/session-validation-cache"
import { withRateLimit } from "@/lib/rate-limiter"

export async function POST(req: Request) {
  try {
    const currentUser = await getCurrentUser()
    if (!currentUser) return error("Unauthorized", 401)

    // This endpoint is only for users in the users table, not employees
    if (currentUser.id.startsWith("emp_")) {
      return error("Not applicable for employee accounts", 400)
    }

    const rateLimit = await withRateLimit("sensitive", currentUser.id)
    if (rateLimit) return rateLimit

    const body = await readJson<{ password?: string }>(req)
    if (!body?.password) return error("New password is required", 400)

    // hashPassword validates complexity requirements before hashing
    const passwordHash = await hashPassword(body.password)

    // Increment sessionVersion to invalidate all existing JWTs for this user
    const [dbUser] = await db
      .select({ sessionVersion: users.sessionVersion })
      .from(users)
      .where(eq(users.id, currentUser.id))
      .limit(1)

    if (!dbUser) return error("User not found", 404)

    await db.update(users).set({
      passwordHash,
      mustChangePassword: false,
      sessionVersion: (dbUser.sessionVersion || 0) + 1,
      updatedAt: new Date(),
    }).where(eq(users.id, currentUser.id))

    // Drop the cached session-validation result so the sessionVersion bump
    // takes effect on the next session check across all devices
    await invalidateSessionValidationCache(currentUser.id)

    // Remove physical sessions so all devices are logged out
    await db.delete(sessions).where(eq(sessions.userId, currentUser.id))

    return ok({ success: true })
  } catch (err: any) {
    const msg = String(err?.message || "")
    if (msg.toLowerCase().includes("invalid password") || msg.toLowerCase().includes("must contain")) {
      return error(err.message, 400)
    }
    console.error("[API/ChangePassword] Unexpected error:", err)
    return error("Failed to change password", 500)
  }
}
