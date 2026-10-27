"use client"

import { useMemo, useState } from "react"
import Link from "next/link"
import useSWR from "swr"
import { AlertTriangle, Banknote, CheckCircle2, Clock, Percent, RefreshCw, Truck } from "lucide-react"

import { OrganizationMultiSelect } from "@/components/finance/organization-multi-select"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { PAYMENT_OVERDUE_AFTER_DAYS, type PaymentFigure, type PaymentKpis } from "@/lib/finance-payment-kpis"
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

const pkr = (cents: number) => formatPKR(cents / 100)

function FigureCard({ title, figure, icon: Icon, tone, note }: Readonly<{
  title: string
  figure: PaymentFigure | null
  icon: typeof Banknote
  tone: "emerald" | "amber" | "rose" | "sky"
  note?: string
}>) {
  const tones = {
    emerald: "text-emerald-700 bg-emerald-50 dark:bg-emerald-950/40 dark:text-emerald-300",
    amber: "text-amber-700 bg-amber-50 dark:bg-amber-950/40 dark:text-amber-300",
    rose: "text-rose-700 bg-rose-50 dark:bg-rose-950/40 dark:text-rose-300",
    sky: "text-sky-700 bg-sky-50 dark:bg-sky-950/40 dark:text-sky-300",
  }
  return (
    <Card className="rounded-2xl">
      <CardContent className="space-y-2 p-5">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          <span className={cn("flex h-8 w-8 items-center justify-center rounded-lg", tones[tone])}>
            <Icon className="h-4 w-4" aria-hidden="true" />
          </span>
        </div>
        {figure ? (
          <>
            <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">{pkr(figure.amountCents)}</p>
            <p className="text-xs text-muted-foreground">
              {figure.count} order{figure.count === 1 ? "" : "s"}{note ? ` · ${note}` : ""}
            </p>
          </>
        ) : (
          <div className="h-12 animate-pulse rounded bg-slate-100 dark:bg-slate-800" aria-label="Loading" />
        )}
      </CardContent>
    </Card>
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

  const { data, error, isLoading, mutate } = useSWR<PaymentKpis>(
    `/api/v1/finance/payment-kpis${query ? `?${query}` : ""}`,
    fetcher,
    { keepPreviousData: true },
  )
  const kpis = isLoading && !data ? null : data ?? null
  const maxAging = Math.max(1, ...(kpis?.aging ?? []).map((row) => row.amountCents))

  return (
    <main className="space-y-6 p-1 md:p-4">
      <section className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight text-slate-900 dark:text-white md:text-3xl">
            <span className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
              <Banknote className="h-5 w-5" aria-hidden="true" />
            </span>
            Payments
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Approved and fulfilled orders by payment status, net of refunds.
          </p>
        </div>
        <div className="grid w-full gap-3 sm:grid-cols-[minmax(0,18rem)_10rem_auto] md:w-auto">
          <div className="space-y-1">
            <Label htmlFor="payment-kpi-organizations" className="text-xs">Organizations</Label>
            <OrganizationMultiSelect
              id="payment-kpi-organizations"
              options={organizationOptions}
              value={organizationIds}
              onChange={setOrganizationIds}
              placeholder="All organizations"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="payment-kpi-period" className="text-xs">Order date</Label>
            <Select value={period} onValueChange={(value) => setPeriod(value as PeriodValue)}>
              <SelectTrigger id="payment-kpi-period"><SelectValue /></SelectTrigger>
              <SelectContent>
                {PERIODS.map((entry) => <SelectItem key={entry.value} value={entry.value}>{entry.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <Button type="button" variant="outline" className="self-end gap-2" onClick={() => mutate()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Refresh
          </Button>
        </div>
      </section>

      {error && (
        <Card className="border-destructive/40">
          <CardContent className="p-5 text-sm text-destructive" role="alert">
            {error instanceof Error && error.message ? error.message : "Payment figures could not be loaded."}
          </CardContent>
        </Card>
      )}

      <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5" aria-label="Payment figures">
        <FigureCard title="Paid" figure={kpis?.paid ?? null} icon={CheckCircle2} tone="emerald" />
        <FigureCard title="Unpaid" figure={kpis?.unpaid ?? null} icon={Clock} tone="amber" />
        <FigureCard title="Unpaid, delivered" figure={kpis?.unpaidDelivered ?? null} icon={Truck} tone="sky" note="goods with the customer" />
        <FigureCard title={`Overdue (over ${PAYMENT_OVERDUE_AFTER_DAYS} days)`} figure={kpis?.overdue ?? null} icon={AlertTriangle} tone="rose" note="since approval" />
        <Card className="rounded-2xl">
          <CardContent className="space-y-2 p-5">
            <div className="flex items-center justify-between">
              <p className="text-sm font-medium text-muted-foreground">Collection rate</p>
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-indigo-700 dark:bg-indigo-950/40 dark:text-indigo-300">
                <Percent className="h-4 w-4" aria-hidden="true" />
              </span>
            </div>
            {kpis ? (
              <>
                <p className="text-2xl font-semibold tabular-nums text-slate-900 dark:text-white">
                  {kpis.collectionRatePct === null ? "—" : `${kpis.collectionRatePct.toFixed(1)}%`}
                </p>
                <p className="text-xs text-muted-foreground">of the amount billed is paid</p>
              </>
            ) : (
              <div className="h-12 animate-pulse rounded bg-slate-100 dark:bg-slate-800" aria-label="Loading" />
            )}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card className="rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">Unpaid by age</CardTitle>
            <CardDescription>Days since the order was approved.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {(kpis?.aging ?? []).map((row) => (
              <div key={row.bucket} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="font-medium">{row.label}</span>
                  <span className="tabular-nums text-muted-foreground">{pkr(row.amountCents)} · {row.count}</span>
                </div>
                <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800" aria-hidden="true">
                  <div
                    className={cn("h-2 rounded-full", row.bucket === "0-30" ? "bg-amber-400" : "bg-rose-500")}
                    style={{ width: `${Math.round((row.amountCents / maxAging) * 100)}%` }}
                  />
                </div>
              </div>
            ))}
            {!kpis && <div className="h-32 animate-pulse rounded bg-slate-100 dark:bg-slate-800" aria-label="Loading" />}
            <div className="flex flex-wrap gap-2 pt-2">
              <Button asChild variant="outline" size="sm">
                <Link href="/orders?status=approved&paymentStatus=UNPAID">Unpaid approved orders</Link>
              </Button>
              <Button asChild variant="outline" size="sm">
                <Link href="/orders?status=fulfilled&paymentStatus=UNPAID">Unpaid fulfilled orders</Link>
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card className="min-w-0 rounded-2xl">
          <CardHeader>
            <CardTitle className="text-base">By organization</CardTitle>
            <CardDescription>Most outstanding first.</CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Organization</TableHead>
                  <TableHead className="text-right">Paid</TableHead>
                  <TableHead className="text-right">Unpaid</TableHead>
                  <TableHead className="text-right">Unpaid, delivered</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(kpis?.organizations ?? []).map((row) => (
                  <TableRow key={row.organizationId}>
                    <TableCell className="font-medium">{row.organizationName}</TableCell>
                    <TableCell className="text-right tabular-nums">{pkr(row.paid.amountCents)}<span className="block text-xs text-muted-foreground">{row.paid.count} orders</span></TableCell>
                    <TableCell className="text-right tabular-nums">{pkr(row.unpaid.amountCents)}<span className="block text-xs text-muted-foreground">{row.unpaid.count} orders</span></TableCell>
                    <TableCell className="text-right tabular-nums">{pkr(row.unpaidDelivered.amountCents)}<span className="block text-xs text-muted-foreground">{row.unpaidDelivered.count} orders</span></TableCell>
                    <TableCell className="text-right tabular-nums">{row.collectionRatePct === null ? "—" : `${row.collectionRatePct.toFixed(1)}%`}</TableCell>
                  </TableRow>
                ))}
                {kpis && kpis.organizations.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      No approved orders in this selection.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </main>
  )
}
