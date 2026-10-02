import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  securelySignOut: vi.fn(),
  routerReplace: vi.fn(),
}))

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement("img", { src, alt }),
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.routerReplace }),
}))
vi.mock("@/lib/session-coordination", () => ({ securelySignOut: mocks.securelySignOut }))

import ForgotPasswordPage from "./page"

function reply(status: number, body: Record<string, unknown>, retryAfter?: string) {
  return {
    status,
    headers: { get: (name: string) => name === "Retry-After" ? retryAfter ?? null : null },
    json: async () => body,
  }
}

beforeEach(() => {
  mocks.fetch.mockReset()
  mocks.securelySignOut.mockReset().mockResolvedValue(undefined)
  mocks.routerReplace.mockReset()
  vi.stubGlobal("fetch", mocks.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("ForgotPasswordPage", () => {
  it("walks from identifier to OTP to a new password and signs out old sessions", async () => {
    mocks.fetch
      .mockResolvedValueOnce(reply(202, {
        challengeId: "11111111-1111-4111-8111-111111111111",
      }))
      .mockResolvedValueOnce(reply(200, {
        resetToken: "x".repeat(43),
        validForSeconds: 600,
      }))
      .mockResolvedValueOnce(reply(200, { success: true }))

    render(<ForgotPasswordPage />)
    fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "person-op" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send verification code" }))
    })

    const codeInputs = await screen.findAllByRole("textbox")
    await act(async () => {
      for (let index = 0; index < 6; index += 1) {
        fireEvent.change(codeInputs[index], { target: { value: String(index + 1) } })
      }
      fireEvent.click(screen.getByRole("button", { name: "Verify code" }))
    })

    fireEvent.change(await screen.findByLabelText("New password"), {
      target: { value: "New-Secure-Password-123!" },
    })
    fireEvent.change(screen.getByLabelText("Confirm new password"), {
      target: { value: "New-Secure-Password-123!" },
    })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reset password" }))
    })

    await waitFor(() => {
      expect(mocks.securelySignOut).toHaveBeenCalledWith({
        callbackUrl: "/login?password-reset=success",
      })
    })
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
  })

  it("keeps the response account-neutral after requesting a code", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(202, {
      challengeId: "22222222-2222-4222-8222-222222222222",
    }))
    render(<ForgotPasswordPage />)
    fireEvent.change(screen.getByLabelText("Username or email"), { target: { value: "unknown" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send verification code" }))
    })

    expect(await screen.findByText(/If an active account matched/)).toBeTruthy()
    expect(document.body.textContent).not.toContain("unknown")
  })
})
