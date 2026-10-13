import "server-only"

import { sendAppEmail } from "@/lib/email/ses"
import { env } from "@/lib/server/env"
import { stringifyPrimitive } from "@/lib/stringify-primitive"
import { WAREHOUSE_HOME } from "@/lib/warehouse-access"
import {
  warehouseOrderCopy,
  warehouseOrderEventOf,
  warehouseOrderLink,
  type WarehouseOrderPayload,
  type WarehouseOrderTemplate,
} from "@/lib/warehouse-order-notifications"

/**
 * The email a warehouse user gets for an order stage. It carries what the
 * in-app notice carries — order, organization, branch, stage — and nothing else.
 * See plans/OF-WAREHOUSE-order-stage-notifications.md.
 */

const escapeHtml = (value: unknown) => stringifyPrimitive(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;")

const safeTagValue = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "unknown"

export function buildWarehouseOrderEmail(template: WarehouseOrderTemplate, payload: WarehouseOrderPayload) {
  const event = warehouseOrderEventOf(template)
  const copy = warehouseOrderCopy(event, payload)
  const path = warehouseOrderLink(event, payload) ?? WAREHOUSE_HOME
  const link = new URL(path, env.NEXTAUTH_URL).toString()
  const actionLabel = copy.opensQueue ? "Open my order queue" : "Open the warehouse"

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
        <tr><td style="padding:28px;background:${copy.accent};color:#ffffff;"><h1 style="margin:0;font-size:24px;">${escapeHtml(copy.title)}</h1></td></tr>
        <tr><td style="padding:28px;">
          <p style="margin:0 0 22px;color:#475569;font-size:15px;line-height:1.6;">${escapeHtml(copy.intro)}</p>
          <table role="presentation" style="width:100%;border-collapse:collapse;">
            ${row("Order TID", payload.tid, true)}
            ${row("Organization", payload.organizationName)}
            ${row("Branch", payload.branchName)}
          </table>
          <div style="margin-top:26px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:9px;background:${copy.accent};color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;">${escapeHtml(actionLabel)}</a></div>
          <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">Sign in to OneFlowe to view current order details. You receive this because the order's branch is assigned to your warehouse.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = [
    copy.title,
    copy.intro,
    `Order TID: ${payload.tid}`,
    `Organization: ${payload.organizationName}`,
    `Branch: ${payload.branchName}`,
    `${actionLabel}: ${link}`,
  ].join("\n")

  return { subject: copy.subject, html, text }
}

export async function sendWarehouseOrderEmail(input: {
  to: string
  template: WarehouseOrderTemplate
  payload: WarehouseOrderPayload
}): Promise<string | null> {
  const content = buildWarehouseOrderEmail(input.template, input.payload)
  const result = await sendAppEmail({
    to: input.to,
    fromName: "OneFlowe Warehouse",
    ...content,
    tags: [
      { name: "type", value: input.template.toLowerCase() },
      { name: "tid", value: safeTagValue(input.payload.tid) },
    ],
  })
  return result.MessageId || null
}
