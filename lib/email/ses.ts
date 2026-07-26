import {
  SESv2Client,
  SendEmailCommand,
  type Attachment,
  type MessageTag,
  type SendEmailCommandInput,
} from "@aws-sdk/client-sesv2"
import { env } from "@/lib/server/env"

type SesEmailConfig = {
  region: string
  fromEmail: string
  configurationSetName?: string
}

export type SendAppEmailAttachment = {
  filename: string
  content: Buffer | Uint8Array | string
  contentType?: string
  contentDisposition?: "ATTACHMENT" | "INLINE"
  contentId?: string
  description?: string
}

type SendAppEmailParams = {
  to: string | string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
  fromName?: string
  attachments?: SendAppEmailAttachment[]
  tags?: Array<{ name: string; value: string }>
}

let sesClient: SESv2Client | null = null
let sesClientRegion: string | null = null

function readSesEmailConfig(): { config: SesEmailConfig | null; missing: string[] } {
  const region = env.AWS_REGION
  const fromEmail = env.SES_FROM_EMAIL
  const configurationSetName = env.SES_CONFIGURATION_SET

  const requiredConfig: Array<[string, string | undefined]> = [
    ["AWS_REGION", region],
    ["SES_FROM_EMAIL", fromEmail],
  ]

  const missing = requiredConfig
    .filter(([, value]) => !value)
    .map(([name]) => name)

  if (missing.length > 0) {
    return { config: null, missing }
  }

  return {
    config: {
      region: region!,
      fromEmail: fromEmail!,
      configurationSetName: configurationSetName || undefined,
    },
    missing: [],
  }
}

export function validateSesConfig(): boolean {
  const { missing } = readSesEmailConfig()

  if (missing.length > 0) {
    console.error(`[Email] AWS SES configuration missing: ${missing.join(", ")}`)
    return false
  }

  return true
}

export const verifySesConfig = validateSesConfig

function getSesClient(config: SesEmailConfig): SESv2Client {
  if (!sesClient || sesClientRegion !== config.region) {
    sesClient = new SESv2Client({
      region: config.region,
    })
    sesClientRegion = config.region
  }

  return sesClient
}

function normalizeRecipients(to: string | string[]): string[] {
  const recipientList = Array.isArray(to) ? to : [to]

  return recipientList
    .flatMap((recipient) => recipient.split(","))
    .map((recipient) => recipient.trim())
    .filter(Boolean)
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function formatFromEmailAddress(fromEmail: string, fromName?: string): string {
  if (!fromName || fromEmail.includes("<")) {
    return fromEmail
  }

  const safeName = fromName
    .replace(/[\r\n]/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .trim()

  return safeName ? `"${safeName}" <${fromEmail}>` : fromEmail
}

function normalizeAttachmentContent(content: Buffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") {
    return Buffer.from(content, "utf8")
  }

  return content
}

function toSesAttachment(attachment: SendAppEmailAttachment): Attachment {
  const sesAttachment: Attachment = {
    FileName: attachment.filename,
    RawContent: normalizeAttachmentContent(attachment.content),
    ContentDisposition: attachment.contentDisposition || "ATTACHMENT",
  }

  if (attachment.contentType) {
    sesAttachment.ContentType = attachment.contentType
  }

  if (attachment.contentId) {
    sesAttachment.ContentId = attachment.contentId
  }

  if (attachment.description) {
    sesAttachment.ContentDescription = attachment.description
  }

  return sesAttachment
}

function toSesTags(tags?: Array<{ name: string; value: string }>): MessageTag[] | undefined {
  if (!tags?.length) {
    return undefined
  }

  return tags.map((tag) => ({
    Name: tag.name,
    Value: tag.value,
  }))
}

export async function sendAppEmail({
  to,
  subject,
  html,
  text,
  replyTo,
  fromName,
  attachments,
  tags,
}: SendAppEmailParams) {
  const { config, missing } = readSesEmailConfig()
  if (!config) {
    throw new Error(`Missing AWS SES configuration: ${missing.join(", ")}`)
  }

  const recipients = normalizeRecipients(to)
  if (recipients.length === 0) {
    throw new Error("At least one recipient is required to send an email")
  }

  const input: SendEmailCommandInput = {
    FromEmailAddress: formatFromEmailAddress(config.fromEmail, fromName),
    Destination: {
      ToAddresses: recipients,
    },
    Content: {
      Simple: {
        Subject: {
          Data: subject,
          Charset: "UTF-8",
        },
        Body: {
          Html: {
            Data: html,
            Charset: "UTF-8",
          },
          Text: {
            Data: text ?? stripHtml(html),
            Charset: "UTF-8",
          },
        },
      },
    },
  }

  if (replyTo) {
    input.ReplyToAddresses = [replyTo]
  }

  if (attachments?.length) {
    input.Content!.Simple!.Attachments = attachments.map(toSesAttachment)
  }

  const emailTags = toSesTags(tags)
  if (emailTags?.length) {
    input.EmailTags = emailTags
  }

  if (config.configurationSetName) {
    input.ConfigurationSetName = config.configurationSetName
  }

  const command = new SendEmailCommand(input)
  return getSesClient(config).send(command)
}
