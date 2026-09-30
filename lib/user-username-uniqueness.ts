import { eq } from "drizzle-orm"

import { employeeCredentials, users } from "@/db/schema"
import { db } from "@/lib/db"

/**
 * Whether a username is already taken, across **both** tables that can hold
 * one.
 *
 * A username authenticates against `users` or against `employee_credentials`
 * (`lib/auth-options.ts` tries both), so a username that is free in one table
 * and taken in the other is not free. This lived inside
 * `app/api/v1/users/route.ts` while administrator creation was the only way an
 * account came into being; the public join flow is a second way, and a second
 * copy of this question would eventually ask it of one table only.
 *
 * Callers pass an already-lower-cased username — both columns store one.
 */
export async function usernameExists(username: string): Promise<boolean> {
  const [[user], [employee]] = await Promise.all([
    db.select({ id: users.id }).from(users).where(eq(users.username, username)).limit(1),
    db
      .select({ id: employeeCredentials.id })
      .from(employeeCredentials)
      .where(eq(employeeCredentials.username, username))
      .limit(1),
  ])
  return Boolean(user || employee)
}
