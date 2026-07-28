import { ok, requireApiRole } from "@/lib/api"
import { db } from "@/lib/db"
import { users, employeeCredentials } from "@/db/schema"
import { eq } from "drizzle-orm"
import { USER_MANAGEMENT_ROLES } from "@/lib/user-management-access"

/**
 * Check if a username is available across both users and employee_credentials tables.
 * If not available, provide 3 unique suggestions.
 */
export async function GET(req: Request) {
  const authError = await requireApiRole(USER_MANAGEMENT_ROLES)
  if (authError) return authError

  const { searchParams } = new URL(req.url)
  const username = searchParams.get("username")?.toLowerCase().trim()

  if (!username || username.length < 3) {
    return ok({ available: false, suggestions: [] })
  }

  // Check availability in both tables
  const [userMatch] = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.username, username))
    .limit(1)

  const [empMatch] = await db
    .select({ id: employeeCredentials.id })
    .from(employeeCredentials)
    .where(eq(employeeCredentials.username, username))
    .limit(1)

  const isAvailable = !userMatch && !empMatch

  if (isAvailable) {
    return ok({ available: true, suggestions: [] })
  }

  // Generate 3 suggestions
  const suggestions: string[] = []
  let counter = 1

  while (suggestions.length < 3) {
    const candidate = `${username}${counter}`
    
    const [uMatch] = await db.select({ id: users.id }).from(users).where(eq(users.username, candidate)).limit(1)
    const [eMatch] = await db.select({ id: employeeCredentials.id }).from(employeeCredentials).where(eq(employeeCredentials.username, candidate)).limit(1)

    if (!uMatch && !eMatch) {
      suggestions.push(candidate)
    }
    counter++
  }

  return ok({ available: false, suggestions })
}
