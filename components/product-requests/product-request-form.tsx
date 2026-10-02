"use client"

import { useId, useState, type ChangeEvent, type ComponentType, type DragEvent, type FormEvent, type ReactNode } from "react"
import useSWR from "swr"
import {
  ImagePlus,
  Link2,
  Loader2,
  MessageSquareText,
  Package,
  Ruler,
  Send,
  Truck,
  X,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { fetcher, jsonFetcher } from "@/lib/fetcher"
import { PRODUCT_REQUEST_LIMITS, isProductRequestImagePath } from "@/lib/product-request"
import {
  EMPTY_PRODUCT_REQUEST_FORM,
  buildProductRequestPayload,
  productRequestCompleteness,
  type ProductRequestFormState,
} from "@/lib/product-request-form"
import { cn } from "@/lib/utils"

/** A lucide icon, or anything drawn the same way. */
type IconComponent = ComponentType<{ className?: string; "aria-hidden"?: boolean }>

type CategoryOption = { id: number; name: string }

const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"]
const MAX_IMAGE_BYTES = 4 * 1024 * 1024
const NONE = "none"

/** Units offered as one-click choices. Any other unit can still be typed. */
const COMMON_UNITS = ["piece", "box", "pack", "bottle", "kg", "litre"] as const

type TextField = Exclude<keyof ProductRequestFormState, "categoryId" | "subcategoryId" | "imageUrl">

/**
 * The Head Office form for asking Super Admin to add a product.
 *
 * Every field is optional; the only refusal is a form with nothing in it. The
 * fields are grouped by the question each one answers, so a long form reads
 * as five short ones, and the footer stays in view with the actions and how
 * much has been given. The picture goes through `POST /api/v1/upload/image`,
 * which sanitises it and returns the stored path the request records.
 */
export function ProductRequestForm({
  onSubmitted,
  onCancel,
}: Readonly<{ onSubmitted: () => void; onCancel: () => void }>) {
  const { toast } = useToast()
  const [state, setState] = useState<ProductRequestFormState>(EMPTY_PRODUCT_REQUEST_FORM)
  const [fieldError, setFieldError] = useState<{ field: keyof ProductRequestFormState | null; message: string } | null>(null)
  const [uploading, setUploading] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const { data: categoryData, isLoading: categoriesLoading } = useSWR<{ items: CategoryOption[] }>(
    "/api/v1/categories?limit=200",
    fetcher,
    { revalidateOnFocus: false },
  )
  const { data: subcategoryData, isLoading: subcategoriesLoading } = useSWR<{ items: CategoryOption[] }>(
    state.categoryId ? `/api/v1/subcategories?categoryId=${encodeURIComponent(state.categoryId)}` : null,
    fetcher,
    { revalidateOnFocus: false },
  )
  const categories = categoryData?.items ?? []
  const subcategories = subcategoryData?.items ?? []

  const set = (field: keyof ProductRequestFormState, value: string) => {
    setState((previous) => ({ ...previous, [field]: value }))
    if (fieldError?.field === field || fieldError?.field === null) setFieldError(null)
  }

  const textInput = (field: TextField) => ({
    id: `product-request-${field}`,
    value: state[field],
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => set(field, event.target.value),
    "aria-invalid": fieldError?.field === field ? true : undefined,
    "aria-describedby": fieldError?.field === field ? "product-request-field-error" : undefined,
  })

  const handleImage = async (file: File | undefined) => {
    if (!file) return
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      toast({ title: "Unsupported image", description: "Use a JPG, PNG, GIF or WEBP image.", variant: "destructive" })
      return
    }
    if (file.size > MAX_IMAGE_BYTES) {
      toast({ title: "Image too large", description: "Use an image under 4 MB.", variant: "destructive" })
      return
    }

    setUploading(true)
    try {
      const form = new FormData()
      form.append("image", file)
      const response = await fetch("/api/v1/upload/image", { method: "POST", body: form })
      const body = await response.json().catch(() => null)
      if (!response.ok || typeof body?.url !== "string") {
        throw new Error(body?.error || "The image could not be uploaded")
      }
      set("imageUrl", body.url)
    } catch (error) {
      toast({
        title: "Upload failed",
        description: error instanceof Error ? error.message : "The image could not be uploaded",
        variant: "destructive",
      })
    } finally {
      setUploading(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting || uploading) return

    const built = buildProductRequestPayload(state)
    if (!built.ok) {
      setFieldError({ field: built.field, message: built.error })
      // Take the person to the box that needs fixing rather than leave them
      // to find it in a long form.
      if (built.field) document.getElementById(`product-request-${built.field}`)?.focus()
      return
    }

    setSubmitting(true)
    try {
      await jsonFetcher("/api/v1/product-requests", { method: "POST", body: JSON.stringify(built.payload) })
      toast({ title: "Request sent", description: "Super Admin has been sent your product request." })
      setState(EMPTY_PRODUCT_REQUEST_FORM)
      onSubmitted()
    } catch (error) {
      setFieldError({ field: null, message: error instanceof Error ? error.message : "The request could not be sent" })
    } finally {
      setSubmitting(false)
    }
  }

  const busy = submitting || uploading
  const completeness = productRequestCompleteness(state)
  const unitLabel = state.unit.trim()

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col" noValidate>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto bg-slate-50/60 px-6 py-5 dark:bg-slate-950/40">
        <p className="text-sm text-muted-foreground">
          Every field is optional — give as much detail as you can so the product can be sourced quickly.
        </p>

        <FormSection icon={Package} title="What is the product?" hint="The name is the single most useful detail.">
          <Field label="Product name" htmlFor="product-request-productName" className="sm:col-span-2">
            <Input
              {...textInput("productName")}
              autoFocus
              maxLength={PRODUCT_REQUEST_LIMITS.productName}
              placeholder="e.g. Hand sanitiser gel"
              className="h-11 text-base"
            />
          </Field>
          <Field label="Brand / manufacturer" htmlFor="product-request-brand" className="sm:col-span-2">
            <Input {...textInput("brand")} maxLength={PRODUCT_REQUEST_LIMITS.brand} placeholder="e.g. Dettol" />
          </Field>
          <Field label="Category" htmlFor="product-request-category">
            <Select
              value={state.categoryId || NONE}
              onValueChange={(value) => {
                setState((previous) => ({ ...previous, categoryId: value === NONE ? "" : value, subcategoryId: "" }))
              }}
            >
              <SelectTrigger id="product-request-category" className="w-full">
                <SelectValue placeholder={categoriesLoading ? "Loading…" : "Select a category"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not sure</SelectItem>
                {categories.map((category) => (
                  <SelectItem key={category.id} value={String(category.id)}>{category.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field
            label="Subcategory"
            htmlFor="product-request-subcategory"
            hint={state.categoryId ? undefined : "Choose a category first"}
          >
            <Select
              value={state.subcategoryId || NONE}
              onValueChange={(value) => set("subcategoryId", value === NONE ? "" : value)}
              disabled={!state.categoryId || subcategoriesLoading || subcategories.length === 0}
            >
              <SelectTrigger id="product-request-subcategory" className="w-full">
                <SelectValue placeholder={state.categoryId ? "Select a subcategory" : "Choose a category first"} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not sure</SelectItem>
                {subcategories.map((subcategory) => (
                  <SelectItem key={subcategory.id} value={String(subcategory.id)}>{subcategory.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </FormSection>

        <FormSection icon={Ruler} title="Size & quantity" hint="How it is sold, what you expect to pay and how much you use.">
          <Field label="Unit of measure" htmlFor="product-request-unit">
            <Input {...textInput("unit")} maxLength={PRODUCT_REQUEST_LIMITS.unit} placeholder="e.g. bottle, kg, box" />
            <div className="flex flex-wrap gap-1.5 pt-1" role="group" aria-label="Common units">
              {COMMON_UNITS.map((unit) => {
                const selected = unitLabel.toLowerCase() === unit
                return (
                  <button
                    key={unit}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => set("unit", selected ? "" : unit)}
                    className={cn(
                      "rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      selected
                        ? "border-primary bg-primary text-white"
                        : "border-slate-200 bg-white text-slate-600 hover:border-primary/60 hover:text-slate-900 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
                    )}
                  >
                    {unit}
                  </button>
                )
              })}
            </div>
          </Field>
          <Field label="Pack size / specification" htmlFor="product-request-packSize">
            <Input {...textInput("packSize")} maxLength={PRODUCT_REQUEST_LIMITS.packSize} placeholder="e.g. 500 ml, carton of 12" />
          </Field>
          <Field
            label="Expected price per unit (PKR)"
            htmlFor="product-request-expectedPrice"
            hint="For reference only — Super Admin sets the actual price."
          >
            <Adorned prefix="Rs">
              <Input {...textInput("expectedPrice")} inputMode="decimal" placeholder="e.g. 450.00" className="pl-10" />
            </Adorned>
          </Field>
          <Field label="Estimated monthly quantity" htmlFor="product-request-estimatedMonthlyQuantity">
            <Adorned suffix={unitLabel ? `${unitLabel} / month` : "per month"}>
              <Input
                {...textInput("estimatedMonthlyQuantity")}
                inputMode="decimal"
                placeholder="e.g. 120"
                className="pr-28"
              />
            </Adorned>
          </Field>
        </FormSection>

        <FormSection icon={Truck} title="Where to source it" hint="Anything that helps identify the exact item.">
          <Field label="Barcode / manufacturer code" htmlFor="product-request-barcode">
            <Input {...textInput("barcode")} maxLength={PRODUCT_REQUEST_LIMITS.barcode} placeholder="e.g. 8961014005019" />
          </Field>
          <Field label="Preferred supplier" htmlFor="product-request-preferredSupplier">
            <Input {...textInput("preferredSupplier")} maxLength={PRODUCT_REQUEST_LIMITS.preferredSupplier} placeholder="e.g. Metro Cash & Carry" />
          </Field>
          <Field label="Reference link" htmlFor="product-request-referenceUrl" className="sm:col-span-2">
            <Adorned prefix={<Link2 className="h-4 w-4" aria-hidden />}>
              <Input
                {...textInput("referenceUrl")}
                type="url"
                maxLength={PRODUCT_REQUEST_LIMITS.referenceUrl}
                placeholder="https://…"
                className="pl-10"
              />
            </Adorned>
          </Field>
        </FormSection>

        <FormSection icon={MessageSquareText} title="Why is it needed?" hint="Context helps Super Admin decide faster.">
          <Field
            label="Description"
            htmlFor="product-request-description"
            className="sm:col-span-2"
            counter={{ used: state.description.length, max: PRODUCT_REQUEST_LIMITS.description }}
          >
            <Textarea
              {...textInput("description")}
              maxLength={PRODUCT_REQUEST_LIMITS.description}
              rows={3}
              placeholder="What it is, what it is used for"
            />
          </Field>
          <Field
            label="Why is it needed? / other notes"
            htmlFor="product-request-notes"
            className="sm:col-span-2"
            counter={{ used: state.notes.length, max: PRODUCT_REQUEST_LIMITS.notes }}
          >
            <Textarea
              {...textInput("notes")}
              maxLength={PRODUCT_REQUEST_LIMITS.notes}
              rows={3}
              placeholder="e.g. Branches keep asking for it; the current one is out of stock"
            />
          </Field>
        </FormSection>

        <FormSection icon={ImagePlus} title="Photo" hint="A picture of the product or its packaging.">
          <div className="sm:col-span-2">
            <ImageDrop
              imageUrl={isProductRequestImagePath(state.imageUrl) ? state.imageUrl : null}
              uploading={uploading}
              disabled={busy}
              onFile={(file) => void handleImage(file)}
              onRemove={() => set("imageUrl", "")}
            />
          </div>
        </FormSection>
      </div>

      <div className="space-y-3 border-t bg-white px-6 py-4 dark:bg-slate-900">
        {fieldError ? (
          <p
            id="product-request-field-error"
            role="alert"
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-medium text-destructive dark:border-rose-900 dark:bg-rose-950/40"
          >
            {fieldError.message}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CompletenessMeter filled={completeness.filled} total={completeness.total} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>Cancel</Button>
            <Button type="submit" disabled={busy} className="min-w-36">
              {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Send className="mr-2 h-4 w-4" />}
              Send request
            </Button>
          </div>
        </div>
      </div>
    </form>
  )
}

function FormSection({
  icon: Icon,
  title,
  hint,
  children,
}: Readonly<{ icon: IconComponent; title: string; hint?: string; children: ReactNode }>) {
  const headingId = useId()
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-xl border border-slate-200 bg-white p-4 shadow-xs sm:p-5 dark:border-slate-800 dark:bg-slate-900"
    >
      <header className="mb-4 flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300">
          <Icon className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <h3 id={headingId} className="text-sm font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
      </header>
      <div className="grid gap-4 sm:grid-cols-2">{children}</div>
    </section>
  )
}

function Field({
  label,
  htmlFor,
  hint,
  counter,
  className,
  children,
}: Readonly<{
  label: string
  htmlFor: string
  hint?: string
  counter?: { used: number; max: number }
  className?: string
  children: ReactNode
}>) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={htmlFor} className="text-slate-700 dark:text-slate-300">{label}</Label>
        {counter ? (
          <span
            className={cn(
              "text-[11px] tabular-nums text-muted-foreground",
              counter.used >= counter.max * 0.9 && "font-medium text-amber-600",
            )}
          >
            {counter.used}/{counter.max}
          </span>
        ) : null}
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** An input with a fixed prefix or suffix drawn inside its border. */
function Adorned({
  prefix,
  suffix,
  children,
}: Readonly<{ prefix?: ReactNode; suffix?: ReactNode; children: ReactNode }>) {
  return (
    <div className="relative">
      {prefix ? (
        <span className="pointer-events-none absolute inset-y-0 left-0 flex w-10 items-center justify-center text-sm text-muted-foreground">
          {prefix}
        </span>
      ) : null}
      {children}
      {suffix ? (
        <span className="pointer-events-none absolute inset-y-0 right-3 flex max-w-24 items-center truncate text-xs text-muted-foreground">
          {suffix}
        </span>
      ) : null}
    </div>
  )
}

function CompletenessMeter({ filled, total }: Readonly<{ filled: number; total: number }>) {
  const percent = total > 0 ? Math.round((filled / total) * 100) : 0
  return (
    <div className="flex min-w-0 items-center gap-3" aria-live="polite">
      <div
        className="h-1.5 w-28 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700"
        role="progressbar"
        aria-label="Details added"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={filled}
      >
        <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${percent}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">
        {filled === 0 ? "Add at least one detail" : `${filled} of ${total} details added`}
      </span>
    </div>
  )
}

/**
 * The picture: click or drop to attach, with a preview and a remove action once
 * attached. The file input stays the labelled control, so it is reachable by
 * keyboard and by assistive technology exactly as a plain input would be.
 */
function ImageDrop({
  imageUrl,
  uploading,
  disabled,
  onFile,
  onRemove,
}: Readonly<{
  imageUrl: string | null
  uploading: boolean
  disabled: boolean
  onFile: (file: File | undefined) => void
  onRemove: () => void
}>) {
  const [dragging, setDragging] = useState(false)

  if (imageUrl) {
    return (
      <div className="flex items-center gap-4 rounded-lg border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-950/40">
        {/* eslint-disable-next-line @next/next/no-img-element -- an authenticated application path, not a static asset */}
        <img src={imageUrl} alt="Requested product" className="h-20 w-20 rounded-md border object-cover" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">Image attached</p>
          <p className="text-xs text-muted-foreground">It will be sent with the request.</p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onRemove} disabled={disabled}>
          <X className="mr-1 h-4 w-4" /> Remove
        </Button>
      </div>
    )
  }

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault()
    setDragging(false)
    if (!disabled) onFile(event.dataTransfer.files?.[0])
  }

  return (
    <label
      htmlFor="product-request-image"
      onDragOver={(event) => {
        event.preventDefault()
        if (!disabled) setDragging(true)
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={cn(
        "flex h-32 cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed text-center transition-colors",
        "focus-within:ring-2 focus-within:ring-ring",
        dragging
          ? "border-indigo-500 bg-indigo-50 text-indigo-700 dark:bg-indigo-500/10"
          : "border-slate-300 bg-slate-50 text-slate-500 hover:border-indigo-400 hover:bg-indigo-50/50 dark:border-slate-700 dark:bg-slate-950/40",
      )}
    >
      {uploading ? <Loader2 className="h-6 w-6 animate-spin" /> : <ImagePlus className="h-6 w-6" />}
      <span className="text-sm font-medium">
        {uploading ? "Uploading…" : dragging ? "Drop the image here" : "Click to attach an image, or drag one here"}
      </span>
      <span className="text-xs">JPG, PNG, GIF or WEBP up to 4 MB</span>
      <input
        id="product-request-image"
        aria-label="Product image"
        type="file"
        accept={ALLOWED_IMAGE_TYPES.join(",")}
        className="sr-only"
        disabled={disabled}
        onChange={(event) => {
          onFile(event.target.files?.[0])
          event.target.value = ""
        }}
      />
    </label>
  )
}
