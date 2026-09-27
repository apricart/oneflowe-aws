"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import { CalendarDays, Database, History, PackageSearch, RefreshCw, Search } from "lucide-react"
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import {
  type ProductPriceHistoryPoint,
  type ProductPriceHistoryRangeKey,
  type ProductPriceHistoryResponse,
  type ProductPriceHistoryRole,
} from "@/lib/product-price-history"
import { cn, formatPKR } from "@/lib/utils"

const RANGE_OPTIONS: Array<{ key: ProductPriceHistoryRangeKey; label: string }> = [
  { key: "90d", label: "Last 90 days" },
  { key: "180d", label: "Last 6 months" },
  { key: "1y", label: "Last 12 months" },
  { key: "all", label: "All time" },
]

const shortNumberFormatter = new Intl.NumberFormat("en-PK", { notation: "compact", maximumFractionDigits: 1 })

function money(cents: number) {
  return formatPKR(cents / 100, { maximumFractionDigits: 2, minimumFractionDigits: 0 })
}

function shortMoney(cents: number) {
  return `PKR ${shortNumberFormatter.format(cents / 100)}`
}

function dateTimeLabel(value: string, includeTime = true) {
  return new Intl.DateTimeFormat("en-PK", {
    timeZone: "Asia/Karachi",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: includeTime ? "numeric" : undefined,
    minute: includeTime ? "2-digit" : undefined,
  }).format(new Date(value))
}

type ChartPoint = ProductPriceHistoryPoint & { axisLabel: string }

function scopeLabel(scope: ProductPriceHistoryPoint["scope"]) {
  return {
    GLOBAL: "Global",
    ORGANIZATION: "Organization",
    GROUP: "Group",
    BRANCH: "Historical branch",
  }[scope]
}

function sourceLabel(source: ProductPriceHistoryPoint["source"]) {
  return {
    CATALOG_CHANGE: "Recorded change",
    ORDER_BACKFILL: "Historical backfill",
    MIGRATION_BASELINE: "Migration baseline",
  }[source]
}

function contextLabel(point: ProductPriceHistoryPoint) {
  if (point.scope === "GLOBAL") return "All organizations"
  const context = [point.organizationName, point.groupName, point.branchName].filter(Boolean)
  return context.length > 0 ? context.join(" · ") : "Archived catalogue scope"
}

function onlyConsumerPriceChanges(points: ProductPriceHistoryPoint[]) {
  const lastPriceByStream = new Map<string, number>()

  return points.filter((point) => {
    if (
      point.priceCents <= 0
      || point.previousPriceCents === null
      || point.previousPriceCents <= 0
      || point.previousPriceCents === point.priceCents
    ) return false
    const stream = point.groupId !== null
      ? `group:${point.groupId}`
      : point.organizationId !== null
        ? `organization:${point.organizationId}`
        : "global"
    if (lastPriceByStream.get(stream) === point.priceCents) return false
    lastPriceByStream.set(stream, point.priceCents)
    return true
  })
}

function PriceTooltip({ active, payload }: Readonly<{ active?: boolean; payload?: Array<{ payload: ChartPoint }> }>) {
  if (!active || !payload?.length) return null
  const point = payload[0].payload
  return (
    <div className="min-w-64 rounded-xl border border-slate-200 bg-white p-3 text-xs shadow-xl dark:border-slate-700 dark:bg-slate-900">
      <p className="font-semibold text-slate-950 dark:text-white">{money(point.priceCents)}</p>
      <p className="mt-1 text-slate-500 dark:text-slate-400">Recorded price · {dateTimeLabel(point.changedAt)}</p>
      <div className="mt-3 space-y-1 border-t border-slate-100 pt-2 text-slate-600 dark:border-slate-800 dark:text-slate-300">
        <p>{scopeLabel(point.scope)} · {sourceLabel(point.source)}</p>
        <p>{contextLabel(point)}</p>
        <p>Previous price: {point.previousPriceCents === null || point.previousPriceCents <= 0 ? "Not available" : money(point.previousPriceCents)}</p>
      </div>
    </div>
  )
}

function PriceHistoryChart({ data, productName }: Readonly<{ data: ChartPoint[]; productName: string }>) {
  const showDots = data.length <= 120
  return (
    <div
      className="h-[360px] w-full"
      role="img"
      aria-label={`Recorded catalogue prices for ${productName}. A table with the same records follows the chart.`}
    >
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 14, right: 24, bottom: 8, left: 12 }}>
          <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="currentColor" className="text-slate-200 dark:text-slate-800" />
          <XAxis
            dataKey="axisLabel"
            tick={{ fontSize: 11, fill: "currentColor" }}
            className="text-slate-500"
            tickLine={false}
            axisLine={false}
            minTickGap={34}
          />
          <YAxis
            tickFormatter={(value) => shortMoney(Number(value))}
            tick={{ fontSize: 11, fill: "currentColor" }}
            className="text-slate-500"
            tickLine={false}
            axisLine={false}
            width={76}
            domain={[(minimum: number) => Math.max(0, Math.floor(minimum * 0.95)), (maximum: number) => Math.ceil(maximum * 1.05)]}
          />
          <Tooltip content={<PriceTooltip />} />
          <Line
            type="linear"
            dataKey="priceCents"
            name="Recorded price"
            stroke="#2563eb"
            strokeWidth={3}
            dot={showDots ? { r: 3, fill: "#2563eb", strokeWidth: 0 } : false}
            activeDot={{ r: 5, fill: "#2563eb", stroke: "white", strokeWidth: 2 }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

function FilterSelect({
  label,
  value,
  disabled,
  allLabel,
  options,
  onChange,
}: Readonly<{
  label: string
  value: string
  disabled?: boolean
  allLabel?: string
  options: Array<{ value: string; label: string }>
  onChange: (value: string) => void
}>) {
  return (
    <div className="min-w-0">
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger className="w-full bg-white dark:bg-slate-950" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {allLabel ? <SelectItem value="all">{allLabel}</SelectItem> : null}
          {options.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  )
}

// This boundary coordinates dependent catalogue filters and their server query.
// eslint-disable-next-line sonarjs/cognitive-complexity
export default function ProductPriceHistoryView({ role }: Readonly<{ role: ProductPriceHistoryRole }>) {
  const [range, setRange] = useState<ProductPriceHistoryRangeKey>("1y")
  const [selectedProductId, setSelectedProductId] = useState<number | null>(null)
  const [organizationId, setOrganizationId] = useState<number | null>(null)
  const [groupId, setGroupId] = useState<number | null>(null)
  const [branchId, setBranchId] = useState<number | null>(null)
  const [search, setSearch] = useState("")

  const endpoint = useMemo(() => {
    const params = new URLSearchParams({ range })
    if (organizationId) params.set("organizationId", String(organizationId))
    if (groupId) params.set("groupId", String(groupId))
    if (branchId) params.set("branchId", String(branchId))
    if (selectedProductId) params.set("productId", String(selectedProductId))
    return `/api/v1/admin/product-price-history?${params.toString()}`
  }, [branchId, groupId, organizationId, range, selectedProductId])

  const { data, error, isLoading, isValidating, mutate } = useSWR<ProductPriceHistoryResponse>(endpoint, fetcher, {
    revalidateOnFocus: false,
    keepPreviousData: true,
  })

  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return data?.products ?? []
    return (data?.products ?? []).filter((product) =>
      product.name.toLowerCase().includes(query) || product.productCode.toLowerCase().includes(query),
    )
  }, [data?.products, search])

  const chartData = useMemo<ChartPoint[]>(() => onlyConsumerPriceChanges(data?.points ?? [])
    // The endpoint already performs the same transition filtering. Retain this
    // guard so a stale browser cache cannot draw zero or repeated-price points.
    .map((point) => ({
      ...point,
      axisLabel: dateTimeLabel(point.changedAt, false),
    })), [data?.points])

  const activeProductId = selectedProductId ?? data?.selectedProduct?.id ?? null
  const effectiveOrganizationId = organizationId ?? data?.selection.organizationId ?? null
  const organizations = (data?.options.organizations ?? []).map((option) => ({ value: String(option.id), label: option.name }))
  const groups = (data?.options.groups ?? []).map((option) => ({
    value: String(option.id),
    label: organizationId === null && role === "SUPER_ADMIN" ? `${option.name} · ${option.organizationName}` : option.name,
  }))
  const branches = (data?.options.branches ?? []).map((option) => ({
    value: String(option.id),
    label: organizationId === null && role === "SUPER_ADMIN" ? `${option.name} · ${option.organizationName}` : option.name,
  }))

  const resetProduct = () => setSelectedProductId(null)
  const changeOrganization = (value: string) => {
    setOrganizationId(value === "all" ? null : Number(value))
    setGroupId(null)
    setBranchId(null)
    resetProduct()
  }
  const changeGroup = (value: string) => {
    setGroupId(value === "all" ? null : Number(value))
    setBranchId(null)
    resetProduct()
  }
  const changeBranch = (value: string) => {
    setBranchId(value === "all" ? null : Number(value))
    resetProduct()
  }
  const changeRange = (value: string) => {
    setRange(value as ProductPriceHistoryRangeKey)
    resetProduct()
  }

  return (
    <div className="space-y-5 p-4 md:p-6">
      <div className="flex flex-col gap-4 rounded-2xl border border-slate-100 bg-white p-4 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] dark:border-slate-800 dark:bg-slate-900 md:flex-row md:items-center md:justify-between md:p-5">
        <div className="flex items-center gap-4">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl border border-blue-100 bg-gradient-to-tr from-blue-100 to-indigo-100 text-blue-600 shadow-inner dark:border-blue-800 dark:from-blue-950 dark:to-indigo-950 dark:text-blue-300">
            <History className="h-6 w-6" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Product Price History</h1>
              {isValidating && data ? <Badge variant="outline" className="gap-1 text-[10px]"><RefreshCw className="h-3 w-3 animate-spin" /> Updating</Badge> : null}
            </div>
            <p className="mt-1 text-xs font-medium text-slate-500 dark:text-slate-400">
              {role === "HEAD_OFFICE"
                ? "See when consumer-facing organization or group prices changed."
                : "See when catalogue prices changed across each pricing tier."}
            </p>
          </div>
        </div>
        <Button variant="outline" size="sm" className="gap-2 self-start md:self-auto" onClick={() => mutate()} disabled={isValidating}>
          <RefreshCw className={cn("h-4 w-4", isValidating && "animate-spin")} />
          Refresh
        </Button>
      </div>

      <div className="flex items-start gap-3 rounded-xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-sm dark:border-blue-900 dark:bg-blue-950/30">
        <Database className="mt-0.5 h-4 w-4 shrink-0 text-blue-600 dark:text-blue-300" />
        <div>
          <p className="font-semibold text-blue-950 dark:text-blue-100">What this history represents</p>
          <p className="mt-0.5 leading-5 text-blue-800/80 dark:text-blue-200/80">
            {role === "HEAD_OFFICE"
              ? "Each point is an organization or group consumer-price change. Global catalogue rows are excluded. Earlier changes were backfilled from eligible charged order prices without treating every order as a change."
              : "Each point is a catalogue price change at the global, organization, or group tier. Earlier changes were backfilled from eligible charged order prices without treating every order as a change."}
          </p>
        </div>
      </div>

      <Card className="gap-4 border-slate-200 py-4 shadow-sm dark:border-slate-800">
        <CardHeader className="px-4 py-0">
          <CardTitle className="text-sm">Filter price records</CardTitle>
          <CardDescription className="text-xs">Filters are applied to both the product list and the chart.</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 px-4 sm:grid-cols-2 xl:grid-cols-4">
          <FilterSelect
            label="Organization"
            value={effectiveOrganizationId === null ? "all" : String(effectiveOrganizationId)}
            disabled={role === "HEAD_OFFICE"}
            allLabel={role === "SUPER_ADMIN" ? "All organizations" : undefined}
            options={organizations}
            onChange={changeOrganization}
          />
          <FilterSelect label="Group" value={groupId === null ? "all" : String(groupId)} allLabel="All groups" options={groups} onChange={changeGroup} />
          <FilterSelect label="Branch" value={branchId === null ? "all" : String(branchId)} allLabel="All branches" options={branches} onChange={changeBranch} />
          <FilterSelect label="Date range" value={range} options={RANGE_OPTIONS.map((option) => ({ value: option.key, label: option.label }))} onChange={changeRange} />
        </CardContent>
      </Card>

      {error ? (
        <Card className="border-rose-200 bg-rose-50 py-8 text-center dark:border-rose-900 dark:bg-rose-950/30">
          <CardContent>
            <p className="font-semibold text-rose-800 dark:text-rose-200">Price history could not be loaded.</p>
            <p className="mt-1 text-sm text-rose-700/80 dark:text-rose-300/80">{error.message}</p>
            <Button className="mt-4" variant="outline" onClick={() => mutate()}>Try again</Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid items-start gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
          <Card className="gap-0 overflow-hidden border-slate-200 py-0 shadow-sm dark:border-slate-800 xl:sticky xl:top-5">
            <CardHeader className="gap-3 border-b border-slate-100 px-4 py-4 dark:border-slate-800">
              <div>
                <CardTitle className="text-sm">Products with price records</CardTitle>
                <CardDescription className="mt-1 text-xs">Choose a product to inspect.</CardDescription>
              </div>
              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search name or code" aria-label="Search products" className="h-9 pl-9" />
              </div>
            </CardHeader>
            <CardContent className="max-h-[680px] overflow-y-auto p-2">
              {isLoading && !data ? (
                <div className="space-y-2 p-1">{Array.from({ length: 7 }, (_, index) => <Skeleton className="h-16 w-full rounded-xl" key={index} />)}</div>
              ) : filteredProducts.length === 0 ? (
                <div className="px-3 py-10 text-center text-sm text-slate-500">No products have eligible price records for these filters.</div>
              ) : filteredProducts.map((product) => (
                <button
                  type="button"
                  key={product.id}
                  onClick={() => setSelectedProductId(product.id)}
                  aria-pressed={activeProductId === product.id}
                  className={cn(
                    "mb-1 w-full rounded-xl border border-transparent px-3 py-3 text-left transition-colors hover:bg-slate-50 dark:hover:bg-slate-800/70",
                    activeProductId === product.id && "border-blue-200 bg-blue-50 hover:bg-blue-50 dark:border-blue-800 dark:bg-blue-950/40 dark:hover:bg-blue-950/40",
                  )}
                >
                  <span className="block truncate text-sm font-semibold text-slate-900 dark:text-slate-100">{product.name}</span>
                  <span className="mt-0.5 block text-[11px] text-slate-500">{product.productCode} · {product.unit}</span>
                  <span className="mt-2 block text-[10px] font-medium text-slate-400">{product.recordCount.toLocaleString()} price {product.recordCount === 1 ? "record" : "records"}</span>
                </button>
              ))}
            </CardContent>
          </Card>

          <div className="min-w-0 space-y-5">
            <Card className="gap-4 border-slate-200 py-4 shadow-sm dark:border-slate-800">
              <CardContent className="px-4">
                {isLoading && !data ? (
                  <div className="space-y-2"><Skeleton className="h-6 w-64" /><Skeleton className="h-4 w-44" /></div>
                ) : data?.selectedProduct ? (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="truncate text-lg font-bold text-slate-950 dark:text-white">{data.selectedProduct.name}</h2>
                      <Badge variant="outline" className="font-mono text-[10px]">{data.selectedProduct.productCode}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{data.range.label} · {data.selectedProduct.recordCount.toLocaleString()} price-change records</p>
                  </>
                ) : <p className="text-sm text-slate-500">No product price records are available for this selection.</p>}
              </CardContent>
            </Card>

            <Card className="gap-4 border-slate-200 py-5 shadow-sm dark:border-slate-800">
              <CardHeader className="flex-row items-start justify-between gap-4 px-5 py-0">
                <div>
                  <CardTitle className="text-base">Catalogue price over time</CardTitle>
                  <CardDescription className="mt-1 text-xs">One point per recorded change or migration baseline.</CardDescription>
                </div>
                <CalendarDays className="h-5 w-5 shrink-0 text-slate-400" />
              </CardHeader>
              <CardContent className="px-3 md:px-5">
                {isLoading && !data ? <Skeleton className="h-[360px] w-full rounded-xl" /> : chartData.length === 0 ? (
                  <div className="flex h-[300px] flex-col items-center justify-center rounded-xl border border-dashed border-slate-200 bg-slate-50/50 px-6 text-center dark:border-slate-800 dark:bg-slate-900/40">
                    <PackageSearch className="h-9 w-9 text-slate-300 dark:text-slate-600" />
                    <p className="mt-3 font-semibold text-slate-700 dark:text-slate-200">No price changes in this range</p>
                    <p className="mt-1 max-w-md text-sm text-slate-500">Try a longer date range or broaden the organization, group, or branch filters.</p>
                  </div>
                ) : (
                  <>
                    <div className="mb-2 flex items-center gap-2 px-2 text-xs text-slate-600 dark:text-slate-300">
                      <span className="h-0.5 w-5 bg-blue-600" /> Recorded catalogue price
                    </div>
                    <PriceHistoryChart data={chartData} productName={data?.selectedProduct?.name ?? "selected product"} />
                    {data?.truncated ? <p className="mt-2 px-2 text-xs text-amber-700 dark:text-amber-300">Showing the latest 5,000 records. Narrow the filters to inspect a smaller set.</p> : null}
                  </>
                )}
              </CardContent>
            </Card>

            <Card className="gap-4 overflow-hidden border-slate-200 py-0 shadow-sm dark:border-slate-800">
              <CardHeader className="border-b border-slate-100 px-5 py-4 dark:border-slate-800">
                <CardTitle className="text-base">Price change records</CardTitle>
                <CardDescription className="text-xs">Catalogue ledger entries, newest first.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto p-0">
                {chartData.length === 0 ? (
                  <p className="px-5 py-8 text-center text-sm text-slate-500">No price change records are available for this selection.</p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-slate-50/80 dark:bg-slate-900/70">
                        <TableHead className="pl-5">Changed</TableHead>
                        <TableHead className="text-right">New price</TableHead>
                        <TableHead>Scope</TableHead>
                        <TableHead>Organization</TableHead>
                        <TableHead>Group</TableHead>
                        <TableHead>Branch</TableHead>
                        <TableHead className="pr-5">Source</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {[...chartData].reverse().map((point) => (
                        <TableRow key={point.id}>
                          <TableCell className="whitespace-nowrap pl-5 font-medium">{dateTimeLabel(point.changedAt)}</TableCell>
                          <TableCell className="text-right font-semibold tabular-nums text-blue-700 dark:text-blue-300">{money(point.priceCents)}</TableCell>
                          <TableCell><Badge variant="outline">{scopeLabel(point.scope)}</Badge></TableCell>
                          <TableCell>{point.organizationName ?? (point.scope === "GLOBAL" ? "All organizations" : "—")}</TableCell>
                          <TableCell>{point.groupName ?? "—"}</TableCell>
                          <TableCell>{point.branchName ?? "—"}</TableCell>
                          <TableCell className="pr-5 text-xs">{sourceLabel(point.source)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      )}
    </div>
  )
}
