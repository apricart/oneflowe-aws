import { stringifyPrimitive } from "../stringify-primitive"
import "server-only"

import { sendAppEmail } from "@/lib/email/ses"
import type { OrderDecisionRole } from "@/lib/order-approver-role"
import { ROLE_DISPLAY_NAMES } from "@/lib/role-display-names"
import { env } from "@/lib/server/env"

export type OrderLifecycleEmailTemplate =
  | "ORDER_CREATED"
  | "ORDER_APPROVED"
  | "ORDER_REJECTED"
  | "ORDER_APPROVED_ADMIN"
  | "ORDER_RETURNED"
  | "ORDER_RESUBMITTED"
  | "ORDER_DELIVERED"

export type OrderLifecycleEmailPayload = {
  orderId: number
  tid: string
  organizationName: string
  branchName: string
  requestedBy?: string | null
  approvedBy?: string | null
  approvedByRole?: OrderDecisionRole | null
  rejectionReason?: string | null
  /** ORDER_APPROVED_ADMIN only: approved at creation by organization policy, not by a person. */
  autoApproved?: boolean | null
  /** ORDER_RETURNED only: what the approver asked to be corrected. */
  correctionComment?: string | null
  /** ORDER_RESUBMITTED only: the requester's optional reply. */
  resubmissionNote?: string | null
}

const escapeHtml = (value: unknown) => stringifyPrimitive(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;")

const safeTagValue = (value: string) => value.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256) || "unknown"

/** Recipients who are mailed about an order because they raised it. */
function isRequesterRole(recipientRole?: string | null): boolean {
  return recipientRole === "ORDER_PORTAL" || recipientRole === "GROUP_ORDER_PORTAL"
}

/**
 * Where the button goes. Approver-facing mail opens the order; requester-facing
 * mail opens the requester's own portal, which for a Group Order Portal raiser
 * is the group workspace rather than the shop.
 */
function orderUrl(template: OrderLifecycleEmailTemplate, orderId: number, recipientRole?: string | null) {
  const opensOrder = template === "ORDER_CREATED"
    || template === "ORDER_APPROVED_ADMIN"
    || template === "ORDER_RESUBMITTED"
    || (template === "ORDER_DELIVERED" && !isRequesterRole(recipientRole))
  const requesterPortal = recipientRole === "GROUP_ORDER_PORTAL" ? "/group-portal" : "/shop"
  const path = opensOrder ? `/orders/${orderId}` : requesterPortal
  return new URL(path, env.NEXTAUTH_URL).toString()
}

type LifecycleCopy = { heading: string; intro: string; subject: string; accent: string }

const AMBER = "#d97706"
const GREEN = "#059669"
const RED = "#dc2626"

function approverRoleLabelOf(payload: OrderLifecycleEmailPayload): string {
  if (payload.approvedByRole === "HEAD_OFFICE") return "Head Office"
  if (payload.approvedByRole === "GROUP_USER") return ROLE_DISPLAY_NAMES.GROUP_USER
  if (payload.approvedByRole === "APRICART_EXECUTIVE") return "Apricart Executive"
  return ROLE_DISPLAY_NAMES.BRANCH_ADMIN
}

/** The wording and colour for each template, in one place. */
function lifecycleCopy(
  template: OrderLifecycleEmailTemplate,
  payload: OrderLifecycleEmailPayload,
  recipientRole?: string | null,
): LifecycleCopy {
  const tid = payload.tid
  if (template === "ORDER_DELIVERED") {
    const acknowledge = "Please acknowledge the delivery by sending the order's fulfilment token, so the order is fulfilled."
    return isRequesterRole(recipientRole)
      ? {
        heading: "Your order was delivered",
        intro: `Your order has been delivered to your branch. ${acknowledge}`,
        subject: `Order ${tid} was delivered — please acknowledge`,
        accent: GREEN,
      }
      : {
        heading: "An order you approved was delivered",
        intro: `An order you approved has been delivered to its branch. ${acknowledge}`,
        subject: `Order ${tid} was delivered — please acknowledge`,
        accent: GREEN,
      }
  }
  if (template === "ORDER_APPROVED_ADMIN") {
    if (payload.autoApproved === true) {
      return {
        heading: "Order approved automatically",
        intro: "This order was approved automatically under its organization's order approval policy. It is ready for Super Admin review.",
        subject: `Order ${tid} was approved automatically`,
        accent: GREEN,
      }
    }
    const label = approverRoleLabelOf(payload)
    return {
      heading: `Order approved by ${label}`,
      intro: `${label} approved an order. It is ready for Super Admin review.`,
      subject: `Order ${tid} was approved by ${label}`,
      accent: GREEN,
    }
  }
  const copy: Record<Exclude<OrderLifecycleEmailTemplate, "ORDER_APPROVED_ADMIN" | "ORDER_DELIVERED">, LifecycleCopy> = {
    ORDER_CREATED: {
      heading: "New order awaiting approval",
      intro: "An Order Initiator submitted a new order that requires your approval.",
      subject: `Order ${tid} is awaiting approval`,
      accent: AMBER,
    },
    ORDER_RETURNED: {
      heading: "Your order needs correction",
      intro: "An authorized administrator returned your order for correction. Update it as requested and resubmit it for approval. The order stays reserved while you do.",
      subject: `Order ${tid} was returned for correction`,
      accent: AMBER,
    },
    ORDER_RESUBMITTED: {
      heading: "Corrected order awaiting approval",
      intro: "An order that was returned for correction has been updated and resubmitted. It requires your approval.",
      subject: `Order ${tid} was resubmitted for approval`,
      accent: AMBER,
    },
    ORDER_APPROVED: {
      heading: "Your order was approved",
      intro: "An authorized administrator approved your order.",
      subject: `Order ${tid} was approved`,
      accent: GREEN,
    },
    ORDER_REJECTED: {
      heading: "Your order was rejected",
      intro: "An authorized administrator rejected your order.",
      subject: `Order ${tid} was rejected`,
      accent: RED,
    },
  }
  return copy[template]
}

/**
 * The free text an email carries, if any: the rejection reason, what to
 * correct, or the requester's reply. Escaped by the caller.
 */
function noteFor(
  template: OrderLifecycleEmailTemplate,
  payload: OrderLifecycleEmailPayload,
): { label: string; value: string; background: string; color: string } | null {
  if (template === "ORDER_REJECTED" && payload.rejectionReason) {
    return { label: "Reason", value: payload.rejectionReason, background: "#fef2f2", color: "#991b1b" }
  }
  if (template === "ORDER_RETURNED" && payload.correctionComment) {
    return { label: "What to correct", value: payload.correctionComment, background: "#fffbeb", color: "#92400e" }
  }
  if (template === "ORDER_RESUBMITTED" && payload.resubmissionNote) {
    return { label: "Requester's note", value: payload.resubmissionNote, background: "#f1f5f9", color: "#334155" }
  }
  return null
}

export function buildOrderLifecycleEmail(
  template: OrderLifecycleEmailTemplate,
  payload: OrderLifecycleEmailPayload,
  recipientRole?: string | null,
) {
  const link = orderUrl(template, payload.orderId, recipientRole)
  const isCreated = template === "ORDER_CREATED"
  const isResubmitted = template === "ORDER_RESUBMITTED"
  const isAdminApproval = template === "ORDER_APPROVED_ADMIN"
  const { heading, intro, subject, accent } = lifecycleCopy(template, payload, recipientRole)
  const actionLabel = (() => {
    if (template === "ORDER_DELIVERED") return "Acknowledge delivery"
    return isCreated || isAdminApproval || isResubmitted ? "Review order" : "View my orders"
  })()

  const note = noteFor(template, payload)
  const noteBlock = note
    ? `<div style="margin-top:20px;padding:14px;border-radius:10px;background:${note.background};color:${note.color};font-size:14px;line-height:1.5;white-space:pre-line;"><strong>${escapeHtml(note.label)}:</strong> ${escapeHtml(note.value)}</div>`
    : ""
  const requesterRow = (isCreated || isResubmitted) && payload.requestedBy
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
          ${noteBlock}
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
    (isCreated || isResubmitted) && payload.requestedBy ? `Requested by: ${payload.requestedBy}` : "",
    isAdminApproval && payload.approvedBy ? `Approved by: ${payload.approvedBy}` : "",
    note ? `${note.label}: ${note.value}` : "",
    `${actionLabel}: ${link}`,
  ].filter(Boolean).join("\n")

  return { subject, html, text }
}

export async function sendOrderLifecycleEmail(input: {
  to: string
  template: OrderLifecycleEmailTemplate
  payload: OrderLifecycleEmailPayload
  recipientRole?: string | null
}) {
  const content = buildOrderLifecycleEmail(input.template, input.payload, input.recipientRole)
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
