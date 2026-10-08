import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Every transactional mail other than the OTP (covered in email.otp.test.ts).
 * SES is stubbed; what is asserted is the message: that values a user typed —
 * product names, branch names, refund reasons — are HTML-escaped in the HTML
 * part, that money is printed in rupees from cents, that tags are reduced to
 * the characters SES accepts, and how each sender reports a failure (most
 * return false; the token mail re-throws so the caller can retry).
 */
type Mail = {
  to: string | string[]
  subject: string
  html: string
  text?: string
  fromName?: string
  attachments?: Array<{ filename: string; content: unknown; contentType?: string }>
  tags?: Array<{ name: string; value: string }>
}

const mocks = vi.hoisted(() => ({
  sendAppEmail: vi.fn(async (_mail: unknown) => ({ MessageId: "m" })),
  validateSesConfig: vi.fn(() => true),
  logError: vi.fn(),
}))

vi.mock("@/lib/email/ses", () => ({
  sendAppEmail: mocks.sendAppEmail,
  validateSesConfig: mocks.validateSesConfig,
}))
vi.mock("@/lib/global-logger", () => ({ logError: mocks.logError }))

import {
  sendGroupOrderTokensEmail,
  sendGroupRefundRequestEmail,
  sendOrderTokenEmail,
  sendRefundRequestEmail,
  sendReportEmail,
  sendWelcomeEmail,
  verifyEmailConfig,
} from "./email"

const HOSTILE = `<img src=x onerror="alert('x')">`
const ESCAPED = "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;"

function lastMail(): Mail {
  const mail = mocks.sendAppEmail.mock.calls.at(-1)?.[0] as Mail | undefined
  if (!mail) throw new Error("no mail was sent")
  return mail
}

beforeEach(() => {
  mocks.sendAppEmail.mockReset().mockResolvedValue({ MessageId: "m" })
  mocks.validateSesConfig.mockReset().mockReturnValue(true)
  mocks.logError.mockClear()
  vi.spyOn(console, "error").mockImplementation(() => {})
  vi.spyOn(console, "log").mockImplementation(() => {})
})

describe("verifyEmailConfig", () => {
  it("reports the SES configuration state", async () => {
    expect(await verifyEmailConfig()).toBe(true)
    mocks.validateSesConfig.mockReturnValue(false)
    expect(await verifyEmailConfig()).toBe(false)
  })

  it("returns false if the check itself throws", async () => {
    mocks.validateSesConfig.mockImplementation(() => {
      throw new Error("boom")
    })
    expect(await verifyEmailConfig()).toBe(false)
    expect(mocks.logError).toHaveBeenCalled()
  })
})

describe("sendReportEmail", () => {
  it("attaches the CSV, joins recipients and escapes the report name", async () => {
    const sent = await sendReportEmail(["a@x.test", "b@x.test"], `Sales ${HOSTILE}`, "Weekly", "a,b\n1,2", "sales.csv")

    expect(sent).toBe(true)
    const mail = lastMail()
    expect(mail.to).toBe("a@x.test, b@x.test")
    expect(mail.subject).toMatch(/^\[REPORT\] Sales /)
    expect(mail.html).toContain(ESCAPED)
    expect(mail.html).not.toContain(HOSTILE)
    expect(mail.attachments).toEqual([{ filename: "sales.csv", content: "a,b\n1,2", contentType: "text/csv; charset=utf-8" }])
    expect(mail.tags?.find((tag) => tag.name === "report")?.value).toMatch(/^[a-zA-Z0-9_-]+$/)
  })

  it("does not send without SES configuration, and reports a send failure as false", async () => {
    mocks.validateSesConfig.mockReturnValue(false)
    expect(await sendReportEmail("a@x.test", "R", "Daily", "", "r.csv")).toBe(false)
    expect(mocks.sendAppEmail).not.toHaveBeenCalled()

    mocks.validateSesConfig.mockReturnValue(true)
    mocks.sendAppEmail.mockRejectedValue(new Error("throttled"))
    expect(await sendReportEmail("a@x.test", "R", "Daily", "", "r.csv")).toBe(false)
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "EMAIL_SEND_REPORT", expect.anything())
  })
})

describe("sendRefundRequestEmail", () => {
  const details = {
    to: "ops@x.test",
    tid: "T-100",
    organizationName: "Acme",
    branchName: HOSTILE,
    requestedBy: "requester@x.test",
    amountCents: 123_456,
    reason: "Damaged",
    items: [{ productName: HOSTILE, quantity: 2, amountCents: 123_456 }],
  }

  it("prints the amount in rupees and escapes typed values in the HTML", async () => {
    expect(await sendRefundRequestEmail(details)).toBe(true)
    const mail = lastMail()
    expect(mail.subject).toBe("Refund request for order T-100")
    expect(mail.text).toContain("Amount: PKR 1234.56")
    expect(mail.text).toContain("Reason: Damaged")
    expect(mail.html).not.toContain(HOSTILE)
    expect(mail.html).toContain(ESCAPED)
  })

  it("omits the reason line when there is none", async () => {
    await sendRefundRequestEmail({ ...details, reason: null })
    expect(lastMail().text).not.toContain("Reason:")
  })

  it("returns false on failure", async () => {
    mocks.sendAppEmail.mockRejectedValue(new Error("x"))
    expect(await sendRefundRequestEmail(details)).toBe(false)
    mocks.validateSesConfig.mockReturnValue(false)
    expect(await sendRefundRequestEmail(details)).toBe(false)
  })
})

describe("sendGroupRefundRequestEmail", () => {
  const details = {
    to: ["ops@x.test"],
    reference: "GO-77",
    requestedBy: "u@x.test",
    organizationId: 3,
    totalAmountCents: 50_005,
    branches: [
      { tid: "T-1", branchName: HOSTILE, refundNumber: "Refund-000001", amountCents: 50_000, itemCount: 1 },
      { tid: "T-2", branchName: "South", refundNumber: "Refund-000002", amountCents: 5, itemCount: 2 },
    ],
  }

  it("summarises every branch in one message", async () => {
    expect(await sendGroupRefundRequestEmail(details)).toBe(true)
    const mail = lastMail()
    expect(mail.subject).toBe("Group refund request for GO-77")
    expect(mail.text).toContain("Branch orders: 2")
    expect(mail.text).toContain("Total: PKR 500.05")
    expect(mail.text).toContain("South (T-2) — PKR 0.05")
    expect(mail.html).not.toContain(HOSTILE)
  })

  it("returns false on failure", async () => {
    mocks.sendAppEmail.mockRejectedValue(new Error("x"))
    expect(await sendGroupRefundRequestEmail(details)).toBe(false)
    mocks.validateSesConfig.mockReturnValue(false)
    expect(await sendGroupRefundRequestEmail(details)).toBe(false)
  })
})

describe("sendGroupOrderTokensEmail", () => {
  it("lists every branch token in one message, escaping names", async () => {
    await sendGroupOrderTokensEmail({
      to: "ho@x.test",
      reference: "GO 9/2026",
      groupName: "Distribution",
      sharedBy: "Head Office",
      entries: [
        { tid: "T-1", branchName: "North", token: "ABCDEF2345", items: [{ productName: HOSTILE, productCode: "P1", quantity: 1.5, unit: "kg" }] },
        { tid: "T-2", branchName: "South", token: "ZYXWVU9876", items: [] },
      ],
    })

    const mail = lastMail()
    expect(mail.text).toContain("North (T-1): ABCDEF2345")
    expect(mail.text).toContain("South (T-2): ZYXWVU9876")
    expect(mail.html).toContain("ABCDEF2345")
    expect(mail.html).not.toContain(HOSTILE)
    expect(mail.tags?.find((tag) => tag.name === "reference")?.value).toBe("GO_9_2026")
  })

  it("lets a send failure reach the caller", async () => {
    mocks.sendAppEmail.mockRejectedValue(new Error("x"))
    await expect(sendGroupOrderTokensEmail({ to: "a@x.test", reference: "r", groupName: "g", sharedBy: "s", entries: [] }))
      .rejects.toThrow("x")
  })
})

describe("sendOrderTokenEmail", () => {
  const details = {
    to: "ba@x.test",
    token: "ABCDEF2345",
    tid: "T-5",
    organizationName: "Acme",
    branchName: "North",
    status: "APPROVED",
    createdAt: "2026-10-06T10:00:00.000Z",
    items: [
      { productName: "Rice", productCode: "R1", quantity: 2.5, unit: "kg" },
      { productName: HOSTILE, quantity: 1 },
    ],
  }

  it("carries the token and each line with its code and unit", async () => {
    await sendOrderTokenEmail(details)
    const mail = lastMail()
    expect(mail.subject).toBe("Order T-5 – Fulfillment Token")
    expect(mail.text).toContain("Fulfillment Token: ABCDEF2345")
    expect(mail.text).toContain("  - R1 - Rice: 2.5 kg")
    expect(mail.html).not.toContain(HOSTILE)
  })

  it("prints N/A for a missing creation date", async () => {
    await sendOrderTokenEmail({ ...details, createdAt: null })
    expect(lastMail().text).toContain("Created:      N/A")
  })

  it("logs and re-throws a send failure so the caller can retry", async () => {
    mocks.sendAppEmail.mockRejectedValue(new Error("throttled"))
    await expect(sendOrderTokenEmail(details)).rejects.toThrow("throttled")
    expect(mocks.logError).toHaveBeenCalledWith(expect.any(Error), "SES_SEND_ORDER_TOKEN", expect.anything())
  })
})

describe("sendWelcomeEmail", () => {
  it("sends the username, temporary password and login URL, escaping the name in the HTML", async () => {
    expect(await sendWelcomeEmail("new@x.test", HOSTILE, "new.user", "Temp-Pass-123!", "https://app.example.test/login")).toBe(true)
    const mail = lastMail()
    expect(mail.text).toContain("Username:           new.user")
    expect(mail.text).toContain("Temporary Password: Temp-Pass-123!")
    expect(mail.text).toContain("Login URL: https://app.example.test/login")
    expect(mail.html).not.toContain(HOSTILE)
  })

  it("greets by username when there is no first name", async () => {
    await sendWelcomeEmail("new@x.test", "", "new.user", "Temp-Pass-123!", "https://app.example.test/login")
    expect(lastMail().text).toContain("Hello new.user,")
  })

  it("refuses incomplete input and reports SES problems as false", async () => {
    expect(await sendWelcomeEmail("", "A", "u", "p", "https://x")).toBe(false)
    expect(await sendWelcomeEmail("a@x.test", "A", "u", "p", "")).toBe(false)
    expect(mocks.sendAppEmail).not.toHaveBeenCalled()

    mocks.validateSesConfig.mockReturnValue(false)
    expect(await sendWelcomeEmail("a@x.test", "A", "u", "p", "https://x")).toBe(false)

    mocks.validateSesConfig.mockReturnValue(true)
    mocks.sendAppEmail.mockRejectedValue(new Error("x"))
    expect(await sendWelcomeEmail("a@x.test", "A", "u", "p", "https://x")).toBe(false)
  })
})
