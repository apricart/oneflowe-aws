"use client"

import { useRef, useState } from "react"
import useSWR from "swr"
import { format } from "date-fns"
import { FileCheck2, FileText, Loader2, Upload } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { toast } from "@/hooks/use-toast"
import {
  DELIVERY_CHALLAN_ACCEPT,
  DELIVERY_CHALLAN_UPLOAD_PURPOSE,
  MAX_DELIVERY_CHALLAN_BYTES,
} from "@/lib/delivery-challan"
import { fetcher } from "@/lib/fetcher"

/**
 * The delivery challan in the browser: preparing and uploading one, and
 * showing an order's challan to whoever can read the order.
 *
 * Presentation only. The server decides everything that matters — who may
 * upload (Super Admin), what is a valid file (by content), and who may read it
 * (whoever may read the order). See plans/OF-DELIVERY-CHALLAN-proof-of-delivery.md.
 */

/** A phone photo is shrunk to this before upload so it fits the 4 MB limit. */
const MAX_IMAGE_EDGE = 2400
const SHRINK_ABOVE_BYTES = 3 * 1024 * 1024

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

async function loadImage(file: File): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file)
  try {
    const image = new Image()
    image.src = url
    await image.decode()
    return image
  } finally {
    URL.revokeObjectURL(url)
  }
}

/**
 * A large or oversized photo, redrawn as a JPEG no larger than 2400 px a side.
 * Anything else — a PDF, or an image already small enough — is sent as it is.
 * A convenience only: the server re-encodes and checks every image anyway.
 */
export async function prepareDeliveryChallanFile(file: File): Promise<File> {
  if (!file.type.startsWith("image/")) return file
  try {
    const image = await loadImage(file)
    const longest = Math.max(image.naturalWidth, image.naturalHeight)
    if (longest <= MAX_IMAGE_EDGE && file.size <= SHRINK_ABOVE_BYTES) return file
    const scale = Math.min(1, MAX_IMAGE_EDGE / longest)
    const canvas = document.createElement("canvas")
    canvas.width = Math.round(image.naturalWidth * scale)
    canvas.height = Math.round(image.naturalHeight * scale)
    canvas.getContext("2d")?.drawImage(image, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85))
    if (!blob) return file
    const name = file.name.replace(/\.[^.]*$/, "") || "delivery-challan"
    return new File([blob], `${name}.jpg`, { type: "image/jpeg" })
  } catch {
    // Not decodable here; let the server decide.
    return file
  }
}

/** Upload one challan for one order; resolves to the id the delivery or replacement then attaches. */
export async function uploadDeliveryChallan(orderId: number, file: File): Promise<number> {
  const prepared = await prepareDeliveryChallanFile(file)
  if (prepared.size > MAX_DELIVERY_CHALLAN_BYTES) {
    throw new Error("The delivery challan must be 4 MB or smaller")
  }
  const form = new FormData()
  form.append("image", prepared)
  form.append("purpose", DELIVERY_CHALLAN_UPLOAD_PURPOSE)
  form.append("orderId", String(orderId))
  const response = await fetch("/api/v1/upload/image", { method: "POST", body: form })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || typeof body?.deliveryChallan?.id !== "number") {
    throw new Error(body?.error || "The delivery challan could not be uploaded")
  }
  return body.deliveryChallan.id
}

/**
 * Choose a challan file and upload it. `onUploaded` receives the challan id;
 * the parent sends it with the delivery (or the replacement), which is where
 * it is actually attached.
 */
export function DeliveryChallanUploadDialog({
  order,
  mode,
  onClose,
  onUploaded,
}: Readonly<{
  order: { id: number; tid: string } | null
  mode: "deliver" | "replace"
  onClose: () => void
  onUploaded: (challanId: number) => Promise<void>
}>) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const reset = () => {
    setFile(null)
    setProblem(null)
    if (inputRef.current) inputRef.current.value = ""
  }

  const close = () => {
    if (busy) return
    reset()
    onClose()
  }

  const submit = async () => {
    if (!order || !file || busy) return
    setBusy(true)
    setProblem(null)
    try {
      const challanId = await uploadDeliveryChallan(order.id, file)
      await onUploaded(challanId)
      reset()
      onClose()
    } catch (uploadError) {
      setProblem(uploadError instanceof Error ? uploadError.message : "The delivery challan could not be uploaded")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={order !== null} onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{mode === "deliver" ? "Mark order delivered" : "Replace delivery challan"}</DialogTitle>
          <DialogDescription>
            {mode === "deliver"
              ? `Attach the signed delivery challan for order ${order?.tid}. The order is marked delivered only once it is uploaded.`
              : `Upload the correct delivery challan for order ${order?.tid}. The current one is kept in the order's history.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="delivery-challan-file">Delivery challan</Label>
          <input
            ref={inputRef}
            id="delivery-challan-file"
            type="file"
            accept={DELIVERY_CHALLAN_ACCEPT}
            disabled={busy}
            onChange={(event) => {
              setProblem(null)
              setFile(event.target.files?.[0] ?? null)
            }}
            className="block w-full text-sm file:mr-3 file:rounded-md file:border-0 file:bg-slate-100 file:px-3 file:py-2 file:text-sm file:font-medium dark:file:bg-slate-800"
            aria-describedby="delivery-challan-help"
          />
          <p id="delivery-challan-help" className="text-xs text-muted-foreground">
            A photo or scan (JPG, PNG, WebP) or a PDF, up to 4 MB. Large photos are reduced automatically.
          </p>
          {file && <p className="text-xs">{file.name} · {formatSize(file.size)}</p>}
          {problem && <p role="alert" className="text-xs text-rose-600">{problem}</p>}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void submit() }} disabled={!file || busy}>
            {busy ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
            {mode === "deliver" ? "Upload and mark delivered" : "Upload and replace"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type ChallanItem = {
  id: number
  fileName: string
  contentType: string
  sizeBytes: number
  uploadedAt: string
  uploadedByRole: string | null
  replacedAt: string | null
  current: boolean
}

function fileUrl(orderId: number, challanId: number): string {
  return `/api/v1/orders/${orderId}/delivery-challan/${challanId}/file`
}

/**
 * An order's delivery challan, for anyone who can read the order. Super Admin
 * also sees the challans a replacement superseded, and may replace the current
 * one. Renders nothing while the order has none.
 */
export function DeliveryChallanPanel({
  orderId,
  orderTid,
  canReplace = false,
}: Readonly<{ orderId: number; orderTid: string; canReplace?: boolean }>) {
  const { data, error, isLoading, mutate } = useSWR<{ items: ChallanItem[] }>(
    `/api/v1/orders/${orderId}/delivery-challan`,
    fetcher,
  )
  const [replacing, setReplacing] = useState(false)
  const items = data?.items ?? []
  const current = items.find((item) => item.current)
  const replaced = items.filter((item) => !item.current)

  const replace = async (challanId: number) => {
    const response = await fetch(`/api/v1/orders/${orderId}/delivery-challan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deliveryChallanId: challanId }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(body?.error || "The delivery challan could not be replaced")
    toast({ title: "Delivery challan replaced", description: `Order ${orderTid} now has the new challan.` })
    await mutate()
  }

  if (isLoading) return null
  if (error) {
    return <p role="alert" className="text-xs text-rose-600">The delivery challan could not be loaded.</p>
  }
  if (!current && replaced.length === 0) return null

  return (
    <section aria-label="Delivery challan" className="space-y-2 rounded-xl border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
          <FileCheck2 className="h-3.5 w-3.5" aria-hidden="true" /> Delivery challan
        </h3>
        {canReplace && current && (
          <Button type="button" variant="outline" size="sm" className="h-7 text-xs" onClick={() => setReplacing(true)}>
            Replace
          </Button>
        )}
      </div>
      {current && <ChallanLink orderId={orderId} item={current} />}
      {replaced.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          <p className="text-[11px] text-muted-foreground">Replaced</p>
          {replaced.map((item) => <ChallanLink key={item.id} orderId={orderId} item={item} />)}
        </div>
      )}
      {canReplace && (
        <DeliveryChallanUploadDialog
          order={replacing ? { id: orderId, tid: orderTid } : null}
          mode="replace"
          onClose={() => setReplacing(false)}
          onUploaded={replace}
        />
      )}
    </section>
  )
}

function ChallanLink({ orderId, item }: Readonly<{ orderId: number; item: ChallanItem }>) {
  const isPdf = item.contentType === "application/pdf"
  return (
    <div className="flex items-center justify-between gap-2">
      <a
        href={fileUrl(orderId, item.id)}
        target={isPdf ? undefined : "_blank"}
        rel="noopener noreferrer"
        className="flex min-w-0 items-center gap-1.5 text-indigo-600 underline-offset-2 hover:underline dark:text-indigo-400"
      >
        <FileText className="h-4 w-4 shrink-0" aria-hidden="true" />
        <span className="truncate">{item.fileName}</span>
      </a>
      <span className="shrink-0 text-[11px] text-muted-foreground">
        {isPdf ? "PDF · download" : "Image"} · {formatSize(item.sizeBytes)}
        {item.uploadedAt ? ` · ${format(new Date(item.uploadedAt), "dd MMM, HH:mm")}` : ""}
      </span>
    </div>
  )
}
