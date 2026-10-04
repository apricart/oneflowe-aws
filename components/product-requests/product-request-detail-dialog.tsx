"use client"

import { useId, useState, type ComponentType, type ReactNode } from "react"
import {
  Building2,
  CalendarClock,
  CheckCircle2,
  Circle,
  Clock3,
  ExternalLink,
  ImageOff,
  Loader2,
  MessageSquareText,
  Package,
  ScanSearch,
  Truck,
  UserRound,
  XCircle,
} from "lucide-react"

import { DIALOG_FITS_SCREEN } from "@/components/product-requests/dialog-layout"
import { ProductRequestStatusBadge } from "@/components/product-requests/product-request-status-badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { jsonFetcher } from "@/lib/fetcher"
import {
  PRODUCT_REQUEST_LIMITS,
  addDaysToDay,
  canReviewProductRequestInStatus,
  canStartProductRequestReview,
  estimatedMonthlyValueCents,
  formatProductRequestDay,
  isProductRequestImagePath,
  normalizeReferenceUrl,
  productRequestAvailabilityBounds,
  productRequestAvailabilityRefusal,
  productRequestTitle,
  type ProductRequestListItem,
  type ProductRequestReviewStatus,
  type ProductRequestStatus,
} from "@/lib/product-request"
import { formatQuantity } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

/** A lucide icon, or anything drawn the same way. */
type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>

const dateTime = (value: string | null) =>
  value ? new Date(value).toLocaleString("en-PK", { dateStyle: "medium", timeStyle: "short" }) : "—"

/** Quick picks for the availability date, counted from today. */
const AVAILABILITY_PRESETS = [
  { label: "In 1 week", days: 7 },
  { label: "In 2 weeks", days: 14 },
  { label: "In 1 month", days: 30 },
] as const

const isDecided = (status: ProductRequestStatus) => status === "APPROVED" || status === "REJECTED"

/** Ready-made notes for the most common outcomes; the note stays editable. */
const NOTE_TEMPLATES = [
  "Added to the catalogue.",
  "Already available in the catalogue.",
  "Cannot be sourced at the moment.",
] as const

type DetailRow = { label: string; value: ReactNode }

/** A detail that was given, or nothing — empty fields are listed once, not one dash each. */
const given = (value: unknown) => value !== null && value !== undefined && value !== ""

/**
 * Everything a request carries, and who raised it. Super Admin decides it here;
 * Head Office reads the outcome. The decision buttons are presentation — the
 * PATCH handler is the control (`lib/product-request-access.ts`).
 *
 * Laid out for the decision: the figures that drive it first, the details
 * grouped by what they answer, the empty ones named in a single line, and the
 * decision itself fixed at the foot so it never scrolls away.
 */
export function ProductRequestDetailDialog({
  request,
  canReview,
  onOpenChange,
  onReviewed,
}: Readonly<{
  request: ProductRequestListItem | null
  canReview: boolean
  onOpenChange: (open: boolean) => void
  onReviewed: () => void
}>) {
  if (!request) return null

  const title = productRequestTitle(request)
  const unit = request.unit?.trim() || null
  const { productRows, sourcingRows, missing } = buildDetailRows(request, unit)

  const reviewable = canReview && canReviewProductRequestInStatus(request.status)

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent
        className="flex flex-col gap-0 overflow-hidden p-0 sm:max-w-3xl"
        // Inline, not a utility class: the dialog fitting the screen is what keeps
        // its header and its actions reachable, so it must not depend on a class
        // having been generated. The body scrolls inside this height.
        style={DIALOG_FITS_SCREEN}
      >
        <DialogHeader className="space-y-3 border-b px-6 py-4 pr-12 text-left">
          <div className="flex items-start gap-4">
            <ProductThumbnail imageUrl={request.imageUrl} alt={title} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <DialogTitle className="text-xl leading-tight">{title}</DialogTitle>
                <ProductRequestStatusBadge status={request.status} />
              </div>
              {request.category ? (
                <p className="text-sm text-slate-600 dark:text-slate-300">
                  {request.category.name}
                  {request.subcategory ? <span className="text-muted-foreground"> › {request.subcategory.name}</span> : null}
                </p>
              ) : null}
              <DialogDescription>
                Requested by {request.requestedBy.fullName || request.requestedBy.email} ({request.organization.name}) on{" "}
                {dateTime(request.createdAt)}
              </DialogDescription>
            </div>
          </div>
          <StatusTimeline request={request} />
        </DialogHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50/60 px-6 py-5 dark:bg-slate-950/40">
          <KeyFigures request={request} unit={unit} />

          {request.status === "UNDER_REVIEW" ? <UnderReviewNotice request={request} /> : null}
          {isDecided(request.status) ? <DecisionOutcome request={request} /> : null}

          <DetailCard icon={Package} title="Product">
            <DetailGrid rows={productRows} />
          </DetailCard>

          <DetailCard icon={Truck} title="Sourcing">
            <DetailGrid rows={sourcingRows} />
          </DetailCard>

          {given(request.description) || given(request.notes) ? (
            <DetailCard icon={MessageSquareText} title="Why it is needed">
              <div className="space-y-3">
                {given(request.description) ? <Narrative label="Description">{request.description}</Narrative> : null}
                {given(request.notes) ? <Narrative label="Why it is needed / notes">{request.notes}</Narrative> : null}
              </div>
            </DetailCard>
          ) : null}

          <RequestParties request={request} />

          {missing.length > 0 ? (
            <p className="text-xs text-muted-foreground">
              <span className="font-medium">Not provided:</span> {missing.join(", ")}
            </p>
          ) : null}
        </div>

        {reviewable ? (
          <ReviewPanel key={request.id} requestId={request.id} status={request.status} onReviewed={onReviewed} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/**
 * The request's details grouped as the dialog shows them, and the labels of
 * every detail that was left empty — listed once at the foot rather than as a
 * dash beside each.
 */
function buildDetailRows(request: ProductRequestListItem, unit: string | null) {
  const referenceUrl = request.referenceUrl ? normalizeReferenceUrl(request.referenceUrl) : null

  const productRows: DetailRow[] = [
    { label: "Product name", value: request.productName },
    { label: "Brand / manufacturer", value: request.brand },
    { label: "Category", value: request.category?.name },
    { label: "Subcategory", value: request.subcategory?.name },
    { label: "Unit of measure", value: unit },
    { label: "Pack size / specification", value: request.packSize },
  ]
  const sourcingRows: DetailRow[] = [
    { label: "Barcode / manufacturer code", value: request.barcode },
    { label: "Preferred supplier", value: request.preferredSupplier },
    {
      label: "Reference link",
      value: referenceUrl ? (
        <a
          href={referenceUrl}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="inline-flex max-w-full items-center gap-1 break-all text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-300"
        >
          {referenceUrl} <ExternalLink className="h-3 w-3 shrink-0" aria-hidden />
        </a>
      ) : null,
    },
  ]
  const missing = [
    ...productRows,
    ...sourcingRows,
    { label: "Expected price", value: request.expectedPriceCents },
    { label: "Monthly quantity", value: request.estimatedMonthlyQuantity },
    { label: "Description", value: request.description },
    { label: "Notes", value: request.notes },
    { label: "Image", value: isProductRequestImagePath(request.imageUrl) ? request.imageUrl : null },
  ].filter((row) => !given(row.value)).map((row) => row.label)

  return { productRows, sourcingRows, missing }
}

function ProductThumbnail({ imageUrl, alt }: Readonly<{ imageUrl: string | null; alt: string }>) {
  return (
    <div className="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl border bg-slate-100 sm:h-20 sm:w-20 dark:bg-slate-800">
      {isProductRequestImagePath(imageUrl) ? (
        // eslint-disable-next-line @next/next/no-img-element -- an authenticated application path, not a static asset
        <img src={imageUrl} alt={alt} className="h-full w-full object-cover" />
      ) : (
        <span className="flex flex-col items-center gap-1 text-[10px] text-muted-foreground">
          <ImageOff className="h-5 w-5" aria-hidden />
          No image
        </span>
      )}
    </div>
  )
}

type StepState = "done" | "current" | "todo" | "rejected"

/** The three steps of the timeline, as the request's status and dates put them. */
function timelineSteps(request: ProductRequestListItem): Array<{ label: string; detail: string; state: StepState }> {
  const decided = isDecided(request.status)
  const approved = request.status === "APPROVED"

  let reviewDetail = "Waiting for Super Admin"
  if (request.reviewStartedAt) reviewDetail = `${decided ? "" : "Since "}${dateTime(request.reviewStartedAt)}`
  else if (decided) reviewDetail = "Decided directly"
  let reviewState: StepState = "todo"
  if (request.status === "UNDER_REVIEW") reviewState = "current"
  else if (decided) reviewState = "done"

  let decisionLabel = "Decision"
  let decisionState: StepState = "todo"
  if (decided) {
    decisionLabel = approved ? "Approved" : "Rejected"
    decisionState = approved ? "done" : "rejected"
  }

  return [
    { label: "Submitted", detail: dateTime(request.createdAt), state: request.status === "PENDING" ? "current" : "done" },
    { label: "Under review", detail: reviewDetail, state: reviewState },
    { label: decisionLabel, detail: decided ? dateTime(request.reviewedAt) : "Not decided yet", state: decisionState },
  ]
}

const STEP_ICONS: Record<StepState, IconComponent> = {
  done: CheckCircle2,
  current: Clock3,
  todo: Circle,
  rejected: XCircle,
}

/**
 * Where the request stands: submitted, under review, decided. The current step
 * is marked with `aria-current`, and every step names itself in words, so the
 * colour is never the only signal.
 */
function StatusTimeline({ request }: Readonly<{ request: ProductRequestListItem }>) {
  const decided = isDecided(request.status)
  const steps = timelineSteps(request)

  return (
    <ol className="grid grid-cols-3 gap-2" aria-label="Request progress">
      {steps.map((step, index) => {
        const Icon = STEP_ICONS[step.state]
        return (
          <li
            key={step.label}
            aria-current={step.state === "current" || (decided && index === steps.length - 1) ? "step" : undefined}
            className="flex min-w-0 items-start gap-2"
          >
            <Icon
              aria-hidden
              className={cn(
                "mt-0.5 h-4 w-4 shrink-0",
                step.state === "done" && "text-emerald-600",
                step.state === "current" && "text-amber-500",
                step.state === "rejected" && "text-rose-600",
                step.state === "todo" && "text-slate-300 dark:text-slate-600",
              )}
            />
            <div className="min-w-0">
              <p className="truncate text-xs font-semibold text-slate-800 dark:text-slate-200">{step.label}</p>
              <p className="truncate text-[11px] text-muted-foreground">{step.detail}</p>
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * The three figures a decision turns on. The monthly value is only drawn when
 * both of its halves were given, and is labelled as the estimate it is.
 */
function KeyFigures({ request, unit }: Readonly<{ request: ProductRequestListItem; unit: string | null }>) {
  const monthlyValue = estimatedMonthlyValueCents(request.expectedPriceCents, request.estimatedMonthlyQuantity)
  const figures = [
    {
      label: "Expected price per unit",
      value: request.expectedPriceCents === null ? null : formatPKR(request.expectedPriceCents / 100),
      note: "For reference only",
    },
    {
      label: "Estimated monthly quantity",
      value: request.estimatedMonthlyQuantity === null ? null : formatQuantity(request.estimatedMonthlyQuantity),
      note: unit ? `${unit} per month` : "per month",
    },
    {
      label: "Estimated monthly value",
      value: monthlyValue === null ? null : `≈ ${formatPKR(monthlyValue / 100)}`,
      note: "Price × quantity",
    },
  ]
  if (figures.every((figure) => figure.value === null)) return null

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {figures.map((figure) => (
        <div
          key={figure.label}
          className="rounded-xl border border-slate-200 bg-white p-3.5 dark:border-slate-800 dark:bg-slate-900"
        >
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{figure.label}</p>
          <p className={cn("mt-1 text-lg font-semibold tabular-nums", figure.value === null ? "text-slate-400" : "text-slate-900 dark:text-white")}>
            {figure.value ?? "—"}
          </p>
          <p className="text-[11px] text-muted-foreground">{figure.value === null ? "Not provided" : figure.note}</p>
        </div>
      ))}
    </div>
  )
}

/** Tells Head Office someone is working on the request, and since when. */
function UnderReviewNotice({ request }: Readonly<{ request: ProductRequestListItem }>) {
  return (
    <div className="flex gap-3 rounded-xl border border-sky-200 bg-sky-50 p-4 dark:border-sky-900 dark:bg-sky-950/30">
      <ScanSearch aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-sky-600" />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-semibold text-sky-900 dark:text-sky-200">
          Under review<span className="font-normal text-muted-foreground"> · since {dateTime(request.reviewStartedAt)}</span>
        </p>
        <p className="text-sm text-slate-700 dark:text-slate-300">
          {request.reviewStartedBy?.fullName || "Super Admin"} is reviewing this request. The decision will appear here.
        </p>
      </div>
    </div>
  )
}

function DecisionOutcome({ request }: Readonly<{ request: ProductRequestListItem }>) {
  const approved = request.status === "APPROVED"
  const availableOn = formatProductRequestDay(request.estimatedAvailableOn)
  const Icon = approved ? CheckCircle2 : XCircle
  return (
    <div
      className={cn(
        "flex gap-3 rounded-xl border p-4",
        approved
          ? "border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/30"
          : "border-rose-200 bg-rose-50 dark:border-rose-900 dark:bg-rose-950/30",
      )}
    >
      <Icon aria-hidden className={cn("mt-0.5 h-5 w-5 shrink-0", approved ? "text-emerald-600" : "text-rose-600")} />
      <div className="min-w-0 space-y-1">
        <p className={cn("text-sm font-semibold", approved ? "text-emerald-900 dark:text-emerald-200" : "text-rose-900 dark:text-rose-200")}>
          <span>{approved ? "Approved by" : "Rejected by"}</span> {request.reviewedBy?.fullName || "Super Admin"}
          <span className="font-normal text-muted-foreground"> · {dateTime(request.reviewedAt)}</span>
        </p>
        {approved ? (
          <p className="flex items-center gap-1.5 text-sm text-emerald-900 dark:text-emerald-200">
            <CalendarClock aria-hidden className="h-4 w-4 shrink-0" />
            {availableOn ? (
              <span>Expected in the catalogue by <span className="font-semibold">{availableOn}</span></span>
            ) : (
              <span className="text-muted-foreground">No availability date was given.</span>
            )}
          </p>
        ) : null}
        {request.reviewNote ? (
          <p className="whitespace-pre-line break-words text-sm text-slate-700 dark:text-slate-300">{request.reviewNote}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No note was left.</p>
        )}
      </div>
    </div>
  )
}

function DetailCard({ icon: Icon, title, children }: Readonly<{ icon: IconComponent; title: string; children: ReactNode }>) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-800 dark:bg-slate-900"
    >
      <h3 id={headingId} className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-900 dark:text-slate-100">
        <Icon className="h-4 w-4 text-indigo-600 dark:text-indigo-300" aria-hidden />
        {title}
      </h3>
      {children}
    </section>
  )
}

/** Only the details that were given; the rest are named once at the foot. */
function DetailGrid({ rows }: Readonly<{ rows: DetailRow[] }>) {
  const present = rows.filter((row) => given(row.value))
  if (present.length === 0) return <p className="text-sm text-muted-foreground">Nothing provided.</p>
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {present.map((row) => (
        <div key={row.label} className="min-w-0 space-y-0.5">
          <dt className="text-xs font-medium text-muted-foreground">{row.label}</dt>
          <dd className="break-words text-sm text-slate-900 dark:text-slate-100">{row.value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Narrative({ label, children }: Readonly<{ label: string; children: ReactNode }>) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className="whitespace-pre-line break-words rounded-lg border-l-4 border-indigo-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 dark:border-indigo-500/40 dark:bg-slate-950/40 dark:text-slate-200">
        {children}
      </p>
    </div>
  )
}

/** Who asked, and for which organization. */
function RequestParties({ request }: Readonly<{ request: ProductRequestListItem }>) {
  return (
    <div className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 dark:border-slate-800 dark:bg-slate-900">
      <Party icon={UserRound} label="Requested by">
        {request.requestedBy.fullName || "—"}
        <span className="block text-xs text-muted-foreground">{request.requestedBy.email}</span>
      </Party>
      <Party icon={Building2} label="Organization">{request.organization.name}</Party>
    </div>
  )
}

function Party({ icon: Icon, label, children }: Readonly<{ icon: IconComponent; label: string; children: ReactNode }>) {
  return (
    <div className="flex min-w-0 items-start gap-3">
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-slate-500 dark:bg-slate-800">
        <Icon className="h-4 w-4" aria-hidden />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <div className="break-words text-sm text-slate-900 dark:text-slate-100">{children}</div>
      </div>
    </div>
  )
}

/** The body each move sends; every shape is strict on the server, so each carries only its own fields. */
function reviewBody(status: ProductRequestReviewStatus, note: string, availableOn: string) {
  if (status === "UNDER_REVIEW") return { status }
  if (status === "APPROVED") return { status, reviewNote: note, estimatedAvailableOn: availableOn }
  return { status, reviewNote: note }
}

const REVIEW_TOASTS: Record<ProductRequestReviewStatus, string> = {
  UNDER_REVIEW: "Marked as under review",
  APPROVED: "Request approved",
  REJECTED: "Request rejected",
}

/**
 * Super Admin's actions, fixed at the foot of the dialog. Keyed by request id
 * where it is rendered, so opening another request starts with an empty note
 * and no date. Every button is disabled while a move is in flight; the
 * server's row lock turns a second one into a 409. The date is checked here
 * only so the mistake is named beside the field — the server is the control.
 */
function ReviewPanel({
  requestId,
  status,
  onReviewed,
}: Readonly<{ requestId: number; status: ProductRequestStatus; onReviewed: () => void }>) {
  const { toast } = useToast()
  const [note, setNote] = useState("")
  const [availableOn, setAvailableOn] = useState("")
  const [bounds] = useState(() => productRequestAvailabilityBounds(new Date()))
  const [pending, setPending] = useState<ProductRequestReviewStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [dateError, setDateError] = useState<string | null>(null)
  const canStartReview = canStartProductRequestReview(status)

  const chooseDate = (value: string) => {
    setAvailableOn(value)
    setDateError(null)
  }

  const submit = async (next: ProductRequestReviewStatus) => {
    if (pending) return
    setError(null)
    setDateError(null)
    if (next === "APPROVED") {
      const refusal = availableOn
        ? productRequestAvailabilityRefusal(availableOn, new Date())
        : "Choose the date the product is expected in the catalogue"
      if (refusal) {
        setDateError(refusal)
        return
      }
    }
    setPending(next)
    try {
      await jsonFetcher(`/api/v1/product-requests/${requestId}`, {
        method: "PATCH",
        body: JSON.stringify(reviewBody(next, note, availableOn)),
      })
      toast({ title: REVIEW_TOASTS[next] })
      onReviewed()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "The decision could not be saved")
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-2.5 border-t bg-white px-6 py-3.5 dark:bg-slate-900">
      <div className="grid gap-3 sm:grid-cols-[1fr_auto]">
        <div className="space-y-1.5">
          <div className="flex items-baseline justify-between gap-2">
            <Label htmlFor="product-request-review-note">Note to Head Office (optional)</Label>
            <span className="text-[11px] tabular-nums text-muted-foreground">{note.length}/{PRODUCT_REQUEST_LIMITS.reviewNote}</span>
          </div>
          <Textarea
            id="product-request-review-note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            maxLength={PRODUCT_REQUEST_LIMITS.reviewNote}
            rows={2}
            placeholder="e.g. Added as product KE-1042, or why it cannot be stocked"
            className="min-h-0 resize-y"
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Note templates">
            {NOTE_TEMPLATES.map((template) => (
              <ChipButton key={template} onClick={() => setNote(template)} disabled={pending !== null}>
                {template}
              </ChipButton>
            ))}
          </div>
        </div>
        <div className="space-y-1.5 sm:w-56">
          <Label htmlFor="product-request-available-on">Expected in catalogue by</Label>
          <Input
            id="product-request-available-on"
            type="date"
            value={availableOn}
            min={bounds.min}
            max={bounds.max}
            onChange={(event) => chooseDate(event.target.value)}
            aria-invalid={dateError ? true : undefined}
            aria-describedby="product-request-available-on-hint"
          />
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Availability presets">
            {AVAILABILITY_PRESETS.map((preset) => (
              <ChipButton
                key={preset.label}
                onClick={() => chooseDate(addDaysToDay(bounds.min, preset.days))}
                disabled={pending !== null}
              >
                {preset.label}
              </ChipButton>
            ))}
          </div>
          <p
            id="product-request-available-on-hint"
            className={cn("text-[11px]", dateError ? "font-medium text-destructive" : "text-muted-foreground")}
          >
            {dateError ?? "Required to approve. Head Office sees this date."}
          </p>
        </div>
      </div>
      {error ? (
        <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-destructive dark:border-rose-900 dark:bg-rose-950/40">
          {error}
        </p>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs text-muted-foreground">
          Approving does <span className="font-semibold">not</span> add the product to the catalogue — add it from
          Global Products by the date you give. A decision cannot be changed afterwards.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          {canStartReview ? (
            <Button
              variant="outline"
              onClick={() => submit("UNDER_REVIEW")}
              disabled={pending !== null}
              className="border-sky-200 text-sky-700 hover:bg-sky-50 hover:text-sky-800 dark:border-sky-900 dark:text-sky-300 dark:hover:bg-sky-950/40"
            >
              {pending === "UNDER_REVIEW" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ScanSearch className="mr-2 h-4 w-4" />}
              Mark under review
            </Button>
          ) : null}
          <Button
            variant="outline"
            onClick={() => submit("REJECTED")}
            disabled={pending !== null}
            className="border-rose-200 text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:border-rose-900 dark:text-rose-300 dark:hover:bg-rose-950/40"
          >
            {pending === "REJECTED" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <XCircle className="mr-2 h-4 w-4" />}
            Reject
          </Button>
          <Button
            onClick={() => submit("APPROVED")}
            disabled={pending !== null}
            className="bg-emerald-600 text-white hover:bg-emerald-700"
          >
            {pending === "APPROVED" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <CheckCircle2 className="mr-2 h-4 w-4" />}
            Approve
          </Button>
        </div>
      </div>
    </div>
  )
}

function ChipButton({
  onClick,
  disabled,
  children,
}: Readonly<{ onClick: () => void; disabled: boolean; children: ReactNode }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs text-slate-600 transition-colors hover:border-indigo-300 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300"
    >
      {children}
    </button>
  )
}
