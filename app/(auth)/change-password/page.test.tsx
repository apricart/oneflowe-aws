import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * The three-step page as a person on a shared branch PC sees it. The server
 * is a stub answering exactly what the real handlers answer (see the route
 * tests beside them), and the assertions are about what the person is
 * shown, what the page sends, and where it sends them next. The server
 * enforces every step regardless of this page; what is on trial here is
 * that the page never asks for something the server will refuse, never
 * leaks the address, and never lets a click go through twice.
 *
 * The three-step suites run with the emailed code pinned to *required*, so
 * they keep guarding that path while `lib/password-change-policy.ts` has it
 * switched off. The last block covers the page as it currently ships: the
 * password form alone.
 */

const mocks = vi.hoisted(() => ({
  useSession: vi.fn(),
  securelySignOut: vi.fn(async () => undefined),
  toast: vi.fn(),
  fetch: vi.fn(),
  emailVerificationRequired: vi.fn(() => true),
}))

vi.mock("next-auth/react", () => ({ useSession: mocks.useSession }))
vi.mock("@/lib/password-change-policy", () => ({
  isEmailVerificationRequiredForPasswordChange: mocks.emailVerificationRequired,
}))
vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement("img", { src, alt }),
}))
vi.mock("@/lib/session-coordination", () => ({ securelySignOut: mocks.securelySignOut }))
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }))

import ChangePasswordPage from "./page"

const SEND = "/api/v1/users/me/email-verification/send"
const VERIFY = "/api/v1/users/me/email-verification/verify"
const CHANGE = "/api/v1/users/me/change-password"

type Reply = { status: number; body?: unknown }

function reply({ status, body = {} }: Reply) {
  return { status, json: async () => body }
}

/** Queue one reply per expected request, in order; anything beyond is a test error. */
function server(...replies: Reply[]) {
  mocks.fetch.mockReset()
  for (const item of replies) mocks.fetch.mockResolvedValueOnce(reply(item))
  mocks.fetch.mockImplementation(async (path: string) => {
    throw new Error(`unexpected request to ${path}`)
  })
}

function requests(): { path: string; body: unknown }[] {
  return mocks.fetch.mock.calls.map(([path, init]) => ({
    path,
    body: init?.body === undefined ? undefined : JSON.parse(init.body),
  }))
}

const sendButton = () => screen.getByRole("button", { name: "Send verification code" })
const codeInputs = () => screen.queryAllByRole("textbox") as HTMLInputElement[]
const title = (name: string) => screen.getByText(name, { selector: "[data-slot=card-title]" })
const banner = () => screen.getByRole("alert")

async function clickSend() {
  await act(async () => {
    fireEvent.click(sendButton())
  })
}

async function typeCode(code: string) {
  const inputs = codeInputs()
  await act(async () => {
    for (let index = 0; index < code.length; index += 1) {
      fireEvent.change(inputs[index], { target: { value: code[index] } })
    }
  })
}

async function reachCodeStep() {
  server({ status: 200, body: { sent: true, emailHint: "a***@ke.com.pk", validForMinutes: 10 } })
  await clickSend()
  await screen.findByText(/A 6-digit code was sent to/)
}

async function reachPasswordStep() {
  await reachCodeStep()
  mocks.fetch.mockResolvedValueOnce(reply({ status: 200, body: { verified: true, validForSeconds: 600 } }))
  await typeCode("123456")
  await screen.findByText("Set New Password", { selector: "[data-slot=card-title]" })
}

async function fillPasswords(current: string, next: string, confirm = next) {
  fireEvent.change(screen.getByLabelText("Current Password"), { target: { value: current } })
  fireEvent.change(screen.getByLabelText("New Password"), { target: { value: next } })
  fireEvent.change(screen.getByLabelText("Confirm New Password"), { target: { value: confirm } })
}

async function submitPasswords() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Set New Password" }))
  })
}

beforeEach(() => {
  mocks.useSession.mockReturnValue({ status: "authenticated", data: { user: { id: "u1", mustChangePassword: true } } })
  mocks.securelySignOut.mockClear()
  mocks.toast.mockClear()
  mocks.emailVerificationRequired.mockReset().mockReturnValue(true)
  vi.stubGlobal("fetch", mocks.fetch)
  server()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe("before anything", () => {
  it("shows only a spinner while the session loads, and asks the server nothing", () => {
    mocks.useSession.mockReturnValue({ status: "loading", data: null })

    render(<ChangePasswordPage />)

    expect(screen.queryByRole("button")).toBeNull()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("explains why, warns that the code is for this account only, and offers to send it — without showing the address", () => {
    render(<ChangePasswordPage />)

    expect(title("Verify Your Email")).toBeTruthy()
    expect(screen.getByText(/requires a new password before you can continue/)).toBeTruthy()
    expect(screen.getByText(/The code is for this account only/)).toBeTruthy()
    expect(sendButton()).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/@/)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})

describe("step 1 — sending the code", () => {
  it("asks for the code with an empty body, then shows the masked address, the validity, and a resend countdown", async () => {
    render(<ChangePasswordPage />)

    await reachCodeStep()

    expect(requests()).toEqual([{ path: SEND, body: undefined }])
    expect(screen.getByText("a***@ke.com.pk")).toBeTruthy()
    expect(screen.getByText(/valid for 10 minutes/)).toBeTruthy()
    expect(screen.getByText(/Check that the email names this account/)).toBeTruthy()
    const resend = screen.getByRole("button", { name: /Resend code in 60s/ }) as HTMLButtonElement
    expect(resend.disabled).toBe(true)
    expect(codeInputs()).toHaveLength(6)
  })

  it("dead-ends an account with no reachable address: no code, no send button, only sign-out", async () => {
    server({ status: 409, body: { code: "EMAIL_UNROUTABLE", emailHint: "n***@ke-legacy.invalid", error: "..." } })
    render(<ChangePasswordPage />)

    await clickSend()

    expect(banner().textContent).toContain("No reachable email address on file (n***@ke-legacy.invalid)")
    expect(banner().textContent).toContain("administrator must correct the email address")
    expect(screen.queryByRole("button", { name: "Send verification code" })).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }))
    expect(mocks.securelySignOut).toHaveBeenCalledWith({ callbackUrl: "/login" })
  })

  it("counts down from the server's Retry-After when told to wait, keeping the button disabled", async () => {
    server({ status: 429, body: { error: "Please wait 1 minute before requesting another OTP", retryAfterSeconds: 37 } })
    render(<ChangePasswordPage />)

    await clickSend()

    expect(banner().textContent).toContain("Please wait 1 minute before requesting another OTP")
    const button = screen.getByRole("button", { name: "Send code (37s)" }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
  })

  it("shows the server's message for any other refusal and lets the person try again", async () => {
    server({ status: 400, body: { error: "Daily OTP request limit exceeded. Please try again tomorrow." } })
    render(<ChangePasswordPage />)

    await clickSend()

    expect(banner().textContent).toContain("Daily OTP request limit exceeded")
    expect((sendButton() as HTMLButtonElement).disabled).toBe(false)
    expect(codeInputs()).toHaveLength(0)
  })

  it("shows a generic message when the request itself fails, never the exception", async () => {
    mocks.fetch.mockReset().mockRejectedValueOnce(new TypeError("Failed to fetch"))
    render(<ChangePasswordPage />)

    await clickSend()

    expect(banner().textContent).toContain("An unexpected error occurred")
    expect(document.body.textContent).not.toContain("Failed to fetch")
  })

  it("ignores a second click while the first request is in flight", async () => {
    let release: (value: ReturnType<typeof reply>) => void = () => undefined
    mocks.fetch.mockReset().mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))
    render(<ChangePasswordPage />)

    fireEvent.click(sendButton())
    await act(async () => undefined)
    const inFlight = screen.getByRole("button", { name: /Sending/ }) as HTMLButtonElement
    expect(inFlight.disabled).toBe(true)
    fireEvent.click(inFlight)

    await act(async () => {
      release(reply({ status: 200, body: { sent: true, emailHint: "a***@ke.com.pk", validForMinutes: 10 } }))
    })

    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })
})

describe("step 2 — entering the code", () => {
  it("verifies as soon as the sixth digit is typed, sending only the code, and moves on to the password", async () => {
    render(<ChangePasswordPage />)

    await reachPasswordStep()

    expect(requests()[1]).toEqual({ path: VERIFY, body: { code: "123456" } })
    expect(screen.getByText(/Email verified/)).toBeTruthy()
    expect(screen.getByLabelText("Current Password")).toBeTruthy()
    expect(screen.getByLabelText("New Password")).toBeTruthy()
    expect(screen.getByLabelText("Confirm New Password")).toBeTruthy()
  })

  it("accepts a pasted code", async () => {
    render(<ChangePasswordPage />)
    await reachCodeStep()
    mocks.fetch.mockResolvedValueOnce(reply({ status: 200, body: { verified: true, validForSeconds: 600 } }))

    await act(async () => {
      fireEvent.paste(codeInputs()[0], { clipboardData: { getData: () => "98 76 54" } })
    })

    expect(requests()[1]).toEqual({ path: VERIFY, body: { code: "987654" } })
    await screen.findByText("Set New Password", { selector: "[data-slot=card-title]" })
  })

  it("shows the server's rejection with the attempts left, clears the digits, and stays on the code", async () => {
    render(<ChangePasswordPage />)
    await reachCodeStep()
    mocks.fetch.mockResolvedValueOnce(reply({ status: 400, body: { error: "Invalid OTP code (4 attempts remaining)" } }))

    await typeCode("000000")

    expect(banner().textContent).toContain("Invalid OTP code (4 attempts remaining)")
    expect(codeInputs().map((input) => input.value)).toEqual(["", "", "", "", "", ""])
    expect(screen.queryByLabelText("New Password")).toBeNull()
    expect(title("Verify Your Email")).toBeTruthy()
  })

  it("signs the person out when the session behind the code is gone", async () => {
    render(<ChangePasswordPage />)
    await reachCodeStep()
    mocks.fetch.mockResolvedValueOnce(reply({ status: 401, body: { error: "Unauthorized" } }))

    await typeCode("123456")

    expect(mocks.securelySignOut).toHaveBeenCalledWith({ callbackUrl: "/login?reason=session-expired" })
  })

  it("keeps the verify button off until six digits are present", async () => {
    render(<ChangePasswordPage />)
    await reachCodeStep()

    const verify = () => screen.getByRole("button", { name: "Verify code" }) as HTMLButtonElement
    expect(verify().disabled).toBe(true)
    await typeCode("12345")
    expect(verify().disabled).toBe(true)
    expect(requests()).toHaveLength(1)
  })

  it("lets the person ask for another code once the countdown ends, and clears the digits for the new one", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    render(<ChangePasswordPage />)
    server({ status: 200, body: { sent: true, emailHint: "a***@ke.com.pk", validForMinutes: 10 } })
    await clickSend()
    await typeCode("12")

    const resend = () => screen.getByRole("button", { name: /Resend code/ }) as HTMLButtonElement
    expect(resend().disabled).toBe(true)
    expect(resend().textContent).toBe("Resend code in 60s")

    // Each tick is scheduled by an effect after the previous render, so the
    // clock is advanced one second per act.
    const tick = async () => { await act(async () => { vi.advanceTimersByTime(1_000) }) }
    for (let second = 0; second < 59; second += 1) await tick()
    expect(resend().textContent).toBe("Resend code in 1s")
    expect(resend().disabled).toBe(true)

    await tick()
    expect(resend().textContent).toBe("Resend code")
    expect(resend().disabled).toBe(false)

    mocks.fetch.mockResolvedValueOnce(reply({ status: 200, body: { sent: true, emailHint: "a***@ke.com.pk", validForMinutes: 10 } }))
    await act(async () => { fireEvent.click(resend()) })

    expect(requests()).toEqual([{ path: SEND, body: undefined }, { path: SEND, body: undefined }])
    expect(codeInputs().map((input) => input.value)).toEqual(["", "", "", "", "", ""])
    expect(resend().textContent).toBe("Resend code in 60s")
  })
})

describe("step 3 — setting the password", () => {
  const CURRENT = "Handout-Passw0rd!"
  const NEXT = "Chosen-Passw0rd!2026"

  it("refuses a mismatched confirmation on the page, without asking the server", async () => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()

    await fillPasswords(CURRENT, NEXT, "Chosen-Passw0rd!2025")
    await submitPasswords()

    expect(banner().textContent).toContain("Passwords do not match.")
    expect(requests()).toHaveLength(2)
  })

  it("sends exactly the current and new password, then signs out to the login page", async () => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()
    mocks.fetch.mockResolvedValueOnce(reply({ status: 200, body: { success: true } }))

    await fillPasswords(CURRENT, NEXT)
    await submitPasswords()

    expect(requests()[2]).toEqual({ path: CHANGE, body: { currentPassword: CURRENT, password: NEXT } })
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Password changed" }))
    expect(mocks.securelySignOut).toHaveBeenCalledWith({ callbackUrl: "/login" })
  })

  it("starts over from the code when the proof has expired or been spent", async () => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()
    mocks.fetch.mockResolvedValueOnce(reply({ status: 403, body: { error: "Verify your email address before changing your password.", code: "EMAIL_VERIFICATION_REQUIRED" } }))

    await fillPasswords(CURRENT, NEXT)
    await submitPasswords()

    expect(banner().textContent).toContain("Your verification has expired. Please request a new code.")
    expect(title("Verify Your Email")).toBeTruthy()
    // Back on step 1. The send button is still inside the resend cooldown
    // from the code sent moments ago, which is right: a spent proof is not a
    // licence to a fresh code sooner than a resend would be.
    expect(screen.getByRole("button", { name: /^Send (verification )?code/ })).toBeTruthy()
    expect(codeInputs()).toHaveLength(0)
    expect(screen.queryByLabelText("New Password")).toBeNull()
    expect(mocks.securelySignOut).not.toHaveBeenCalled()
  })

  it.each([
    "The current password is incorrect.",
    "The new password must be different from your current password.",
    "Password must be at least 12 characters, Password must contain a special character",
  ])("shows the server's refusal and keeps the person on the form: %s", async (message) => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()
    mocks.fetch.mockResolvedValueOnce(reply({ status: 400, body: { error: message } }))

    await fillPasswords(CURRENT, NEXT)
    await submitPasswords()

    expect(banner().textContent).toContain(message)
    expect(title("Set New Password")).toBeTruthy()
    expect((screen.getByLabelText("New Password") as HTMLInputElement).value).toBe(NEXT)
    expect(mocks.securelySignOut).not.toHaveBeenCalled()
  })

  it("tells a locked-out person to wait, without signing them out", async () => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()
    mocks.fetch.mockResolvedValueOnce(reply({ status: 423, body: { error: "Too many failed attempts. Please try again later.", code: "ACCOUNT_LOCKED" } }))

    await fillPasswords("wrong-again", NEXT)
    await submitPasswords()

    expect(banner().textContent).toContain("Too many failed attempts")
    expect(mocks.securelySignOut).not.toHaveBeenCalled()
  })

  it("signs the person out when the session is gone", async () => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()
    mocks.fetch.mockResolvedValueOnce(reply({ status: 401, body: { error: "Unauthorized" } }))

    await fillPasswords(CURRENT, NEXT)
    await submitPasswords()

    expect(mocks.securelySignOut).toHaveBeenCalledWith({ callbackUrl: "/login?reason=session-expired" })
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it("ignores a second submit while the first is in flight", async () => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()
    let release: (value: ReturnType<typeof reply>) => void = () => undefined
    mocks.fetch.mockImplementationOnce(() => new Promise((resolve) => { release = resolve }))

    await fillPasswords(CURRENT, NEXT)
    fireEvent.click(screen.getByRole("button", { name: "Set New Password" }))
    await act(async () => undefined)
    const saving = screen.getByRole("button", { name: /Saving/ }) as HTMLButtonElement
    expect(saving.disabled).toBe(true)
    fireEvent.click(saving)

    await act(async () => { release(reply({ status: 200, body: { success: true } })) })

    expect(requests().filter((entry) => entry.path === CHANGE)).toHaveLength(1)
  })

  it("lets the person reveal what they typed, one field at a time", async () => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()

    const field = screen.getByLabelText("New Password") as HTMLInputElement
    expect(field.type).toBe("password")
    fireEvent.click(screen.getByRole("button", { name: "Show new password" }))
    expect(field.type).toBe("text")
    expect((screen.getByLabelText("Current Password") as HTMLInputElement).type).toBe("password")
    fireEvent.click(screen.getByRole("button", { name: "Hide new password" }))
    expect(field.type).toBe("password")
  })
})

describe("what never reaches the screen", () => {
  it("shows the address only masked, at every step", async () => {
    render(<ChangePasswordPage />)
    await reachPasswordStep()

    await waitFor(() => expect(document.body.textContent).not.toMatch(/[a-z]{2,}@ke\.com\.pk/))
  })
})

describe("with the emailed code switched off — the page as it currently ships", () => {
  const CURRENT = "Handout-Passw0rd!"
  const NEXT = "Chosen-Passw0rd!2026"

  beforeEach(() => {
    mocks.emailVerificationRequired.mockReturnValue(false)
  })

  it("opens on the password form, says why, and asks the server nothing first", () => {
    render(<ChangePasswordPage />)

    expect(title("Set New Password")).toBeTruthy()
    expect(screen.getByText(/requires a new password before you can continue/)).toBeTruthy()
    expect(screen.getByLabelText("Current Password")).toBeTruthy()
    expect(screen.getByLabelText("New Password")).toBeTruthy()
    expect(screen.getByLabelText("Confirm New Password")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Send verification code" })).toBeNull()
    expect(screen.queryByText(/Email verified/)).toBeNull()
    expect(codeInputs()).toHaveLength(0)
    expect(document.body.textContent).not.toMatch(/@/)
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it("changes the password with one request — never a send, never a verify — then signs out to the login page", async () => {
    server({ status: 200, body: { success: true } })
    render(<ChangePasswordPage />)

    await fillPasswords(CURRENT, NEXT)
    await submitPasswords()

    expect(requests()).toEqual([{ path: CHANGE, body: { currentPassword: CURRENT, password: NEXT } }])
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Password changed" }))
    expect(mocks.securelySignOut).toHaveBeenCalledWith({ callbackUrl: "/login" })
  })

  it("still refuses a mismatched confirmation on the page", async () => {
    render(<ChangePasswordPage />)

    await fillPasswords(CURRENT, NEXT, "Chosen-Passw0rd!2025")
    await submitPasswords()

    expect(banner().textContent).toContain("Passwords do not match.")
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each([
    "The current password is incorrect.",
    "The new password must be different from your current password.",
  ])("shows the server's refusal and keeps the form: %s", async (message) => {
    server({ status: 400, body: { error: message } })
    render(<ChangePasswordPage />)

    await fillPasswords(CURRENT, NEXT)
    await submitPasswords()

    expect(banner().textContent).toContain(message)
    expect(title("Set New Password")).toBeTruthy()
    expect(mocks.securelySignOut).not.toHaveBeenCalled()
  })

  it("signs the person out when the server says the session is gone", async () => {
    server({ status: 401, body: { error: "Unauthorized" } })
    render(<ChangePasswordPage />)

    await fillPasswords(CURRENT, NEXT)
    await submitPasswords()

    expect(mocks.securelySignOut).toHaveBeenCalledWith({ callbackUrl: "/login?reason=session-expired" })
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it("falls back to the code when a server built the other way demands one", async () => {
    // A page with the proof off against a server with it on must not strand
    // the person: the 403 sends them to step one instead of a dead end.
    server({ status: 403, body: { error: "Verify your email address before changing your password.", code: "EMAIL_VERIFICATION_REQUIRED" } })
    render(<ChangePasswordPage />)

    await fillPasswords(CURRENT, NEXT)
    await submitPasswords()

    expect(title("Verify Your Email")).toBeTruthy()
    expect(banner().textContent).toContain("Please verify your email address before setting a new password.")
    expect(sendButton()).toBeTruthy()
    expect(mocks.securelySignOut).not.toHaveBeenCalled()

    // And from there the full three steps still work.
    await reachCodeStep()
    expect(requests().at(-1)).toEqual({ path: SEND, body: undefined })
  })
})
