import { SESv2Client, SendEmailCommand, type SendEmailCommandInput } from '@aws-sdk/client-sesv2'

import { sesToolEnv } from '@/lib/server/ses-tool-env'

let client: SESv2Client | null = null

function getClient(): SESv2Client {
  client ??= new SESv2Client({ region: sesToolEnv.AWS_REGION })
  return client
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function welcomeHtml(firstName: string, username: string, temporaryPassword: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:32px;background:#f4f4f4;font-family:Arial,sans-serif;color:#212529">
    <table role="presentation" style="width:100%;max-width:600px;margin:auto;background:#fff;border-collapse:collapse;border-radius:8px">
      <tr><td style="padding:32px;background:#4f46e5;color:#fff"><h1 style="margin:0;font-size:26px">OneFlowe</h1><p style="margin:8px 0 0">Your account has been created</p></td></tr>
      <tr><td style="padding:32px">
        <p>Hello ${escapeHtml(firstName || username)},</p>
        <p>An account has been created for you on <strong>Apricart OneFlowe</strong>. Use the credentials below to sign in.</p>
        <table role="presentation" style="width:100%;margin:24px 0;background:#f8f9fa;border:1px solid #e9ecef;border-collapse:collapse">
          <tr><td style="padding:12px">Username</td><td style="padding:12px;font-family:monospace;font-weight:bold">${escapeHtml(username)}</td></tr>
          <tr><td style="padding:12px">Temporary password</td><td style="padding:12px;font-family:monospace;font-weight:bold">${escapeHtml(temporaryPassword)}</td></tr>
        </table>
        <p style="padding:14px;background:#fff3cd;border:1px solid #ffc107"><strong>Important:</strong> You must change this password immediately after your first login.</p>
        <p>Keep your credentials confidential and do not share them.</p>
      </td></tr>
    </table>
  </body>
</html>`
}

function welcomeText(firstName: string, username: string, temporaryPassword: string): string {
  return [
    'Welcome to Apricart OneFlowe',
    '',
    `Hello ${firstName || username},`,
    '',
    'An account has been created for you. Use the credentials below to sign in.',
    'You must change your password immediately after your first login.',
    '',
    `Username: ${username}`,
    `Temporary password: ${temporaryPassword}`,
    '',
    'Keep your credentials confidential and do not share them.',
  ].join('\n')
}

export function verifyUserImportEmailConfig(): boolean {
  return Boolean(sesToolEnv.AWS_REGION && sesToolEnv.SES_FROM_EMAIL)
}

export async function sendUserImportWelcomeEmail(
  to: string,
  firstName: string,
  username: string,
  temporaryPassword: string,
): Promise<boolean> {
  try {
    const input: SendEmailCommandInput = {
      FromEmailAddress: `"OneFlowe" <${sesToolEnv.SES_FROM_EMAIL}>`,
      Destination: { ToAddresses: [to] },
      Content: {
        Simple: {
          Subject: { Data: 'Your OneFlowe account has been created', Charset: 'UTF-8' },
          Body: {
            Html: { Data: welcomeHtml(firstName, username, temporaryPassword), Charset: 'UTF-8' },
            Text: { Data: welcomeText(firstName, username, temporaryPassword), Charset: 'UTF-8' },
          },
        },
      },
      EmailTags: [{ Name: 'type', Value: 'welcome' }],
      ConfigurationSetName: sesToolEnv.SES_CONFIGURATION_SET || undefined,
    }
    await getClient().send(new SendEmailCommand(input))
    return true
  } catch (error) {
    console.error('[User Import] Welcome email delivery failed', {
      type: error instanceof Error ? error.name : 'UnknownError',
    })
    return false
  }
}
