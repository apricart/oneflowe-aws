"use client"

import { isReadOnlyRole } from "@/lib/viewer-access"
import { useState } from "react"
import Link from "next/link"
import { CheckCircle2, Download, Loader2, Lock, RotateCcw, Send } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { useAPI } from "@/lib/hooks/use-api"
import { cn } from "@/lib/utils"
import {
  SUPPORT_MESSAGE_MAX_LENGTH,
  SUPPORT_PRIORITIES,
  SUPPORT_PRIORITY_LABELS,
  supportThreadReference,
} from "@/lib/support-thread"
import {
  AttachmentPicker,
  formatBytes,
  type PendingAttachment,
} from "@/components/support/attachment-picker"
import {
  CategoryLabel,
  PriorityBadge,
  StatusBadge,
  SupportHeader,
  formatWhen,
  useSupportSide,
} from "@/components/support/support-chrome"

type SupportMessage = {
  id: number
  authorUserId: string
  authorName: string | null
  authorSide: string
  authorRole: string
  body: string
  createdAt: string
  attachments: Array<{ id: number; fileName: string; contentType: string; sizeBytes: number }>
}

type SupportThreadResponse = {
  thread: {
    id: number
    reference: string
    subject: string
    category: string
    status: string
    priority: string
    organizationName: string | null
    branchName: string | null
    orderId: number | null
    orderTid: string | null
  productCode: string | null
  productName: string | null
    createdByName: string | null
    assignedToName: string | null
    createdAt: string
    messages: SupportMessage[]
  }
  viewer: { side: "CUSTOMER" | "APRICART"; canManage: boolean; userId: string }
}

export function SupportThreadView({ threadId }: Readonly<{ threadId: number }>) {
  const { toast } = useToast()
  // Whether the portal chrome is around us — read from the session, so it is
  // settled before the thread itself arrives.
  const { embedded, role: sessionRole } = useSupportSide()
  const { data, error, isLoading, mutate } = useAPI<SupportThreadResponse>(
    `/api/v1/support/threads/${threadId}`,
    { refreshInterval: 30_000 },
  )

  const [reply, setReply] = useState("")
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const [sending, setSending] = useState(false)
  const [updating, setUpdating] = useState(false)

  if (isLoading && !data) return <ThreadLoading />
  // A thread that is not this viewer's comes back as a 404, so "unavailable"
  // covers both "gone" and "not yours" — the same conflation the API makes.
  if (error || !data?.thread) return <ThreadUnavailable />

  const { thread, viewer } = data
  const apricart = viewer.side === "APRICART"
  const closed = thread.status === "CLOSED"
  // The read-only Viewer reads the conversation; it replies, resolves, closes
  // and reopens nothing (every write endpoint refuses it besides).
  const readOnly = isReadOnlyRole(sessionRole)

  async function send() {
    if (sending || !reply.trim()) return
    setSending(true)
    const outcome = await submitJson(`/api/v1/support/threads/${threadId}/messages`, "POST", {
      message: reply.trim(),
      attachmentIds: attachments.map((attachment) => attachment.id),
    })
    setSending(false)

    if (!outcome.ok) {
      toast({ title: "Message not sent", description: outcome.error, variant: "destructive" })
      return
    }
    setReply("")
    setAttachments([])
    await mutate()
  }

  async function patch(body: Record<string, unknown>, successMessage: string) {
    if (updating) return
    setUpdating(true)
    const outcome = await submitJson(`/api/v1/support/threads/${threadId}`, "PATCH", body)
    setUpdating(false)

    if (!outcome.ok) {
      toast({
        title: "Could not update the request",
        description: outcome.error,
        variant: "destructive",
      })
      return
    }
    toast({ title: successMessage })
    await mutate()
  }

  return (
    <div className={cn(embedded && "mx-auto max-w-3xl")}>
      <SupportHeader
        embedded={embedded}
        title={thread.subject}
        subtitle={`${supportThreadReference(thread.id)} · raised ${formatWhen(thread.createdAt)} by ${thread.createdByName || "a colleague"}`}
        backHref="/support"
        backLabel="All requests"
        actions={
          <div className="flex items-center gap-2">
            <PriorityBadge priority={thread.priority} />
            <StatusBadge status={thread.status} apricart={apricart} />
          </div>
        }
      />

      <div className={cn("space-y-4", embedded ? "" : "mx-auto max-w-3xl p-4")}>
        <Card>
          <CardContent className="grid gap-x-6 gap-y-2 py-4 text-sm sm:grid-cols-2">
            <Detail label="Category">
              <CategoryLabel category={thread.category} />
            </Detail>
            {thread.orderId ? (
              <Detail label="About order">
                <Link
                  href={`/invoices/${thread.orderId}`}
                  className="font-semibold text-indigo-600 hover:underline dark:text-indigo-400"
                >
                  {thread.orderTid || `#${thread.orderId}`}
                </Link>
              </Detail>
            ) : null}
            {thread.productCode ? (
              <Detail label="About product">
                <span className="font-mono font-semibold">{thread.productCode}</span>
                {thread.productName ? (
                  <span className="text-slate-500 dark:text-slate-400"> · {thread.productName}</span>
                ) : null}
              </Detail>
            ) : null}
            {apricart ? (
              <Detail label="Organization">
                {thread.organizationName}
                {thread.branchName ? ` · ${thread.branchName}` : ""}
              </Detail>
            ) : null}
            {thread.assignedToName ? (
              <Detail label="Handled by">{thread.assignedToName}</Detail>
            ) : null}
          </CardContent>
        </Card>

        <ol className="space-y-3">
          {thread.messages.map((message) => (
            <MessageBubble
              key={message.id}
              message={message}
              mine={message.authorUserId === viewer.userId}
            />
          ))}
        </ol>

        {readOnly && (
          <p className="mt-4 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            This account is view only. It can read this conversation but not reply to it.
          </p>
        )}
        {!readOnly && closed && (
          <ClosedNotice
            apricart={apricart}
            busy={updating}
            onReopen={() => void patch({ status: "OPEN" }, "Request reopened")}
          />
        )}
        {!readOnly && !closed && (
          <ReplyComposer
            threadId={thread.id}
            apricart={apricart}
            canManage={viewer.canManage}
            status={thread.status}
            priority={thread.priority}
            reply={reply}
            onReplyChange={setReply}
            attachments={attachments}
            onAttachmentsChange={setAttachments}
            sending={sending}
            updating={updating}
            onSend={send}
            onResolve={() => void patch({ status: "RESOLVED" }, "Request marked resolved")}
            onClose={() => void patch({ status: "CLOSED" }, "Request closed")}
            onPriority={(value) => void patch({ priority: value }, "Priority updated")}
          />
        )}
      </div>
    </div>
  )
}

/** A closed thread takes no more messages. Only Apricart can reopen one. */
function ClosedNotice({
  apricart,
  busy,
  onReopen,
}: Readonly<{ apricart: boolean; busy: boolean; onReopen: () => void }>) {
  return (
    <Card>
      <CardContent className="flex items-center gap-3 py-5 text-sm text-slate-600 dark:text-slate-300">
        <Lock className="h-4 w-4 shrink-0 text-slate-400" />
        <span>
          This request is closed.{" "}
          {apricart
            ? "Reopen it to continue the conversation."
            : "Raise a new query if you need to take it further."}
        </span>
        {apricart ? (
          <Button size="sm" variant="outline" className="ml-auto" disabled={busy} onClick={onReopen}>
            <RotateCcw className="mr-1.5 h-4 w-4" />
            Reopen
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

/**
 * The reply box and the actions beside it.
 *
 * The triage controls render only for Apricart, and that is presentation: the
 * PATCH endpoint refuses them for anybody else regardless of what renders here.
 */
function ReplyComposer({
  threadId,
  apricart,
  canManage,
  status,
  priority,
  reply,
  onReplyChange,
  attachments,
  onAttachmentsChange,
  sending,
  updating,
  onSend,
  onResolve,
  onClose,
  onPriority,
}: Readonly<{
  threadId: number
  apricart: boolean
  canManage: boolean
  status: string
  priority: string
  reply: string
  onReplyChange: (value: string) => void
  attachments: PendingAttachment[]
  onAttachmentsChange: (next: PendingAttachment[]) => void
  sending: boolean
  updating: boolean
  onSend: () => void
  onResolve: () => void
  onClose: () => void
  onPriority: (value: string) => void
}>) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <Textarea
          value={reply}
          rows={4}
          maxLength={SUPPORT_MESSAGE_MAX_LENGTH}
          placeholder={apricart ? "Reply to the customer…" : "Reply to the Apricart team…"}
          onChange={(event) => onReplyChange(event.target.value)}
        />
        <AttachmentPicker
          attachments={attachments}
          onChange={onAttachmentsChange}
          disabled={sending}
          threadId={threadId}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button onClick={onSend} disabled={sending || !reply.trim()}>
            {sending ? (
              <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-1.5 h-4 w-4" />
            )}
            Send reply
          </Button>

          {status === "RESOLVED" ? null : (
            <Button variant="outline" disabled={updating} onClick={onResolve}>
              <CheckCircle2 className="mr-1.5 h-4 w-4" />
              Mark resolved
            </Button>
          )}

          {canManage ? (
            <div className="ml-auto flex items-center gap-2">
              <Select value={priority} disabled={updating} onValueChange={onPriority}>
                <SelectTrigger className="w-[150px]">
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
              <Button variant="outline" disabled={updating} onClick={onClose}>
                <Lock className="mr-1.5 h-4 w-4" />
                Close
              </Button>
            </div>
          ) : null}
        </div>
      </CardContent>
    </Card>
  )
}

function ThreadLoading() {
  const { embedded } = useSupportSide()

  return (
    <div className={cn(embedded && "mx-auto max-w-3xl")}>
      <SupportHeader
        embedded={embedded}
        title="Support request"
        backHref="/support"
        backLabel="All requests"
      />
      <div className={cn("space-y-3", embedded ? "" : "mx-auto max-w-3xl p-4")}>
        <Skeleton className="h-24 w-full rounded-lg" />
        <Skeleton className="h-32 w-full rounded-lg" />
      </div>
    </div>
  )
}

function ThreadUnavailable() {
  const { embedded } = useSupportSide()

  return (
    <div className={cn(embedded && "mx-auto max-w-3xl")}>
      <SupportHeader
        embedded={embedded}
        title="Support request"
        backHref="/support"
        backLabel="All requests"
      />
      <div className={cn(embedded ? "" : "mx-auto max-w-3xl p-4")}>
        <Card>
          <CardContent className="py-14 text-center">
            <p className="font-semibold text-slate-700 dark:text-slate-200">
              This request is not available
            </p>
            <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
              It may have been removed, or it belongs to someone else.
            </p>
            <Button asChild variant="outline" className="mt-4">
              <Link href="/support">Back to all requests</Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}

/**
 * One request, one answer. The server's message is shown when there is one, and
 * a neutral sentence when the request never arrived — never a raw exception.
 */
async function submitJson(
  url: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (response.ok) return { ok: true }

    const payload = await response.json().catch(() => ({}))
    return { ok: false, error: payload?.error || "Please try again." }
  } catch {
    return { ok: false, error: "The request did not reach the server. Please try again." }
  }
}

function Detail({ label, children }: Readonly<{ label: string; children: React.ReactNode }>) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className="text-slate-800 dark:text-slate-100">{children}</dd>
    </div>
  )
}

function MessageBubble({
  message,
  mine,
}: Readonly<{ message: SupportMessage; mine: boolean }>) {
  const fromApricart = message.authorSide === "APRICART"

  return (
    <li
      className={cn(
        "rounded-lg border p-4",
        fromApricart
          ? "border-indigo-200 bg-indigo-50/60 dark:border-indigo-900 dark:bg-indigo-950/40"
          : "border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold text-slate-900 dark:text-slate-50">
          {mine ? "You" : message.authorName || (fromApricart ? "Apricart team" : "A colleague")}
        </span>
        {fromApricart && !mine ? (
          <span className="rounded bg-indigo-600 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white">
            Apricart
          </span>
        ) : null}
        <span className="ml-auto text-xs text-slate-400">{formatWhen(message.createdAt)}</span>
      </div>

      {/*
        Rendered as text, never as markup. React escapes it, and `whitespace-pre-wrap`
        keeps the author's line breaks without any HTML being involved.
      */}
      <p className="mt-2 whitespace-pre-wrap break-words text-sm text-slate-700 dark:text-slate-200">
        {message.body}
      </p>

      {message.attachments.length > 0 ? (
        <ul className="mt-3 flex flex-wrap gap-2">
          {message.attachments.map((attachment) => (
            <li key={attachment.id}>
              <a
                href={`/api/v1/support/attachments/${attachment.id}`}
                className="inline-flex items-center gap-1.5 rounded-md border bg-white px-2 py-1 text-xs hover:border-indigo-300 dark:border-slate-700 dark:bg-slate-800"
              >
                <Download className="h-3.5 w-3.5 text-slate-400" />
                <span className="max-w-[200px] truncate">{attachment.fileName}</span>
                <span className="text-slate-400">{formatBytes(attachment.sizeBytes)}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  )
}
