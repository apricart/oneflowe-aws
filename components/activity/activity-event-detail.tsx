"use client"

import { ArrowRight } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import type { ActivityEvent } from "@/lib/activity-log"
import {
  OPERATION_LABEL,
  OPERATION_TONE,
  SEVERITY_LABEL,
  SEVERITY_MEANING,
  SEVERITY_TONE,
  actorLabel,
  changedFields,
  contextEntries,
  scopeLabel,
} from "@/lib/activity-log-view"
import { cn } from "@/lib/utils"

/**
 * One event in full: who, where, from what address, and — where the writer
 * recorded both sides — exactly which fields changed and to what.
 *
 * The before/after table is the part the audit review asked for. Everything
 * else the writer put in `metadata` is shown below it, verbatim, because an
 * audit record a reader cannot see all of is one they cannot rely on.
 */

function formatValue(value: unknown): string {
  if (value === undefined) return "—"
  if (value === null) return "null"
  if (typeof value === "string") return value.length > 0 ? value : '""'
  if (typeof value === "object") return JSON.stringify(value, null, 2)
  return String(value)
}

function Row({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div className="grid grid-cols-[minmax(0,7rem)_1fr] gap-3 py-1.5 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium">{children}</dd>
    </div>
  )
}

type Props = Readonly<{
  event: ActivityEvent | null
  onClose: () => void
}>

export function ActivityEventDetail({ event, onClose }: Props) {
  return (
    <Sheet open={event !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        {event ? <DetailBody event={event} /> : null}
      </SheetContent>
    </Sheet>
  )
}

function DetailBody({ event }: Readonly<{ event: ActivityEvent }>) {
  const changes = changedFields(event.metadata)
  const context = contextEntries(event.metadata)

  return (
    <>
      <SheetHeader className="space-y-3 text-left">
        <SheetTitle className="text-lg">{event.actionLabel}</SheetTitle>
        <SheetDescription>
          {new Date(event.occurredAt).toLocaleString()} · {actorLabel(event)}
        </SheetDescription>
        <div className="flex flex-wrap gap-2">
          <Badge variant="outline" className={cn("font-semibold", OPERATION_TONE[event.operation])}>
            {OPERATION_LABEL[event.operation]}
          </Badge>
          <Badge
            variant="outline"
            className={cn("font-semibold", SEVERITY_TONE[event.severity])}
            title={SEVERITY_MEANING[event.severity]}
          >
            {SEVERITY_LABEL[event.severity]}
          </Badge>
          <Badge variant="outline" className="font-semibold capitalize">
            {event.category}
          </Badge>
          {event.success ? null : (
            <Badge variant="destructive" className="font-semibold">
              Failed
            </Badge>
          )}
        </div>
      </SheetHeader>

      <Separator className="my-4" />

      <dl className="divide-y divide-border">
        <Row label="Action">
          <code className="rounded bg-muted px-1.5 py-0.5 text-xs">{event.action}</code>
        </Row>
        <Row label="Record">
          {event.entityLabel}
          {event.entityId ? (
            <span className="ml-1 text-muted-foreground">#{event.entityId}</span>
          ) : null}
        </Row>
        <Row label="Person">
          <div className="space-y-0.5">
            <div>{actorLabel(event)}</div>
            {event.actor.email && event.actor.email !== actorLabel(event) ? (
              <div className="text-xs text-muted-foreground">{event.actor.email}</div>
            ) : null}
            {event.actor.role ? (
              <div className="text-xs uppercase tracking-wide text-muted-foreground">
                {event.actor.role}
              </div>
            ) : null}
            {event.actor.id ? (
              <div className="font-mono text-[10px] text-muted-foreground">{event.actor.id}</div>
            ) : null}
          </div>
        </Row>
        <Row label="Scope">{scopeLabel(event)}</Row>
        <Row label="Address">
          {event.ipAddress ? (
            <code className="font-mono text-xs">{event.ipAddress}</code>
          ) : (
            <span className="text-muted-foreground">
              {event.actor.redacted ? "Withheld" : "Not recorded"}
            </span>
          )}
        </Row>
        {event.userAgent ? (
          <Row label="Device">
            <span className="break-all text-xs text-muted-foreground">{event.userAgent}</span>
          </Row>
        ) : null}
        {event.errorMessage ? (
          <Row label="Reason">
            <span className="text-destructive">{event.errorMessage}</span>
          </Row>
        ) : null}
        <Row label="Recorded in">
          <code className="text-xs">{event.id}</code>
        </Row>
      </dl>

      {changes.length > 0 ? (
        <section className="mt-6" aria-labelledby="activity-changes-heading">
          <h3 id="activity-changes-heading" className="mb-2 text-sm font-semibold">
            What changed
          </h3>
          <ul className="space-y-2">
            {changes.map((change) => (
              <li key={change.field} className="rounded-lg border bg-muted/30 p-3">
                <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {change.field}
                </div>
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 text-xs">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-rose-700 dark:text-rose-300">
                    {formatValue(change.before)}
                  </pre>
                  <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" aria-label="changed to" />
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-background p-2 font-mono text-emerald-700 dark:text-emerald-300">
                    {formatValue(change.after)}
                  </pre>
                </div>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {context.length > 0 ? (
        <section className="mt-6" aria-labelledby="activity-context-heading">
          <h3 id="activity-context-heading" className="mb-2 text-sm font-semibold">
            Recorded details
          </h3>
          <dl className="divide-y divide-border rounded-lg border">
            {context.map(([key, value]) => (
              <div key={key} className="grid grid-cols-[minmax(0,8rem)_1fr] gap-3 p-3 text-xs">
                <dt className="font-medium text-muted-foreground">{key}</dt>
                <dd className="min-w-0">
                  <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono">
                    {formatValue(value)}
                  </pre>
                </dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}
    </>
  )
}
