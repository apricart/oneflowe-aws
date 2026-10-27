import "server-only"

import { sendAppEmail } from "@/lib/email/ses"
import { env } from "@/lib/server/env"
import { stringifyPrimitive } from "@/lib/stringify-primitive"
import {
  PRICE_CONTRACT_EXPIRING_TEMPLATE,
  formatPriceContractDay,
  priceContractReminderCopy,
  type PriceContractReminderPayload,
} from "@/lib/price-contract-validity"

/**
 * The email Super Admin and an assigned Apricart Executive get when an
 * organization's price contract enters its last week. It names the
 * organization and the date, and no price.
 * See plans/OF-PRICE-CONTRACT-organization-price-contract-validity.md.
 */

const escapeHtml = (value: unknown) => stringifyPrimitive(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;")

const ACCENT = "#b45309"

export function buildPriceContractReminderEmail(payload: PriceContractReminderPayload, daysLeft: number) {
  const copy = priceContractReminderCopy(payload, daysLeft)
  const link = new URL("/", env.NEXTAUTH_URL).toString()
  const actionLabel = "Open OneFlowe"
  const validUntil = formatPriceContractDay(payload.validUntil)

  const row = (label: string, value: string, first = false) => {
    const pad = first ? "" : "padding-top:8px;"
    return `<tr><td style="${pad}color:#64748b;font-size:13px;font-weight:700;">${escapeHtml(label)}</td><td style="${pad}text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(value)}</td></tr>`
  }

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${escapeHtml(copy.title)}</title></head>
<body style="margin:0;padding:0;font-family:Arial,sans-serif;background:#f8fafc;">
  <table role="presentation" style="width:100%;border-collapse:collapse;">
    <tr><td style="padding:32px 12px;">
      <table role="presentation" style="width:100%;max-width:620px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;overflow:hidden;">
        <tr><td style="padding:28px;background:${ACCENT};color:#ffffff;"><h1 style="margin:0;font-size:24px;">${escapeHtml(copy.title)}</h1></td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 22px;color:#475569;font-size:15px;line-height:1.6;">${escapeHtml(copy.intro)}</p>
          <table role="presentation" style="width:100%;border-collapse:collapse;">
            ${row("Organization", payload.organizationName, true)}
            ${payload.organizationCode ? row("Code", payload.organizationCode) : ""}
            ${row("Prices valid until", validUntil)}
          </table>
          <div style="margin-top:26px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:9px;background:${ACCENT};color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;">${escapeHtml(actionLabel)}</a></div>
          <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">This is a reminder only. Customers can keep ordering after the date passes.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = [
    copy.title,
    copy.intro,
    `Organization: ${payload.organizationName}`,
    ...(payload.organizationCode ? [`Code: ${payload.organizationCode}`] : []),
    `Prices valid until: ${validUntil}`,
    `${actionLabel}: ${link}`,
  ].join("\n")

  return { subject: copy.subject, html, text }
}

export async function sendPriceContractReminderEmail(input: {
  to: string
  payload: PriceContractReminderPayload
  daysLeft: number
}): Promise<string | null> {
  const content = buildPriceContractReminderEmail(input.payload, input.daysLeft)
  const result = await sendAppEmail({
    to: input.to,
    fromName: "OneFlowe",
    ...content,
    tags: [
      { name: "type", value: PRICE_CONTRACT_EXPIRING_TEMPLATE.toLowerCase() },
      { name: "organization", value: String(input.payload.organizationId) },
    ],
  })
  return result.MessageId || null
}
