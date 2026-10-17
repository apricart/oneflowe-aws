import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The support, join-decision, order-lifecycle and CLI welcome mails. The
 * properties held here are the ones each module's header promises: support
 * mail never carries the conversation, join mail never carries a password or a
 * rejection reason, typed values are escaped in HTML, and every link points at
 * the configured portal origin. SES is stubbed; `ses-tool-env` is mocked so the
 * CLI module never reads a real `.env.local`.
 */
const mocks = vi.hoisted(() => ({
  sendAppEmail: vi.fn(async (_mail: unknown) => ({ MessageId: "msg-1" })),
  validateSesConfig: vi.fn(() => true),
  logError: vi.fn(),
  sesSend: vi.fn(async (_command: unknown) => ({})),
}))

vi.mock("@/lib/server/env", () => ({ env: { NEXTAUTH_URL: "https://portal.example.test" } }))
vi.mock("@/lib/email/ses", () => ({
  sendAppEmail: mocks.sendAppEmail,
  validateSesConfig: mocks.validateSesConfig,
}))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))
vi.mock("@/lib/server/ses-tool-env", () => ({
  sesToolEnv: { AWS_REGION: "me-central-1", SES_FROM_EMAIL: "noreply@example.test", SES_CONFIGURATION_SET: "" },
}))
vi.mock("@aws-sdk/client-sesv2", () => ({
  SESv2Client: class {
    send(command: unknown) {
      return mocks.sesSend(command)
    }
  },
  SendEmailCommand: class {
    constructor(public input: any) {}
  },
}))

import { sendJoinDecisionEmail } from "./join-request"
import { buildOrderLifecycleEmail, sendOrderLifecycleEmail } from "./order-lifecycle"
import {
  SUPPORT_EMAIL_TEMPLATES,
  buildSupportEmail,
  isSupportEmailTemplate,
  parseSupportEmailPayload,
  sendSupportEmail,
} from "./support"
import { sendUserImportWelcomeEmail, verifyUserImportEmailConfig } from "./user-import-cli"

const HOSTILE = `<script>alert("x")</script>`

type Mail = { to: string; subject: string; html: string; text: string; tags: Array<{ name: string; value: string }> }
const lastMail = () => mocks.sendAppEmail.mock.calls.at(-1)?.[0] as Mail

beforeEach(() => {
  mocks.sendAppEmail.mockReset().mockResolvedValue({ MessageId: "msg-1" })
  mocks.validateSesConfig.mockReset().mockReturnValue(true)
  mocks.logError.mockClear()
  mocks.sesSend.mockReset().mockResolvedValue({})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("support mail", () => {
  const payload = {
    threadId: 42,
    subject: `Invoice question ${HOSTILE}`,
    category: "INVOICE",
    organizationName: "K Org",
    actorName: "Sana",
    toApricart: true,
  }

  it("recognises its templates", () => {
    for (const template of SUPPORT_EMAIL_TEMPLATES) expect(isSupportEmailTemplate(template)).toBe(true)
    expect(isSupportEmailTemplate("ORDER_CREATED")).toBe(false)
    expect(isSupportEmailTemplate(7)).toBe(false)
  })

  it("parses a stored payload, defaulting the actor and the side", () => {
    expect(parseSupportEmailPayload({ threadId: "42", subject: "s", category: "ORDER", organizationName: "o" })).toEqual({
      threadId: 42,
      subject: "s",
      category: "ORDER",
      organizationName: "o",
      actorName: "A colleague",
      toApricart: false,
    })
  })

  it.each([
    [{ threadId: 0, subject: "s", category: "c", organizationName: "o" }],
    [{ threadId: 1.5, subject: "s", category: "c", organizationName: "o" }],
    [{ threadId: 1, subject: "", category: "c", organizationName: "o" }],
    [{ threadId: 1, subject: "s", category: 3, organizationName: "o" }],
    [{ threadId: 1, subject: "s", category: "c" }],
  ])("refuses an incomplete payload %#", (value) => {
    expect(parseSupportEmailPayload(value as Record<string, unknown>)).toBeNull()
  })

  it("references the thread, links to it, and escapes the subject in the HTML", () => {
    const email = buildSupportEmail("SUPPORT_THREAD_OPENED", payload)

    expect(email.subject).toBe(`[SUP-000042] Invoice question ${HOSTILE}`)
    expect(email.text).toContain("Open the request: https://portal.example.test/support/42")
    expect(email.text).toContain("Sana at K Org raised a new request with the Apricart team.")
    expect(email.html).not.toContain(HOSTILE)
    expect(email.html).toContain("https://portal.example.test/support/42")
  })

  it("words each event for the side receiving it", () => {
    expect(buildSupportEmail("SUPPORT_THREAD_OPENED", { ...payload, toApricart: false }).text)
      .toContain("Your request has reached the Apricart team.")
    expect(buildSupportEmail("SUPPORT_MESSAGE_RECEIVED", payload).text).toContain("Sana at K Org replied on a support request.")
    expect(buildSupportEmail("SUPPORT_MESSAGE_RECEIVED", { ...payload, toApricart: false }).text)
      .toContain("The Apricart team replied to your request.")
    expect(buildSupportEmail("SUPPORT_THREAD_RESOLVED", payload).text).toContain("Sana marked this request as resolved.")
    expect(buildSupportEmail("SUPPORT_THREAD_CLOSED", payload).text).toContain("Sana closed this request.")
  })

  it("labels an unknown category as Other", () => {
    expect(buildSupportEmail("SUPPORT_THREAD_OPENED", { ...payload, category: "NOPE" }).text).toContain("Category: Other")
  })

  it("sends through SES with tags and returns the message id", async () => {
    expect(await sendSupportEmail({ to: "a@x.test", template: "SUPPORT_THREAD_CLOSED", payload })).toBe("msg-1")
    expect(lastMail().tags).toEqual([
      { name: "type", value: "support_thread_closed" },
      { name: "thread", value: "SUP-000042" },
    ])

    mocks.sendAppEmail.mockResolvedValue({ MessageId: undefined } as never)
    expect(await sendSupportEmail({ to: "a@x.test", template: "SUPPORT_THREAD_CLOSED", payload })).toBeNull()
  })
})

describe("join decision mail", () => {
  const base = {
    to: "applicant@x.test",
    firstName: "Ali",
    username: "ali.k",
    organizationName: `K ${HOSTILE}`,
    approved: true,
    loginUrl: "https://portal.example.test/login",
  }

  it("tells an approved applicant how to sign in, and never includes a password", async () => {
    expect(await sendJoinDecisionEmail(base)).toBe(true)
    const mail = lastMail()
    expect(mail.subject).toBe(`You have been added to K ${HOSTILE} on OneFlowe`)
    expect(mail.text).toContain("username ali.k")
    expect(mail.text).toContain("Sign in: https://portal.example.test/login")
    expect(mail.text.toLowerCase()).not.toContain("password:")
    expect(mail.html).not.toContain(HOSTILE)
    expect(mail.tags).toEqual([{ name: "type", value: "join_approved" }])
  })

  it("tells a rejected applicant without giving a reason or a link", async () => {
    await sendJoinDecisionEmail({ ...base, approved: false, firstName: "" })
    const mail = lastMail()
    expect(mail.text).toContain("was not approved")
    expect(mail.text).toContain("Hello ali.k,")
    expect(mail.text).not.toContain("Sign in:")
    expect(mail.tags).toEqual([{ name: "type", value: "join_rejected" }])
  })

  it("never throws: no address, no SES, or a send failure all return false", async () => {
    expect(await sendJoinDecisionEmail({ ...base, to: "" })).toBe(false)
    mocks.validateSesConfig.mockReturnValue(false)
    expect(await sendJoinDecisionEmail(base)).toBe(false)
    mocks.validateSesConfig.mockReturnValue(true)
    mocks.sendAppEmail.mockRejectedValue(new Error("x"))
    expect(await sendJoinDecisionEmail(base)).toBe(false)
    expect(mocks.logError).toHaveBeenCalled()
  })
})

describe("order lifecycle mail", () => {
  const payload = { orderId: 41, tid: "TID 41", organizationName: "Org", branchName: HOSTILE }

  it("asks an approver to review a new order, naming the requester", () => {
    const email = buildOrderLifecycleEmail("ORDER_CREATED", { ...payload, requestedBy: "Requester" })
    expect(email.subject).toBe("Order TID 41 is awaiting approval")
    expect(email.text).toContain("Requested by: Requester")
    expect(email.text).toContain("Review order: https://portal.example.test/orders/41")
    expect(email.html).not.toContain(HOSTILE)
  })

  it("tells the requester about approval and rejection, linking to the shop", () => {
    const approved = buildOrderLifecycleEmail("ORDER_APPROVED", payload)
    expect(approved.subject).toBe("Order TID 41 was approved")
    expect(approved.text).toContain("View my orders: https://portal.example.test/shop")

    const rejected = buildOrderLifecycleEmail("ORDER_REJECTED", { ...payload, rejectionReason: `No ${HOSTILE}` })
    expect(rejected.subject).toBe("Order TID 41 was rejected")
    expect(rejected.text).toContain(`Reason: No ${HOSTILE}`)
    expect(rejected.html).not.toContain(HOSTILE)
  })

  it("names the approving role for a Super Admin, defaulting to Financial Approver", () => {
    expect(buildOrderLifecycleEmail("ORDER_APPROVED_ADMIN", { ...payload, approvedByRole: "GROUP_USER" }).subject)
      .toBe("Order TID 41 was approved by Group Financial Approver")
    expect(buildOrderLifecycleEmail("ORDER_APPROVED_ADMIN", payload).subject)
      .toBe("Order TID 41 was approved by Financial Approver")
  })

  it("tells the raiser what to correct, escaped, linking to the portal they order from", () => {
    const toShop = buildOrderLifecycleEmail(
      "ORDER_RETURNED",
      { ...payload, correctionComment: `Fewer reams ${HOSTILE}` },
      "ORDER_PORTAL",
    )
    expect(toShop.subject).toBe("Order TID 41 was returned for correction")
    expect(toShop.text).toContain(`What to correct: Fewer reams ${HOSTILE}`)
    expect(toShop.text).toContain("View my orders: https://portal.example.test/shop")
    expect(toShop.html).not.toContain(HOSTILE)

    const toGroupPortal = buildOrderLifecycleEmail(
      "ORDER_RETURNED",
      { ...payload, correctionComment: "Fewer reams" },
      "GROUP_ORDER_PORTAL",
    )
    expect(toGroupPortal.text).toContain("View my orders: https://portal.example.test/group-portal")
  })

  it("asks the approver to review a resubmission, with the requester's note escaped", () => {
    const email = buildOrderLifecycleEmail(
      "ORDER_RESUBMITTED",
      { ...payload, requestedBy: "Requester", resubmissionNote: `Done ${HOSTILE}` },
      "BRANCH_ADMIN",
    )
    expect(email.subject).toBe("Order TID 41 was resubmitted for approval")
    expect(email.text).toContain("Requested by: Requester")
    expect(email.text).toContain(`Requester's note: Done ${HOSTILE}`)
    expect(email.text).toContain("Review order: https://portal.example.test/orders/41")
    expect(email.html).not.toContain(HOSTILE)
  })

  it("leaves out an empty correction or resubmission note", () => {
    expect(buildOrderLifecycleEmail("ORDER_RESUBMITTED", payload).text).not.toContain("Requester's note")
    expect(buildOrderLifecycleEmail("ORDER_RETURNED", payload).text).not.toContain("What to correct")
  })

  it("sends with a sanitised tid tag", async () => {
    expect(await sendOrderLifecycleEmail({ to: "a@x.test", template: "ORDER_APPROVED", payload })).toBe("msg-1")
    expect(lastMail().tags).toEqual([
      { name: "type", value: "order_approved" },
      { name: "tid", value: "TID_41" },
    ])
  })
})

describe("CLI welcome mail", () => {
  it("is configured when a region and sender are present", () => {
    expect(verifyUserImportEmailConfig()).toBe(true)
  })

  it("sends the credentials, escaped in HTML, and reports success", async () => {
    expect(await sendUserImportWelcomeEmail("new@x.test", HOSTILE, "new.user", "Temp-1!aaaaaa")).toBe(true)
    const input = (mocks.sesSend.mock.calls[0][0] as { input: any }).input
    expect(input.Destination.ToAddresses).toEqual(["new@x.test"])
    expect(input.Content.Simple.Body.Text.Data).toContain("Temporary password: Temp-1!aaaaaa")
    expect(input.Content.Simple.Body.Html.Data).not.toContain(HOSTILE)
    expect(input.ConfigurationSetName).toBeUndefined()
  })

  it("reports a delivery failure as false without logging the error message", async () => {
    mocks.sesSend.mockRejectedValue(Object.assign(new Error("secret detail"), { name: "MessageRejected" }))
    expect(await sendUserImportWelcomeEmail("new@x.test", "", "new.user", "p")).toBe(false)
    expect(console.error).toHaveBeenCalledWith("[User Import] Welcome email delivery failed", { type: "MessageRejected" })
  })
})
