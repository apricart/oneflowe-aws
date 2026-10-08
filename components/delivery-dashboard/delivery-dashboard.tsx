"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { AlertTriangle, CheckCircle2, Clock, Loader2, PackageCheck, RefreshCw, Timer, Truck } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { fetcher } from "@/lib/fetcher"
import { cn } from "@/lib/utils"
import type { DeliveryDashboardResponse, DeliveryListRow } from "@/lib/delivery-dashboard"
import type { DeliveryGroupRow, DeliveryListView } from "@/lib/delivery-sla"

/**
 * The management delivery dashboard. Rendered for Apricart Executive at
 * `/executive` and for Super Admin at `/delivery-dashboard`; both read the same
 * two endpoints, which decide who may read and what is returned. Presentation
 * only: every figure here — health, deadlines, counts — comes from the server,
 * which computes it once through `lib/delivery-sla.ts`.
 */

const ALL = "all"

type Filters = {
  organizationId: string
  region: string
  city: string
  branchId: string
  fulfillmentStatus: string
  deliveredFrom: string
  deliveredTo: string
}

const EMPTY_FILTERS: Filters = {
  organizationId: ALL,
  region: ALL,
  city: ALL,
  branchId: ALL,
  fulfillmentStatus: ALL,
  deliveredFrom: "",
  deliveredTo: "",
}

const HEALTH_STYLES: Record<string, string> = {
  OVERDUE: "bg-rose-100 text-rose-800 dark:bg-rose-950/50 dark:text-rose-300",
  DUE_SOON: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-300",
  ON_TRACK: "bg-sky-100 text-sky-800 dark:bg-sky-950/50 dark:text-sky-300",
  DELIVERED_ON_TIME: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300",
  DELIVERED_LATE: "bg-orange-100 text-orange-800 dark:bg-orange-950/50 dark:text-orange-300",
  DELIVERED_UNTIMED: "bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300",
}

const DASHBOARD_ENDPOINT = "/api/v1/delivery-dashboard"
const dashboardTimelineEndpoint = (orderId: number) => `/api/v1/delivery-dashboard/orders/${orderId}/timeline`

function buildQuery(filters: Filters, view: DeliveryListView, base: string): string {
  const params = new URLSearchParams()
  if (filters.organizationId !== ALL) params.set("organizationId", filters.organizationId)
  if (filters.organizationId !== ALL && filters.branchId !== ALL) params.set("branchId", filters.branchId)
  if (filters.region !== ALL) params.set("region", filters.region)
  if (filters.city !== ALL) params.set("city", filters.city)
  if (filters.fulfillmentStatus !== ALL) params.set("fulfillmentStatus", filters.fulfillmentStatus)
  if (filters.deliveredFrom) params.set("deliveredFrom", filters.deliveredFrom)
  if (filters.deliveredTo) params.set("deliveredTo", filters.deliveredTo)
  if (view !== "ALL") params.set("view", view)
  const query = params.toString()
  return `${base}${query ? `?${query}` : ""}`
}

function formatHours(hours: number | null | undefined): string {
  if (hours === null || hours === undefined) return "—"
  if (hours < 1) return `${Math.round(hours * 60)} min`
  return `${hours.toLocaleString(undefined, { maximumFractionDigits: 1 })} hrs`
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? "—" : format(date, "dd MMM, HH:mm")
}

/** "27 hrs overdue" / "5 hrs left" / "Delivered in 40 hrs". */
function delayText(row: Pick<DeliveryListRow, "hoursOverdue" | "hoursRemaining" | "deliveryHours" | "health">): string {
  if (row.health === "OVERDUE") return `${formatHours(row.hoursOverdue)} overdue`
  if (row.health === "DUE_SOON" || row.health === "ON_TRACK") return `${formatHours(row.hoursRemaining)} left`
  if (row.health === "DELIVERED_LATE") return `${formatHours(row.hoursOverdue)} late`
  if (row.deliveryHours !== null) return `Delivered in ${formatHours(row.deliveryHours)}`
  return "Delivered"
}

/**
 * The endpoints default to management's; the warehouse passes its own, which
 * answer the same query string with the same shape, fenced to its branches.
 */
export function DeliveryDashboard({
  dashboardEndpoint = DASHBOARD_ENDPOINT,
  timelineEndpoint = dashboardTimelineEndpoint,
}: Readonly<{
  dashboardEndpoint?: string
  timelineEndpoint?: (orderId: number) => string
}> = {}) {
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS)
  const [view, setView] = useState<DeliveryListView>("ALL")
  const [timelineOrder, setTimelineOrder] = useState<DeliveryListRow | null>(null)
  const endpoint = useMemo(() => buildQuery(filters, view, dashboardEndpoint), [filters, view, dashboardEndpoint])

  const { data, error, isLoading, isValidating, mutate } = useSWR<DeliveryDashboardResponse>(
    endpoint,
    fetcher,
    { keepPreviousData: true, refreshInterval: 5 * 60 * 1000 },
  )

  const update = (patch: Partial<Filters>) => setFilters((current) => ({ ...current, ...patch }))

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold text-slate-900 dark:text-white">Delivery management</h2>
          <p className="text-sm text-muted-foreground">
            {data
              ? `${data.sla.hours}-hour delivery target from approval · due soon in the last ${data.sla.dueSoonHours} hours · orders approved from ${data.sla.countsOrdersApprovedFrom}`
              : "Approved orders against the delivery target"}
          </p>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => { void mutate() }} disabled={isValidating}>
          <RefreshCw className={cn("mr-2 h-4 w-4", isValidating && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <FilterBar filters={filters} data={data} onChange={update} onReset={() => setFilters(EMPTY_FILTERS)} />

      {error && (
        <Card role="alert" className="border-rose-200 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20">
          <CardContent className="p-5 text-sm">
            {(error as Error)?.message || "The delivery dashboard could not be loaded. Please try again."}
          </CardContent>
        </Card>
      )}

      {isLoading && !data && (
        <div className="flex items-center gap-2 p-8 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading delivery figures…
        </div>
      )}

      {data && (
        <>
          {data.truncated && (
            <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              More orders match than one view can read. Narrow the filters for exact figures.
            </p>
          )}

          <KpiCards data={data} view={view} onSelect={setView} />
          <AlertStrip data={data} onSelect={setView} />

          <OrdersCard
            data={data}
            view={view}
            onViewChange={setView}
            onOpen={setTimelineOrder}
          />

          <div className="grid gap-6 lg:grid-cols-2">
            <PipelineCard data={data} />
            <OverdueAgeCard data={data} />
          </div>

          <BreakdownCard
            data={data}
            onCity={(label) => update({ city: label })}
            onRegion={(key) => update({ region: key })}
            onOrganization={(key) => update({ organizationId: key, branchId: ALL })}
          />
        </>
      )}

      <TimelineSheet order={timelineOrder} timelineEndpoint={timelineEndpoint} onClose={() => setTimelineOrder(null)} />
    </div>
  )
}

function FilterBar({
  filters,
  data,
  onChange,
  onReset,
}: Readonly<{
  filters: Filters
  data: DeliveryDashboardResponse | undefined
  onChange: (patch: Partial<Filters>) => void
  onReset: () => void
}>) {
  const options = data?.options
  return (
    <Card>
      <CardContent className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7">
        <FilterSelect
          id="delivery-filter-organization"
          label="Client"
          value={filters.organizationId}
          onChange={(value) => onChange({ organizationId: value, branchId: ALL })}
          options={(options?.organizations ?? []).map((org) => ({ value: String(org.id), label: org.name }))}
          allLabel="All clients"
        />
        <FilterSelect
          id="delivery-filter-region"
          label="Region"
          value={filters.region}
          onChange={(value) => onChange({ region: value })}
          options={options?.regions ?? []}
          allLabel="All regions"
        />
        <FilterSelect
          id="delivery-filter-city"
          label="City"
          value={filters.city}
          onChange={(value) => onChange({ city: value })}
          options={(options?.cities ?? []).map((city) => ({ value: city, label: city }))}
          allLabel="All cities"
        />
        <FilterSelect
          id="delivery-filter-branch"
          label="Branch"
          value={filters.branchId}
          onChange={(value) => onChange({ branchId: value })}
          options={(options?.branches ?? []).map((branch) => ({ value: String(branch.id), label: branch.name }))}
          allLabel={filters.organizationId === ALL ? "Choose a client first" : "All branches"}
          disabled={filters.organizationId === ALL}
        />
        <FilterSelect
          id="delivery-filter-stage"
          label="Stage"
          value={filters.fulfillmentStatus}
          onChange={(value) => onChange({ fulfillmentStatus: value })}
          options={options?.stages ?? []}
          allLabel="All stages"
        />
        <div className="space-y-1">
          <Label htmlFor="delivery-filter-from" className="text-xs">Delivered from</Label>
          <Input
            id="delivery-filter-from"
            type="date"
            value={filters.deliveredFrom || data?.filters.deliveredFrom || ""}
            onChange={(event) => onChange({ deliveredFrom: event.target.value })}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="delivery-filter-to" className="text-xs">Delivered to</Label>
          <div className="flex gap-2">
            <Input
              id="delivery-filter-to"
              type="date"
              value={filters.deliveredTo || data?.filters.deliveredTo || ""}
              onChange={(event) => onChange({ deliveredTo: event.target.value })}
            />
            <Button type="button" variant="ghost" size="sm" onClick={onReset}>Reset</Button>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  allLabel,
  disabled,
}: Readonly<{
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  options: ReadonlyArray<{ value: string; label: string }>
  allLabel: string
  disabled?: boolean
}>) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">{label}</Label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id}>
          <SelectValue placeholder={allLabel} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function KpiCards({
  data,
  view,
  onSelect,
}: Readonly<{ data: DeliveryDashboardResponse; view: DeliveryListView; onSelect: (view: DeliveryListView) => void }>) {
  const { kpis } = data
  const cards: Array<{ view: DeliveryListView; label: string; value: string; icon: typeof Clock; tone: string; hint?: string }> = [
    { view: "OPEN", label: "Open orders", value: String(kpis.open), icon: Truck, tone: "text-slate-900 dark:text-white" },
    { view: "ON_TRACK", label: "On track", value: String(kpis.onTrack), icon: CheckCircle2, tone: "text-sky-700 dark:text-sky-300" },
    { view: "DUE_SOON", label: "Due soon", value: String(kpis.dueSoon), icon: Clock, tone: "text-amber-700 dark:text-amber-300" },
    { view: "OVERDUE", label: "Overdue", value: String(kpis.overdue), icon: AlertTriangle, tone: "text-rose-700 dark:text-rose-300" },
    { view: "DELIVERED_TODAY", label: "Delivered today", value: String(kpis.deliveredToday), icon: PackageCheck, tone: "text-emerald-700 dark:text-emerald-300" },
    {
      view: "DELIVERED",
      label: "Avg approval → delivery",
      value: formatHours(kpis.averageDeliveryHours),
      icon: Timer,
      tone: "text-slate-900 dark:text-white",
      hint: kpis.onTimeRate === null ? "No timed deliveries in range" : `${kpis.onTimeRate}% on time · ${kpis.delivered} delivered in range`,
    },
  ]
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
      {cards.map((card) => {
        const active = view === card.view
        const overdue = card.view === "OVERDUE" && kpis.overdue > 0
        return (
          <button
            key={card.view}
            type="button"
            onClick={() => onSelect(active ? "ALL" : card.view)}
            aria-pressed={active}
            className={cn(
              "rounded-2xl border bg-white p-4 text-left shadow-sm transition hover:border-indigo-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 dark:bg-slate-900",
              active && "border-indigo-500 ring-1 ring-indigo-500",
              overdue && "border-rose-300 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30",
            )}
          >
            <div className="flex items-center justify-between text-xs font-medium text-muted-foreground">
              {card.label}
              <card.icon className={cn("h-4 w-4", card.tone)} aria-hidden="true" />
            </div>
            <p className={cn("mt-2 text-2xl font-semibold", card.tone, overdue && "text-3xl")}>{card.value}</p>
            {card.hint && <p className="mt-1 text-[11px] text-muted-foreground">{card.hint}</p>}
          </button>
        )
      })}
    </div>
  )
}

function AlertStrip({
  data,
  onSelect,
}: Readonly<{ data: DeliveryDashboardResponse; onSelect: (view: DeliveryListView) => void }>) {
  const { alerts } = data
  if (alerts.overdue === 0 && alerts.dueSoon === 0) return null
  return (
    <div className="flex flex-wrap gap-2" role="status">
      {alerts.overdue > 0 && (
        <button type="button" onClick={() => onSelect("OVERDUE")} className="rounded-full bg-rose-600 px-3 py-1 text-xs font-semibold text-white">
          {alerts.overdue} overdue
          {alerts.overdueOver24Hours > 0 ? ` · ${alerts.overdueOver24Hours} by more than 24 hrs` : ""}
          {alerts.overdueOver72Hours > 0 ? ` · ${alerts.overdueOver72Hours} by more than 72 hrs` : ""}
        </button>
      )}
      {alerts.dueSoon > 0 && (
        <button type="button" onClick={() => onSelect("DUE_SOON")} className="rounded-full bg-amber-500 px-3 py-1 text-xs font-semibold text-white">
          {alerts.dueSoon} due within {data.sla.dueSoonHours} hrs
        </button>
      )}
    </div>
  )
}

const VIEW_LABELS: Record<DeliveryListView, string> = {
  ALL: "Needs attention first",
  OPEN: "Open",
  ON_TRACK: "On track",
  DUE_SOON: "Due soon",
  OVERDUE: "Overdue",
  DELIVERED: "Delivered",
  DELIVERED_LATE: "Delivered late",
  DELIVERED_TODAY: "Delivered today",
}

function OrdersCard({
  data,
  view,
  onViewChange,
  onOpen,
}: Readonly<{
  data: DeliveryDashboardResponse
  view: DeliveryListView
  onViewChange: (view: DeliveryListView) => void
  onOpen: (row: DeliveryListRow) => void
}>) {
  const { items, total } = data.orders
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="text-base">Orders requiring attention</CardTitle>
        <Select value={view} onValueChange={(value) => onViewChange(value as DeliveryListView)}>
          <SelectTrigger className="w-48" aria-label="Which orders to list">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(VIEW_LABELS) as DeliveryListView[]).map((key) => (
              <SelectItem key={key} value={key}>{VIEW_LABELS[key]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </CardHeader>
      <CardContent className="p-0">
        {items.length === 0 ? (
          <p className="p-6 text-center text-sm text-muted-foreground">No orders match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[56rem] text-sm">
              <thead>
                <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th scope="col" className="px-4 py-2 font-medium">Order</th>
                  <th scope="col" className="px-4 py-2 font-medium">Client</th>
                  <th scope="col" className="px-4 py-2 font-medium">Region</th>
                  <th scope="col" className="px-4 py-2 font-medium">City</th>
                  <th scope="col" className="px-4 py-2 font-medium">Branch</th>
                  <th scope="col" className="px-4 py-2 font-medium">Stage</th>
                  <th scope="col" className="px-4 py-2 font-medium">Approved</th>
                  <th scope="col" className="px-4 py-2 font-medium">Expected</th>
                  <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  <th scope="col" className="px-4 py-2 text-right font-medium">Delay</th>
                </tr>
              </thead>
              <tbody>
                {items.map((row) => (
                  <tr
                    key={row.id}
                    onClick={() => onOpen(row)}
                    className="cursor-pointer border-b last:border-0 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <td className="px-4 py-2">
                      <button
                        type="button"
                        onClick={(event) => { event.stopPropagation(); onOpen(row) }}
                        className="font-mono text-xs text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
                      >
                        {row.tid}
                      </button>
                    </td>
                    <td className="px-4 py-2">{row.organizationName}</td>
                    <td className="px-4 py-2">{row.region}</td>
                    <td className="px-4 py-2">{row.city}</td>
                    <td className="px-4 py-2">{row.branchName}</td>
                    <td className="px-4 py-2">{row.stageLabel}</td>
                    <td className="px-4 py-2 text-xs">{formatWhen(row.approvedAt)}</td>
                    <td className="px-4 py-2 text-xs">{formatWhen(row.promisedAt)}</td>
                    <td className="px-4 py-2">
                      <Badge variant="secondary" className={cn("rounded-full text-[10px] font-bold", HEALTH_STYLES[row.health])}>
                        {row.healthLabel}
                      </Badge>
                    </td>
                    <td className={cn("px-4 py-2 text-right text-xs font-semibold", row.health === "OVERDUE" && "text-rose-700 dark:text-rose-300")}>
                      {delayText(row)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {total > items.length && (
          <p className="border-t p-3 text-center text-xs text-muted-foreground">
            Showing the {items.length} most urgent of {total}. Narrow the filters to see the rest.
          </p>
        )}
      </CardContent>
    </Card>
  )
}

function PipelineCard({ data }: Readonly<{ data: DeliveryDashboardResponse }>) {
  const max = Math.max(1, ...data.pipeline.map((entry) => entry.count))
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Order pipeline (open orders)</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        {data.pipeline.map((entry) => (
          <div key={entry.stage} className="space-y-1">
            <div className="flex justify-between text-sm"><span>{entry.label}</span><span className="font-semibold">{entry.count}</span></div>
            <div className="h-2 rounded-full bg-slate-100 dark:bg-slate-800">
              <div className="h-2 rounded-full bg-indigo-500" style={{ width: `${(entry.count / max) * 100}%` }} />
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  )
}

function OverdueAgeCard({ data }: Readonly<{ data: DeliveryDashboardResponse }>) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">How late are overdue orders</CardTitle></CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <tbody>
            {data.overdueAge.map((bucket) => (
              <tr key={bucket.key} className="border-b last:border-0">
                <th scope="row" className="py-2 text-left font-normal">{bucket.label} overdue</th>
                <td className={cn("py-2 text-right font-semibold", bucket.count > 0 && "text-rose-700 dark:text-rose-300")}>{bucket.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </CardContent>
    </Card>
  )
}

function BreakdownCard({
  data,
  onCity,
  onRegion,
  onOrganization,
}: Readonly<{
  data: DeliveryDashboardResponse
  onCity: (label: string) => void
  onRegion: (key: string) => void
  onOrganization: (key: string) => void
}>) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Delivery performance</CardTitle></CardHeader>
      <CardContent>
        <Tabs defaultValue="city">
          <TabsList>
            <TabsTrigger value="city">By city</TabsTrigger>
            <TabsTrigger value="region">By region</TabsTrigger>
            <TabsTrigger value="client">By client</TabsTrigger>
            <TabsTrigger value="branch">By branch</TabsTrigger>
          </TabsList>
          <TabsContent value="city"><GroupTable rows={data.byCity} heading="City" onSelect={(row) => onCity(row.label)} /></TabsContent>
          <TabsContent value="region"><GroupTable rows={data.byRegion} heading="Region" onSelect={(row) => onRegion(row.key)} /></TabsContent>
          <TabsContent value="client"><GroupTable rows={data.byOrganization} heading="Client" onSelect={(row) => onOrganization(row.key)} /></TabsContent>
          <TabsContent value="branch"><GroupTable rows={data.byBranch} heading="Branch" /></TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  )
}

function GroupTable({
  rows,
  heading,
  onSelect,
}: Readonly<{ rows: DeliveryGroupRow[]; heading: string; onSelect?: (row: DeliveryGroupRow) => void }>) {
  if (rows.length === 0) return <p className="p-4 text-sm text-muted-foreground">No orders in this view.</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-sm">
        <thead>
          <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
            <th scope="col" className="py-2 font-medium">{heading}</th>
            <th scope="col" className="py-2 text-right font-medium">Open</th>
            <th scope="col" className="py-2 text-right font-medium">On track</th>
            <th scope="col" className="py-2 text-right font-medium">Due soon</th>
            <th scope="col" className="py-2 text-right font-medium">Overdue</th>
            <th scope="col" className="py-2 text-right font-medium">Delivered</th>
            <th scope="col" className="py-2 text-right font-medium">On time</th>
            <th scope="col" className="py-2 text-right font-medium">Avg delivery</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-b last:border-0">
              <th scope="row" className="py-2 text-left font-medium">
                {onSelect ? (
                  <button type="button" onClick={() => onSelect(row)} className="text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400">
                    {row.label}
                  </button>
                ) : row.label}
              </th>
              <td className="py-2 text-right">{row.open}</td>
              <td className="py-2 text-right">{row.onTrack}</td>
              <td className="py-2 text-right">{row.dueSoon}</td>
              <td className={cn("py-2 text-right", row.overdue > 0 && "font-semibold text-rose-700 dark:text-rose-300")}>{row.overdue}</td>
              <td className="py-2 text-right">{row.delivered}</td>
              <td className="py-2 text-right">{row.onTimeRate === null ? "—" : `${row.onTimeRate}%`}</td>
              <td className="py-2 text-right">{formatHours(row.averageDeliveryHours)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

type TimelineResponse = {
  order: { tid: string; organizationName: string; branchName: string; region: string; city: string; stageLabel: string }
  delivery: {
    health: string
    healthLabel: string
    approvedAt: string
    promisedAt: string
    deliveredAt: string | null
    hoursRemaining: number | null
    hoursOverdue: number | null
    deliveryHours: number | null
  }
  events: Array<{ key: string; label: string; at: string; by: string | null }>
}

function TimelineSheet({
  order,
  timelineEndpoint,
  onClose,
}: Readonly<{ order: DeliveryListRow | null; timelineEndpoint: (orderId: number) => string; onClose: () => void }>) {
  const { data, error, isLoading } = useSWR<TimelineResponse>(
    order ? timelineEndpoint(order.id) : null,
    fetcher,
  )
  return (
    <Sheet open={order !== null} onOpenChange={(open) => { if (!open) onClose() }}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Order {order?.tid}</SheetTitle>
          <SheetDescription>
            {order ? `${order.organizationName} · ${order.branchName} · ${order.city}` : "Delivery journey"}
          </SheetDescription>
        </SheetHeader>
        <div className="space-y-4 p-4">
          {isLoading && <p className="text-sm text-muted-foreground">Loading the timeline…</p>}
          {error && <p role="alert" className="text-sm text-rose-600">{(error as Error)?.message || "The timeline could not be loaded."}</p>}
          {data && (
            <>
              <div className="rounded-xl border p-3 text-sm">
                <Badge variant="secondary" className={cn("rounded-full text-[10px] font-bold", HEALTH_STYLES[data.delivery.health])}>
                  {data.delivery.healthLabel}
                </Badge>
                <p className="mt-2 font-semibold">{delayText({ ...data.delivery })}</p>
                <p className="text-xs text-muted-foreground">
                  Expected by {formatWhen(data.delivery.promisedAt)} · currently {data.order.stageLabel} · {data.order.region}
                </p>
              </div>
              <ol className="relative space-y-4 border-l border-slate-200 pl-4 dark:border-slate-800">
                {data.events.map((event) => (
                  <li key={event.key}>
                    <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full bg-indigo-500" aria-hidden="true" />
                    <p className="text-sm font-medium">{event.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {formatWhen(event.at)}{event.by ? ` · ${event.by}` : ""}
                    </p>
                  </li>
                ))}
                <li>
                  <span className="absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full border-2 border-amber-500 bg-white dark:bg-slate-900" aria-hidden="true" />
                  <p className="text-sm font-medium">Expected delivery</p>
                  <p className="text-xs text-muted-foreground">{formatWhen(data.delivery.promisedAt)}</p>
                </li>
                <li>
                  <span className={cn("absolute -left-1.5 mt-1.5 h-3 w-3 rounded-full", data.delivery.deliveredAt ? "bg-emerald-500" : "bg-rose-500")} aria-hidden="true" />
                  <p className="text-sm font-medium">{data.delivery.deliveredAt ? "Delivered" : "Not delivered yet"}</p>
                  <p className="text-xs text-muted-foreground">{formatWhen(data.delivery.deliveredAt)}</p>
                </li>
              </ol>
            </>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
