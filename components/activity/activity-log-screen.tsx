"use client"

import { AlertTriangle, Download, Loader2, RefreshCw, ScrollText } from "lucide-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"

import { ActivityEventDetail } from "@/components/activity/activity-event-detail"
import {
  ActivityLogFilters,
  EMPTY_FILTERS,
  type ActivityFilterState,
} from "@/components/activity/activity-log-filters"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  ACTIVITY_PAGE_SIZE_DEFAULT,
  type ActivityEvent,
  type ActivityLogPage,
} from "@/lib/activity-log"
import {
  OPERATION_LABEL,
  OPERATION_TONE,
  SEVERITY_LABEL,
  SEVERITY_MEANING,
  SEVERITY_TONE,
  actorLabel,
  csvFileName,
  eventAriaLabel,
  eventsToCsv,
  scopeLabel,
  windowForPreset,
} from "@/lib/activity-log-view"
import { cn } from "@/lib/utils"

/**
 * The admin activity log.
 *
 * Paging is by cursor and accumulates: filters replace the list, "Load more"
 * appends to it. There are no page numbers because there is no total to number
 * against — counting a filtered union of three unbounded tables would cost more
 * than the page itself (see `plans/OF-AUDIT-admin-activity-log.md`).
 *
 * SWR is not used here, deliberately. Its cache is keyed on a URL, and every
 * page of this list has a different cursor in its URL, so accumulating pages
 * would mean either re-fetching the whole list on each append or holding an
 * ever-growing set of cache keys for a screen nobody revisits. The three states
 * are held explicitly instead, and the one in-flight request is cancelled when
 * the filters change.
 */

const SEARCH_DEBOUNCE_MS = 350

type LoadState = "idle" | "loading" | "appending" | "error"

function buildQuery(filters: ActivityFilterState, cursor: string | null, now: Date): string {
  const params = new URLSearchParams()

  if (filters.preset === "custom") {
    if (filters.customFrom) params.set("from", new Date(`${filters.customFrom}T00:00:00`).toISOString())
    if (filters.customTo) params.set("to", new Date(`${filters.customTo}T23:59:59.999`).toISOString())
  } else {
    const window = windowForPreset(filters.preset, now)
    if (window) {
      params.set("from", window.from.toISOString())
      params.set("to", window.to.toISOString())
    }
  }

  if (filters.source !== "all") params.set("source", filters.source)
  if (filters.operation !== "all") params.set("operation", filters.operation)
  if (filters.category !== "all") params.set("category", filters.category)
  if (filters.role !== "all") params.set("actorRole", filters.role)
  if (filters.outcome !== "all") params.set("outcome", filters.outcome)
  const search = filters.search.trim()
  if (search.length > 0) params.set("search", search)
  params.set("limit", String(ACTIVITY_PAGE_SIZE_DEFAULT))
  if (cursor) params.set("cursor", cursor)

  return `/api/v1/activity-logs?${params.toString()}`
}

/** Exported for the screen's test: the query a given filter state produces. */
export function activityQueryFor(filters: ActivityFilterState, now: Date): string {
  return buildQuery(filters, null, now)
}

type ScreenProps = Readonly<{
  /**
   * Whether the reader sees every tenant (Super Admin) or one (Head Office).
   * Copy only — the endpoint decides which rows arrive. Defaults to the
   * narrower claim so a missing prop never tells a tenant it sees the platform.
   */
  platformWide?: boolean
}>

export function ActivityLogScreen({ platformWide = false }: ScreenProps = {}) {
  const [filters, setFilters] = useState<ActivityFilterState>(EMPTY_FILTERS)
  const [debouncedSearch, setDebouncedSearch] = useState("")
  const [events, setEvents] = useState<ActivityEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [state, setState] = useState<LoadState>("loading")
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [selected, setSelected] = useState<ActivityEvent | null>(null)

  const inFlight = useRef<AbortController | null>(null)

  // Typing must not fire a request per keystroke against three tables.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [filters.search])

  const effectiveFilters = useMemo(
    () => ({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  )

  const load = useCallback(
    async (nextCursor: string | null) => {
      inFlight.current?.abort()
      const controller = new AbortController()
      inFlight.current = controller

      setState(nextCursor ? "appending" : "loading")
      setErrorMessage(null)

      try {
        const response = await fetch(buildQuery(effectiveFilters, nextCursor, new Date()), {
          signal: controller.signal,
          headers: { accept: "application/json" },
        })
        const body = (await response.json()) as ActivityLogPage & { error?: string }

        if (!response.ok) {
          // The message is the one `lib/error-handler.ts` produced server-side;
          // never a raw exception.
          throw new Error(body?.error ?? "The activity log could not be loaded.")
        }

        setEvents((previous) => (nextCursor ? [...previous, ...body.items] : body.items))
        setCursor(body.nextCursor)
        setState("idle")
      } catch (error) {
        if (controller.signal.aborted) return
        setErrorMessage(error instanceof Error ? error.message : "The activity log could not be loaded.")
        setState("error")
      }
    },
    [effectiveFilters],
  )

  // A filter change starts a new list; it never appends onto the old one.
  useEffect(() => {
    void load(null)
    return () => inFlight.current?.abort()
  }, [load])

  const exportCsv = () => {
    const blob = new Blob([eventsToCsv(events)], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.href = url
    link.download = csvFileName(new Date())
    link.click()
    URL.revokeObjectURL(url)
  }

  const busy = state === "loading" || state === "appending"

  return (
    <div className="space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight">
            <ScrollText className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            Activity log
          </h1>
          <p className="max-w-2xl text-sm text-muted-foreground">
            {platformWide
              ? "Sign-ins, business changes and group operations across every organization, newest first. Select a row to see who did it, from what address, and exactly what changed."
              : "Sign-ins, business changes and group operations in your organization, newest first. Select a row to see who did it and exactly what changed. Changes made by Apricart administrators are shown without their personal details."}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void load(null)}
            disabled={busy}
          >
            <RefreshCw className={cn("mr-2 h-4 w-4", state === "loading" && "animate-spin")} aria-hidden="true" />
            Refresh
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportCsv}
            disabled={events.length === 0}
            title="Exports the rows currently loaded"
          >
            <Download className="mr-2 h-4 w-4" aria-hidden="true" />
            Export CSV
          </Button>
        </div>
      </header>

      <Card>
        <CardHeader className="pb-4">
          <CardTitle className="text-sm font-semibold">Filters</CardTitle>
        </CardHeader>
        <CardContent>
          <ActivityLogFilters filters={filters} onChange={setFilters} platformWide={platformWide} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-4 pb-4">
          <CardTitle className="text-sm font-semibold" aria-live="polite">
            {state === "loading"
              ? "Loading activity…"
              : `${events.length} event${events.length === 1 ? "" : "s"} loaded${cursor ? " (more available)" : ""}`}
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {state === "error" ? (
            <ErrorState message={errorMessage} onRetry={() => void load(null)} />
          ) : null}

          {state === "loading" ? <LoadingRows /> : null}

          {state !== "loading" && state !== "error" && events.length === 0 ? <EmptyState /> : null}

          {events.length > 0 ? (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[170px]">When</TableHead>
                    <TableHead className="w-[130px]">Operation</TableHead>
                    <TableHead>What happened</TableHead>
                    <TableHead className="w-[200px]">Who</TableHead>
                    <TableHead className="w-[180px]">Where</TableHead>
                    <TableHead className="w-[110px]">Severity</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((event) => (
                    <EventRow key={event.id} event={event} onSelect={() => setSelected(event)} />
                  ))}
                </TableBody>
              </Table>
            </div>
          ) : null}

          {cursor ? (
            <div className="flex justify-center border-t p-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => void load(cursor)}
                disabled={busy}
              >
                {state === "appending" ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />
                ) : null}
                Load more
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      <ActivityEventDetail event={selected} onClose={() => setSelected(null)} />
    </div>
  )
}

function EventRow({ event, onSelect }: Readonly<{ event: ActivityEvent; onSelect: () => void }>) {
  return (
    <TableRow className="cursor-pointer hover:bg-muted/40">
      <TableCell className="p-0" colSpan={6}>
        {/* One button spanning the row: the whole row is the control, and it is
            reachable and operable from the keyboard like any other button. */}
        <button
          type="button"
          onClick={onSelect}
          aria-label={eventAriaLabel(event)}
          className="grid w-full grid-cols-[170px_130px_1fr_200px_180px_110px] items-start gap-0 px-0 py-0 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
        >
          <span className="px-4 py-3 text-xs">
            <span className="block font-medium">
              {new Date(event.occurredAt).toLocaleDateString()}
            </span>
            <span className="block font-mono text-muted-foreground">
              {new Date(event.occurredAt).toLocaleTimeString()}
            </span>
          </span>

          <span className="px-4 py-3">
            <Badge
              variant="outline"
              className={cn("font-semibold", OPERATION_TONE[event.operation])}
            >
              {OPERATION_LABEL[event.operation]}
            </Badge>
          </span>

          <span className="min-w-0 px-4 py-3">
            <span className="block truncate text-sm font-medium">{event.actionLabel}</span>
            <span className="block truncate text-xs text-muted-foreground">
              {event.entityLabel}
              {event.entityId ? ` #${event.entityId}` : ""}
              {event.success ? "" : ` · failed${event.errorMessage ? `: ${event.errorMessage}` : ""}`}
            </span>
          </span>

          <span className="min-w-0 px-4 py-3">
            <span className="block truncate text-sm">{actorLabel(event)}</span>
            <span className="block truncate text-[10px] uppercase tracking-wide text-muted-foreground">
              {event.actor.role ?? "—"}
            </span>
          </span>

          <span className="min-w-0 px-4 py-3">
            <span className="block truncate text-xs">{scopeLabel(event)}</span>
            {event.ipAddress ? (
              <span className="block truncate font-mono text-[10px] text-muted-foreground">
                {event.ipAddress}
              </span>
            ) : null}
          </span>

          <span className="px-4 py-3">
            <Badge
              variant="outline"
              className={cn("font-semibold", SEVERITY_TONE[event.severity])}
              title={SEVERITY_MEANING[event.severity]}
            >
              {SEVERITY_LABEL[event.severity]}
            </Badge>
          </span>
        </button>
      </TableCell>
    </TableRow>
  )
}

function LoadingRows() {
  return (
    <div className="space-y-3 p-4" aria-busy="true" aria-label="Loading activity">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex items-center gap-4">
          <Skeleton className="h-10 w-[150px]" />
          <Skeleton className="h-10 w-[110px]" />
          <Skeleton className="h-10 flex-1" />
          <Skeleton className="h-10 w-[160px]" />
        </div>
      ))}
    </div>
  )
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-2 px-6 py-16 text-center">
      <ScrollText className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium">No activity in this period</p>
      <p className="max-w-sm text-xs text-muted-foreground">
        Nothing was recorded for the filters above. Widen the period or clear a filter — not every
        operation in the application writes an audit record yet.
      </p>
    </div>
  )
}

function ErrorState({ message, onRetry }: Readonly<{ message: string | null; onRetry: () => void }>) {
  return (
    <div role="alert" className="m-4 flex flex-col items-start gap-3 rounded-lg border border-destructive/40 bg-destructive/5 p-4">
      <div className="flex items-center gap-2 text-sm font-semibold text-destructive">
        <AlertTriangle className="h-4 w-4" aria-hidden="true" />
        The activity log could not be loaded
      </div>
      <p className="text-sm text-muted-foreground">{message ?? "Please try again."}</p>
      <Button type="button" variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  )
}
