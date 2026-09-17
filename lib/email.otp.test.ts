import { beforeEach, describe, expect, it, vi } from "vitest"
import type { sendAppEmail } from "./email/ses"

/**
 * What the verification mail says. Every mirrored K-Electric person has a
 * `-ba` and a `-op` account behind one mailbox and each gets its own code,
 * so the mail has to name the account or the person tries the wrong code on
 * the wrong account; and the validity printed has to be the one the code
 * really has. SES itself is stubbed — this is about the message, not the
 * transport — except to check that a transport failure is reported, not
 * thrown, since the caller turns it into a 400.
 */

const mocks = vi.hoisted(() => ({
  sendAppEmail: vi.fn(async (_message: Parameters<typeof sendAppEmail>[0]) => undefined),
  validateSesConfig: vi.fn(() => true),
  logError: vi.fn(),
}))

vi.mock("@/lib/email/ses", () => ({
  sendAppEmail: mocks.sendAppEmail,
  validateSesConfig: mocks.validateSesConfig,
}))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))

import { sendOTPEmail } from "./email"

const ACCOUNT_SENTENCE = "This code is for your Branch Admin account (username imran-17655-ba). It will not work for any other account that uses this email address."

function lastMail() {
  const call = mocks.sendAppEmail.mock.calls.at(-1)?.[0] as
    | { to: string; subject: string; text: string; html: string; tags?: { name: string; value: string }[] }
    | undefined
  if (!call) throw new Error("no mail was sent")
  return call
}

beforeEach(() => {
  mocks.sendAppEmail.mockClear()
  mocks.validateSesConfig.mockReset().mockReturnValue(true)
  mocks.logError.mockClear()
})

describe("the verification mail", () => {
  it("names the account the code opens, in the text and the HTML, with the code and its real validity", async () => {
    const sent = await sendOTPEmail("imrank@ke.com.pk", "482913", "VERIFY_EMAIL", {
      validForMinutes: 10,
      account: { username: "imran-17655-ba", accountLabel: "Branch Admin" },
    })

    expect(sent).toBe(true)
    const mail = lastMail()
    expect(mail.to).toBe("imrank@ke.com.pk")
    expect(mail.subject).toBe("Your OneFlowe Email Verification Code")
    expect(mail.text).toContain(ACCOUNT_SENTENCE)
    expect(mail.text).toContain("OTP Code: 482913")
    expect(mail.text).toContain("expire in 10 minutes")
    expect(mail.html).toContain(ACCOUNT_SENTENCE)
    expect(mail.html).toContain("482913")
    expect(mail.html).toContain("10 minutes")
    expect(mail.tags).toEqual([{ name: "type", value: "otp_verify_email" }])
  })

  it("says which account without a username when the row has none", async () => {
    await sendOTPEmail("head@example.test", "111111", "VERIFY_EMAIL", {
      validForMinutes: 10,
      account: { username: null, accountLabel: "Head Office" },
    })

    const mail = lastMail()
    expect(mail.text).toContain("This code is for your Head Office account. It will not work")
    expect(mail.text).not.toContain("(username")
  })

  it("escapes the username in the HTML so a hostile value cannot inject markup", async () => {
    await sendOTPEmail("x@example.test", "111111", "VERIFY_EMAIL", {
      validForMinutes: 10,
      account: { username: "<img src=x onerror=alert(1)>", accountLabel: "Branch Admin" },
    })

    const mail = lastMail()
    expect(mail.html).not.toContain("<img src=x")
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;")
    // The plain-text part is not HTML and carries the value as it is.
    expect(mail.text).toContain("(username <img src=x onerror=alert(1)>)")
  })

  it("leaves a login code exactly as before: two minutes, no account line", async () => {
    await sendOTPEmail("x@example.test", "222222", "LOGIN")

    const mail = lastMail()
    expect(mail.subject).toBe("Your OneFlowe Login Code")
    expect(mail.text).toContain("expire in 2 minutes")
    expect(mail.text).not.toContain("This code is for your")
    expect(mail.html).not.toContain("This code is for your")
    expect(mail.tags).toEqual([{ name: "type", value: "otp_login" }])
  })

  it("does not print the account line when no account context is given, whatever the type", async () => {
    await sendOTPEmail("x@example.test", "333333", "VERIFY_EMAIL", { validForMinutes: 10, account: null })

    expect(lastMail().text).not.toContain("This code is for your")
  })
})

describe("the verification mail — failure", () => {
  it("reports false and sends nothing when SES is not configured", async () => {
    mocks.validateSesConfig.mockReturnValue(false)

    expect(await sendOTPEmail("x@example.test", "111111", "VERIFY_EMAIL")).toBe(false)
    expect(mocks.sendAppEmail).not.toHaveBeenCalled()
  })

  it("reports false rather than throwing when the transport fails, and logs it without the code", async () => {
    mocks.sendAppEmail.mockRejectedValueOnce(new Error("MessageRejected: Email address is not verified"))

    expect(await sendOTPEmail("x@example.test", "777777", "VERIFY_EMAIL")).toBe(false)
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "EMAIL_SEND_OTP", { to: "x@example.test", type: "VERIFY_EMAIL" })
    expect(JSON.stringify(mocks.logError.mock.calls)).not.toContain("777777")
  })

  it.each([
    ["no recipient", "", "111111", "VERIFY_EMAIL"],
    ["no code", "x@example.test", "", "VERIFY_EMAIL"],
    ["no type", "x@example.test", "111111", ""],
  ])("refuses to send with %s", async (_label, to, code, type) => {
    expect(await sendOTPEmail(to, code, type as "VERIFY_EMAIL")).toBe(false)
    expect(mocks.sendAppEmail).not.toHaveBeenCalled()
  })
})
