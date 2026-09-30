import "server-only"

import { eq } from "drizzle-orm"

import { organizations } from "@/db/schema"
import { generateApprovalToken, hashApprovalToken } from "@/lib/approval-token"

export type InitialOrderApproval = {
  approvalRequired: boolean
  values: {
    status: "PENDING" | "APPROVED"
    approvedAt: Date | null
    approvalToken: string | null
    approvalTokenHash: string | null
    approvalTokenCreatedAt: Date | null
  }
}

/**
 * Resolve the tenant's policy while holding a shared lock on its row.
 *
 * Organization policy edits take a FOR UPDATE lock on the same row. The order
 * therefore commits entirely under either the old or the new policy and can
 * never be created half-pending and half-approved during a concurrent edit.
 */
export async function resolveInitialOrderApproval(
  tx: any,
  organizationId: number,
  now = new Date(),
): Promise<InitialOrderApproval> {
  const [organization] = await tx
    .select({ orderApprovalRequired: organizations.orderApprovalRequired })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("share")
    .limit(1)

  if (!organization) throw new Error("ORGANIZATION_NOT_FOUND")

  // Fail safely if a legacy or malformed read does not contain an explicit
  // false value: approval remains required.
  if (organization.orderApprovalRequired !== false) {
    return {
      approvalRequired: true,
      values: {
        status: "PENDING",
        approvedAt: null,
        approvalToken: null,
        approvalTokenHash: null,
        approvalTokenCreatedAt: null,
      },
    }
  }

  const approvalToken = generateApprovalToken(10)
  const approvalTokenHash = await hashApprovalToken(approvalToken)

  return {
    approvalRequired: false,
    values: {
      status: "APPROVED",
      approvedAt: now,
      approvalToken,
      approvalTokenHash,
      approvalTokenCreatedAt: now,
    },
  }
}
