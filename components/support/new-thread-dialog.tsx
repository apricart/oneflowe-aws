"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { Loader2, Plus } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import {
  SUPPORT_CATEGORY_LABELS,
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  SUPPORT_SELECTABLE_CATEGORIES,
  SUPPORT_SUBJECT_MAX_LENGTH,
  isProductRequiredForCategory,
  isSelectableSupportCategory,
  type SupportSelectableCategory,
} from "@/lib/support-thread"
import { AttachmentPicker, type PendingAttachment } from "@/components/support/attachment-picker"
import { ProductPicker, type SupportProduct } from "@/components/support/product-picker"

/**
 * Said in one place, because the dialog shows it under the field and repeats
 * it in the toast that explains why nothing was sent.
 */
const PRODUCT_REQUIRED_MESSAGE = "Choose the product this query is about."

/**
 * Raising a query.
 *
 * `orderId` arrives from a deep link — the "Raise a query" action on an order
 * or an invoice — and is sent as-is. Whether this person may cite that order is
 * decided on the server against the order row; a bad id comes back as an
 * ordinary field error.
 */
export function NewThreadDialog({
  orderId,
  orderLabel,
  open: controlledOpen,
  onOpenChange,
  trigger = true,
  onCreated,
}: Readonly<{
  orderId?: number | null
  orderLabel?: string | null
  open?: boolean
  onOpenChange?: (open: boolean) => void
  trigger?: boolean
  onCreated?: () => void
}>) {
  const router = useRouter()
  const { toast } = useToast()
  const [internalOpen, setInternalOpen] = useState(false)
  const open = controlledOpen ?? internalOpen
  const setOpen = onOpenChange ?? setInternalOpen

  const [subject, setSubject] = useState("")
  const [category, setCategory] = useState<SupportSelectableCategory>(orderId ? "ORDER" : "OTHER")
  const [priority, setPriority] = useState<string>("NORMAL")
  const [product, setProduct] = useState<SupportProduct | null>(null)
  const [productError, setProductError] = useState<string | null>(null)
  const [message, setMessage] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setCategory(orderId ? "ORDER" : "OTHER")
    setProductError(null)
  }, [open, orderId])

  // The category decides whether the product is needed. Marking the field is
  // presentation only: the same rule is applied again by the schema the
  // endpoint parses with.
  const productRequired = isProductRequiredForCategory(category)

  async function submit() {
    if (submitting) return
    if (!subject.trim() || !message.trim()) {
      toast({
        title: "Almost there",
        description: "A subject and a message are both needed.",
        variant: "destructive",
      })
      return
    }

    if (productRequired && !product) {
      setProductError(PRODUCT_REQUIRED_MESSAGE)
      toast({
        title: "Almost there",
        description: PRODUCT_REQUIRED_MESSAGE,
        variant: "destructive",
      })
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch("/api/v1/support/threads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          subject: subject.trim(),
          category,
          priority,
          orderId: orderId ?? undefined,
          productId: product?.id ?? undefined,
          message: message.trim(),
          attachmentIds: attachments.map((attachment) => attachment.id),
        }),
      })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        toast({
          title: "Could not raise the request",
          description: payload?.error || "Please try again.",
          variant: "destructive",
        })
        return
      }

      toast({
        title: `Request ${payload.reference} raised`,
        description: "The Apricart team has been notified.",
      })
      setSubject("")
      setMessage("")
      setProduct(null)
      setProductError(null)
      setAttachments([])
      setOpen(false)
      onCreated?.()
      router.push(`/support/${payload.id}`)
    } catch {
      toast({
        title: "Could not raise the request",
        description: "The request did not reach the server. Please try again.",
        variant: "destructive",
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? (
        <Button onClick={() => setOpen(true)}>
          <Plus className="mr-1.5 h-4 w-4" />
          Raise a query
        </Button>
      ) : null}
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Raise a query with Apricart</DialogTitle>
          <DialogDescription>
            {orderLabel
              ? `About order ${orderLabel}. The Apricart team is notified as soon as you send it.`
              : "Ask about an invoice, an order, a delivery, or anything else. The Apricart team is notified as soon as you send it."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="support-subject">Subject</Label>
            <Input
              id="support-subject"
              value={subject}
              maxLength={SUPPORT_SUBJECT_MAX_LENGTH}
              placeholder="Invoice total does not match the delivered items"
              onChange={(event) => setSubject(event.target.value)}
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="support-category">Category</Label>
              <Select
                value={category}
                onValueChange={(value) => {
                  if (!isSelectableSupportCategory(value)) return
                  setCategory(value)
                  // The field may have just become optional, and an error left
                  // standing under a field nobody must fill is noise.
                  setProductError(null)
                }}
              >
                <SelectTrigger id="support-category">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORT_SELECTABLE_CATEGORIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {SUPPORT_CATEGORY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="support-priority">Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger id="support-priority">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SUPPORT_PRIORITIES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {SUPPORT_PRIORITY_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <ProductPicker
            value={product}
            onChange={(next) => {
              setProduct(next)
              setProductError(null)
            }}
            required={productRequired}
            error={productError}
            disabled={submitting}
          />

          <div className="space-y-1.5">
            <Label htmlFor="support-message">What has happened?</Label>
            <Textarea
              id="support-message"
              value={message}
              rows={6}
              maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
              placeholder="Describe the problem, and include anything that will help us find it — an invoice number, a date, a product name."
              onChange={(event) => setMessage(event.target.value)}
            />
            <p className="text-right text-xs text-slate-400">
              {message.length}/{SUPPORT_MESSAGE_MAX_LENGTH}
            </p>
          </div>

          <AttachmentPicker
            attachments={attachments}
            onChange={setAttachments}
            disabled={submitting}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={submitting}>
            {submitting ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            Send to Apricart
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
