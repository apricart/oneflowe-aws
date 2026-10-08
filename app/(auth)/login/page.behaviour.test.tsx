import { fireEvent, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { installFetch, renderWithApp, resetUi, ui } from "@/tests/support/ui-harness"

vi.mock("next-auth/react", async () => (await import("@/tests/support/ui-mocks")).nextAuthMock())
vi.mock("next/navigation", async () => (await import("@/tests/support/ui-mocks")).navigationMock())

import { getSession, signIn } from "next-auth/react"

import LoginPage from "./page"

/**
 * The sign-in form against a faked NextAuth client. What is pinned: the
 * message each server error code becomes, the fallback to the employee
 * provider, the MFA hand-off, where each role lands, and that `callbackUrl`
 * can only ever send the browser somewhere inside the application.
 */
const replace = vi.fn()
const originalLocation = window.location

beforeEach(() => {
  resetUi(null)
  installFetch([[/.*/, { message: "sent" }]])
  vi.mocked(signIn).mockReset()
  vi.mocked(getSession).mockReset()
  replace.mockReset()
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...originalLocation, replace, href: "http://localhost/login", origin: "http://localhost" },
  })
  vi.spyOn(console, "log").mockImplementation(() => {})
  vi.spyOn(console, "warn").mockImplementation(() => {})
})

afterEach(() => {
  Object.defineProperty(window, "location", { configurable: true, value: originalLocation })
})

async function submit(username = "ahmed", password = "Secret-Passw0rd!") {
  fireEvent.change(screen.getByLabelText(/username/i), { target: { value: username } })
  fireEvent.change(document.getElementById("password")!, { target: { value: password } })
  fireEvent.submit(document.getElementById("password")!.closest("form")!)
}

describe("Login", () => {
  it.each([
    ["CredentialsSignin", "Invalid credentials. Please check your username/email and password."],
    ["ORGANIZATION_INACTIVE", "Company has been de-activated by the Admin."],
    ["BRANCH_INACTIVE", "Branch has been de-activated by the Admin."],
    ["USER_INACTIVE", "Your account has been deactivated. Please contact support."],
    ["NETWORK_RESTRICTED", "Please log in from your organization's network."],
    ["ACCOUNT_LOCKED", "Too many failed sign-in attempts. This account is temporarily locked. Please try again later or contact support."],
  ])("explains %s", async (code, message) => {
    vi.mocked(signIn).mockResolvedValue({ ok: false, error: code } as any)
    renderWithApp(<LoginPage />, { withAppContext: false })
    await submit()
    expect(await screen.findByText(message)).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })

  it("tries the employee provider when the staff provider rejects the credentials", async () => {
    vi.mocked(signIn)
      .mockResolvedValueOnce({ ok: false, error: "CredentialsSignin" } as any)
      .mockResolvedValueOnce({ ok: true, error: null } as any)
    vi.mocked(getSession).mockResolvedValue({ user: { role: "EMPLOYEE" } } as any)
    renderWithApp(<LoginPage />, { withAppContext: false })
    await submit()
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/shop"))
    expect(vi.mocked(signIn).mock.calls.map((call) => call[0])).toEqual(["credentials", "employee-credentials"])
  })

  it.each([
    ["ORDER_PORTAL", "/shop"],
    ["GROUP_ORDER_PORTAL", "/group-portal"],
    ["GROUP_USER", "/dashboard"],
  ])("sends %s to its own landing page", async (role, path) => {
    vi.mocked(signIn).mockResolvedValue({ ok: true, error: null } as any)
    vi.mocked(getSession).mockResolvedValue({ user: { role } } as any)
    renderWithApp(<LoginPage />, { withAppContext: false })
    await submit()
    await waitFor(() => expect(replace).toHaveBeenCalledWith(path))
  })

  it("sends a flagged account to change its password first", async () => {
    vi.mocked(signIn).mockResolvedValue({ ok: true, error: null } as any)
    vi.mocked(getSession).mockResolvedValue({ user: { role: "HEAD_OFFICE", mustChangePassword: true } } as any)
    renderWithApp(<LoginPage />, { withAppContext: false })
    await submit()
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/change-password"))
  })

  it("honours an internal callbackUrl and refuses an external one", async () => {
    vi.mocked(signIn).mockResolvedValue({ ok: true, error: null } as any)
    vi.mocked(getSession).mockResolvedValue({ user: { role: "HEAD_OFFICE" } } as any)

    ui.searchParams = new URLSearchParams("callbackUrl=/reports/order-report")
    const first = renderWithApp(<LoginPage />, { withAppContext: false })
    await submit()
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/reports/order-report"))
    first.unmount()

    for (const hostile of ["https://evil.example/steal", "//evil.example", "/\\evil.example", "javascript:alert(1)"]) {
      replace.mockReset()
      ui.searchParams = new URLSearchParams({ callbackUrl: hostile })
      const view = renderWithApp(<LoginPage />, { withAppContext: false })
      await submit()
      await waitFor(() => expect(replace).toHaveBeenCalled())
      const target = String(replace.mock.calls[0][0])
      expect(target.startsWith("/") && !target.startsWith("//") && !target.includes("\\"), `${hostile} -> ${target}`).toBe(true)
      view.unmount()
    }
  })

  it("hands an MFA account to the code dialog instead of redirecting", async () => {
    vi.mocked(signIn).mockResolvedValue({ ok: false, error: "MFA_REQUIRED" } as any)
    renderWithApp(<LoginPage />, { withAppContext: false })
    await submit()
    expect(await screen.findByText(/Verify Your Identity/)).toBeTruthy()
    expect(replace).not.toHaveBeenCalled()
  })

  it("reports a sign-in it cannot confirm", async () => {
    vi.mocked(signIn).mockResolvedValue({ ok: true, error: null } as any)
    vi.mocked(getSession).mockResolvedValue(null as any)
    renderWithApp(<LoginPage />, { withAppContext: false })
    await submit()
    expect(await screen.findByText("We couldn't confirm your sign in. Please try again.")).toBeTruthy()
  })

  it("retries once after a malformed NextAuth response, then gives a plain message", async () => {
    vi.mocked(signIn).mockRejectedValue(new TypeError("Failed to construct 'URL': Invalid URL"))
    renderWithApp(<LoginPage />, { withAppContext: false })
    await submit()
    expect(await screen.findByText("We couldn't complete sign in. Please try again.")).toBeTruthy()
    expect(vi.mocked(signIn)).toHaveBeenCalledTimes(2)
  })

  it("explains an expired session and a completed reset", () => {
    ui.searchParams = new URLSearchParams("reason=session-expired&password-reset=success")
    renderWithApp(<LoginPage />, { withAppContext: false })
    expect(screen.getByText("Your session expired. Please sign in again.")).toBeTruthy()
    expect(screen.getByText(/Password reset complete/)).toBeTruthy()
  })
})
