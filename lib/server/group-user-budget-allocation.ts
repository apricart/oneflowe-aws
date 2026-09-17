import "server-only"

import { and, eq, isNull } from "drizzle-orm"
import { roles, users } from "@/db/schema"
import { db } from "@/lib/db"

/** Read the current account and tenant on each budget request. JWT claims only drive UI. */
export async function isGroupUserBudgetAllocationEnabled(userId: unknown, organizationId: unknown): Promise<boolean> {
  if (typeof userId !== "string" || !userId || !Number.isInteger(organizationId) || Number(organizationId) <= 0) {
    return false
  }

  const [user] = await db.select({ enabled: users.budgetAllocationEnabled })
    .from(users)
    .innerJoin(roles, eq(users.roleId, roles.id))
    .where(and(
      eq(users.id, userId),
      eq(users.organizationId, Number(organizationId)),
      eq(roles.name, "GROUP_USER"),
      eq(users.isActive, true),
      isNull(users.deletedAt),
    ))
    .limit(1)
  return user?.enabled === true
}
