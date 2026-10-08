import "server-only"

import { eq } from "drizzle-orm"

import { organizations } from "@/db/schema"
import { generateApprovalToken, hashApprovalToken } from "@/lib/approval-token"
import { orderDeskRequiresExecutiveApproval } from "@/lib/order-desk-access"
import { DESK_ORDER_APPROVAL_BASIS } from "@/lib/order-desk-approval"

export type InitialOrderApproval = {
  approvalRequired: boolean
  values: {
    status: "PENDING" | "APPROVED"
    approvedAt: Date | null
    approvalToken: string | null
    approvalTokenHash: string | null
    approvalTokenCreatedAt: Date | null
  }
  /** Present only when the creator, not the tenant's policy, decided the approval. */
  approvalBasis?: typeof DESK_ORDER_APPROVAL_BASIS
}

/** Who is creating the order, from the session. */
export type InitialOrderApprovalCreator = {
  role: unknown
  userId: string
}

function pendingValues(): InitialOrderApproval["values"] {
  return {
    status: "PENDING",
    approvedAt: null,
    approvalToken: null,
    approvalTokenHash: null,
    approvalTokenCreatedAt: null,
  }
}

async function approvedValues(now: Date) {
  const approvalToken = generateApprovalToken(10)
  const approvalTokenHash = await hashApprovalToken(approvalToken)
  return {
    status: "APPROVED" as const,
    approvedAt: now,
    approvalToken,
    approvalTokenHash,
    approvalTokenCreatedAt: now,
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
  creator?: InitialOrderApprovalCreator,
): Promise<InitialOrderApproval> {
  const [organization] = await tx
    .select({ orderApprovalRequired: organizations.orderApprovalRequired })
    .from(organizations)
    .where(eq(organizations.id, organizationId))
    .for("share")
    .limit(1)

  if (!organization) throw new Error("ORGANIZATION_NOT_FOUND")

  // An Order Desk entry waits for an Apricart Executive assigned to the
  // organization, whatever the tenant's switch says. The role comes from the
  // session, and only Super Admin can grant it.
  if (creator && orderDeskRequiresExecutiveApproval(creator.role)) {
    return { approvalRequired: true, values: pendingValues(), approvalBasis: DESK_ORDER_APPROVAL_BASIS }
  }

  // Fail safely if a legacy or malformed read does not contain an explicit
  // false value: approval remains required.
  if (organization.orderApprovalRequired !== false) {
    return { approvalRequired: true, values: pendingValues() }
  }

  return {
    approvalRequired: false,
    values: await approvedValues(now),
  }
}
