"use client"

import { useRef, useState } from "react"
import { ImagePlus, Loader2, X } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useToast } from "@/hooks/use-toast"
import { SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE } from "@/lib/support-thread"

export type PendingAttachment = {
  id: number
  fileName: string
  sizeBytes: number
}

/**
 * Uploads a screenshot and holds on to the id until the message is posted.
 *
 * The upload happens first and separately, so a large file cannot make the
 * message body time out, and a message that is never sent leaves an unclaimed
 * row that belongs to nobody's thread.
 */
export function AttachmentPicker({
  attachments,
  onChange,
  disabled,
}: Readonly<{
  attachments: PendingAttachment[]
  onChange: (next: PendingAttachment[]) => void
  disabled?: boolean
}>) {
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [uploading, setUploading] = useState(false)
  const atLimit = attachments.length >= SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE

  async function upload(file: File) {
    setUploading(true)
    try {
      const form = new FormData()
      form.append("file", file)
      const response = await fetch("/api/v1/support/attachments", {
        method: "POST",
        body: form,
      })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        toast({
          title: "Could not attach that file",
          description: payload?.error || "The upload was rejected.",
          variant: "destructive",
        })
        return
      }

      onChange([
        ...attachments,
        { id: payload.id, fileName: payload.fileName, sizeBytes: payload.sizeBytes },
      ])
    } catch {
      toast({
        title: "Could not attach that file",
        description: "The upload did not complete. Please try again.",
        variant: "destructive",
      })
    } finally {
      setUploading(false)
      if (inputRef.current) inputRef.current.value = ""
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0]
          if (file) void upload(file)
        }}
      />
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || uploading || atLimit}
          onClick={() => inputRef.current?.click()}
        >
          {uploading ? (
            <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
          ) : (
            <ImagePlus className="mr-1.5 h-4 w-4" />
          )}
          Attach a screenshot
        </Button>
        <span className="text-xs text-slate-500 dark:text-slate-400">
          {atLimit
            ? `Up to ${SUPPORT_MAX_ATTACHMENTS_PER_MESSAGE} images per message`
            : "PNG, JPG, GIF or WebP, up to 4 MB"}
        </span>
      </div>
      {attachments.length > 0 ? (
        <ul className="flex flex-wrap gap-2">
          {attachments.map((attachment) => (
            <li
              key={attachment.id}
              className="flex items-center gap-2 rounded-md border bg-slate-50 px-2 py-1 text-xs dark:border-slate-700 dark:bg-slate-800"
            >
              <span className="max-w-[180px] truncate">{attachment.fileName}</span>
              <button
                type="button"
                aria-label={`Remove ${attachment.fileName}`}
                className="text-slate-400 hover:text-red-600"
                disabled={disabled}
                onClick={() => onChange(attachments.filter((item) => item.id !== attachment.id))}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB"
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
