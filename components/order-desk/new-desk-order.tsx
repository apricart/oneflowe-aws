"use client"

import { useMemo, useRef, useState } from "react"
import useSWR from "swr"
import {
  Building2,
  CheckCircle2,
  Circle,
  ImagePlus,
  Info,
  Loader2,
  PackageSearch,
  Search,
  ShoppingBasket,
  Trash2,
  X,
} from "lucide-react"

import { QuantityStepper } from "@/components/group-portal/quantity-stepper"
import { CHANNEL_META, StepHeading } from "@/components/order-desk/desk-theme"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { fetcher } from "@/lib/fetcher"
import { formatPriceInput } from "@/lib/group-price-input"
import { INTAKE_CHANNELS, INTAKE_REFERENCE_MAX_LENGTH } from "@/lib/order-desk-access"
import {
  buildDeskOrderRequest,
  deskDraftChecklist,
  deskLineUnitPriceCents,
  estimateDraftTotalCents,
  filledLines,
  isDeskPriceChanged,
  parseDeskPriceInput,
  NOTES_MAX_LENGTH,
  SCREENSHOT_TYPES,
  screenshotFileError,
  type DeskCatalogueItem,
  unavailableDraftLines,
  type DeskDraft,
  type DeskDraftCheck,
} from "@/lib/order-desk-draft"
import { MAX_PO_NUMBER_LENGTH } from "@/lib/purchase-order"
import { calculateLineCents, formatQuantity, parseQuantity, sanitizeQuantityStep } from "@/lib/quantity"
import { cn, formatPKR } from "@/lib/utils"

type Target = {
  id: number
  name: string
  code: string | null
  branches: { id: number; name: string; city: string | null }[]
}

type CatalogueItem = DeskCatalogueItem & {
  productCode: string
  unit: string
  stockQuantity: number
}

type SummaryLine = { organizationInventoryId: number; raw: string; item: CatalogueItem }

/** The order just created, shown until the desk user starts the next one. */
type CreatedOrder = { tid: string; customer: string; totalCents: number | null }

const EMPTY_DRAFT: DeskDraft = {
  organizationId: null,
  branchId: null,
  quantities: {},
  prices: {},
  intakeChannel: "",
  intakeReference: "",
  poNumber: "",
  notes: "",
  intakeAttachmentKey: null,
}

function newIdempotencyKey() {
  return `desk-${crypto.randomUUID()}`
}

function Optional() {
  return <span className="font-normal text-muted-foreground">(optional)</span>
}

function CreatedPanel({
  created,
  onNext,
  onViewOrders,
}: Readonly<{ created: CreatedOrder; onNext: () => void; onViewOrders: () => void }>) {
  return (
    <Card className="mx-auto max-w-xl border-emerald-200 dark:border-emerald-900">
      <CardContent className="space-y-5 p-8 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-950">
          <CheckCircle2 className="h-8 w-8 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        </div>
        <div className="space-y-1">
          <h2 className="text-xl font-semibold">Order {created.tid} created</h2>
          <p className="text-sm text-muted-foreground">{created.customer}</p>
          {created.totalCents !== null && <p className="text-sm font-medium">{formatPKR(created.totalCents / 100)}</p>}
        </div>
        <p className="rounded-md bg-muted/50 p-3 text-sm text-muted-foreground">
          It is <span className="font-medium text-foreground">awaiting approval</span> by an Apricart Executive. Once
          approved and delivered, it shows under <span className="font-medium text-foreground">Ready to fulfil</span>.
        </p>
        <div className="flex flex-col justify-center gap-2 sm:flex-row">
          <Button onClick={onNext}>Create another order</Button>
          <Button variant="outline" onClick={onViewOrders}>View orders</Button>
        </div>
      </CardContent>
    </Card>
  )
}

function NoTargets() {
  return (
    <Card>
      <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
        <Building2 className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
        <h2 className="text-lg font-semibold">No organizations assigned yet</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          Ask a Super Admin to give you access in <span className="font-medium">Order Desk Team</span>. The organizations
          and branches you are assigned will appear here.
        </p>
      </CardContent>
    </Card>
  )
}

function CustomerStep({
  targets,
  loading,
  organization,
  branchId,
  disabled,
  onOrganization,
  onBranch,
}: Readonly<{
  targets: Target[]
  loading: boolean
  organization: Target | null
  branchId: number | null
  disabled: boolean
  onOrganization: (value: string) => void
  onBranch: (value: string) => void
}>) {
  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <StepHeading
          number={1}
          done={Boolean(organization && branchId)}
          title="Customer"
          description="Which organization and branch is this order for?"
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="desk-organization">Organization</Label>
            <Select value={organization ? String(organization.id) : ""} onValueChange={onOrganization}>
              <SelectTrigger id="desk-organization" className="w-full" disabled={loading || disabled}>
                <SelectValue placeholder={loading ? "Loading…" : "Select organization"} />
              </SelectTrigger>
              <SelectContent>
                {targets.map((target) => (
                  <SelectItem key={target.id} value={String(target.id)}>
                    {target.name}{target.code ? ` (${target.code})` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="desk-branch">Branch</Label>
            <Select value={branchId ? String(branchId) : ""} onValueChange={onBranch}>
              <SelectTrigger id="desk-branch" className="w-full" disabled={!organization || disabled}>
                <SelectValue placeholder={organization ? "Select branch" : "Choose an organization first"} />
              </SelectTrigger>
              <SelectContent>
                {(organization?.branches ?? []).map((option) => (
                  <SelectItem key={option.id} value={String(option.id)}>
                    {option.name}{option.city ? ` — ${option.city}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

/**
 * The price the order charges for this product. Blank charges the catalogue
 * price (shown as the placeholder); anything typed is charged instead and shown
 * to the approving executive beside the catalogue price.
 */
function LinePriceInput({
  item,
  rawPrice,
  disabled,
  onPrice,
}: Readonly<{ item: CatalogueItem; rawPrice: string | undefined; disabled: boolean; onPrice: (raw: string) => void }>) {
  const invalid = parseDeskPriceInput(rawPrice, item.name).kind === "invalid"
  return (
    <div className="relative w-28">
      <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-muted-foreground" aria-hidden="true">Rs</span>
      <Input
        aria-label={`Price per ${item.unit} of ${item.name}, in rupees including tax`}
        aria-invalid={invalid}
        inputMode="decimal"
        placeholder={item.priceCents === null ? "Price" : formatPriceInput(item.priceCents)}
        value={rawPrice ?? ""}
        disabled={disabled}
        onChange={(event) => onPrice(event.target.value)}
        className={cn("h-9 pl-8 text-right tabular-nums", invalid && "border-rose-400 focus-visible:ring-rose-400")}
      />
    </div>
  )
}

function ProductRow({
  item,
  raw,
  rawPrice,
  disabled,
  onQuantity,
  onPrice,
}: Readonly<{
  item: CatalogueItem
  raw: string | undefined
  rawPrice: string | undefined
  disabled: boolean
  onQuantity: (quantity: number) => void
  onPrice: (raw: string) => void
}>) {
  const quantity = parseQuantity(raw || 0)
  const selected = Number.isFinite(quantity) && quantity > 0
  const outOfStock = item.stockQuantity <= 0
  const changed = isDeskPriceChanged(item, rawPrice)
  const price = item.priceCents === null ? "No catalogue price" : `${formatPKR(item.priceCents / 100)} per ${item.unit}`
  return (
    <li className={cn("flex flex-wrap items-center justify-between gap-3 px-3 py-2.5 transition-colors", selected && "bg-indigo-50/70 dark:bg-indigo-950/30")}>
      <div className="min-w-0 flex-1">
        <p className="truncate font-medium">{item.name}</p>
        <p className="text-xs text-muted-foreground">
          {item.productCode} · <span className={cn(changed && "line-through")}>{price}</span>
          {changed && (
            <span className="ml-1 font-medium text-indigo-700 dark:text-indigo-300">
              Custom {formatPKR((deskLineUnitPriceCents(item, rawPrice) ?? 0) / 100)}
            </span>
          )}
          {" "}·{" "}
          <span className={cn(outOfStock && "font-medium text-amber-700 dark:text-amber-400")}>
            {outOfStock ? "Out of stock" : `${formatQuantity(item.stockQuantity)} in stock`}
          </span>
        </p>
      </div>
      <div className="flex items-center gap-2">
        <LinePriceInput item={item} rawPrice={rawPrice} disabled={disabled} onPrice={onPrice} />
        <QuantityStepper
          value={selected ? quantity : 0}
          step={sanitizeQuantityStep(item.allowDecimalQuantity, item.quantityStep)}
          label={`Quantity of ${item.name}`}
          disabled={disabled}
          onChange={onQuantity}
        />
      </div>
    </li>
  )
}

function ProductsStep({
  catalogueUrl,
  catalogue,
  loading,
  failed,
  quantities,
  prices,
  disabled,
  onQuantity,
  onPrice,
}: Readonly<{
  catalogueUrl: string | null
  catalogue: CatalogueItem[]
  loading: boolean
  failed: boolean
  quantities: Readonly<Record<number, string>>
  prices: Readonly<Record<number, string>>
  disabled: boolean
  onQuantity: (inventoryId: number, quantity: number) => void
  onPrice: (inventoryId: number, raw: string) => void
}>) {
  const [search, setSearch] = useState("")
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return catalogue
    return catalogue.filter((item) => item.name.toLowerCase().includes(term) || item.productCode.toLowerCase().includes(term))
  }, [catalogue, search])
  const chosen = Object.values(quantities).filter((value) => value.trim() !== "").length

  let body: React.ReactNode
  if (!catalogueUrl) {
    body = (
      <div className="flex items-center gap-3 rounded-md border border-dashed p-6 text-sm text-muted-foreground">
        <PackageSearch className="h-5 w-5 shrink-0" aria-hidden="true" />
        Choose the organization and branch first — the branch&apos;s own products and prices appear here.
      </div>
    )
  } else if (failed) {
    body = <p role="alert" className="text-sm text-destructive">Could not load this branch&apos;s products.</p>
  } else if (loading) {
    body = (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading products…
      </p>
    )
  } else if (catalogue.length === 0) {
    body = <p className="text-sm text-muted-foreground">No products are assigned to this branch yet.</p>
  } else {
    body = (
      <>
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
          <Input
            aria-label="Search products"
            placeholder="Search by product name or code"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="pl-9"
          />
        </div>
        {visible.length === 0 ? (
          <p className="text-sm text-muted-foreground">No product matches &ldquo;{search}&rdquo;.</p>
        ) : (
          <ul className="max-h-[460px] divide-y overflow-auto rounded-md border">
            {visible.map((item) => (
              <ProductRow
                key={item.organizationInventoryId}
                item={item}
                raw={quantities[item.organizationInventoryId]}
                rawPrice={prices[item.organizationInventoryId]}
                disabled={disabled}
                onQuantity={(quantity) => onQuantity(item.organizationInventoryId, quantity)}
                onPrice={(raw) => onPrice(item.organizationInventoryId, raw)}
              />
            ))}
          </ul>
        )}
      </>
    )
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5">
        <StepHeading
          number={2}
          done={chosen > 0}
          title="Products"
          description="Set a quantity for each product the customer asked for. Leave the price blank to charge the catalogue price, or type the price agreed with the customer (including tax)."
        />
        {body}
      </CardContent>
    </Card>
  )
}

function ScreenshotField({
  preview,
  uploading,
  disabled,
  onUpload,
  onClear,
}: Readonly<{
  preview: string | null
  uploading: boolean
  disabled: boolean
  onUpload: (file: File | undefined) => void
  onClear: () => void
}>) {
  return (
    <div className="space-y-2">
      <Label htmlFor="desk-screenshot">Screenshot of the message</Label>
      {preview ? (
        <div className="relative overflow-hidden rounded-md border bg-muted/30">
          {/* A local object URL of the file just uploaded, not a remote image. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Screenshot of the customer's message" className="max-h-56 w-full object-contain" />
          <Button type="button" size="sm" variant="secondary" className="absolute right-2 top-2" onClick={onClear} disabled={disabled}>
            <X className="mr-1 h-4 w-4" aria-hidden="true" /> Remove
          </Button>
        </div>
      ) : (
        <label
          htmlFor="desk-screenshot"
          className={cn(
            "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed p-5 text-center text-sm text-muted-foreground transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 dark:hover:bg-indigo-950/20",
            uploading && "pointer-events-none opacity-70",
          )}
        >
          {uploading ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden="true" /> : <ImagePlus className="h-5 w-5" aria-hidden="true" />}
          <span className="font-medium text-foreground">{uploading ? "Uploading…" : "Upload a WhatsApp or email screenshot"}</span>
          <span className="text-xs">PNG, JPEG, WebP or GIF, up to 4 MB. Kept private to the Order Desk.</span>
        </label>
      )}
      <input
        id="desk-screenshot"
        type="file"
        accept={SCREENSHOT_TYPES.join(",")}
        className="sr-only"
        disabled={uploading || disabled}
        onChange={(event) => {
          onUpload(event.target.files?.[0])
          event.target.value = ""
        }}
      />
    </div>
  )
}

function OriginStep({
  draft,
  disabled,
  update,
  screenshot,
}: Readonly<{
  draft: DeskDraft
  disabled: boolean
  update: (patch: Partial<DeskDraft>) => void
  screenshot: React.ReactNode
}>) {
  return (
    <Card>
      <CardContent className="space-y-5 p-5">
        <StepHeading
          number={3}
          done={draft.intakeChannel !== "" && draft.intakeReference.trim() !== "" && Boolean(draft.intakeAttachmentKey)}
          title="Where the order came from"
          description="So anyone can trace this order back to the customer's message."
        />
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Order channel</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {INTAKE_CHANNELS.map((channel) => {
              const meta = CHANNEL_META[channel]
              const Icon = meta.icon
              const selected = draft.intakeChannel === channel
              return (
                <button
                  key={channel}
                  type="button"
                  aria-pressed={selected}
                  disabled={disabled}
                  onClick={() => update({ intakeChannel: channel })}
                  className={cn(
                    "flex items-center justify-center gap-2 rounded-md border px-3 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500",
                    selected ? meta.selected : "bg-background hover:bg-muted/60",
                  )}
                >
                  <Icon className={cn("h-4 w-4", !selected && meta.tone)} aria-hidden="true" />
                  {meta.label}
                </button>
              )
            })}
          </div>
        </fieldset>

        <div className="space-y-2">
          <Label htmlFor="desk-intake-reference">Reference</Label>
          <Input
            id="desk-intake-reference"
            placeholder="e.g. Ali Khan, WhatsApp 10:14 — or the email subject"
            maxLength={INTAKE_REFERENCE_MAX_LENGTH}
            value={draft.intakeReference}
            onChange={(event) => update({ intakeReference: event.target.value })}
            disabled={disabled}
          />
        </div>

        {screenshot}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="desk-po-number">Customer PO number <Optional /></Label>
            <Input
              id="desk-po-number"
              maxLength={MAX_PO_NUMBER_LENGTH}
              value={draft.poNumber}
              onChange={(event) => update({ poNumber: event.target.value })}
              disabled={disabled}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="desk-notes">Notes <Optional /></Label>
            <Textarea
              id="desk-notes"
              rows={2}
              maxLength={NOTES_MAX_LENGTH}
              value={draft.notes}
              onChange={(event) => update({ notes: event.target.value })}
              disabled={disabled}
            />
          </div>
        </div>
      </CardContent>
    </Card>
  )
}

function SummaryLines({
  lines,
  prices,
  disabled,
  onRemove,
}: Readonly<{ lines: SummaryLine[]; prices: Readonly<Record<number, string>>; disabled: boolean; onRemove: (inventoryId: number) => void }>) {
  if (lines.length === 0) return <p className="text-sm text-muted-foreground">Nothing added yet.</p>
  return (
    <ul className="space-y-2">
      {lines.map(({ organizationInventoryId, raw, item }) => {
        const quantity = parseQuantity(raw)
        const unitPriceCents = deskLineUnitPriceCents(item, prices[organizationInventoryId])
        const changed = isDeskPriceChanged(item, prices[organizationInventoryId])
        const lineTotal = unitPriceCents === null ? "—" : formatPKR(calculateLineCents(unitPriceCents, quantity) / 100)
        return (
          <li key={organizationInventoryId} className="flex items-start justify-between gap-2 text-sm">
            <div className="min-w-0">
              <p className="truncate font-medium">{item.name}</p>
              <p className="text-xs text-muted-foreground">
                {formatQuantity(quantity)} {item.unit}
                {unitPriceCents !== null && ` × ${formatPKR(unitPriceCents / 100)}`}
                {changed && <span className="ml-1 font-medium text-indigo-700 dark:text-indigo-300">(custom price)</span>}
              </p>
            </div>
            <div className="flex items-center gap-1">
              <span className="whitespace-nowrap">{lineTotal}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-muted-foreground hover:text-rose-600"
                aria-label={`Remove ${item.name}`}
                disabled={disabled}
                onClick={() => onRemove(organizationInventoryId)}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}

function Checklist({ checks }: Readonly<{ checks: DeskDraftCheck[] }>) {
  return (
    <ul className="space-y-1.5" aria-label="What this order still needs">
      {checks.map((check) => (
        <li key={check.key} className={cn("flex items-center gap-2 text-sm", check.done ? "text-foreground" : "text-muted-foreground")}>
          {check.done
            ? <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            : <Circle className="h-4 w-4" aria-hidden="true" />}
          <span>{check.label}</span>
          <span className="sr-only">{check.done ? "done" : "still needed"}</span>
        </li>
      ))}
    </ul>
  )
}

/**
 * Products chosen earlier that the branch no longer offers (the catalogue was
 * refreshed after a product was hidden or unassigned). They have no row above,
 * so they are named here with a way out; otherwise the order can never be sent.
 */
function UnavailableLines({ count, disabled, onRemove }: Readonly<{ count: number; disabled: boolean; onRemove: () => void }>) {
  if (count === 0) return null
  return (
    <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
      <span>
        {count === 1 ? "1 product you chose is" : `${count} products you chose are`} no longer available for this branch.
      </span>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRemove}>
        Remove {count === 1 ? "it" : "them"}
      </Button>
    </div>
  )
}

function SummaryPanel({
  organization,
  branchName,
  lines,
  prices,
  unavailableCount,
  estimatedCents,
  checks,
  formError,
  busy,
  submitting,
  onRemove,
  onRemoveUnavailable,
  onSubmit,
}: Readonly<{
  organization: Target | null
  branchName: string | null
  lines: SummaryLine[]
  prices: Readonly<Record<number, string>>
  unavailableCount: number
  estimatedCents: number
  checks: DeskDraftCheck[]
  formError: string | null
  busy: boolean
  submitting: boolean
  onRemove: (inventoryId: number) => void
  onRemoveUnavailable: () => void
  onSubmit: () => void
}>) {
  const ready = checks.every((check) => check.done)
  return (
    <aside className="lg:sticky lg:top-24 lg:self-start">
      <Card className="overflow-hidden">
        <div className="flex items-center gap-2 border-b bg-indigo-50/60 px-5 py-3 dark:bg-indigo-950/30">
          <ShoppingBasket className="h-4 w-4 text-indigo-600 dark:text-indigo-400" aria-hidden="true" />
          <h2 className="text-sm font-semibold">Order summary</h2>
        </div>
        <CardContent className="space-y-4 p-5">
          <div className="text-sm">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Customer</p>
            <p className="font-medium">{organization?.name ?? "—"}</p>
            <p className="text-muted-foreground">{branchName ?? "No branch chosen"}</p>
          </div>
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Products ({lines.length})</p>
            <SummaryLines lines={lines} prices={prices} disabled={busy} onRemove={onRemove} />
            <UnavailableLines count={unavailableCount} disabled={busy} onRemove={onRemoveUnavailable} />
          </div>
          <div className="flex items-baseline justify-between border-t pt-3">
            <span className="text-sm font-medium">Estimated total</span>
            <span className="text-lg font-semibold">{formatPKR(estimatedCents / 100)}</span>
          </div>
          <Checklist checks={checks} />
          {formError && (
            <p role="alert" className="rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
              {formError}
            </p>
          )}
          <Button className="w-full" size="lg" onClick={onSubmit} disabled={!ready || busy}>
            {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            Create order
          </Button>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            An Apricart Executive approves the order before delivery, and sees any price you typed beside the catalogue price. The final total is calculated when it is created.
          </p>
        </CardContent>
      </Card>
    </aside>
  )
}

/**
 * A new order in three steps — the customer, the products, where the order
 * came from — with a summary beside them that says what is still missing.
 * The order is created through the same endpoint every role uses and comes
 * back pending, for an Apricart Executive to approve.
 */
export function NewDeskOrder({ onViewOrders }: Readonly<{ onViewOrders: () => void }>) {
  const [draft, setDraft] = useState<DeskDraft>(EMPTY_DRAFT)
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  // A local preview of the chosen file; the server keeps the screenshot private.
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null)
  const [created, setCreated] = useState<CreatedOrder | null>(null)
  // One key per draft: a retried submit of the same draft is answered with the
  // order it already created instead of creating a second one.
  const idempotencyKey = useRef(newIdempotencyKey())

  const { data: targetData, error: targetError, isLoading: targetsLoading } = useSWR<{ items: Target[] }>(
    "/api/v1/order-desk/targets",
    fetcher,
  )
  const targets = targetData?.items ?? []
  const organization = targets.find((target) => target.id === draft.organizationId) ?? null
  const branch = organization?.branches.find((candidate) => candidate.id === draft.branchId) ?? null

  const catalogueUrl = draft.organizationId && draft.branchId
    ? `/api/v1/order-desk/catalogue?organizationId=${draft.organizationId}&branchId=${draft.branchId}`
    : null
  const { data: catalogueData, error: catalogueError, isLoading: catalogueLoading } = useSWR<{ items: CatalogueItem[] }>(
    catalogueUrl,
    fetcher,
  )
  const catalogue = useMemo(() => catalogueData?.items ?? [], [catalogueData])
  const byId = useMemo(() => new Map(catalogue.map((item) => [item.organizationInventoryId, item])), [catalogue])
  const lines: SummaryLine[] = filledLines(draft).flatMap((line) => {
    const item = byId.get(line.organizationInventoryId)
    return item ? [{ ...line, item }] : []
  })
  // Judged only once the catalogue has loaded, or every line would look unavailable.
  const unavailable = catalogueData ? unavailableDraftLines(draft.quantities, catalogue) : []

  const update = (patch: Partial<DeskDraft>) => {
    setFormError(null)
    setDraft((current) => ({ ...current, ...patch }))
  }

  const setQuantity = (inventoryId: number, quantity: number) => {
    setFormError(null)
    setDraft((current) => ({
      ...current,
      quantities: { ...current.quantities, [inventoryId]: quantity > 0 ? String(quantity) : "" },
    }))
  }

  const setPrice = (inventoryId: number, raw: string) => {
    setFormError(null)
    setDraft((current) => ({ ...current, prices: { ...current.prices, [inventoryId]: raw } }))
  }

  const replacePreview = (next: string | null) => {
    if (screenshotPreview) URL.revokeObjectURL(screenshotPreview)
    setScreenshotPreview(next)
  }

  const uploadScreenshot = async (file: File | undefined) => {
    if (!file || uploading) return
    const fileError = screenshotFileError(file)
    if (fileError) {
      setFormError(fileError)
      return
    }
    setUploading(true)
    setFormError(null)
    try {
      const form = new FormData()
      form.append("image", file)
      const response = await fetch("/api/v1/upload/image", { method: "POST", body: form })
      const data = await response.json().catch(() => ({}))
      if (!response.ok || typeof data?.attachmentKey !== "string") {
        setFormError(typeof data?.error === "string" ? data.error : "The screenshot could not be uploaded")
        return
      }
      replacePreview(URL.createObjectURL(file))
      update({ intakeAttachmentKey: data.attachmentKey })
    } catch {
      setFormError("The screenshot could not be uploaded. Check the connection and try again.")
    } finally {
      setUploading(false)
    }
  }

  const startNext = () => {
    replacePreview(null)
    setDraft(EMPTY_DRAFT)
    setFormError(null)
    setCreated(null)
    idempotencyKey.current = newIdempotencyKey()
  }

  const submit = async () => {
    if (submitting || uploading) return
    const built = buildDeskOrderRequest(draft, catalogue)
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setSubmitting(true)
    setFormError(null)
    try {
      const response = await fetch("/api/v1/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey.current },
        body: JSON.stringify(built.body),
      })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        setFormError(typeof data?.error === "string" ? data.error : "The order could not be created")
        return
      }
      setCreated({
        tid: String(data?.order?.tid ?? "The order"),
        customer: [organization?.name, branch?.name].filter(Boolean).join(" · "),
        totalCents: typeof data?.order?.totalCents === "number" ? data.order.totalCents : null,
      })
    } catch {
      setFormError("The order could not be sent. Check the connection and try again.")
    } finally {
      setSubmitting(false)
    }
  }

  if (created) return <CreatedPanel created={created} onNext={startNext} onViewOrders={onViewOrders} />
  if (targetError) {
    return <p role="alert" className="text-sm text-destructive">Could not load the organizations you can order for. Refresh the page to try again.</p>
  }
  if (!targetsLoading && targets.length === 0) return <NoTargets />

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <div className="space-y-6">
        <CustomerStep
          targets={targets}
          loading={targetsLoading}
          organization={organization}
          branchId={draft.branchId}
          disabled={submitting}
          // A new organization means a new branch and a new catalogue: nothing
          // chosen for the previous one may carry over.
          onOrganization={(value) => update({ organizationId: Number(value), branchId: null, quantities: {}, prices: {} })}
          onBranch={(value) => update({ branchId: Number(value), quantities: {}, prices: {} })}
        />
        <ProductsStep
          key={catalogueUrl ?? "none"}
          catalogueUrl={catalogueUrl}
          catalogue={catalogue}
          loading={catalogueLoading}
          failed={Boolean(catalogueError)}
          quantities={draft.quantities}
          prices={draft.prices}
          disabled={submitting}
          onQuantity={setQuantity}
          onPrice={setPrice}
        />
        <OriginStep
          draft={draft}
          disabled={submitting}
          update={update}
          screenshot={
            <ScreenshotField
              preview={draft.intakeAttachmentKey ? screenshotPreview : null}
              uploading={uploading}
              disabled={submitting}
              onUpload={(file) => { void uploadScreenshot(file) }}
              onClear={() => {
                replacePreview(null)
                update({ intakeAttachmentKey: null })
              }}
            />
          }
        />
      </div>

      <SummaryPanel
        organization={organization}
        branchName={branch?.name ?? null}
        lines={lines}
        prices={draft.prices}
        unavailableCount={unavailable.length}
        estimatedCents={estimateDraftTotalCents(draft, catalogue)}
        checks={deskDraftChecklist(draft)}
        formError={formError}
        busy={submitting || uploading}
        submitting={submitting}
        onRemove={(inventoryId) => setQuantity(inventoryId, 0)}
        onRemoveUnavailable={() => { for (const inventoryId of unavailable) setQuantity(inventoryId, 0) }}
        onSubmit={() => { void submit() }}
      />
    </div>
  )
}
