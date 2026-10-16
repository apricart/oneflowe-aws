import "server-only"

import { eq } from "drizzle-orm"

import { organizations } from "@/db/schema"
import { db } from "@/lib/db"
import { organizationUsername } from "@/lib/username-prefix"

type Executor = Pick<typeof db, "select">

/**
 * The username a new account gets in `organizationId`: the organization's
 * prefix, read from its own row, then the username asked for
 * (plans/OF-USERS-organization-username-prefix.md). An account with no
 * organization — Super Admin, the Order Desk, Apricart Executives, the
 * warehouse — takes the username as asked, lower-cased.
 */
export async function organizationUsernameFor(
  executor: Executor,
  organizationId: number | null | undefined,
  username: string,
): Promise<string> {
  if (!organizationId) return username.trim().toLowerCase()
  const [organization] = await executor
    .select({ name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .limit(1)
  return organizationUsername(organization?.name, username)
}
