import { NextResponse, type NextRequest } from "next/server"
import { getServerSession } from "next-auth"

import { authOptions } from "@/lib/auth-options"
import {
  EXECUTIVE_THRESHOLDS,
  classifyBudgetHealth,
  countToReachShare,
  growthPct,
  resolveQuantityUnit,
  safeDivide,
  utilizationPct,
  withCumulativeShare,
} from "@/lib/executive-analytics"
import { parseExecutiveRequest, previousWindow } from "@/lib/executive-analytics-request"
import {
  loadAgingPendingOrders,
  loadBranchBudgets,
  loadBranchCategoryMatrix,
  loadLineGrainSeries,
  loadOrderGrainSeries,
  loadPriceVariance,
  loadStatusComposition,
  loadUnitsInScope,
  type ExecutiveFilters,
} from "@/lib/server/executive-analytics-queries"
import { loadScopedBranches, resolveExecutiveScope } from "@/lib/server/executive-analytics-scope"

/**
 * Level 1 of the Executive Analytics Center: "what is happening right now?"
 *
 * One request returns the whole overview — KPIs, the branch budget position,
 * the trend, the category concentration, the branch × category mix, the price
 * outliers, the process composition and the attention list — because the page
 * shows them together and eight round trips would only add latency.
 *
 * Authorization happens once, at the top, in `resolveExecutiveScope`. Every
 * builder below is handed the resolved scope and applies its branch fence
 * itself, so there is no path through this handler that reads a row the caller
 * was not already entitled to.
 */
export async function GET(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    const url = new URL(req.url)

    const scope = await resolveExecutiveScope(session, url.searchParams)
    if (!scope.ok) return NextResponse.json({ error: scope.error }, { status: scope.status })

    const parsed = parseExecutiveRequest(url.searchParams)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })

    const baseFilters: ExecutiveFilters = {
      startDate: parsed.startDate,
      endDate: parsed.endDate,
      categoryIds: parsed.categoryIds,
      productIds: parsed.productIds,
      groupIds: parsed.groupIds,
      userIds: parsed.userIds,
      unit: null,
    }

    // Quantity is only totalled inside one unit of measure. Resolve which unit
    // applies before any quantity figure is computed, so a mixed scope reports
    // the conflict instead of adding litres to packs.
    const unitsInScope = await loadUnitsInScope(scope, baseFilters)
    const unitResolution = resolveQuantityUnit(unitsInScope, parsed.requestedUnit)
    const filters: ExecutiveFilters = { ...baseFilters, unit: unitResolution.unit }

    const { previousStart, previousEnd } = previousWindow(parsed.startDate, parsed.endDate)
    const previousFilters: ExecutiveFilters = { ...filters, startDate: previousStart, endDate: previousEnd }

    const [
      branchList,
      budgetRows,
      previousBudgetRows,
      branchOrders,
      previousBranchOrders,
      monthlyTrend,
      previousMonthlyTrend,
      categoryRows,
      matrixRows,
      statusRows,
      priceRows,
      agingRows,
    ] = await Promise.all([
      loadScopedBranches(scope),
      loadBranchBudgets(scope, filters),
      loadBranchBudgets(scope, previousFilters),
      loadOrderGrainSeries(scope, filters, "branch", 50),
      loadOrderGrainSeries(scope, previousFilters, "branch", 50),
      loadOrderGrainSeries(scope, filters, "month", 120),
      loadOrderGrainSeries(scope, previousFilters, "month", 120),
      loadLineGrainSeries(scope, filters, "category", 20),
      loadBranchCategoryMatrix(scope, filters),
      loadStatusComposition(scope, filters),
      loadPriceVariance(scope, filters, 10),
      loadAgingPendingOrders(scope, filters, EXECUTIVE_THRESHOLDS.pendingOrderAgingDays),
    ])

    const previousBudgetByBranch = new Map(previousBudgetRows.map((row) => [row.branchId, row]))
    const orderByBranch = new Map(branchOrders.map((row) => [Number(row.key), row]))
    const previousOrderByBranch = new Map(previousBranchOrders.map((row) => [Number(row.key), row]))

    // ── Branch rollup: budget position joined to order activity ─────────────
    // Both sides are already aggregated to one row per branch, so this is a
    // lookup rather than a join, and no figure can be double-counted here.
    const branchRollup = budgetRows.map((budget) => {
      const activity = orderByBranch.get(budget.branchId)
      const previousActivity = previousOrderByBranch.get(budget.branchId)
      const previousBudget = previousBudgetByBranch.get(budget.branchId)
      return {
        branchId: budget.branchId,
        branchName: budget.branchName,
        allocatedCents: budget.allocatedCents,
        creditedCents: budget.creditedCents,
        totalBudgetCents: budget.totalBudgetCents,
        spentCents: budget.spentCents,
        heldCents: budget.heldCents,
        consumedCents: budget.consumedCents,
        remainingCents: budget.remainingCents,
        utilizationPct: utilizationPct(budget.consumedCents, budget.totalBudgetCents),
        health: classifyBudgetHealth(budget.totalBudgetCents, budget.consumedCents),
        spendCents: activity?.spendCents ?? 0,
        orderCount: activity?.orderCount ?? 0,
        avgOrderValueCents: activity?.avgOrderValueCents ?? 0,
        spendGrowthPct: growthPct(activity?.spendCents ?? 0, previousActivity?.spendCents ?? 0),
        previousConsumedCents: previousBudget?.consumedCents ?? 0,
      }
    })

    const organizationSpendCents = branchRollup.reduce((sum, row) => sum + row.spendCents, 0)
    const rankedBranches = [...branchRollup]
      .map((row) => ({ ...row, shareOfSpendPct: safeDivide(row.spendCents, organizationSpendCents) * 100 }))
      .sort((left, right) => right.spendCents - left.spendCents)

    // ── KPIs ───────────────────────────────────────────────────────────────
    const totals = branchRollup.reduce((accumulator, row) => ({
      totalBudgetCents: accumulator.totalBudgetCents + row.totalBudgetCents,
      allocatedCents: accumulator.allocatedCents + row.allocatedCents,
      creditedCents: accumulator.creditedCents + row.creditedCents,
      spentCents: accumulator.spentCents + row.spentCents,
      heldCents: accumulator.heldCents + row.heldCents,
      consumedCents: accumulator.consumedCents + row.consumedCents,
      remainingCents: accumulator.remainingCents + row.remainingCents,
      orderCount: accumulator.orderCount + row.orderCount,
      spendCents: accumulator.spendCents + row.spendCents,
    }), {
      totalBudgetCents: 0, allocatedCents: 0, creditedCents: 0, spentCents: 0,
      heldCents: 0, consumedCents: 0, remainingCents: 0, orderCount: 0, spendCents: 0,
    })

    const previousTotals = previousBudgetRows.reduce((accumulator, row) => ({
      totalBudgetCents: accumulator.totalBudgetCents + row.totalBudgetCents,
      consumedCents: accumulator.consumedCents + row.consumedCents,
    }), { totalBudgetCents: 0, consumedCents: 0 })

    const previousSpendCents = previousBranchOrders.reduce((sum, row) => sum + row.spendCents, 0)
    const previousOrderCount = previousBranchOrders.reduce((sum, row) => sum + row.orderCount, 0)

    // ── Category concentration (Pareto) ────────────────────────────────────
    const categoryPareto = withCumulativeShare(categoryRows, (row) => row.valueCents)
    const categoriesTo80 = countToReachShare(categoryPareto, 80)

    // ── Branch × Category matrix, normalized per branch row ────────────────
    const branchTotals = new Map<number, number>()
    matrixRows.forEach((cell) => {
      branchTotals.set(cell.branchId, (branchTotals.get(cell.branchId) ?? 0) + cell.valueCents)
    })
    const matrixCategories = Array.from(
      new Map(matrixRows.map((cell) => [cell.categoryKey, cell.categoryName])).entries(),
    ).map(([key, name]) => ({ key, name }))

    const matrix = Array.from(new Set(matrixRows.map((cell) => cell.branchId))).map((branchId) => {
      const branchCells = matrixRows.filter((cell) => cell.branchId === branchId)
      const branchTotal = branchTotals.get(branchId) ?? 0
      return {
        branchId,
        branchName: branchCells[0]?.branchName ?? "Unassigned",
        totalCents: branchTotal,
        cells: matrixCategories.map((category) => {
          const cell = branchCells.find((entry) => entry.categoryKey === category.key)
          return {
            categoryKey: category.key,
            valueCents: cell?.valueCents ?? 0,
            quantity: cell?.quantity ?? 0,
            sharePct: safeDivide(cell?.valueCents ?? 0, branchTotal) * 100,
          }
        }),
      }
    })

    // ── Process composition, as a share of each branch's own orders ─────────
    const statusByBranch = Array.from(new Set(statusRows.map((row) => row.branchId))).map((branchId) => {
      const rows = statusRows.filter((row) => row.branchId === branchId)
      const total = rows.reduce((sum, row) => sum + row.orderCount, 0)
      return {
        branchId,
        branchName: rows[0]?.branchName ?? "Unassigned",
        totalOrders: total,
        statuses: rows.map((row) => ({
          status: row.status,
          orderCount: row.orderCount,
          sharePct: safeDivide(row.orderCount, total) * 100,
        })),
      }
    }).sort((left, right) => right.totalOrders - left.totalOrders)

    // ── Attention list ─────────────────────────────────────────────────────
    const attention = buildAttentionList({ rankedBranches, priceRows, agingRows })

    return NextResponse.json({
      scope: {
        role: scope.role,
        organizationIds: scope.organizationIds,
        branchCount: branchList.length,
        branches: branchList.map((branch) => ({ id: branch.id, name: branch.name })),
      },
      period: {
        startDate: parsed.startDate.toISOString(),
        endDate: parsed.endDate.toISOString(),
        previousStartDate: previousStart.toISOString(),
        previousEndDate: previousEnd.toISOString(),
      },
      quantityUnit: {
        selected: unitResolution.unit,
        conflict: unitResolution.conflict,
        available: unitResolution.units,
      },
      kpis: {
        ...totals,
        utilizationPct: utilizationPct(totals.consumedCents, totals.totalBudgetCents),
        varianceCents: totals.totalBudgetCents - totals.consumedCents,
        consumedGrowthPct: growthPct(totals.consumedCents, previousTotals.consumedCents),
        spendGrowthPct: growthPct(totals.spendCents, previousSpendCents),
        orderGrowthPct: growthPct(totals.orderCount, previousOrderCount),
        avgOrderValueCents: Math.round(safeDivide(totals.spendCents, totals.orderCount)),
        previousSpendCents,
        previousOrderCount,
        previousConsumedCents: previousTotals.consumedCents,
      },
      branches: rankedBranches,
      trend: {
        current: monthlyTrend,
        previous: previousMonthlyTrend,
      },
      categories: categoryPareto,
      categoryConcentration: {
        categoriesTo80,
        totalCategories: categoryPareto.length,
      },
      matrix: { categories: matrixCategories, rows: matrix },
      statusByBranch,
      priceVariance: priceRows,
      attention,
      thresholds: EXECUTIVE_THRESHOLDS,
    })
  } catch (error) {
    console.error("Executive analytics overview failed:", error)
    return NextResponse.json({ error: "Internal Server Error" }, { status: 500 })
  }
}

type AttentionItem = {
  id: string
  severity: "critical" | "serious" | "warning" | "good"
  title: string
  detail: string
  branchId?: number
  productId?: number
}

/**
 * The "where should I look first?" shortlist.
 *
 * Every entry is a rule against a documented threshold in
 * `EXECUTIVE_THRESHOLDS`, and every entry states the number that triggered it,
 * so nothing here reads as a business rule the application enforces.
 */
function buildAttentionList({ rankedBranches, priceRows, agingRows }: {
  rankedBranches: Array<{
    branchId: number
    branchName: string
    totalBudgetCents: number
    consumedCents: number
    utilizationPct: number
    health: string
    spendGrowthPct: number | null
  }>
  priceRows: Array<{ productId: number; productName: string; unit: string; spreadPct: number; branchCount: number; minUnitPriceCents: number; maxUnitPriceCents: number }>
  agingRows: Array<{ branchId: number; branchName: string; orderCount: number; oldestDays: number }>
}): AttentionItem[] {
  const items: AttentionItem[] = []

  rankedBranches.forEach((branch) => {
    if (branch.health === "over") {
      items.push({
        id: `over-${branch.branchId}`,
        severity: "critical",
        title: `${branch.branchName} is over budget`,
        detail: `${branch.utilizationPct.toFixed(1)}% of its budget is consumed or committed.`,
        branchId: branch.branchId,
      })
    } else if (branch.health === "warning") {
      items.push({
        id: `near-${branch.branchId}`,
        severity: "serious",
        title: `${branch.branchName} is approaching its limit`,
        detail: `${branch.utilizationPct.toFixed(1)}% consumed, at or above the ${EXECUTIVE_THRESHOLDS.budgetWarningPct}% review threshold.`,
        branchId: branch.branchId,
      })
    } else if (branch.health === "underused" && branch.totalBudgetCents > 0) {
      items.push({
        id: `under-${branch.branchId}`,
        severity: "warning",
        title: `${branch.branchName} has used little of its budget`,
        detail: `${branch.utilizationPct.toFixed(1)}% consumed, below the ${EXECUTIVE_THRESHOLDS.budgetUnderusedPct}% review threshold.`,
        branchId: branch.branchId,
      })
    }

    if (branch.spendGrowthPct !== null && Math.abs(branch.spendGrowthPct) >= EXECUTIVE_THRESHOLDS.spendSwingPct) {
      items.push({
        id: `swing-${branch.branchId}`,
        severity: branch.spendGrowthPct > 0 ? "serious" : "warning",
        title: `${branch.branchName} spend ${branch.spendGrowthPct > 0 ? "rose" : "fell"} ${Math.abs(branch.spendGrowthPct).toFixed(0)}%`,
        detail: `Compared with the previous period of the same length, beyond the ${EXECUTIVE_THRESHOLDS.spendSwingPct}% review threshold.`,
        branchId: branch.branchId,
      })
    }
  })

  priceRows
    .filter((row) => row.spreadPct >= EXECUTIVE_THRESHOLDS.priceSpreadPct)
    .slice(0, 5)
    .forEach((row) => {
      items.push({
        id: `price-${row.productId}-${row.unit}`,
        severity: "serious",
        title: `${row.productName}: ${row.spreadPct.toFixed(0)}% price gap between branches`,
        detail: `${row.branchCount} branches bought this per ${row.unit || "unit"} at different weighted average prices.`,
        productId: row.productId,
      })
    })

  agingRows.slice(0, 5).forEach((row) => {
    items.push({
      id: `aging-${row.branchId}`,
      severity: "warning",
      title: `${row.branchName} has ${row.orderCount} order${row.orderCount === 1 ? "" : "s"} awaiting approval`,
      detail: `Oldest is ${row.oldestDays} days old, past the ${EXECUTIVE_THRESHOLDS.pendingOrderAgingDays}-day review threshold.`,
      branchId: row.branchId,
    })
  })

  const severityOrder = { critical: 0, serious: 1, warning: 2, good: 3 }
  return items.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity]).slice(0, 12)
}
