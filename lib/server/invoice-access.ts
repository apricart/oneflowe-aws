import { isViewerRole, viewerReadScope } from "@/lib/viewer-access"
import { eq } from "drizzle-orm"
import { db } from "@/lib/db"
import { orders } from "@/db/schema"
import { getRequestScope, getSharedServerSession, type RequestScope } from "@/lib/auth"
import type { Role } from "@/lib/rbac"
import {
  invoiceScopeNeedsAssignedBranches,
  ORDER_NOT_FOUND,
  resolveInvoiceAccess,
  type InvoiceAccessDenial,
  type InvoiceRequesterScope,
} from "@/lib/invoice-access-policy"
import { resolveScopedBranchIds } from "@/lib/server/multi-branch-scope"

export type InvoiceOrder = typeof orders.$inferSelect

export type InvoiceAccessResult =
  | { ok: true; role: Role; scope: RequestScope; order: InvoiceOrder }
  | { ok: false; denial: InvoiceAccessDenial }

/**
 * Resolve the caller, load the order, and apply the shared invoice policy.
 * Both invoice endpoints authorize through this and nothing else, so the
 * organization, branch, and ownership rules cannot drift apart between the
 * preview and the download.
 *
 * The organization and branch come from `getRequestScope`, which reads them
 * from the database rather than from the session token.
 */
export async function authorizeInvoiceRequest(
  orderId: number,
): Promise<InvoiceAccessResult> {
  const [session, requestScope] = await Promise.all([
    getSharedServerSession(),
    getRequestScope(),
  ])
  const sessionRole = (session?.user as any)?.role as Role | undefined
  // Every caller is a GET handler (pinned by `lib/viewer-access.test.ts`). An
  // organization-wide Viewer reads its tenant's invoices as Head Office does;
  // a branch-pinned one keeps its own rule, which reads none.
  const viewerScope = isViewerRole(sessionRole) ? viewerReadScope(requestScope) : null
  const role = (viewerScope?.role ?? sessionRole) as Role | undefined
  const scope = viewerScope ?? requestScope

  // Reject an unusable caller before touching the database.
  const identityDenial = resolveInvoiceAccess({ role, scope, order: null })
  if (identityDenial && identityDenial !== ORDER_NOT_FOUND) {
    return { ok: false, denial: identityDenial }
  }

  // The group-based roles reach branches through their group and branch
  // assignments rather than a single pinned branch, so resolve that set for
  // them — and only for them, so no other role pays for the query.
  const invoiceScope: InvoiceRequesterScope | null = scope
    ? {
        ...scope,
        scopedBranchIds: invoiceScopeNeedsAssignedBranches(role)
          ? await resolveScopedBranchIds(db, scope.userId)
          : null,
      }
    : null

  const [order] = await db
    .select()
    .from(orders)
    .where(eq(orders.id, orderId))
    .limit(1)

  const denial = resolveInvoiceAccess({ role, scope: invoiceScope, order: order ?? null })
  if (denial) {
    if (denial.status === 403) {
      console.warn(
        `[Security] Invoice access denied: user ${scope?.userId} (${role}) requested order ${orderId}`,
      )
    }
    return { ok: false, denial }
  }

  return { ok: true, role: role as Role, scope: scope as RequestScope, order }
}
