import "server-only"

import { sendAppEmail } from "@/lib/email/ses"
import { env } from "@/lib/server/env"
import { stringifyPrimitive } from "@/lib/stringify-primitive"
import {
  SUPPORT_CATEGORY_LABELS,
  isSupportCategory,
  supportThreadReference,
} from "@/lib/support-thread"

/**
 * Mail for the direct channel between a client organization and Apricart.
 *
 * The message body itself is deliberately **not** included. A support thread
 * can carry an invoice dispute, a price, or a name, and an email is the one
 * place in this system where that content would leave the application's own
 * access control behind — forwarded, quoted, or read on a shared mailbox. The
 * email says that something happened and links to the thread; reading it
 * requires signing in and passing the thread's visibility rule.
 */

export type SupportEmailTemplate =
  | "SUPPORT_THREAD_OPENED"
  | "SUPPORT_MESSAGE_RECEIVED"
  | "SUPPORT_THREAD_RESOLVED"
  | "SUPPORT_THREAD_CLOSED"

export const SUPPORT_EMAIL_TEMPLATES: readonly SupportEmailTemplate[] = [
  "SUPPORT_THREAD_OPENED",
  "SUPPORT_MESSAGE_RECEIVED",
  "SUPPORT_THREAD_RESOLVED",
  "SUPPORT_THREAD_CLOSED",
] as const

export function isSupportEmailTemplate(value: unknown): value is SupportEmailTemplate {
  return (
    typeof value === "string" &&
    SUPPORT_EMAIL_TEMPLATES.includes(value as SupportEmailTemplate)
  )
}

export type SupportEmailPayload = {
  threadId: number
  subject: string
  category: string
  organizationName: string
  /** Who wrote or acted, by display name — never an email address. */
  actorName: string
  /** True when the recipient is on the Apricart side of the conversation. */
  toApricart: boolean
}

const escapeHtml = (value: unknown) => stringifyPrimitive(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;")

const safeTagValue = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "unknown"

function supportUrl(threadId: number): string {
  return new URL(`/support/${threadId}`, env.NEXTAUTH_URL).toString()
}

export function parseSupportEmailPayload(
  value: Record<string, unknown>,
): SupportEmailPayload | null {
  const threadId = Number(value?.threadId)
  if (
    !Number.isInteger(threadId) || threadId <= 0 ||
    typeof value?.subject !== "string" || !value.subject ||
    typeof value?.category !== "string" ||
    typeof value?.organizationName !== "string"
  ) {
    return null
  }

  return {
    threadId,
    subject: value.subject,
    category: value.category,
    organizationName: value.organizationName,
    actorName: typeof value.actorName === "string" ? value.actorName : "A colleague",
    toApricart: value.toApricart === true,
  }
}

export function buildSupportEmail(
  template: SupportEmailTemplate,
  payload: SupportEmailPayload,
): { subject: string; html: string; text: string } {
  const reference = supportThreadReference(payload.threadId)
  const link = supportUrl(payload.threadId)
  const categoryLabel = isSupportCategory(payload.category)
    ? SUPPORT_CATEGORY_LABELS[payload.category]
    : "Other"

  const { heading, intro, accent } = (() => {
    switch (template) {
      case "SUPPORT_THREAD_OPENED":
        return {
          heading: "New support request",
          accent: "#d97706",
          intro: payload.toApricart
            ? `${payload.actorName} at ${payload.organizationName} raised a new request with the Apricart team.`
            : "Your request has reached the Apricart team. You will be notified when they reply.",
        }
      case "SUPPORT_MESSAGE_RECEIVED":
        return {
          heading: "New reply on your support request",
          accent: "#2563eb",
          intro: payload.toApricart
            ? `${payload.actorName} at ${payload.organizationName} replied on a support request.`
            : `The Apricart team replied to your request.`,
        }
      case "SUPPORT_THREAD_RESOLVED":
        return {
          heading: "Support request resolved",
          accent: "#059669",
          intro: `${payload.actorName} marked this request as resolved. If the matter is not settled, reopen it by replying.`,
        }
      default:
        return {
          heading: "Support request closed",
          accent: "#475569",
          intro: `${payload.actorName} closed this request. Raise a new one if you need to take it further.`,
        }
    }
  })()

  const subject = `[${reference}] ${payload.subject}`

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(heading)}</title></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f8fafc;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:32px 12px;">
      <table role="presentation" style="width:100%;max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px;background:${accent};color:#ffffff;"><h1 style="margin:0;font-size:24px;">${escapeHtml(heading)}</h1></td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 22px;color:#475569;font-size:15px;line-height:1.6;">${escapeHtml(intro)}</p>
          <table role="presentation" style="width:100%;border-collapse:collapse;">
            <tr><td style="color:#64748b;font-size:13px;font-weight:700;">Reference</td><td style="text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(reference)}</td></tr>
            <tr><td style="padding-top:8px;color:#64748b;font-size:13px;font-weight:700;">Subject</td><td style="padding-top:8px;text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(payload.subject)}</td></tr>
            <tr><td style="padding-top:8px;color:#64748b;font-size:13px;font-weight:700;">Category</td><td style="padding-top:8px;text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(categoryLabel)}</td></tr>
            <tr><td style="padding-top:8px;color:#64748b;font-size:13px;font-weight:700;">Organization</td><td style="padding-top:8px;text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(payload.organizationName)}</td></tr>
          </table>
          <div style="margin-top:26px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:9px;background:${accent};color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;">Open the request</a></div>
          <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">Sign in to OneFlowe to read and reply. The conversation itself is never included in this email.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = [
    heading,
    intro,
    `Reference: ${reference}`,
    `Subject: ${payload.subject}`,
    `Category: ${categoryLabel}`,
    `Organization: ${payload.organizationName}`,
    `Open the request: ${link}`,
    "Sign in to OneFlowe to read and reply. The conversation itself is never included in this email.",
  ].join("\n")

  return { subject, html, text }
}

export async function sendSupportEmail(input: {
  to: string
  template: SupportEmailTemplate
  payload: SupportEmailPayload
}): Promise<string | null> {
  const content = buildSupportEmail(input.template, input.payload)
  const result = await sendAppEmail({
    to: input.to,
    fromName: "OneFlowe Support",
    ...content,
    tags: [
      { name: "type", value: input.template.toLowerCase() },
      { name: "thread", value: safeTagValue(supportThreadReference(input.payload.threadId)) },
    ],
  })

  return result.MessageId || null
}
