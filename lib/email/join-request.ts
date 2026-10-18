import "server-only"

import { logError } from "@/lib/global-logger"
import { sendAppEmail, validateSesConfig } from "@/lib/email/ses"
import { stringifyPrimitive } from "@/lib/stringify-primitive"

/**
 * Telling somebody what happened to their request to join an organization.
 *
 * What this mail deliberately does **not** contain:
 *
 *   * a password, or anything derived from one. The applicant chose their own
 *     password on the join form and it was hashed on arrival — there is nothing
 *     to send, and nothing that could be sent.
 *   * a rejection reason. Head Office records one for its own trail, and it may
 *     name a person or a decision that has no business travelling to an
 *     unverified mailbox. The mail says the request was not approved and points
 *     at the organization.
 *   * anything about the tenant beyond the name the applicant already typed a
 *     code for.
 */

const escapeHtml = (value: unknown) => stringifyPrimitive(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;")

export type JoinDecisionEmail = {
  to: string
  firstName: string
  username: string
  organizationName: string
  approved: boolean
  loginUrl: string
}

function body(payload: JoinDecisionEmail): { subject: string; html: string; text: string } {
  const who = payload.firstName || payload.username
  const organization = payload.organizationName

  if (payload.approved) {
    return {
      subject: `You have been added to ${organization} on OneFlowe`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a;">
          <h1 style="font-size:22px;margin:0 0 16px;">Your request was approved</h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hello ${escapeHtml(who)},</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            ${escapeHtml(organization)} has approved your request to join. You can sign in with the
            username <strong style="font-family:monospace;">${escapeHtml(payload.username)}</strong>
            and the password you chose when you applied.
          </p>
          <p style="margin:24px 0;">
            <a href="${escapeHtml(payload.loginUrl)}" style="background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Sign in</a>
          </p>
          <p style="font-size:13px;line-height:1.6;color:#64748b;margin:0;">
            This is an automated message, please do not reply.
          </p>
        </div>`,
      text: [
        `Your request to join ${organization} was approved.`,
        ``,
        `Hello ${who},`,
        ``,
        `You can now sign in with the username ${payload.username} and the password you`,
        `chose when you applied.`,
        ``,
        `Sign in: ${payload.loginUrl}`,
        ``,
        `This is an automated message, please do not reply.`,
      ].join("\n"),
    }
  }

  return {
    subject: `Your request to join ${organization} on OneFlowe`,
    html: `
      <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a;">
        <h1 style="font-size:22px;margin:0 0 16px;">Your request was not approved</h1>
        <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hello ${escapeHtml(who)},</p>
        <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
          ${escapeHtml(organization)} did not approve your request to join, and no account has been
          created. If you believe this was a mistake, please contact the head office of
          ${escapeHtml(organization)} directly.
        </p>
        <p style="font-size:13px;line-height:1.6;color:#64748b;margin:0;">
          This is an automated message, please do not reply.
        </p>
      </div>`,
    text: [
      `Your request to join ${organization} was not approved.`,
      ``,
      `Hello ${who},`,
      ``,
      `No account has been created. If you believe this was a mistake, please contact`,
      `the head office of ${organization} directly.`,
      ``,
      `This is an automated message, please do not reply.`,
    ].join("\n"),
  }
}

/**
 * Best effort by design: the caller has already committed the decision, so a
 * mail failure must never undo it or surface as an error to Head Office.
 */
export async function sendJoinDecisionEmail(payload: JoinDecisionEmail): Promise<boolean> {
  try {
    if (!payload.to) return false
    if (!validateSesConfig()) {
      console.error("[Email] AWS SES not configured — skipping join decision email")
      return false
    }

    const { subject, html, text } = body(payload)
    await sendAppEmail({
      fromName: "OneFlowe",
      to: payload.to,
      subject,
      html,
      text,
      tags: [{ name: "type", value: payload.approved ? "join_approved" : "join_rejected" }],
    })
    return true
  } catch (error) {
    logError(error, "EMAIL_SEND_JOIN_DECISION", { to: payload.to })
    return false
  }
}

export type JoinApproverNoticeEmail = {
  to: string
  firstName: string
  level: number
  initiatorName: string
  organizationName: string
  /** The approval converted this Branch Admin to a Group User and ended its sessions. */
  becameGroupUser?: boolean
  loginUrl: string
}

/**
 * Telling an existing approver that a department sign-up made them an order
 * approver, or gave them more branches (plans/OF-JOIN-department-signup-multi-user.md).
 * Names the level and the person, nothing else: no amounts, no branches.
 * Best effort, like the decision email.
 */
export async function sendJoinApproverNoticeEmail(payload: JoinApproverNoticeEmail): Promise<boolean> {
  try {
    if (!payload.to) return false
    if (!validateSesConfig()) {
      console.error("[Email] AWS SES not configured — skipping join approver notice")
      return false
    }

    const who = payload.firstName || "there"
    await sendAppEmail({
      fromName: "OneFlowe",
      to: payload.to,
      subject: `You are a Level ${payload.level} order approver at ${payload.organizationName}`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#0f172a;">
          <h1 style="font-size:22px;margin:0 0 16px;">You have been named an order approver</h1>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">Hello ${escapeHtml(who)},</p>
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            ${escapeHtml(payload.organizationName)} has approved ${escapeHtml(payload.initiatorName)}'s
            request to join, naming you as their Level ${escapeHtml(payload.level)} financial approver.
            Orders at their branches in your level's range will come to you for approval.
          </p>${payload.becameGroupUser ? `
          <p style="font-size:15px;line-height:1.6;margin:0 0 16px;">
            To approve for all of their branches, your account is now a Group Financial Approver instead of a
            Financial Approver, and you keep your own branch. You have been signed out; sign in again
            with your usual username and password.
          </p>` : ""}
          <p style="margin:24px 0;">
            <a href="${escapeHtml(payload.loginUrl)}" style="background:#2563eb;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700;">Sign in</a>
          </p>
          <p style="font-size:13px;line-height:1.6;color:#64748b;margin:0;">
            This is an automated message, please do not reply.
          </p>
        </div>`,
      text: [
        `You have been named an order approver at ${payload.organizationName}.`,
        ``,
        `Hello ${who},`,
        ``,
        `${payload.organizationName} has approved ${payload.initiatorName}'s request to join, naming you`,
        `as their Level ${payload.level} financial approver. Orders at their branches in your`,
        `level's range will come to you for approval.`,
        ...(payload.becameGroupUser
          ? [
              ``,
              `To approve for all of their branches, your account is now a Group Financial Approver instead of a`,
              `Financial Approver, and you keep your own branch. You have been signed out; sign in again`,
              `with your usual username and password.`,
            ]
          : []),
        ``,
        `Sign in: ${payload.loginUrl}`,
        ``,
        `This is an automated message, please do not reply.`,
      ].join("\n"),
      tags: [{ name: "type", value: "join_approver_notice" }],
    })
    return true
  } catch (error) {
    logError(error, "EMAIL_SEND_JOIN_APPROVER_NOTICE", { to: payload.to })
    return false
  }
}
