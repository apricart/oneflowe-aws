import { NextRequest,NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { db } from "@/lib/db"
import { budgets,orders,branches } from "@/db/schema"
import { and,eq,sql,inArray } from "drizzle-orm"
import { budgetTrackedOrderSql } from "@/lib/server/organization-budget-policy"
import { auditActorFromSession, recordAuditEvent } from "@/lib/server/activity-audit"

async function resolveTargetBranchIds(branchId: unknown, organizationId: unknown): Promise<number[]> {
  if (branchId) return [Number(branchId)]
  if (!organizationId) return []
  const orgBranches = await db.select({ id: branches.id })
    .from(branches)
    .where(eq(branches.organizationId, Number(organizationId)))
  return orgBranches.map((branch) => branch.id)
}

/**
 * POST /api/v1/admin/repair-budgets
 * 
 * Repair corrupted budget data by:
 * 1. Deleting all existing budget records for the given branch(es)
 * 2. Recalculating spent/held amounts from actual order records
 * 3. Recreating clean budget records per month
 * 
 * Body: { branchId?: number, organizationId?: number, mode: "reset" | "recalculate" }
 * - "reset": Delete all budget records (start fresh)
 * - "recalculate": Delete and rebuild from order history
 */
export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const role = (session.user as any).role
    if (role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Only SUPER_ADMIN can repair budgets" }, { status: 403 })
    }

    const body = await req.json()
    const { branchId, organizationId, mode = "reset" } = body

    if (!branchId && !organizationId) {
      return NextResponse.json({ error: "branchId or organizationId required" }, { status: 400 })
    }

    // 1. Find target branches
    const targetBranchIds = await resolveTargetBranchIds(branchId, organizationId)

    if (targetBranchIds.length === 0) {
      return NextResponse.json({ error: "No branches found" }, { status: 404 })
    }

    console.log(`[REPAIR] Repairing budget data for branches: ${targetBranchIds.join(", ")}`)

    // 2. Read every budget row about to be destroyed, in full.
    //
    // This endpoint deletes a branch's entire budget history, and until now it
    // recorded nothing at all. The rows themselves go into the audit entry: once
    // the delete has run, the trail is the only place the allocations, spend and
    // holds that were here still exist.
    const existingBudgets = await db.select()
      .from(budgets)
      .where(inArray(budgets.branchId, targetBranchIds))

    const addonsDeleted = existingBudgets.length

    // 3. Delete all existing budget records, with the record of what was here.
    await db.transaction(async (tx) => {
      await tx.delete(budgets).where(inArray(budgets.branchId, targetBranchIds))

      await recordAuditEvent(tx, {
        action: "RESET_BRANCH_BUDGETS",
        entity: "budget",
        // One scope per request, so a single id names it: the branch when one was
        // asked for, otherwise the organization. The branches reached are listed
        // in metadata, because `entity_id` holds one id.
        entityId: branchId ? Number(branchId) : null,
        actor: auditActorFromSession(session),
        organizationId: organizationId ? Number(organizationId) : null,
        branchId: branchId ? Number(branchId) : null,
        before: {
          budgets: existingBudgets.map((row) => ({
            id: row.id,
            branchId: row.branchId,
            period: row.period,
            allocatedCents: row.amountAllocatedCents,
            spentCents: row.amountSpentCents,
            heldCents: row.amountHeldCents,
            creditedCents: row.amountCreditedCents,
          })),
        },
        context: { mode, branchIds: targetBranchIds, budgetsDeleted: existingBudgets.length },
      })
    })

    const budgetsDeleted = existingBudgets.length
    console.log(`[REPAIR] Deleted ${budgetsDeleted} budget records and associated addons`)

    if (mode === "reset") {
      return NextResponse.json({
        message: "Budget data reset successfully",
        budgetsDeleted,
        addonsDeleted,
        branchIds: targetBranchIds,
        note: "All budget records have been deleted. New budget records will be auto-created when the budget page is accessed."
      })
    }

    // 4. Recalculate from orders — group fulfilled orders by branch + month.
    // Only orders that took a budget hold: one placed while the tenant had
    // budgets off was never charged to a budget and must not be rebuilt into one.
    const orderSpending = await db
      .select({
        branchId: orders.branchId,
        organizationId: orders.organizationId,
        period: sql<string>`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`,
        totalSpentCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) = 'FULFILLED' THEN ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0) ELSE 0 END), 0)`.mapWith(Number),
        totalHeldCents: sql<number>`COALESCE(SUM(CASE WHEN UPPER(${orders.status}) IN ('PENDING', 'APPROVED') THEN ${orders.totalCents} - COALESCE(${orders.refundAmountCents}, 0) ELSE 0 END), 0)`.mapWith(Number),
      })
      .from(orders)
      .where(and(inArray(orders.branchId, targetBranchIds), budgetTrackedOrderSql()))
      .groupBy(orders.branchId, orders.organizationId, sql`TO_CHAR(${orders.createdAt}, 'YYYY-MM')`)

    console.log(`[REPAIR] Found ${orderSpending.length} month-branch combinations with orders`)

    // 5. Get branch baselines
    const branchData = await db.select({
      id: branches.id,
      organizationId: branches.organizationId,
      baselineBudgetCents: branches.baselineBudgetCents,
    }).from(branches).where(inArray(branches.id, targetBranchIds))

    const branchMap = new Map(branchData.map(b => [b.id, b]))

    // 6. Create new budget records.
    //
    // One transaction for the whole rebuild and its audit row. Two reasons: the
    // record must commit with the rebuild rather than be best effort, and a
    // failure part-way through used to leave a branch with some months rebuilt
    // and the rest simply gone.
    let budgetsCreated = 0
    const currentMonth = new Date().toISOString().slice(0, 7)

    budgetsCreated = await db.transaction(async (tx) => {
      let created = 0

      for (const row of orderSpending) {
        const branch = branchMap.get(row.branchId)
        if (!branch) continue

        // For the current month, use baseline. For past months, set allocated to 0
        // (we don't know what was allocated historically since we deleted the records)
        const isCurrentMonth = row.period === currentMonth
        const allocated = isCurrentMonth ? (branch.baselineBudgetCents || 0) : 0

        await tx.insert(budgets).values({
          organizationId: branch.organizationId,
          branchId: row.branchId,
          period: row.period,
          amountAllocatedCents: allocated,
          amountSpentCents: row.totalSpentCents,
          amountHeldCents: row.totalHeldCents,
          amountCreditedCents: 0,
        }).onConflictDoNothing()

        created++
      }

      // Also create current month record for branches that have no orders this month
      for (const branch of branchData) {
        const hasCurrentMonth = orderSpending.some(
          r => r.branchId === branch.id && r.period === currentMonth
        )
        if (!hasCurrentMonth) {
          await tx.insert(budgets).values({
            organizationId: branch.organizationId,
            branchId: branch.id,
            period: currentMonth,
            amountAllocatedCents: 0, // Start fresh at 0
            amountSpentCents: 0,
            amountHeldCents: 0,
            amountCreditedCents: 0,
          }).onConflictDoNothing()
          created++
        }
      }

      await recordAuditEvent(tx, {
        action: "REBUILD_BRANCH_BUDGETS",
        entity: "budget",
        entityId: branchId ? Number(branchId) : null,
        actor: auditActorFromSession(session),
        organizationId: organizationId ? Number(organizationId) : null,
        branchId: branchId ? Number(branchId) : null,
        after: {
          budgets: orderSpending.map((row) => ({
            branchId: row.branchId,
            period: row.period,
            spentCents: row.totalSpentCents,
            heldCents: row.totalHeldCents,
          })),
        },
        context: { budgetsCreated: created, branchIds: targetBranchIds, rebuiltFrom: "orders" },
      })

      return created
    })

    return NextResponse.json({
      message: "Budget data recalculated successfully",
      budgetsDeleted,
      addonsDeleted,
      budgetsCreated,
      branchIds: targetBranchIds,
      orderMonths: orderSpending.map(r => ({
        branchId: r.branchId,
        period: r.period,
        spent: r.totalSpentCents / 100,
        held: r.totalHeldCents / 100,
      }))
    })

  } catch (e: any) {
    console.error("[REPAIR] Error:", e)
    return NextResponse.json({ error: "Repair failed" }, { status: 500 })
  }
}
