import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The SES wrapper is the only path mail leaves the application by. These tests
 * read back the exact `SendEmailCommand` input it builds: recipients, the
 * display name (a header — so CR/LF and quotes must not survive into it), the
 * plain-text fallback, attachments, tags and the configuration set.
 */
const sdk = vi.hoisted(() => ({
  sent: [] as any[],
  clients: [] as Array<{ region: string }>,
  fail: null as Error | null,
}))

vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    region: string
    constructor(options: { region: string }) {
      this.region = options.region
      sdk.clients.push(options)
    }
    async send(command: { input: unknown }) {
      if (sdk.fail) throw sdk.fail
      sdk.sent.push(command.input)
      return { MessageId: `m-${sdk.sent.length}` }
    }
  },
  SendEmailCommand: class {
    input: unknown
    constructor(input: unknown) {
      this.input = input
    }
  },
}))

const envState = vi.hoisted(() => ({
  AWS_REGION: "me-central-1" as string | undefined,
  SES_FROM_EMAIL: "noreply@example.test" as string | undefined,
  SES_CONFIGURATION_SET: undefined as string | undefined,
}))
vi.mock("@/lib/server/env", () => ({ env: envState }))

import { sendAppEmail, validateSesConfig, verifySesConfig } from "./ses"

beforeEach(() => {
  sdk.sent.length = 0
  sdk.fail = null
  envState.AWS_REGION = "me-central-1"
  envState.SES_FROM_EMAIL = "noreply@example.test"
  envState.SES_CONFIGURATION_SET = undefined
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("validateSesConfig", () => {
  it("is satisfied by a region and a sender", () => {
    expect(validateSesConfig()).toBe(true)
    expect(verifySesConfig).toBe(validateSesConfig)
  })

  it("names what is missing", () => {
    envState.AWS_REGION = undefined
    envState.SES_FROM_EMAIL = ""
    expect(validateSesConfig()).toBe(false)
    expect(console.error).toHaveBeenCalledWith("[Email] AWS SES configuration missing: AWS_REGION, SES_FROM_EMAIL")
  })
})

describe("sendAppEmail", () => {
  it("builds a UTF-8 message with an HTML body and a derived plain-text body", async () => {
    const result = await sendAppEmail({
      to: "a@example.test",
      subject: "Order 12 approved",
      html: "<style>p{color:red}</style><p>Hello <b>Ayesha</b>,</p><script>x()</script><p>approved.</p>",
    })

    expect(result).toEqual({ MessageId: "m-1" })
    const [input] = sdk.sent
    expect(input.FromEmailAddress).toBe("noreply@example.test")
    expect(input.Destination).toEqual({ ToAddresses: ["a@example.test"] })
    expect(input.Content.Simple.Subject).toEqual({ Data: "Order 12 approved", Charset: "UTF-8" })
    expect(input.Content.Simple.Body.Text.Data).toBe("Hello Ayesha , approved.")
    expect(input.Content.Simple.Body.Html.Charset).toBe("UTF-8")
    expect(input.ReplyToAddresses).toBeUndefined()
    expect(input.EmailTags).toBeUndefined()
    expect(input.ConfigurationSetName).toBeUndefined()
  })

  it("prefers an explicit text body", async () => {
    await sendAppEmail({ to: "a@example.test", subject: "s", html: "<p>x</p>", text: "plain" })
    expect(sdk.sent[0].Content.Simple.Body.Text.Data).toBe("plain")
  })

  it("keeps an unterminated tag as text rather than dropping the rest of the body", async () => {
    await sendAppEmail({ to: "a@example.test", subject: "s", html: "Total < 5 items" })
    expect(sdk.sent[0].Content.Simple.Body.Text.Data).toBe("Total < 5 items")
  })

  it("splits comma-separated recipients and drops blanks", async () => {
    await sendAppEmail({ to: ["a@example.test, b@example.test", "  ", "c@example.test"], subject: "s", html: "x" })
    expect(sdk.sent[0].Destination.ToAddresses).toEqual(["a@example.test", "b@example.test", "c@example.test"])
  })

  it("refuses to send with no recipients", async () => {
    await expect(sendAppEmail({ to: " , ", subject: "s", html: "x" })).rejects.toThrow(
      "At least one recipient is required to send an email",
    )
    expect(sdk.sent).toHaveLength(0)
  })

  it("refuses to send without configuration", async () => {
    envState.SES_FROM_EMAIL = undefined
    await expect(sendAppEmail({ to: "a@example.test", subject: "s", html: "x" })).rejects.toThrow(
      "Missing AWS SES configuration: SES_FROM_EMAIL",
    )
  })

  it("quotes the display name and strips header-breaking characters from it", async () => {
    await sendAppEmail({
      to: "a@example.test",
      subject: "s",
      html: "x",
      fromName: 'Apricart "Ops"\r\nBcc: victim@example.test\\',
    })
    const from = sdk.sent[0].FromEmailAddress as string
    expect(from).not.toMatch(/[\r\n]/)
    expect(from).toBe(String.raw`"Apricart \"Ops\"  Bcc: victim@example.test\\" <noreply@example.test>`)
  })

  it("does not wrap a sender that already carries a display name, or a blank name", async () => {
    envState.SES_FROM_EMAIL = "OneFlowe <noreply@example.test>"
    await sendAppEmail({ to: "a@example.test", subject: "s", html: "x", fromName: "Other" })
    expect(sdk.sent[0].FromEmailAddress).toBe("OneFlowe <noreply@example.test>")

    envState.SES_FROM_EMAIL = "noreply@example.test"
    await sendAppEmail({ to: "a@example.test", subject: "s", html: "x", fromName: "  " })
    expect(sdk.sent[1].FromEmailAddress).toBe("noreply@example.test")
  })

  it("passes reply-to, attachments, tags and the configuration set through", async () => {
    envState.SES_CONFIGURATION_SET = "oneflowe-prod"
    await sendAppEmail({
      to: "a@example.test",
      subject: "s",
      html: "x",
      replyTo: "support@example.test",
      attachments: [
        { filename: "invoice.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" },
        { filename: "note.txt", content: "hello", contentDisposition: "INLINE", contentId: "n1", description: "note" },
      ],
      tags: [{ name: "kind", value: "invoice" }],
    })

    const [input] = sdk.sent
    expect(input.ReplyToAddresses).toEqual(["support@example.test"])
    expect(input.ConfigurationSetName).toBe("oneflowe-prod")
    expect(input.EmailTags).toEqual([{ Name: "kind", Value: "invoice" }])
    const [pdf, note] = input.Content.Simple.Attachments
    expect(pdf).toMatchObject({ FileName: "invoice.pdf", ContentType: "application/pdf", ContentDisposition: "ATTACHMENT" })
    expect(note).toMatchObject({ FileName: "note.txt", ContentDisposition: "INLINE", ContentId: "n1", ContentDescription: "note" })
    expect(Buffer.from(note.RawContent).toString("utf8")).toBe("hello")
  })

  it("reuses one client per region and builds a new one when the region changes", async () => {
    const before = sdk.clients.length
    await sendAppEmail({ to: "a@example.test", subject: "s", html: "x" })
    await sendAppEmail({ to: "a@example.test", subject: "s", html: "x" })
    const afterSameRegion = sdk.clients.length
    envState.AWS_REGION = "eu-west-1"
    await sendAppEmail({ to: "a@example.test", subject: "s", html: "x" })

    expect(afterSameRegion - before).toBeLessThanOrEqual(1)
    expect(sdk.clients.at(-1)).toEqual({ region: "eu-west-1" })
  })

  it("lets an SES failure reach the caller", async () => {
    sdk.fail = new Error("MessageRejected")
    await expect(sendAppEmail({ to: "a@example.test", subject: "s", html: "x" })).rejects.toThrow("MessageRejected")
  })
})
