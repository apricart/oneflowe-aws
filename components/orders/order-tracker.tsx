"use client"

import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useEffect, useState, type FormEvent, type ReactNode } from "react"
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  ClipboardList,
  Copy,
  CreditCard,
  History,
  Home,
  Loader2,
  MapPin,
  Package,
  PackageCheck,
  PackageOpen,
  RefreshCw,
  Route,
  Search,
  ShoppingBag,
  Truck,
  XCircle,
} from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { useRecentTrackableOrders, useTrackedOrder } from "@/lib/hooks/use-order-tracking"
import {
  getOrderTrackingActivity,
  getOrderTrackingSteps,
  getTrackingSummary,
  MAX_TRACKING_REFERENCE_LENGTH,
  parseTrackingReference,
  type RecentTrackableOrder,
  type TrackedOrderView,
  type TrackingStage,
  type TrackingStatusCard,
  type TrackingStep,
  type TrackingStepKey,
  type TrackingTone,
} from "@/lib/order-tracking"
import { cn, formatPKR } from "@/lib/utils"

const PANEL = "gap-0 py-0 rounded-2xl border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"

const BRAND_GRADIENT =
  "radial-gradient(circle at 30% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 35%), transparent 60%), var(--color-brand-primary)"

const TONE_PILL: Record<TrackingTone, string> = {
  success: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950/40 dark:text-emerald-300",
  info: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950/40 dark:text-sky-300",
  warning: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-300",
  danger: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950/40 dark:text-rose-300",
  neutral: "border-slate-200 bg-slate-50 text-slate-600 dark:border-slate-700 dark:bg-slate-800/60 dark:text-slate-300",
}

const TONE_DOT: Record<TrackingTone, string> = {
  success: "bg-emerald-500",
  info: "bg-sky-500",
  warning: "bg-amber-500",
  danger: "bg-rose-500",
  neutral: "bg-slate-400",
}

const TONE_ICON: Record<TrackingTone, string> = {
  success: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300",
  info: "bg-sky-100 text-sky-700 dark:bg-sky-950/60 dark:text-sky-300",
  warning: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300",
  danger: "bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-300",
  neutral: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300",
}

const STEP_ICONS: Record<TrackingStepKey, typeof Check> = {
  placed: ClipboardList,
  approved: BadgeCheck,
  in_process: PackageOpen,
  out_for_delivery: Truck,
  delivered: Home,
  fulfilled: PackageCheck,
  rejected: XCircle,
  cancelled: XCircle,
  refunded: XCircle,
}

function formatDateTime(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "numeric", minute: "2-digit", hour12: true })
}

function formatDate(value: string | null | undefined): string | null {
  if (!value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })
}

function formatQuantity(quantity: number): string {
  return Number.isInteger(quantity) ? String(quantity) : quantity.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
}

/**
 * The requester's order-tracking page, shared by the Order Initiator Portal
 * (`/shop/tracking`) and the Group Order Initiator Portal
 * (`/group-portal/tracking`). The order being tracked lives in the URL
 * (`?reference=`), so a tracking link can be shared, bookmarked or opened from
 * an order history row.
 */
export function OrderTrackingWorkspace({
  homeHref,
  homeLabel,
  portalName,
}: Readonly<{ homeHref: string; homeLabel: string; portalName: string }>) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const reference = parseTrackingReference(searchParams.get("reference"))

  const tracked = useTrackedOrder(reference)
  const recent = useRecentTrackableOrders()

  const track = (value: string | null) => {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set("reference", value)
    else params.delete("reference")
    const query = params.toString()
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-slate-100/60 dark:from-slate-950 dark:to-slate-900">
      <header className="sticky top-0 z-30 border-b border-slate-200 bg-white/80 backdrop-blur-xl dark:border-slate-800 dark:bg-slate-900/80">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-4 py-3.5">
          <div className="flex min-w-0 items-center gap-3">
            <div className="hidden shrink-0 rounded-xl p-2 shadow-sm sm:block" style={{ background: BRAND_GRADIENT }}>
              <Route className="h-5 w-5 text-white" aria-hidden="true" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-lg font-semibold tracking-tight text-slate-900 dark:text-white sm:text-xl">Order tracking</h1>
              <p className="truncate text-xs text-muted-foreground">{portalName}</p>
            </div>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0 gap-2">
            <Link href={homeHref}>
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">{homeLabel}</span>
              <span className="sm:hidden">Back</span>
            </Link>
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6 sm:py-8">
        <TrackingSearch key={reference ?? ""} initial={reference ?? ""} busy={tracked.isLoading} onTrack={track} />

        {!reference && <RecentOrders state={recent} onTrack={track} />}

        {reference && tracked.isLoading && <TrackingSkeleton />}

        {reference && tracked.error && (
          <Card className={cn(PANEL, "border-rose-200 dark:border-rose-900/60")}>
            <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
              <span className="flex size-12 items-center justify-center rounded-full bg-rose-50 text-rose-600 dark:bg-rose-950/50 dark:text-rose-300">
                <AlertTriangle className="size-6" aria-hidden="true" />
              </span>
              <div role="alert">
                <p className="font-semibold text-slate-900 dark:text-white">We couldn&apos;t track “{reference}”</p>
                <p className="mt-1 text-sm text-muted-foreground">{tracked.error.message}</p>
              </div>
              <p className="max-w-md text-xs text-muted-foreground">
                Check the order ID or transaction ID on your order confirmation or in your order history. Only orders you can
                see in your portal can be tracked.
              </p>
              <Button variant="outline" size="sm" onClick={() => track(null)}>Show my recent orders</Button>
            </CardContent>
          </Card>
        )}

        {reference && tracked.data?.item && (
          <TrackingResult
            order={tracked.data.item}
            refreshing={tracked.isValidating}
            onRefresh={() => { void tracked.mutate() }}
          />
        )}
      </main>
    </div>
  )
}

function TrackingSearch({ initial, busy, onTrack }: Readonly<{ initial: string; busy: boolean; onTrack: (value: string | null) => void }>) {
  const [value, setValue] = useState(initial)
  const [invalid, setInvalid] = useState(false)

  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseTrackingReference(value)
    setInvalid(!parsed)
    if (parsed) onTrack(parsed)
  }

  return (
    <section
      className="relative overflow-hidden rounded-3xl px-5 py-7 text-white shadow-lg sm:px-8 sm:py-9"
      style={{ background: BRAND_GRADIENT }}
      aria-labelledby="track-heading"
    >
      <div className="pointer-events-none absolute -right-16 -top-16 size-56 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
      <div className="pointer-events-none absolute -bottom-20 right-24 size-48 rounded-full bg-white/10 blur-2xl" aria-hidden="true" />
      <div className="relative max-w-2xl">
        <p className="text-xs font-semibold uppercase tracking-[0.2em] text-white/70">Track your order</p>
        <h2 id="track-heading" className="mt-1 text-2xl font-bold tracking-tight sm:text-3xl">Where is my order?</h2>
        <p className="mt-1.5 text-sm text-white/80">
          Enter your order ID or transaction ID to see its approval, delivery and payment status.
        </p>
        <form onSubmit={submit} className="mt-5 flex flex-col gap-2 sm:flex-row" noValidate>
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
            <Input
              value={value}
              onChange={(event) => { setValue(event.target.value); setInvalid(false) }}
              placeholder="e.g. 2251 or mgx4k2p1a9c3e7f0b5d8"
              aria-label="Order ID or transaction ID"
              aria-invalid={invalid}
              aria-describedby={invalid ? "track-reference-error" : undefined}
              maxLength={MAX_TRACKING_REFERENCE_LENGTH + 1}
              autoComplete="off"
              spellCheck={false}
              className="h-12 rounded-xl border-0 bg-white pl-10 text-base text-slate-900 shadow-sm placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-white/70 dark:bg-white dark:text-slate-900"
            />
          </div>
          <Button
            type="submit"
            disabled={busy || !value.trim()}
            className="h-12 gap-2 rounded-xl bg-slate-900 px-6 text-white hover:bg-slate-800 dark:bg-slate-950 dark:hover:bg-slate-900"
          >
            {busy ? <Loader2 className="size-4 animate-spin" aria-hidden="true" /> : <Route className="size-4" aria-hidden="true" />}
            Track order
          </Button>
        </form>
        {invalid && (
          <p id="track-reference-error" className="mt-2 text-sm font-medium text-white">
            Enter an order ID (numbers only) or a transaction ID (letters and numbers).
          </p>
        )}
      </div>
    </section>
  )
}

function RecentOrders({ state, onTrack }: Readonly<{
  state: ReturnType<typeof useRecentTrackableOrders>
  onTrack: (value: string) => void
}>) {
  const items = state.data?.items ?? []

  return (
    <Card className={PANEL}>
      <CardHeader className="px-5 pb-3 pt-5 sm:px-6">
        <CardTitle className="flex items-center gap-2 text-base">
          <History className="size-4 text-muted-foreground" aria-hidden="true" /> Your recent orders
        </CardTitle>
        <p className="text-sm text-muted-foreground">Pick an order to see where it is.</p>
      </CardHeader>
      <CardContent className="px-5 pb-5 pt-0 sm:px-6">
        {state.isLoading && (
          <div className="space-y-2">
            {[0, 1, 2].map((row) => <Skeleton key={row} className="h-16 w-full rounded-xl" />)}
          </div>
        )}
        {state.error && <p className="text-sm text-rose-600 dark:text-rose-300">{state.error.message}</p>}
        {!state.isLoading && !state.error && items.length === 0 && (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-slate-200 px-6 py-10 text-center dark:border-slate-700">
            <ShoppingBag className="size-8 text-slate-300 dark:text-slate-600" aria-hidden="true" />
            <p className="text-sm font-medium text-slate-700 dark:text-slate-200">No orders yet</p>
            <p className="text-xs text-muted-foreground">Orders you place will appear here so you can track them.</p>
          </div>
        )}
        {items.length > 0 && (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-100 dark:divide-slate-800 dark:border-slate-800">
            {items.map((order) => <RecentOrderRow key={order.id} order={order} onTrack={onTrack} />)}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}

function RecentOrderRow({ order, onTrack }: Readonly<{ order: RecentTrackableOrder; onTrack: (value: string) => void }>) {
  const summary = getTrackingSummary(order)
  return (
    <li>
      <button
        type="button"
        onClick={() => onTrack(order.tid)}
        className="group flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none dark:hover:bg-slate-800/60 dark:focus-visible:bg-slate-800/60 sm:flex-row sm:items-center sm:justify-between"
      >
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300">
            <Package className="size-4" aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-900 dark:text-white">Order #{order.id}</p>
            <p className="truncate text-xs text-muted-foreground">
              <span className="font-mono">{order.tid}</span>
              {formatDate(order.createdAt) ? ` · ${formatDate(order.createdAt)}` : ""}
              {order.branchName ? ` · ${order.branchName}` : ""}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pl-12 sm:pl-0">
          <StatusPill tone={summary.order.tone}>{summary.order.label}</StatusPill>
          <StatusPill tone={summary.delivery.tone}>{summary.delivery.label}</StatusPill>
          <StatusPill tone={summary.payment.tone}>{summary.payment.label}</StatusPill>
          <ArrowRight className="ml-1 hidden size-4 text-slate-400 transition-transform group-hover:translate-x-0.5 sm:block" aria-hidden="true" />
        </div>
      </button>
    </li>
  )
}

function TrackingResult({ order, refreshing, onRefresh }: Readonly<{
  order: TrackedOrderView
  refreshing: boolean
  onRefresh: () => void
}>) {
  const steps = getOrderTrackingSteps(order)
  const summary = getTrackingSummary(order)
  const activity = getOrderTrackingActivity(order, order.refunds)
  const note = order.rejectionReason
    ? { title: "Reason for rejection", text: order.rejectionReason, tone: "danger" as const }
    : order.cancellationReason
      ? { title: "Reason for cancellation", text: order.cancellationReason, tone: "danger" as const }
      : order.correctionRequestNote && order.returnedForCorrectionAt && order.status === "PENDING"
        ? { title: "Changes requested by your approver", text: order.correctionRequestNote, tone: "warning" as const }
        : null

  return (
    <div className="space-y-6" aria-live="polite">
      <Card className={PANEL}>
        <CardContent className="flex flex-col gap-4 p-5 sm:flex-row sm:items-start sm:justify-between sm:p-6">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-white">Order #{order.id}</h2>
              <StatusPill tone={summary.order.tone} large>{summary.order.label}</StatusPill>
              {order.isGroupOrder && <Badge variant="secondary" className="rounded-full">Group order</Badge>}
            </div>
            <CopyableTid tid={order.tid} />
            <dl className="flex flex-wrap gap-x-5 gap-y-1 text-sm text-muted-foreground">
              {formatDateTime(order.createdAt) && (
                <div className="flex gap-1"><dt>Placed</dt><dd className="font-medium text-slate-700 dark:text-slate-200">{formatDateTime(order.createdAt)}</dd></div>
              )}
              {order.branchName && (
                <div className="flex gap-1"><dt>Branch</dt><dd className="font-medium text-slate-700 dark:text-slate-200">{order.branchName}</dd></div>
              )}
              {order.poNumber && (
                <div className="flex gap-1"><dt>PO</dt><dd className="font-medium text-slate-700 dark:text-slate-200">{order.poNumber}</dd></div>
              )}
            </dl>
          </div>
          <Button type="button" variant="outline" size="sm" className="shrink-0 gap-2 self-start" disabled={refreshing} onClick={onRefresh}>
            <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden="true" /> Refresh
          </Button>
        </CardContent>
      </Card>

      <Card className={PANEL}>
        <CardHeader className="px-5 pb-2 pt-5 sm:px-6">
          <CardTitle className="text-base">Order journey</CardTitle>
        </CardHeader>
        <CardContent className="px-5 pb-6 pt-4 sm:px-6">
          <HorizontalJourney steps={steps} />
          <VerticalJourney steps={steps} />
        </CardContent>
      </Card>

      {note && (
        <div className={cn("flex gap-3 rounded-2xl border p-4", TONE_PILL[note.tone])}>
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <div>
            <p className="text-sm font-semibold">{note.title}</p>
            <p className="mt-0.5 whitespace-pre-line text-sm opacity-90">{note.text}</p>
          </div>
        </div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <StatusCard icon={<PackageCheck className="size-5" />} title="Order status" card={summary.order} stages={summary.order.stages} />
        <StatusCard icon={<Truck className="size-5" />} title="Delivery status" card={summary.delivery} stages={summary.delivery.stages} />
        <StatusCard
          icon={<CreditCard className="size-5" />}
          title="Payment status"
          card={summary.payment}
          stages={summary.payment.stages}
          extra={order.totalCents !== null ? `Order total ${formatPKR(order.totalCents / 100)}` : null}
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-5">
        <Card className={cn(PANEL, "lg:col-span-3")}>
          <CardHeader className="px-5 pb-3 pt-5 sm:px-6">
            <CardTitle className="flex items-center gap-2 text-base">
              <History className="size-4 text-muted-foreground" aria-hidden="true" /> Activity
            </CardTitle>
          </CardHeader>
          <CardContent className="px-5 pb-5 pt-0 sm:px-6">
            {activity.length === 0 ? (
              <p className="text-sm text-muted-foreground">No activity has been recorded yet.</p>
            ) : (
              <ol className="relative">
                {activity.map((event, index) => (
                  <li key={event.key} className="relative flex gap-4 pb-5 last:pb-0">
                    {index < activity.length - 1 && (
                      <span className="absolute left-[7px] top-4 h-full w-px bg-slate-200 dark:bg-slate-700" aria-hidden="true" />
                    )}
                    <span className={cn("relative z-10 mt-1 size-[15px] shrink-0 rounded-full ring-4 ring-white dark:ring-slate-900", TONE_DOT[event.tone])} aria-hidden="true" />
                    <div className="min-w-0 flex-1 sm:flex sm:items-baseline sm:justify-between sm:gap-4">
                      <p className={cn("text-sm text-slate-800 dark:text-slate-100", index === 0 && "font-semibold")}>{event.label}</p>
                      <p className="shrink-0 text-xs text-muted-foreground">{formatDateTime(event.at)}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>

        <Card className={cn(PANEL, "lg:col-span-2")}>
          <CardHeader className="px-5 pb-3 pt-5 sm:px-6">
            <CardTitle className="flex items-center justify-between gap-2 text-base">
              <span className="flex items-center gap-2"><Package className="size-4 text-muted-foreground" aria-hidden="true" /> Items</span>
              <span className="text-xs font-normal text-muted-foreground">{order.items.length} {order.items.length === 1 ? "product" : "products"}</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 px-5 pb-5 pt-0 sm:px-6">
            <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto pr-1 dark:divide-slate-800">
              {order.items.map((item, index) => (
                <li key={`${item.productCode ?? item.productName}-${index}`} className="flex items-start justify-between gap-3 py-2.5 first:pt-0">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-slate-800 dark:text-slate-100">{item.productName}</p>
                    {item.productCode && <p className="font-mono text-[11px] text-muted-foreground">{item.productCode}</p>}
                  </div>
                  <span className="shrink-0 rounded-md bg-slate-100 px-2 py-0.5 text-xs font-semibold text-slate-700 dark:bg-slate-800 dark:text-slate-200">
                    {formatQuantity(item.quantity)} {item.unit}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex gap-3 rounded-xl bg-slate-50 p-3 dark:bg-slate-800/60">
              <MapPin className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
              <div className="min-w-0 text-sm">
                <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Delivering to</p>
                <p className="font-medium text-slate-800 dark:text-slate-100">{order.branchName ?? "Your branch"}</p>
                {order.deliveryAddress && <p className="text-xs text-muted-foreground">{order.deliveryAddress}</p>}
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

function CopyableTid({ tid }: Readonly<{ tid: string }>) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <span>Transaction ID</span>
      <code className="rounded-md bg-slate-100 px-2 py-0.5 font-mono text-xs font-semibold text-slate-800 dark:bg-slate-800 dark:text-slate-100">{tid}</code>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={copied ? "Transaction ID copied" : "Copy transaction ID"}
        onClick={() => {
          void navigator.clipboard?.writeText(tid).then(() => setCopied(true)).catch(() => undefined)
        }}
      >
        {copied ? <Check className="size-3.5 text-emerald-600" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </Button>
    </div>
  )
}

function stepColors(state: TrackingStep["state"]): string {
  if (state === "complete") return "border-emerald-500 bg-emerald-500 text-white"
  if (state === "current") return "border-[color:var(--color-brand-primary)] bg-[color:var(--color-brand-primary)] text-white ring-4 ring-[color:color-mix(in_oklab,var(--color-brand-primary),transparent_80%)]"
  if (state === "stopped") return "border-rose-500 bg-rose-500 text-white"
  return "border-slate-300 bg-white text-slate-400 dark:border-slate-600 dark:bg-slate-900 dark:text-slate-500"
}

function connectorColor(next: TrackingStep | undefined): string {
  if (!next || next.state === "upcoming") return "bg-slate-200 dark:bg-slate-700"
  if (next.state === "stopped") return "bg-gradient-to-r from-emerald-500 to-rose-500"
  return "bg-emerald-500"
}

function StepLabel({ step, align }: Readonly<{ step: TrackingStep; align: "center" | "left" }>) {
  return (
    <div className={cn("min-w-0", align === "center" && "text-center")}>
      <p className={cn(
        "text-sm font-semibold",
        step.state === "upcoming" ? "text-slate-400 dark:text-slate-500" : "text-slate-900 dark:text-white",
        step.state === "stopped" && "text-rose-600 dark:text-rose-400",
      )}>
        {step.label}
      </p>
      <p className="mt-0.5 text-xs font-medium text-slate-600 dark:text-slate-300">{formatDateTime(step.at) ?? (step.state === "upcoming" ? "" : "—")}</p>
      <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{step.detail}</p>
    </div>
  )
}

function HorizontalJourney({ steps }: Readonly<{ steps: TrackingStep[] }>) {
  return (
    <ol className="hidden md:flex" aria-label="Order journey">
      {steps.map((step, index) => {
        const Icon = STEP_ICONS[step.key]
        return (
          <li key={step.key} className="relative flex flex-1 flex-col items-center px-2" aria-current={step.state === "current" ? "step" : undefined}>
            {index < steps.length - 1 && (
              <span className={cn("absolute left-1/2 top-5 h-1 w-full rounded-full", connectorColor(steps[index + 1]))} aria-hidden="true" />
            )}
            <span className={cn("relative z-10 flex size-10 items-center justify-center rounded-full border-2 transition-colors", stepColors(step.state))}>
              {step.state === "complete" ? <Check className="size-5" aria-hidden="true" /> : <Icon className="size-5" aria-hidden="true" />}
            </span>
            <div className="mt-3 w-full max-w-[11rem]">
              <StepLabel step={step} align="center" />
            </div>
          </li>
        )
      })}
    </ol>
  )
}

function VerticalJourney({ steps }: Readonly<{ steps: TrackingStep[] }>) {
  return (
    <ol className="md:hidden" aria-label="Order journey">
      {steps.map((step, index) => {
        const Icon = STEP_ICONS[step.key]
        return (
          <li key={step.key} className="relative flex gap-4 pb-6 last:pb-0" aria-current={step.state === "current" ? "step" : undefined}>
            {index < steps.length - 1 && (
              <span className={cn("absolute left-[18px] top-10 h-[calc(100%-2.5rem)] w-1 rounded-full", connectorColor(steps[index + 1]))} aria-hidden="true" />
            )}
            <span className={cn("relative z-10 flex size-10 shrink-0 items-center justify-center rounded-full border-2", stepColors(step.state))}>
              {step.state === "complete" ? <Check className="size-5" aria-hidden="true" /> : <Icon className="size-5" aria-hidden="true" />}
            </span>
            <div className="pt-1.5"><StepLabel step={step} align="left" /></div>
          </li>
        )
      })}
    </ol>
  )
}

function StatusCard({ icon, title, card, stages, extra }: Readonly<{
  icon: ReactNode
  title: string
  card: TrackingStatusCard
  stages: TrackingStage[]
  extra?: string | null
}>) {
  const stopTone = card.tone === "danger"
  return (
    <Card className={PANEL}>
      <CardContent className="flex h-full flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className={cn("flex size-10 items-center justify-center rounded-xl", TONE_ICON[card.tone])} aria-hidden="true">{icon}</span>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</p>
              <p className="text-lg font-bold text-slate-900 dark:text-white">{card.label}</p>
            </div>
          </div>
        </div>
        <div className="text-sm text-muted-foreground">
          <p>{card.detail}</p>
          {formatDateTime(card.at) && <p className="mt-0.5 text-xs">{formatDateTime(card.at)}</p>}
          {extra && <p className="mt-1 text-sm font-semibold text-slate-800 dark:text-slate-100">{extra}</p>}
        </div>
        <div className="mt-auto">
          <div className="flex gap-1" aria-hidden="true">
            {stages.map((stage) => (
              <span
                key={stage.key}
                className={cn(
                  "h-1.5 flex-1 rounded-full",
                  !stage.reached
                    ? "bg-slate-200 dark:bg-slate-700"
                    : stage.current && stopTone
                      ? "bg-rose-500"
                      : stage.current && card.tone !== "success"
                        ? "bg-[color:var(--color-brand-primary)]"
                        : "bg-emerald-500",
                )}
              />
            ))}
          </div>
          <ul className="mt-2 flex gap-1" aria-label={`${title} stages`}>
            {stages.map((stage) => (
              <li
                key={stage.key}
                aria-current={stage.current ? "step" : undefined}
                className={cn(
                  "flex-1 text-center text-[11px] leading-tight",
                  stage.current ? "font-semibold text-slate-900 dark:text-white" : stage.reached ? "text-slate-600 dark:text-slate-300" : "text-slate-400 dark:text-slate-500",
                )}
              >
                {stage.label}
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  )
}

function StatusPill({ tone, children, large = false }: Readonly<{ tone: TrackingTone; children: ReactNode; large?: boolean }>) {
  return (
    <span className={cn(
      "inline-flex items-center gap-1.5 rounded-full border font-medium",
      large ? "px-3 py-1 text-sm" : "px-2 py-0.5 text-[11px]",
      TONE_PILL[tone],
    )}>
      <span className={cn("size-1.5 rounded-full", TONE_DOT[tone])} aria-hidden="true" />
      {children}
    </span>
  )
}

function TrackingSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true" aria-label="Loading order">
      <Skeleton className="h-32 w-full rounded-2xl" />
      <Skeleton className="h-48 w-full rounded-2xl" />
      <div className="grid gap-4 md:grid-cols-3">
        {[0, 1, 2].map((card) => <Skeleton key={card} className="h-44 rounded-2xl" />)}
      </div>
    </div>
  )
}
