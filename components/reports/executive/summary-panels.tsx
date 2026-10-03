"use client"

import * as React from "react"
import {
  AlertTriangle,
  ArrowDownRight,
  ArrowUpRight,
  Ban,
  CircleAlert,
  Minus,
  Wallet,
  Receipt,
  PiggyBank,
  Gauge,
  ShoppingCart,
} from "lucide-react"

import { Card, CardContent } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import type { BudgetTrackingCoverage } from "@/lib/organization-budget-policy"
import { STATUS_COLOR, changeLabel, countShort, money, percent } from "./chart-kit"

/**
 * The executive header: the four or five figures a decision-maker reads first,
 * and the shortlist of things that need looking at.
 *
 * Deliberately short. A wall of KPI cards is the fastest way to make a
 * dashboard unreadable, so anything that is not a leading indicator lives in a
 * chart tooltip instead.
 */

export type ExecutiveKpis = {
  totalBudgetCents: number
  allocatedCents: number
  creditedCents: number
  spentCents: number
  heldCents: number
  consumedCents: number
  remainingCents: number
  utilizationPct: number
  varianceCents: number
  spendCents: number
  orderCount: number
  avgOrderValueCents: number
  consumedGrowthPct: number | null
  spendGrowthPct: number | null
  orderGrowthPct: number | null
  /**
   * Whether the budget figures cover every tenant on screen, some, or none —
   * "none" being a tenant with budget allocation switched off. Absent from an
   * older response, which reads as "all".
   */
  budgetTracking?: BudgetTrackingCoverage
}

type KpiSpec = {
  key: string
  label: string
  value: string
  hint: string
  change: number | null
  icon: React.ComponentType<{ className?: string }>
  accent?: string
}

const BUDGET_OFF_HINT = "Budget allocation is off for this organization"

/**
 * The budget cards for a view whose tenants all have budget allocation off:
 * "Off" in words, never a zero budget, a negative remaining or "no budget".
 */
function budgetOffKpis(): KpiSpec[] {
  return [
    { key: "budget", label: "Total Budget", value: "Off", hint: BUDGET_OFF_HINT, change: null, icon: Wallet },
    { key: "consumed", label: "Consumed", value: "Off", hint: BUDGET_OFF_HINT, change: null, icon: Receipt },
    { key: "remaining", label: "Remaining", value: "Off", hint: BUDGET_OFF_HINT, change: null, icon: PiggyBank },
    { key: "utilization", label: "Utilization", value: "Off", hint: BUDGET_OFF_HINT, change: null, icon: Gauge },
  ]
}

function buildKpis(kpis: ExecutiveKpis): KpiSpec[] {
  if (kpis.budgetTracking === "none") {
    return [
      ...budgetOffKpis(),
      {
        key: "orders",
        label: "Orders",
        value: countShort(kpis.orderCount),
        hint: `${money(kpis.avgOrderValueCents)} average order value`,
        change: kpis.orderGrowthPct,
        icon: ShoppingCart,
      },
    ]
  }
  const partial = kpis.budgetTracking === "some"
  return [
    {
      key: "budget",
      label: "Total Budget",
      value: money(kpis.totalBudgetCents),
      hint: partial
        ? `${money(kpis.allocatedCents)} allocated + ${money(kpis.creditedCents)} add-ons; organizations with budget allocation off are not included`
        : `${money(kpis.allocatedCents)} allocated + ${money(kpis.creditedCents)} add-ons`,
      change: null,
      icon: Wallet,
    },
    {
      key: "consumed",
      label: "Consumed",
      value: money(kpis.consumedCents),
      hint: "Charged against the budget, including orders awaiting approval",
      change: kpis.consumedGrowthPct,
      icon: Receipt,
    },
    {
      key: "remaining",
      label: "Remaining",
      value: money(kpis.remainingCents),
      hint: kpis.remainingCents < 0 ? "Over the allocated budget" : "Available before branches are blocked",
      change: null,
      icon: PiggyBank,
      accent: kpis.remainingCents < 0 ? STATUS_COLOR.critical : undefined,
    },
    {
      key: "utilization",
      label: "Utilization",
      value: kpis.totalBudgetCents > 0 ? percent(kpis.utilizationPct) : "no budget",
      hint: kpis.totalBudgetCents > 0
        ? `Variance ${money(kpis.varianceCents)}`
        : "No budget allocated in the selected period",
      change: null,
      icon: Gauge,
      accent: kpis.utilizationPct > 100 ? STATUS_COLOR.critical : undefined,
    },
    {
      key: "orders",
      label: "Orders",
      value: countShort(kpis.orderCount),
      hint: `${money(kpis.avgOrderValueCents)} average order value`,
      change: kpis.orderGrowthPct,
      icon: ShoppingCart,
    },
  ]
}

export function KpiRow({ kpis, loading }: Readonly<{ kpis: ExecutiveKpis | null; loading: boolean }>) {
  if (loading || !kpis) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, index) => index).map((index) => (
          <Skeleton key={index} className="h-[104px] rounded-xl" />
        ))}
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
      {buildKpis(kpis).map((kpi) => {
        const change = changeLabel(kpi.change)
        const ChangeIcon = change.tone === "up" ? ArrowUpRight : change.tone === "down" ? ArrowDownRight : Minus
        return (
          <Card key={kpi.key}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400">
                  {kpi.label}
                </p>
                <kpi.icon className="h-4 w-4 text-slate-400" />
              </div>
              <p
                className="mt-1.5 break-words text-xl font-bold leading-tight text-slate-900 dark:text-slate-100"
                style={kpi.accent ? { color: kpi.accent } : undefined}
              >
                {kpi.value}
              </p>
              <p className="mt-1 text-[11px] leading-snug text-slate-500 dark:text-slate-400">{kpi.hint}</p>
              {kpi.change !== null ? (
                <p className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-slate-600 dark:text-slate-300">
                  <ChangeIcon className="h-3 w-3" aria-hidden />
                  {change.text}
                </p>
              ) : null}
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}

// ── Attention list ─────────────────────────────────────────────────────────

export type AttentionItem = {
  id: string
  severity: "critical" | "serious" | "warning" | "good"
  title: string
  detail: string
  branchId?: number
  productId?: number
}

const SEVERITY_META = {
  critical: { color: STATUS_COLOR.critical, icon: Ban, label: "Critical" },
  serious: { color: STATUS_COLOR.serious, icon: AlertTriangle, label: "Review" },
  warning: { color: STATUS_COLOR.warning, icon: CircleAlert, label: "Watch" },
  good: { color: STATUS_COLOR.good, icon: CircleAlert, label: "Fine" },
} as const

/**
 * "Where should I look first?"
 *
 * Every row names the threshold that produced it, and severity is carried by an
 * icon and a word as well as a colour — a status hue never means anything on
 * its own here.
 */
export function AttentionList({ items, loading, onSelectBranch }: Readonly<{
  items: AttentionItem[]
  loading: boolean
  onSelectBranch?: (branchId: number) => void
}>) {
  if (loading) return <Skeleton className="h-[280px] w-full rounded-xl" />

  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="flex min-h-[160px] flex-col items-center justify-center gap-2 p-6 text-center">
          <CircleAlert className="h-5 w-5" style={{ color: STATUS_COLOR.good }} aria-hidden />
          <p className="text-sm font-semibold text-slate-800 dark:text-slate-200">Nothing flagged</p>
          <p className="max-w-xs text-xs text-slate-500 dark:text-slate-400">
            No branch crossed a budget, price-spread or approval-aging threshold in the selected period.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <Card>
      <CardContent className="p-4">
        <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">Needs attention</h3>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          Rule-based flags against documented analytics thresholds, most severe first.
        </p>
        <ul className="mt-3 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
          {items.map((item) => {
            const meta = SEVERITY_META[item.severity]
            const Icon = meta.icon
            const clickable = Boolean(item.branchId && onSelectBranch)
            return (
              <li key={item.id}>
                <button
                  type="button"
                  disabled={!clickable}
                  onClick={() => item.branchId && onSelectBranch?.(item.branchId)}
                  className={cn(
                    "flex w-full items-start gap-2.5 rounded-lg border border-slate-200 px-3 py-2 text-left transition dark:border-slate-700",
                    clickable ? "cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-800/60" : "cursor-default",
                  )}
                >
                  <Icon className="mt-0.5 h-4 w-4 shrink-0" style={{ color: meta.color }} aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-xs font-semibold text-slate-800 dark:text-slate-200">
                      <span className="sr-only">{meta.label}: </span>
                      {item.title}
                    </span>
                    <span className="mt-0.5 block text-[11px] leading-snug text-slate-500 dark:text-slate-400">
                      {item.detail}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      </CardContent>
    </Card>
  )
}
