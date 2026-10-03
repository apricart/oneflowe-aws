import "server-only"

import { headers } from "next/headers"

import { auditLogs, systemLogs } from "@/db/schema"
import { db } from "@/lib/db"
import { resolveRequestClientIp } from "@/lib/server/request-ip"

/**
 * The trail for delivery addresses.
 *
 * Where a tenant's goods may be sent is a privileged fact: an approved address
 * diverts stock to somewhere the branch's own record does not mention. A
 * reviewer must be able to reconstruct who asked for a destination, who allowed
 * it, and when — which matters more here than for most administrative edits,
 * because the address itself was supplied from outside head office.
 *
 * Written to both tables, matching the rest of the codebase: `audit_logs` for
 * the entity trail, `system_logs` for the request-shaped record with the
 * address it came from.
 *
 * `metadata` is assembled explicitly by the caller — nothing is spread into it,
 * so a column added to the row later cannot start appearing in the trail by
 * accident.
 */

export type DeliveryAddressAuditAction =
  | "REQUEST_BRANCH_DELIVERY_ADDRESS"
  | "APPROVE_BRANCH_DELIVERY_ADDRESS"
  | "REJECT_BRANCH_DELIVERY_ADDRESS"

/**
 * The request's address and agent, or nulls.
 *
 * Resolved separately from the insert and never allowed to throw into it: a
 * failed header lookup must cost the trail its *decoration*, not the row.
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

export async function writeDeliveryAddressAudit(input: {
  action: DeliveryAddressAuditAction
  organizationId: number
  actorUserId: string
  actorRole: string
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
        entity: "branch_delivery_address",
        entityId: input.entityId,
        metadata: input.metadata,
      }),
      db.insert(systemLogs).values({
        userId: input.actorUserId,
        userRole: input.actorRole,
        organizationId: input.organizationId,
        action: input.action,
        resourceType: "branch_delivery_address",
        resourceId: input.entityId,
        details: input.metadata,
        ipAddress,
        userAgent,
        success: true,
      }),
    ])
  } catch (auditError) {
    // The decision is already committed; failing the response over the trail
    // would leave the caller believing nothing happened when the address is
    // live.
    console.error("[DELIVERY_ADDRESS_AUDIT] Failed to write the audit trail:", auditError)
  }
}
