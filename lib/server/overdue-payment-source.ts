import "server-only"

import { NOT_CONFIGURED_OVERDUE_SUMMARY, type OverduePaymentSummary } from "@/lib/payment-control-policy"
import type { db } from "@/lib/db"

type DbClient = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Where "does this branch have overdue payments" comes from.
 *
 * This is the one seam the rest of the feature depends on. The resolver, the
 * order gate, the routes and the UI read only the returned shape; none of
 * them knows how it is computed.
 *
 * No reliable source exists in production today
 * (plans/OF-PAYMENT-CONTROL-overdue-ordering-block.md, "What the
 * investigation found"): the only payment fact in the database is the
 * hand-toggled UNPAID/PAID flag on an order, with no due date, and the budget
 * ledger is a spending allowance, not money owed. Until the client says what
 * an overdue payment is and where it is recorded, this returns "not
 * configured", which the policy treats as: nothing is known, nothing is
 * blocked, nothing is shown.
 *
 * When that decision lands, replace the body — read the agreed table, feed,
 * or flag — and return `configured: true` with the count and the items. The
 * integration tests inject a configured source through this module to prove
 * the gate blocks when one exists.
 */
export type OverduePaymentSource = (
  client: DbClient,
  scope: { organizationId: number; branchId: number },
  now: Date,
) => Promise<OverduePaymentSummary>

export const overduePaymentSource: OverduePaymentSource = async () => NOT_CONFIGURED_OVERDUE_SUMMARY
