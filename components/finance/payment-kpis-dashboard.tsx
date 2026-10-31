"use client"

import { useMemo, useState, type ReactNode } from "react"
import Link from "next/link"
import useSWR from "swr"
import { AlertTriangle, ArrowRight, Banknote, CalendarRange, CheckCircle2, Clock, Percent, RefreshCw, Truck } from "lucide-react"

import { OrganizationMultiSelect } from "@/components/finance/organization-multi-select"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { PAYMENT_OVERDUE_AFTER_DAYS, type PaymentAgingBucketKey, type PaymentFigure, type PaymentKpis } from "@/lib/finance-payment-kpis"
import { cn, formatPKR } from "@/lib/utils"

const PERIODS = [
  { value: "all", label: "All time", months: null },
  { value: "month", label: "This month", months: 0 },
  { value: "3m", label: "Last 3 months", months: 3 },
  { value: "12m", label: "Last 12 months", months: 12 },
] as const

type PeriodValue = (typeof PERIODS)[number]["value"]

function isoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0")
  const day = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${month}-${day}`
}

/** The order-date window a period stands for, as the date-only params the API reads. */
function periodRange(period: PeriodValue, now = new Date()): { startDate: string; endDate: string } | null {
  const definition = PERIODS.find((entry) => entry.value === period)
  if (!definition || definition.months === null) return null
  const start = definition.months === 0
    ? new Date(now.getFullYear(), now.getMonth(), 1)
    : new Date(now.getFullYear(), now.getMonth() - definition.months, now.getDate())
  return { startDate: isoDate(start), endDate: isoDate(now) }
}

/** The exact amount, as on an invoice. */
const pkr = (cents: number) => formatPKR(cents / 100)
/** A headline amount short enough for a card ("Rs 61.83M"); the exact one is always shown beside it. */
const pkrCompact = (cents: number) => formatPKR(cents / 100, { notation: "compact", maximumFractionDigits: 2 })

/** A percentage that never shows a non-zero share as 0.0%. */
function percentLabel(value: number | null): string {
  if (value === null) return "—"
  if (value > 0 && value < 0.1) return "<0.1%"
  return `${value.toFixed(1)}%`
}

function shareOf(part: number, whole: number): number {
  return whole > 0 ? Math.min(100, (part / whole) * 100) : 0
}

const orderCount = (count: number) => `${count.toLocaleString("en-PK")} order${count === 1 ? "" : "s"}`

type Tone = "emerald" | "amber" | "sky" | "rose" | "indigo"

const TONES: Record<Tone, { card: string; accent: string; icon: string; bar: string; text: string }> = {
  emerald: {
    card: "from-emerald-50/90 via-white to-white dark:from-emerald-950/40 dark:via-slate-900 dark:to-slate-900",
    accent: "bg-emerald-500",
    icon: "bg-emerald-500/10 text-emerald-600 ring-emerald-500/20 dark:text-emerald-300",
    bar: "bg-emerald-500",
    text: "text-emerald-700 dark:text-emerald-300",
  },
  amber: {
    card: "from-amber-50/90 via-white to-white dark:from-amber-950/40 dark:via-slate-900 dark:to-slate-900",
    accent: "bg-amber-500",
    icon: "bg-amber-500/10 text-amber-600 ring-amber-500/20 dark:text-amber-300",
    bar: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
  },
  sky: {
    card: "from-sky-50/90 via-white to-white dark:from-sky-950/40 dark:via-slate-900 dark:to-slate-900",
    accent: "bg-sky-500",
    icon: "bg-sky-500/10 text-sky-600 ring-sky-500/20 dark:text-sky-300",
    bar: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-300",
  },
  rose: {
    card: "from-rose-50/90 via-white to-white dark:from-rose-950/40 dark:via-slate-900 dark:to-slate-900",
    accent: "bg-rose-500",
    icon: "bg-rose-500/10 text-rose-600 ring-rose-500/20 dark:text-rose-300",
    bar: "bg-rose-500",
    text: "text-rose-700 dark:text-rose-300",
  },
  indigo: {
    card: "from-indigo-50/90 via-white to-white dark:from-indigo-950/40 dark:via-slate-900 dark:to-slate-900",
    accent: "bg-indigo-500",
    icon: "bg-indigo-500/10 text-indigo-600 ring-indigo-500/20 dark:text-indigo-300",
    bar: "bg-indigo-500",
    text: "text-indigo-700 dark:text-indigo-300",
  },
}

/** Age buckets run from calm to alarming. */
const AGING_BAR: Record<PaymentAgingBucketKey, string> = {
  "0-30": "bg-emerald-500",
  "31-60": "bg-amber-400",
  "61-90": "bg-orange-500",
  "90+": "bg-rose-500",
}

function Meter({ value, className, label }: Readonly<{ value: number; className: string; label: string }>) {
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-slate-200/70 dark:bg-slate-800"
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(value)}
    >
      <div className={cn("h-full rounded-full transition-[width] duration-500", className)} style={{ width: `${value}%` }} />
    </div>
  )
}

function KpiCard({ title, tone, icon: Icon, headline, exact, children, loading }: Readonly<{
  title: string
  tone: Tone
  icon: typeof Banknote
  headline: string
  /** The exact figure behind a shortened headline. */
  exact?: string
  children?: ReactNode
  loading: boolean
}>) {
  const style = TONES[tone]
  return (
    <div
      className={cn(
        "group relative flex min-w-0 flex-col overflow-hidden rounded-2xl border border-slate-200/80 bg-gradient-to-br p-5 shadow-sm transition-all duration-200 hover:-translate-y-0.5 hover:shadow-md dark:border-slate-800",
        style.card,
      )}
    >
      <span className={cn("absolute inset-x-0 top-0 h-1", style.accent)} aria-hidden="true" />
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 text-sm font-medium leading-snug text-slate-600 dark:text-slate-300">{title}</p>
        <span className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ring-1", style.icon)}>
          <Icon className="h-4 w-4" aria-hidden="true" />
        </span>
      </div>
      {loading ? (
        <div className="mt-4 space-y-2" aria-label="Loading">
          <div className="h-8 w-3/4 animate-pulse rounded-lg bg-slate-200/70 dark:bg-slate-800" />
          <div className="h-3 w-1/2 animate-pulse rounded bg-slate-200/70 dark:bg-slate-800" />
        </div>
      ) : (
        <>
          <p
            className="mt-3 truncate text-[1.65rem] font-bold leading-tight tracking-tight tabular-nums text-slate-900 dark:text-white"
            title={exact ?? headline}
          >
            {headline}
          </p>
          {exact && (
            <p className="truncate text-xs tabular-nums text-slate-500 dark:text-slate-400" title={exact}>{exact}</p>
          )}
          <div className="mt-auto space-y-2 pt-4 text-xs text-slate-500 dark:text-slate-400">{children}</div>
        </>
      )}
    </div>
  )
}

function FigureCard({ title, figure, tone, icon, note, share, shareLabel, loading }: Readonly<{
  title: string
  figure: PaymentFigure | null
  tone: Tone
  icon: typeof Banknote
  note?: string
  /** Share of the unpaid total, 0–100, drawn as a meter. */
  share?: number
  shareLabel?: string
  loading: boolean
}>) {
  return (
    <KpiCard
      title={title}
      tone={tone}
      icon={icon}
      loading={loading || !figure}
      headline={figure ? pkrCompact(figure.amountCents) : ""}
      exact={figure ? pkr(figure.amountCents) : undefined}
    >
      {figure && (
        <>
          {share !== undefined && <Meter value={share} className={TONES[tone].bar} label={shareLabel ?? title} />}
          <p className="flex flex-wrap items-center gap-x-1.5">
            <span className={cn("font-semibold", TONES[tone].text)}>{orderCount(figure.count)}</span>
            {note && <span>· {note}</span>}
          </p>
        </>
      )}
    </KpiCard>
  )
}

function Panel({ title, description, children, className }: Readonly<{
  title: string
  description: string
  children: ReactNode
  className?: string
}>) {
  return (
    <section className={cn("min-w-0 rounded-2xl border border-slate-200/80 bg-white p-6 shadow-sm dark:border-slate-800 dark:bg-slate-900", className)}>
      <header className="mb-5">
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">{title}</h2>
        <p className="mt-0.5 text-sm text-slate-500 dark:text-slate-400">{description}</p>
      </header>
      {children}
    </section>
  )
}

/**
 * The payment KPIs page (plans/OF-FINANCE-finance-role.md): paid and unpaid
 * orders, collection rate, aging of what is owed, and a breakdown per
 * organization. Every figure comes from `GET /api/v1/finance/payment-kpis`,
 * which fences Finance to its assigned organizations.
 */
export function PaymentKpisDashboard() {
  const [organizationIds, setOrganizationIds] = useState<number[]>([])
  const [period, setPeriod] = useState<PeriodValue>("all")

  const { data: organizationsData } = useSWR<{ items?: Array<{ id: number; name: string; code?: string | null }> }>(
    "/api/v1/organizations",
    fetcher,
  )
  const organizationOptions = useMemo(
    () => (organizationsData?.items ?? [])
      .map((organization) => ({ id: organization.id, label: organization.name, keywords: organization.code ?? null }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    [organizationsData?.items],
  )

  const query = useMemo(() => {
    const params = new URLSearchParams()
    if (organizationIds.length > 0) params.set("organizationIds", [...organizationIds].sort((a, b) => a - b).join(","))
    const range = periodRange(period)
    if (range) {
      params.set("startDate", range.startDate)
      params.set("endDate", range.endDate)
    }
    return params.toString()
  }, [organizationIds, period])

  const { data, error, isLoading, isValidating, mutate } = useSWR<PaymentKpis>(
    `/api/v1/finance/payment-kpis${query ? `?${query}` : ""}`,
    fetcher,
    { keepPreviousData: true },
  )
  const kpis = isLoading && !data ? null : data ?? null
  const loading = kpis === null
  const unpaidCents = kpis?.unpaid.amountCents ?? 0

  return (
    <main className="space-y-6 p-1 md:p-4">
      {/* Header */}
      <section className="relative overflow-hidden rounded-3xl border border-slate-200/80 bg-gradient-to-br from-indigo-50 via-white to-emerald-50 p-6 shadow-sm dark:border-slate-800 dark:from-indigo-950/50 dark:via-slate-900 dark:to-emerald-950/30 md:p-8">
        <div className="pointer-events-none absolute -right-16 -top-16 h-56 w-56 rounded-full bg-emerald-300/20 blur-3xl dark:bg-emerald-500/10" aria-hidden="true" />
        <div className="pointer-events-none absolute -bottom-20 left-1/3 h-56 w-56 rounded-full bg-indigo-300/20 blur-3xl dark:bg-indigo-500/10" aria-hidden="true" />
        <div className="relative flex flex-col gap-6 xl:flex-row xl:items-end xl:justify-between">
          <div className="flex items-start gap-4">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg shadow-emerald-500/25">
              <Banknote className="h-6 w-6" aria-hidden="true" />
            </span>
            <div>
              <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white md:text-3xl">Payments</h1>
              <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">
                Approved and fulfilled orders by payment status, net of refunds.
              </p>
            </div>
          </div>
          <div className="grid w-full gap-3 sm:grid-cols-[minmax(0,1fr)_11rem_auto] xl:w-auto xl:min-w-[36rem]">
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="payment-kpi-organizations" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Organizations
              </Label>
              <div className="rounded-lg bg-white shadow-sm dark:bg-slate-900">
                <OrganizationMultiSelect
                  id="payment-kpi-organizations"
                  options={organizationOptions}
                  value={organizationIds}
                  onChange={setOrganizationIds}
                  placeholder="All organizations"
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="payment-kpi-period" className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">
                Order date
              </Label>
              <Select value={period} onValueChange={(value) => setPeriod(value as PeriodValue)}>
                <SelectTrigger id="payment-kpi-period" className="bg-white shadow-sm dark:bg-slate-900">
                  <CalendarRange className="mr-2 h-4 w-4 text-slate-400" aria-hidden="true" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIODS.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <Button
              type="button"
              variant="outline"
              className="gap-2 self-end bg-white shadow-sm dark:bg-slate-900"
              onClick={() => mutate()}
              disabled={isValidating}
            >
              <RefreshCw className={cn("h-4 w-4", isValidating && "animate-spin")} aria-hidden="true" />
              Refresh
            </Button>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300" role="alert">
          {error instanceof Error && error.message ? error.message : "Payment figures could not be loaded."}
        </div>
      )}

      {/* KPIs */}
      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5" aria-label="Payment figures">
        <FigureCard title="Paid" figure={kpis?.paid ?? null} tone="emerald" icon={CheckCircle2} loading={loading} />
        <FigureCard title="Unpaid" figure={kpis?.unpaid ?? null} tone="amber" icon={Clock} loading={loading} />
        <FigureCard
          title="Unpaid, delivered"
          figure={kpis?.unpaidDelivered ?? null}
          tone="sky"
          icon={Truck}
          note="with the customer"
          share={kpis ? shareOf(kpis.unpaidDelivered.amountCents, unpaidCents) : undefined}
          shareLabel="Share of the unpaid amount already delivered"
          loading={loading}
        />
        <FigureCard
          title={`Overdue · over ${PAYMENT_OVERDUE_AFTER_DAYS} days`}
          figure={kpis?.overdue ?? null}
          tone="rose"
          icon={AlertTriangle}
          note="since approval"
          share={kpis ? shareOf(kpis.overdue.amountCents, unpaidCents) : undefined}
          shareLabel="Share of the unpaid amount that is overdue"
          loading={loading}
        />
        <KpiCard
          title="Collection rate"
          tone="indigo"
          icon={Percent}
          loading={loading}
          headline={percentLabel(kpis?.collectionRatePct ?? null)}
        >
          {kpis && (
            <>
              <Meter value={kpis.collectionRatePct ?? 0} className={TONES.indigo.bar} label="Collection rate" />
              <p>of the amount billed is paid</p>
            </>
          )}
        </KpiCard>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        {/* Aging */}
        <Panel title="Unpaid by age" description="Days since the order was approved.">
          <div className="space-y-5">
            {(kpis?.aging ?? []).map((row) => {
              const share = shareOf(row.amountCents, unpaidCents)
              return (
                <div key={row.bucket} className="space-y-2">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="flex items-center gap-2 text-sm font-medium text-slate-800 dark:text-slate-200">
                      <span className={cn("h-2.5 w-2.5 rounded-full", AGING_BAR[row.bucket])} aria-hidden="true" />
                      {row.label}
                    </span>
                    <span className="min-w-0 truncate text-right text-sm tabular-nums text-slate-500 dark:text-slate-400" title={pkr(row.amountCents)}>
                      <span className="font-semibold text-slate-800 dark:text-slate-200">{pkrCompact(row.amountCents)}</span>
                      {" · "}{orderCount(row.count)}
                    </span>
                  </div>
                  <Meter value={share} className={AGING_BAR[row.bucket]} label={`${row.label}: share of the unpaid amount`} />
                </div>
              )
            })}
            {!kpis && (
              <div className="space-y-4" aria-label="Loading">
                {[0, 1, 2, 3].map((key) => <div key={key} className="h-8 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" />)}
              </div>
            )}
          </div>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            <Button asChild variant="outline" size="sm" className="justify-between gap-2">
              <Link href="/orders?status=approved&paymentStatus=UNPAID">
                Unpaid approved
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="sm" className="justify-between gap-2">
              <Link href="/orders?status=fulfilled&paymentStatus=UNPAID">
                Unpaid fulfilled
                <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
            </Button>
          </div>
        </Panel>

        {/* By organization */}
        <Panel title="By organization" description="Most outstanding first. Hover an amount for the exact figure.">
          <div className="-mx-2 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-slate-200 hover:bg-transparent dark:border-slate-800">
                  <TableHead className="text-xs font-semibold uppercase tracking-wide">Organization</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide">Paid</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide">Unpaid</TableHead>
                  <TableHead className="text-right text-xs font-semibold uppercase tracking-wide">Unpaid, delivered</TableHead>
                  <TableHead className="w-40 text-xs font-semibold uppercase tracking-wide">Collected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(kpis?.organizations ?? []).map((row) => (
                  <TableRow key={row.organizationId} className="border-slate-100 dark:border-slate-800">
                    <TableCell>
                      <div className="flex items-center gap-3">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-300" aria-hidden="true">
                          {row.organizationName.trim().charAt(0).toUpperCase()}
                        </span>
                        <span className="font-medium text-slate-900 dark:text-white">{row.organizationName}</span>
                      </div>
                    </TableCell>
                    {([
                      [row.paid, "text-emerald-700 dark:text-emerald-300"],
                      [row.unpaid, "text-amber-700 dark:text-amber-300"],
                      [row.unpaidDelivered, "text-sky-700 dark:text-sky-300"],
                    ] as const).map(([figure, color], index) => (
                      <TableCell key={index} className="whitespace-nowrap text-right tabular-nums">
                        <span className={cn("font-semibold", figure.amountCents > 0 ? color : "text-slate-400")} title={pkr(figure.amountCents)}>
                          {pkrCompact(figure.amountCents)}
                        </span>
                        <span className="block text-xs text-slate-500 dark:text-slate-400">{orderCount(figure.count)}</span>
                      </TableCell>
                    ))}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Meter value={row.collectionRatePct ?? 0} className="bg-indigo-500" label={`${row.organizationName}: collected`} />
                        <span className="w-12 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-700 dark:text-slate-300">
                          {percentLabel(row.collectionRatePct)}
                        </span>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
                {kpis && kpis.organizations.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="py-10 text-center text-sm text-slate-500">
                      No approved orders in this selection.
                    </TableCell>
                  </TableRow>
                )}
                {!kpis && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5}>
                      <div className="h-24 animate-pulse rounded-lg bg-slate-100 dark:bg-slate-800" aria-label="Loading" />
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </Panel>
      </section>
    </main>
  )
}
