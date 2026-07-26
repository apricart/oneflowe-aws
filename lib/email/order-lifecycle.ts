import "server-only"

import { sendAppEmail } from "@/lib/email/ses"
import { env } from "@/lib/server/env"

export type OrderLifecycleEmailTemplate =
  | "ORDER_CREATED"
  | "ORDER_APPROVED"
  | "ORDER_REJECTED"
  | "ORDER_APPROVED_ADMIN"

export type OrderLifecycleEmailPayload = {
  orderId: number
  tid: string
  organizationName: string
  branchName: string
  requestedBy?: string | null
  approvedBy?: string | null
  rejectionReason?: string | null
}

const escapeHtml = (value: unknown) => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;")

const safeTagValue = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "unknown"

function orderUrl(template: OrderLifecycleEmailTemplate, orderId: number) {
  const path = template === "ORDER_CREATED" || template === "ORDER_APPROVED_ADMIN"
    ? `/orders/${orderId}`
    : "/shop"
  return new URL(path, env.NEXTAUTH_URL).toString()
}

export function buildOrderLifecycleEmail(
  template: OrderLifecycleEmailTemplate,
  payload: OrderLifecycleEmailPayload,
) {
  const link = orderUrl(template, payload.orderId)
  const isCreated = template === "ORDER_CREATED"
  const isAdminApproval = template === "ORDER_APPROVED_ADMIN"
  const isApproved = template === "ORDER_APPROVED"
  const heading = isCreated
    ? "New order awaiting approval"
    : isAdminApproval
      ? "Order approved by Branch Admin"
    : isApproved
      ? "Your order was approved"
      : "Your order was rejected"
  const accent = isCreated ? "#d97706" : isApproved || isAdminApproval ? "#059669" : "#dc2626"
  const intro = isCreated
    ? "An Order Portal user submitted a new order for your branch."
    : isAdminApproval
      ? "A Branch Admin approved an order. It is ready for Super Admin review."
    : isApproved
      ? "An authorized administrator approved your order."
      : "An authorized administrator rejected your order."
  const actionLabel = isCreated || isAdminApproval ? "Review order" : "View my orders"
  const subject = isCreated
    ? `Order ${payload.tid} is awaiting approval`
    : isAdminApproval
      ? `Order ${payload.tid} was approved by Branch Admin`
    : `Order ${payload.tid} was ${isApproved ? "approved" : "rejected"}`

  const rejectionBlock = template === "ORDER_REJECTED" && payload.rejectionReason
    ? `<div style="margin-top:20px;padding:14px;border-radius:10px;background:#fef2f2;color:#991b1b;font-size:14px;line-height:1.5;"><strong>Reason:</strong> ${escapeHtml(payload.rejectionReason)}</div>`
    : ""
  const requesterRow = isCreated && payload.requestedBy
    ? `<tr><td style="padding-top:8px;color:#64748b;font-size:13px;font-weight:700;">Requested by</td><td style="padding-top:8px;text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(payload.requestedBy)}</td></tr>`
    : ""
  const approverRow = isAdminApproval && payload.approvedBy
    ? `<tr><td style="padding-top:8px;color:#64748b;font-size:13px;font-weight:700;">Approved by</td><td style="padding-top:8px;text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(payload.approvedBy)}</td></tr>`
    : ""

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
            <tr><td style="color:#64748b;font-size:13px;font-weight:700;">Order TID</td><td style="text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(payload.tid)}</td></tr>
            <tr><td style="padding-top:8px;color:#64748b;font-size:13px;font-weight:700;">Organization</td><td style="padding-top:8px;text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(payload.organizationName)}</td></tr>
            <tr><td style="padding-top:8px;color:#64748b;font-size:13px;font-weight:700;">Branch</td><td style="padding-top:8px;text-align:right;color:#1e293b;font-size:13px;font-weight:800;">${escapeHtml(payload.branchName)}</td></tr>
            ${requesterRow}
            ${approverRow}
          </table>
          ${rejectionBlock}
          <div style="margin-top:26px;"><a href="${escapeHtml(link)}" style="display:inline-block;padding:12px 18px;border-radius:9px;background:${accent};color:#ffffff;text-decoration:none;font-size:14px;font-weight:800;">${escapeHtml(actionLabel)}</a></div>
          <p style="margin:24px 0 0;color:#94a3b8;font-size:12px;line-height:1.5;">Sign in to OneFlowe to view current order details. This email never contains an approval or fulfillment token.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`

  const text = [
    heading,
    intro,
    `Order TID: ${payload.tid}`,
    `Organization: ${payload.organizationName}`,
    `Branch: ${payload.branchName}`,
    isCreated && payload.requestedBy ? `Requested by: ${payload.requestedBy}` : "",
    isAdminApproval && payload.approvedBy ? `Approved by: ${payload.approvedBy}` : "",
    template === "ORDER_REJECTED" && payload.rejectionReason ? `Reason: ${payload.rejectionReason}` : "",
    `${actionLabel}: ${link}`,
  ].filter(Boolean).join("\n")

  return { subject, html, text }
}

export async function sendOrderLifecycleEmail(input: {
  to: string
  template: OrderLifecycleEmailTemplate
  payload: OrderLifecycleEmailPayload
}) {
  const content = buildOrderLifecycleEmail(input.template, input.payload)
  const result = await sendAppEmail({
    to: input.to,
    fromName: "OneFlowe Orders",
    ...content,
    tags: [
      { name: "type", value: input.template.toLowerCase() },
      { name: "tid", value: safeTagValue(input.payload.tid) },
    ],
  })

  return result.MessageId || null
}
