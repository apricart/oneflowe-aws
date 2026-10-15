import "server-only"

import { headers } from "next/headers"

import { auditLogs, systemLogs } from "@/db/schema"
import { db } from "@/lib/db"
import { resolveRequestClientIp } from "@/lib/server/request-ip"

/**
 * The trail for joining.
 *
 * Every privileged act in this feature is recorded: opening a tenant to
 * joining, closing it again, and each approval or rejection. A reviewer must be
 * able to reconstruct who let a given account in, when, and with what role —
 * which matters more here than for administrator-created accounts, because the
 * person's own details arrived from outside the application.
 *
 * Written to both tables, matching the rest of the codebase: `audit_logs` for
 * the entity trail, `system_logs` for the request-shaped record with the
 * address it came from.
 *
 * **What never reaches the trail**: the join code itself, and any password or
 * hash. `metadata` is assembled explicitly by the caller for that reason —
 * nothing is spread into it.
 */

export type JoinAuditAction =
  | "SET_ORGANIZATION_JOIN_CODE"
  | "CLEAR_ORGANIZATION_JOIN_CODE"
  | "APPROVE_ORGANIZATION_JOIN_REQUEST"
  | "REJECT_ORGANIZATION_JOIN_REQUEST"
  // Head Office naming a different approver on a pending department sign-up.
  | "REPLACE_ORGANIZATION_JOIN_REQUEST_APPROVER"

/**
 * The request's address and agent, or nulls.
 *
 * Resolved separately from the insert and never allowed to throw into it: a
 * failed header lookup must cost the trail its *decoration*, not the row. The
 * row is the auditable fact; `headers()` is unavailable outside a request scope
 * and would otherwise take the whole audit entry down with it.
 */
async function describeRequestOrigin(): Promise<{ ipAddress: string; userAgent: string | null }> {
  try {
    const headersList = await headers()
    const ipAddress = await resolveRequestClientIp()
    return { ipAddress: ipAddress ?? "unknown", userAgent: headersList.get("user-agent") }
  } catch {
    return { ipAddress: "unknown", userAgent: null }
  }
}

export async function writeJoinAudit(input: {
  action: JoinAuditAction
  organizationId: number
  actorUserId: string
  entityId: string
  metadata: Record<string, unknown>
}): Promise<void> {
  try {
    const { ipAddress, userAgent } = await describeRequestOrigin()

    await Promise.all([
      db.insert(auditLogs).values({
        userId: input.actorUserId,
        organizationId: input.organizationId,
        action: input.action,
        entity: "organization_join_request",
        entityId: input.entityId,
        metadata: input.metadata,
      }),
      db.insert(systemLogs).values({
        userId: input.actorUserId,
        userRole: "HEAD_OFFICE",
        organizationId: input.organizationId,
        action: input.action,
        resourceType: "organization_join_request",
        resourceId: input.entityId,
        details: input.metadata,
        ipAddress,
        userAgent,
        success: true,
      }),
    ])
  } catch (auditError) {
    // The decision is already committed; failing the response over the trail
    // would leave the caller believing nothing happened when a user exists.
    console.error("[JOIN_AUDIT] Failed to write the join audit trail:", auditError)
  }
}
