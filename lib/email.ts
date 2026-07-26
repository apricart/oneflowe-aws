/**
 * Email Service
 * Handles application email sending using AWS SES.
 */

import { logError } from '@/lib/global-logger'
import { sendAppEmail, validateSesConfig } from '@/lib/email/ses'
import { formatQuantity } from '@/lib/quantity'

const sanitizeEmailTagValue = (value: string) =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 256) || "unknown"

/**
 * Generate HTML email template for OTP
 */
function generateOTPEmailHTML(code: string, type: string): string {
  const typeText = type === 'LOGIN' ? 'Login' : type === 'VERIFY_EMAIL' ? 'Email Verification' : 'Password Reset'

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Your OTP Code</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
      <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 40px 0;">
            <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <!-- Header -->
              <tr>
                <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">OneFlowe</h1>
                  <p style="margin: 10px 0 0 0; color: #ffffff; font-size: 14px; opacity: 0.9;">${typeText} Verification</p>
                </td>
              </tr>
              
              <!-- Content -->
              <tr>
                <td style="padding: 40px 30px;">
                  <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                    Hello,
                  </p>
                  <p style="margin: 0 0 30px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                    We received a request for ${typeText.toLowerCase()}. Please use the following one-time password (OTP) to complete your verification:
                  </p>
                  
                  <!-- OTP Code -->
                  <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 30px 0;">
                    <tr>
                      <td style="text-align: center; padding: 20px; background-color: #f8f9fa; border-radius: 8px;">
                        <div style="font-size: 36px; font-weight: 700; letter-spacing: 8px; color: #667eea; font-family: 'Courier New', monospace;">
                          ${code}
                        </div>
                      </td>
                    </tr>
                  </table>
                  
                  <p style="margin: 30px 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                    This code will expire in <strong>2 minutes</strong>.
                  </p>
                  
                  <p style="margin: 0 0 10px 0; color: #666666; font-size: 14px; line-height: 1.5;">
                    If you didn't request this code, please ignore this email or contact support if you have concerns.
                  </p>
                </td>
              </tr>
              
              <!-- Footer -->
              <tr>
                <td style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
                  <p style="margin: 0 0 10px 0; color: #666666; font-size: 14px;">
                    This is an automated message, please do not reply.
                  </p>
                  <p style="margin: 0; color: #999999; font-size: 12px;">
                    © ${new Date().getFullYear()} OneFlowe. All rights reserved.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `
}

/**
 * Generate plain text email for OTP (fallback)
 */
function generateOTPEmailText(code: string, type: string): string {
  const typeText = type === 'LOGIN' ? 'Login' : type === 'VERIFY_EMAIL' ? 'Email Verification' : 'Password Reset'

  return `
OneFlowe - ${typeText} Verification

Hello,

We received a request for ${typeText.toLowerCase()}. Please use the following one-time password (OTP) to complete your verification:

OTP Code: ${code}

This code will expire in 2 minutes.

If you didn't request this code, please ignore this email or contact support if you have concerns.

This is an automated message, please do not reply.

© ${new Date().getFullYear()} OneFlowe. All rights reserved.
  `.trim()
}

/**
 * Send OTP email to user
 */
export async function sendOTPEmail(
  to: string,
  code: string,
  type: 'LOGIN' | 'VERIFY_EMAIL' | 'RESET_PASSWORD'
): Promise<boolean> {
  try {
    // Validate inputs
    if (!to || !code || !type) {
      console.error('[Email] Invalid parameters for sendOTPEmail')
      return false
    }

    if (!validateSesConfig()) {
      console.error('[Email] Failed to validate AWS SES configuration.')
      return false
    }

    // Prepare email subject
    const typeText = type === 'LOGIN' ? 'Login' : type === 'VERIFY_EMAIL' ? 'Email Verification' : 'Password Reset'
    const subject = `Your OneFlowe ${typeText} Code`

    await sendAppEmail({
      fromName: "OneFlowe",
      to,
      subject,
      text: generateOTPEmailText(code, type),
      html: generateOTPEmailHTML(code, type),
      tags: [
        { name: "type", value: sanitizeEmailTagValue(`otp_${type.toLowerCase()}`) },
      ],
    })

    return true

  } catch (error) {
    logError(error, 'EMAIL_SEND_OTP', { to, type })
    return false
  }
}

/**
 * Verify email service configuration
 */
export async function verifyEmailConfig(): Promise<boolean> {
  try {
    const verified = validateSesConfig()
    if (verified) console.log('[Email] AWS SES configuration verified successfully')
    return verified
  } catch (error) {
    logError(error, 'EMAIL_VERIFY_CONFIG')
    return false
  }
}

/**
 * Generate HTML email template for Reports
 */
function generateReportEmailHTML(reportName: string, frequency: string): string {
  const safeReportName = escapeHtml(reportName)
  const safeFrequency = escapeHtml(frequency)
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${safeReportName} Delivery</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f8fafc;">
      <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 40px 0;">
            <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1), 0 2px 4px -1px rgba(0,0,0,0.06);">
              <!-- Header -->
              <tr>
                <td style="background-color: #4f46e5; padding: 40px 30px; text-align: center;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.025em; text-transform: uppercase; font-style: italic;">OneFlowe BI</h1>
                  <p style="margin: 10px 0 0 0; color: #e0e7ff; font-size: 14px; font-weight: 500; opacity: 0.9;">Automated Intel Delivery</p>
                </td>
              </tr>
              
              <!-- Content -->
              <tr>
                <td style="padding: 40px 30px;">
                  <div style="display: flex; align-items: center; margin-bottom: 24px;">
                    <span style="background-color: #f0f9ff; color: #0369a1; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">${safeFrequency} REPORT</span>
                  </div>
                  <h2 style="margin: 0 0 16px 0; color: #1e293b; font-size: 20px; font-weight: 700;">${safeReportName}</h2>
                  <p style="margin: 0 0 24px 0; color: #475569; font-size: 15px; line-height: 1.6;">
                    Hello, please find your scheduled ${escapeHtml(reportName.toLowerCase())} attached below. This report contains the latest data audits and performance metrics based on your configuration.
                  </p>
                  
                  <div style="padding: 24px; background-color: #f8fafc; border-radius: 12px; border: 1px solid #f1f5f9; margin-bottom: 24px;">
                    <p style="margin: 0 0 8px 0; color: #64748b; font-size: 12px; font-weight: 600; text-transform: uppercase;">Delivery Details</p>
                    <p style="margin: 0; color: #1e293b; font-size: 14px; font-weight: 500;">
                      <strong>Generated At:</strong> ${new Date().toLocaleString()}<br>
                      <strong>Frequency:</strong> ${safeFrequency}<br>
                      <strong>Format:</strong> CSV Attachment
                    </p>
                  </div>
                </td>
              </tr>
              
              <!-- Footer -->
              <tr>
                <td style="background-color: #f8fafc; padding: 30px; text-align: center; border-top: 1px solid #f1f5f9;">
                  <p style="margin: 0 0 10px 0; color: #94a3b8; font-size: 13px;">
                    To modify this schedule, please login to your OneFlowe Portal.
                  </p>
                  <p style="margin: 0; color: #cbd5e1; font-size: 12px;">
                    © ${new Date().getFullYear()} OneFlowe BI Solutions. All rights reserved.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `
}

/**
 * Send Automated Report email
 */
export async function sendReportEmail(
  to: string | string[],
  reportName: string,
  frequency: string,
  attachmentData: Buffer | string,
  fileName: string
): Promise<boolean> {
  try {
    if (!validateSesConfig()) return false

    const recipients = Array.isArray(to) ? to.join(', ') : to
    const subject = `[REPORT] ${reportName} - ${new Date().toLocaleDateString()}`

    await sendAppEmail({
      fromName: "OneFlowe BI",
      to: recipients,
      subject,
      html: generateReportEmailHTML(reportName, frequency),
      attachments: [
        {
          filename: fileName,
          content: attachmentData,
          contentType: "text/csv; charset=utf-8",
        },
      ],
      tags: [
        { name: "type", value: "scheduled_report" },
        { name: "report", value: sanitizeEmailTagValue(reportName) },
      ],
    })

    return true
  } catch (error) {
    console.error(`[Email] Failed to send report email:`, error)
    logError(error, 'EMAIL_SEND_REPORT', { to, reportName })
    return false
  }
}

const escapeHtml = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")


export type OrderTokenEmailItem = {
  productName: string
  productCode?: string | null
  quantity: number
  unit?: string | null
}

export type OrderTokenEmailDetails = {
  to: string
  token: string
  tid: string
  organizationName: string
  branchName: string
  status: string
  createdAt: Date | string | null
  items: OrderTokenEmailItem[]
}

export type RefundRequestEmailItem = {
  productName: string
  quantity: number
  amountCents: number
}

export type RefundRequestEmailDetails = {
  to: string | string[]
  tid: string
  organizationName: string
  branchName: string
  requestedBy: string
  amountCents: number
  reason?: string | null
  items: RefundRequestEmailItem[]
}

const generateRefundRequestEmailHTML = (details: RefundRequestEmailDetails) => {
  const itemRows = details.items.map((item) => `
    <tr>
      <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #334155; font-size: 14px; font-weight: 700;">${escapeHtml(item.productName)}</td>
      <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #475569; font-size: 14px; text-align: right;">${escapeHtml(formatQuantity(item.quantity))}</td>
      <td style="padding: 10px 0; border-bottom: 1px solid #e2e8f0; color: #dc2626; font-size: 14px; font-weight: 800; text-align: right;">PKR ${escapeHtml((item.amountCents / 100).toFixed(2))}</td>
    </tr>
  `).join("")

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Refund Request</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f8fafc;">
      <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 32px 0;">
            <table role="presentation" style="width: 100%; max-width: 640px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0;">
              <tr>
                <td style="background-color: #dc2626; padding: 30px;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 900;">Refund Request Submitted</h1>
                  <p style="margin: 8px 0 0; color: #fee2e2; font-size: 13px; font-weight: 700;">A refund is waiting for super admin review.</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 30px;">
                  <table role="presentation" style="width: 100%; border-collapse: collapse;">
                    <tr><td style="color: #64748b; font-size: 13px; font-weight: 700;">Order TID</td><td style="text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(details.tid)}</td></tr>
                    <tr><td style="padding-top: 8px; color: #64748b; font-size: 13px; font-weight: 700;">Organization</td><td style="padding-top: 8px; text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(details.organizationName)}</td></tr>
                    <tr><td style="padding-top: 8px; color: #64748b; font-size: 13px; font-weight: 700;">Branch</td><td style="padding-top: 8px; text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(details.branchName)}</td></tr>
                    <tr><td style="padding-top: 8px; color: #64748b; font-size: 13px; font-weight: 700;">Requested By</td><td style="padding-top: 8px; text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(details.requestedBy)}</td></tr>
                    <tr><td style="padding-top: 8px; color: #64748b; font-size: 13px; font-weight: 700;">Refund Amount</td><td style="padding-top: 8px; text-align: right; color: #dc2626; font-size: 16px; font-weight: 900;">PKR ${escapeHtml((details.amountCents / 100).toFixed(2))}</td></tr>
                  </table>
                  ${details.reason ? `<div style="margin-top: 22px; padding: 14px; background-color: #f8fafc; border-radius: 10px; color: #475569; font-size: 14px; line-height: 1.5;"><strong>Reason:</strong> ${escapeHtml(details.reason)}</div>` : ""}
                  <table role="presentation" style="width: 100%; margin-top: 24px; border-collapse: collapse;">
                    <thead>
                      <tr>
                        <th style="padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 11px; text-align: left; text-transform: uppercase;">Item</th>
                        <th style="padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 11px; text-align: right; text-transform: uppercase;">Qty</th>
                        <th style="padding-bottom: 8px; border-bottom: 2px solid #e2e8f0; color: #64748b; font-size: 11px; text-align: right; text-transform: uppercase;">Amount</th>
                      </tr>
                    </thead>
                    <tbody>${itemRows}</tbody>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `
}

export async function sendRefundRequestEmail(details: RefundRequestEmailDetails): Promise<boolean> {
  try {
    if (!validateSesConfig()) return false

    await sendAppEmail({
      fromName: "OneFlowe Refunds",
      to: details.to,
      subject: `Refund request for order ${details.tid}`,
      html: generateRefundRequestEmailHTML(details),
      text: [
        "OneFlowe refund request submitted",
        `TID: ${details.tid}`,
        `Organization: ${details.organizationName}`,
        `Branch: ${details.branchName}`,
        `Requested by: ${details.requestedBy}`,
        `Amount: PKR ${(details.amountCents / 100).toFixed(2)}`,
        details.reason ? `Reason: ${details.reason}` : "",
      ].filter(Boolean).join("\n"),
      tags: [
        { name: "type", value: "refund_request" },
        { name: "tid", value: sanitizeEmailTagValue(details.tid) },
      ],
    })

    return true
  } catch (error) {
    console.error("[Email] Failed to send refund request email:", error)
    logError(error, "EMAIL_SEND_REFUND_REQUEST", { tid: details.tid })
    return false
  }
}


const generateOrderTokenEmailHTML = (details: OrderTokenEmailDetails) => {
  const createdAt = details.createdAt ? new Date(details.createdAt).toLocaleString() : "N/A"
  const items = details.items.map((item) => `
    <tr>
      <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #334155; font-size: 14px; font-weight: 600;">${escapeHtml(item.productCode ? `${item.productCode} - ${item.productName}` : item.productName)}</td>
      <td style="padding: 8px 0; border-bottom: 1px solid #f1f5f9; color: #4f46e5; font-size: 14px; font-weight: 800; text-align: right;">${escapeHtml(`${formatQuantity(item.quantity)}${item.unit ? ` ${item.unit}` : ""}`)}</td>
    </tr>
  `).join("")

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Order Fulfillment Token</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f8fafc;">
      <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 32px 0;">
            <table role="presentation" style="width: 100%; max-width: 640px; margin: 0 auto; background-color: #ffffff; border-radius: 16px; overflow: hidden; border: 1px solid #e2e8f0;">
              <tr>
                <td style="background-color: #4f46e5; padding: 30px;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 900;">OneFlowe Fulfillment Token</h1>
                  <p style="margin: 8px 0 0; color: #c7d2fe; font-size: 12px; font-weight: 700; letter-spacing: 2px;">SHARE WITH SUPER ADMIN</p>
                </td>
              </tr>
              <tr>
                <td style="padding: 30px;">
                  <p style="margin: 0 0 10px; color: #64748b; font-size: 12px; font-weight: 800; letter-spacing: 2px;">FULFILLMENT TOKEN</p>
                  <div style="padding: 18px; background-color: #eef2ff; border: 1px solid #c7d2fe; border-radius: 12px; color: #4338ca; font-family: 'Courier New', monospace; font-size: 30px; font-weight: 900; letter-spacing: 6px; text-align: center;">
                    ${escapeHtml(details.token)}
                  </div>
                  <table role="presentation" style="width: 100%; margin-top: 26px; border-collapse: collapse;">
                    <tr><td style="color: #64748b; font-size: 13px; font-weight: 700;">TID</td><td style="text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(details.tid)}</td></tr>
                    <tr><td style="padding-top: 8px; color: #64748b; font-size: 13px; font-weight: 700;">Status</td><td style="padding-top: 8px; text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(details.status)}</td></tr>
                    <tr><td style="padding-top: 8px; color: #64748b; font-size: 13px; font-weight: 700;">Organization</td><td style="padding-top: 8px; text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(details.organizationName)}</td></tr>
                    <tr><td style="padding-top: 8px; color: #64748b; font-size: 13px; font-weight: 700;">Branch</td><td style="padding-top: 8px; text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(details.branchName)}</td></tr>
                    <tr><td style="padding-top: 8px; color: #64748b; font-size: 13px; font-weight: 700;">Created</td><td style="padding-top: 8px; text-align: right; color: #1e293b; font-size: 13px; font-weight: 800;">${escapeHtml(createdAt)}</td></tr>
                  </table>
                  <p style="margin: 24px 0 8px; color: #64748b; font-size: 12px; font-weight: 800; letter-spacing: 2px;">ORDER ITEMS</p>
                  <table role="presentation" style="width: 100%; border-collapse: collapse; border-top: 1px solid #e2e8f0;">
                    <thead>
                      <tr>
                        <th style="padding-bottom: 8px; padding-top: 8px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 11px; font-weight: 700; text-align: left; text-transform: uppercase;">Product</th>
                        <th style="padding-bottom: 8px; padding-top: 8px; border-bottom: 1px solid #e2e8f0; color: #64748b; font-size: 11px; font-weight: 700; text-align: right; text-transform: uppercase;">Qty</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${items}
                    </tbody>
                  </table>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `
}

export async function sendOrderTokenEmail(details: OrderTokenEmailDetails): Promise<void> {
  try {
    const createdAt = details.createdAt ? new Date(details.createdAt).toLocaleString() : "N/A"
    const itemLines = details.items.map((item) =>
      `  - ${item.productCode ? `${item.productCode} - ` : ""}${item.productName}: ${formatQuantity(item.quantity)}${item.unit ? ` ${item.unit}` : ""}`
    )

    await sendAppEmail({
      fromName: "OneFlowe Orders",
      to: details.to,
      subject: `Order ${details.tid} – Fulfillment Token`,
      html: generateOrderTokenEmailHTML(details),
      text: [
        `OneFlowe – Fulfillment Token`,
        ``,
        `Fulfillment Token: ${details.token}`,
        ``,
        `TID:          ${details.tid}`,
        `Status:       ${details.status}`,
        `Organization: ${details.organizationName}`,
        `Branch:       ${details.branchName}`,
        `Created:      ${createdAt}`,
        ``,
        `Order Items:`,
        ...itemLines,
      ].join("\n"),
      tags: [
        { name: "type", value: "order_token" },
        { name: "tid", value: sanitizeEmailTagValue(details.tid) },
      ],
    })
  } catch (error) {
    console.error("[Email] Failed to send order token email with AWS SES:", error)
    logError(error, "SES_SEND_ORDER_TOKEN", { to: details.to, tid: details.tid })
    throw error
  }
}

function generateWelcomeEmailHTML(
  firstName: string,
  username: string,
  temporaryPassword: string,
  loginUrl: string
): string {
  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Welcome to OneFlowe</title>
    </head>
    <body style="margin: 0; padding: 0; font-family: Arial, sans-serif; background-color: #f4f4f4;">
      <table role="presentation" style="width: 100%; border-collapse: collapse;">
        <tr>
          <td style="padding: 40px 0;">
            <table role="presentation" style="width: 100%; max-width: 600px; margin: 0 auto; background-color: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <!-- Header -->
              <tr>
                <td style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 40px 30px; text-align: center;">
                  <h1 style="margin: 0; color: #ffffff; font-size: 28px; font-weight: 600;">OneFlowe</h1>
                  <p style="margin: 10px 0 0 0; color: #ffffff; font-size: 14px; opacity: 0.9;">Your account has been created</p>
                </td>
              </tr>

              <!-- Content -->
              <tr>
                <td style="padding: 40px 30px;">
                  <p style="margin: 0 0 20px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                    Hello ${escapeHtml(firstName)},
                  </p>
                  <p style="margin: 0 0 30px 0; color: #333333; font-size: 16px; line-height: 1.5;">
                    An account has been created for you on <strong>Apricart OneFlowe</strong>. Please use the credentials below to sign in. You will be asked to set a new password immediately after your first login.
                  </p>

                  <!-- Credentials Box -->
                  <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                    <tr>
                      <td style="padding: 24px; background-color: #f8f9fa; border-radius: 8px; border: 1px solid #e9ecef;">
                        <p style="margin: 0 0 16px 0; color: #495057; font-size: 13px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;">Your Login Credentials</p>
                        <table role="presentation" style="width: 100%; border-collapse: collapse;">
                          <tr>
                            <td style="padding: 8px 0; color: #6c757d; font-size: 14px; width: 140px;">Username</td>
                            <td style="padding: 8px 0; color: #212529; font-size: 14px; font-weight: 600; font-family: 'Courier New', monospace;">${escapeHtml(username)}</td>
                          </tr>
                          <tr>
                            <td style="padding: 8px 0; color: #6c757d; font-size: 14px;">Temporary Password</td>
                            <td style="padding: 8px 0; color: #212529; font-size: 14px; font-weight: 600; font-family: 'Courier New', monospace;">${escapeHtml(temporaryPassword)}</td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>

                  <!-- Login Link -->
                  <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 30px 0;">
                    <tr>
                      <td style="text-align: center;">
                        <a href="${escapeHtml(loginUrl)}" target="_blank" style="display: inline-block; padding: 14px 28px; background-color: #667eea; color: #ffffff; text-decoration: none; border-radius: 6px; font-size: 16px; font-weight: 600;">
                          Log in to OneFlowe
                        </a>
                        <p style="margin: 16px 0 0 0; color: #6c757d; font-size: 13px; line-height: 1.5;">
                          If the button does not work, copy and paste this URL into your browser:<br>
                          <a href="${escapeHtml(loginUrl)}" target="_blank" style="color: #667eea; word-break: break-all;">${escapeHtml(loginUrl)}</a>
                        </p>
                      </td>
                    </tr>
                  </table>

                  <!-- Warning -->
                  <table role="presentation" style="width: 100%; border-collapse: collapse; margin: 0 0 24px 0;">
                    <tr>
                      <td style="padding: 16px; background-color: #fff3cd; border-radius: 8px; border: 1px solid #ffc107;">
                        <p style="margin: 0; color: #856404; font-size: 14px; line-height: 1.5;">
                          <strong>Important:</strong> You must change your password immediately after your first login. Keep your credentials confidential and do not share them with anyone.
                        </p>
                      </td>
                    </tr>
                  </table>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color: #f8f9fa; padding: 30px; text-align: center; border-top: 1px solid #e9ecef;">
                  <p style="margin: 0 0 10px 0; color: #666666; font-size: 14px;">
                    This is an automated message, please do not reply.
                  </p>
                  <p style="margin: 0; color: #999999; font-size: 12px;">
                    © ${new Date().getFullYear()} OneFlowe. All rights reserved.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `
}

export async function sendWelcomeEmail(
  to: string,
  firstName: string,
  username: string,
  temporaryPassword: string,
  loginUrl: string
): Promise<boolean> {
  try {
    if (!to || !username || !temporaryPassword || !loginUrl) {
      console.error('[Email] Invalid parameters for sendWelcomeEmail')
      return false
    }

    if (!validateSesConfig()) {
      console.error('[Email] AWS SES not configured — skipping welcome email')
      return false
    }

    await sendAppEmail({
      fromName: "OneFlowe",
      to,
      subject: "Your OneFlowe account has been created",
      html: generateWelcomeEmailHTML(firstName || username, username, temporaryPassword, loginUrl),
      text: [
        `Welcome to Apricart OneFlowe`,
        ``,
        `Hello ${firstName || username},`,
        ``,
        `An account has been created for you. Use the credentials below to sign in.`,
        `You will be required to change your password immediately after your first login.`,
        ``,
        `Username:           ${username}`,
        `Temporary Password: ${temporaryPassword}`,
        ``,
        `Login URL: ${loginUrl}`,
        ``,
        `Keep your credentials confidential and do not share them with anyone.`,
        ``,
        `This is an automated message, please do not reply.`,
        `© ${new Date().getFullYear()} OneFlowe. All rights reserved.`,
      ].join("\n"),
      tags: [
        { name: "type", value: "welcome" },
      ],
    })

    return true
  } catch (error) {
    logError(error, 'EMAIL_SEND_WELCOME', { to })
    return false
  }
}
