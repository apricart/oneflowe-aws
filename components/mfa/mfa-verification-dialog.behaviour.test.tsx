import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { callsTo, installFetch, renderWithApp, resetUi } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())
const toast = vi.hoisted(() => vi.fn())
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast, toasts: [], dismiss: vi.fn() }), toast }))

import { signIn } from "next-auth/react"

import { MFAVerificationDialog } from "./mfa-verification-dialog"

/**
 * The one-time-code dialog. It sends a code once when it opens, verifies the
 * typed code either through the MFA sign-in provider (login) or the verify
 * endpoint (everything else), and turns the server's refusal into a message.
 */
/** Type a code one digit per box, once the send has finished and the boxes are enabled. */
async function enterCode(code: string) {
  await waitFor(() => {
    const boxes = screen.getAllByRole("textbox") as HTMLInputElement[]
    expect(boxes.length).toBeGreaterThanOrEqual(6)
    expect(boxes.every((box) => !box.disabled)).toBe(true)
  })
  const boxes = screen.getAllByRole("textbox") as HTMLInputElement[]
  code.split("").forEach((digit, index) => {
    fireEvent.change(boxes[index], { target: { value: digit } })
  })
}

beforeEach(() => {
  resetUi(null)
  toast.mockClear()
  vi.mocked(signIn).mockReset()
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "debug").mockImplementation(() => {})
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("MFA verification dialog", () => {
  it("sends a code exactly once when it opens", async () => {
    installFetch([["/api/v1/mfa/login/send-otp", { message: "If MFA is enabled for this account, a verification code has been sent." }]])
    renderWithApp(<MFAVerificationDialog open onClose={vi.fn()} onSuccess={vi.fn()} username="ahmed" />, { withAppContext: false })
    await waitFor(() => expect(callsTo("/api/v1/mfa/login/send-otp", "POST")).toHaveLength(1))
    expect(callsTo("/api/v1/mfa/login/send-otp", "POST")[0].body).toEqual({ username: "ahmed", type: "LOGIN" })
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "OTP Sent" })))
  })

  it("verifies through the API when no password is held, and reports success", async () => {
    installFetch([
      ["/api/v1/mfa/login/send-otp", { message: "sent" }],
      ["/api/v1/mfa/login/verify-otp", { message: "OTP verified successfully", verified: true }],
    ])
    const onSuccess = vi.fn()
    const onClose = vi.fn()
    renderWithApp(<MFAVerificationDialog open onClose={onClose} onSuccess={onSuccess} username="ahmed" type="VERIFY_EMAIL" />, { withAppContext: false })
    await waitFor(() => expect(callsTo("/api/v1/mfa/login/send-otp")).toHaveLength(1))

    await enterCode("123456")
    await waitFor(() => expect(callsTo("/api/v1/mfa/login/verify-otp", "POST")).toHaveLength(1))
    expect(callsTo("/api/v1/mfa/login/verify-otp", "POST")[0].body).toEqual({ username: "ahmed", code: "123456", type: "VERIFY_EMAIL" })
    await waitFor(() => expect(onSuccess).toHaveBeenCalledWith("123456"))
    expect(onClose).toHaveBeenCalled()
  })

  it("shows the server's refusal of a wrong code", async () => {
    installFetch([
      ["/api/v1/mfa/login/send-otp", { message: "sent" }],
      ["/api/v1/mfa/login/verify-otp", { status: 400, body: { error: "Invalid OTP code. Please use the latest code sent to your email. (4 attempts remaining)" } }],
    ])
    const onSuccess = vi.fn()
    renderWithApp(<MFAVerificationDialog open onClose={vi.fn()} onSuccess={onSuccess} username="ahmed" type="VERIFY_EMAIL" />, { withAppContext: false })
    await waitFor(() => expect(callsTo("/api/v1/mfa/login/send-otp")).toHaveLength(1))
    await enterCode("654321")
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Verification Failed" })))
    expect(onSuccess).not.toHaveBeenCalled()
  })

  it("signs in through the MFA provider at login, and refuses a rejected code", async () => {
    installFetch([["/api/v1/mfa/login/send-otp", { message: "sent" }]])
    vi.mocked(signIn).mockResolvedValue({ ok: false, error: "CredentialsSignin" } as any)
    renderWithApp(<MFAVerificationDialog open onClose={vi.fn()} onSuccess={vi.fn()} username="ahmed" userPassword="pw" />, { withAppContext: false })
    await waitFor(() => expect(callsTo("/api/v1/mfa/login/send-otp")).toHaveLength(1))
    await enterCode("111111")
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("mfa-credentials", expect.objectContaining({ username: "ahmed", otp: "111111", redirect: false })))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Verification Failed",
      description: "Invalid OTP code. Please check your email and try again.",
    })))
  })

  it("uses the employee MFA provider for an employee", async () => {
    installFetch([["/api/v1/mfa/login/send-otp", { message: "sent" }]])
    vi.mocked(signIn).mockResolvedValue({ ok: true, error: null } as any)
    renderWithApp(<MFAVerificationDialog open onClose={vi.fn()} onSuccess={vi.fn()} username="emp" userPassword="pw" isEmployee />, { withAppContext: false })
    await waitFor(() => expect(callsTo("/api/v1/mfa/login/send-otp")).toHaveLength(1))
    await enterCode("222222")
    await waitFor(() => expect(signIn).toHaveBeenCalledWith("employee-mfa-credentials", expect.anything()))
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Login Successful" })))
  })

  it("reports a failed send", async () => {
    installFetch([["/api/v1/mfa/login/send-otp", { status: 429, body: { error: "Too many requests. Please try again later." } }]])
    renderWithApp(<MFAVerificationDialog open onClose={vi.fn()} onSuccess={vi.fn()} username="ahmed" />, { withAppContext: false })
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Error" })))
  })
})
