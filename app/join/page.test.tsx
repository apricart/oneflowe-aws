import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { createElement } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

vi.mock("next/image", () => ({
  default: ({ src, alt }: { src: string; alt: string }) => createElement("img", { src, alt }),
}))

import JoinPage from "./page"

function reply(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: "",
    headers: { get: () => null },
    json: async () => body,
  }
}

const OPEN_ORGANIZATION = {
  organizationName: "K-Electric",
  emailDomain: "ke.com.pk",
  branches: [{ id: 7, name: "North" }],
  groups: [],
}

/** What the lookup answers for a real code whose organization set no domain. */
const DOMAINLESS_ORGANIZATION = {
  organizationName: "Demo Corp",
  emailDomain: null,
  branches: [],
  groups: [],
}

async function enterCode(code = "ACDE-4FGH-7JKL") {
  fireEvent.change(screen.getByLabelText(/Organization join code/), { target: { value: code } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
  })
}

beforeEach(() => {
  mocks.fetch.mockReset()
  vi.stubGlobal("fetch", mocks.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("JoinPage — an organization with no email domain", () => {
  it("prompts the applicant to contact their organization and never shows the form", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(200, DOMAINLESS_ORGANIZATION))
    render(<JoinPage />)
    await enterCode()

    const prompt = await screen.findByRole("alertdialog")
    expect(prompt.textContent).toContain("Email domain not set")
    expect(prompt.textContent).toContain(
      "Your organization's email domain is not set, so you cannot join yet. Please contact your organization.",
    )
    expect(prompt.textContent).toContain("Demo Corp")

    // The form is not mounted at all — there is nothing to fill in.
    expect(screen.queryByLabelText(/^Work email/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Send request" })).toBeNull()
  })

  it("closes back to the code step, still without the form", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(200, DOMAINLESS_ORGANIZATION))
    render(<JoinPage />)
    await enterCode()

    fireEvent.click(await screen.findByRole("button", { name: "OK" }))

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull())
    expect(screen.getByLabelText(/Organization join code/)).toBeTruthy()
    expect(screen.queryByLabelText(/^Work email/)).toBeNull()
  })

  it("offers the way back to sign in from the prompt", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(200, DOMAINLESS_ORGANIZATION))
    render(<JoinPage />)
    await enterCode()

    const back = await screen.findByRole("link", { name: "Back to sign in" })
    // Two such links exist once the prompt is open; the prompt's is inside it.
    expect(screen.getByRole("alertdialog").contains(back)).toBe(true)
    expect(back.getAttribute("href")).toBe("/login")
  })
})

const CHALLENGE_ID = "6f0c3a52-8a3f-4b8e-9a37-0c2b0d4e5f61"
const PROOF = "p".repeat(43)

/** Types the six digits into the code boxes. */
function enterOtp(digits: string) {
  const group = screen.getByRole("group", { name: "Verification code" })
  const boxes = Array.from(group.querySelectorAll("input"))
  digits.split("").forEach((digit, index) => {
    fireEvent.change(boxes[index], { target: { value: digit } })
  })
}

/** From a resolved code, through the email and its code, to the form. */
async function verifyEmail(localPart = "ada") {
  fireEvent.change(screen.getByLabelText(/^Work email/), { target: { value: localPart } })
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }))
  })
  enterOtp("123456")
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: /Verify and continue/ }))
  })
}

describe("JoinPage — an organization with an email domain", () => {
  it("asks for the email first, with the domain fixed, and shows no form yet", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(200, OPEN_ORGANIZATION))
    render(<JoinPage />)
    await enterCode("acde-4fgh-7jkl")

    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(screen.getByText("@ke.com.pk")).toBeTruthy()
    expect(screen.getByRole("button", { name: /Send verification code/ })).toBeTruthy()
    expect(screen.queryByLabelText(/^First name/)).toBeNull()
    expect(screen.queryByRole("button", { name: "Send request" })).toBeNull()
  })

  it("mails a code to the composed address, under the join code, never an organization", async () => {
    mocks.fetch
      .mockResolvedValueOnce(reply(200, OPEN_ORGANIZATION))
      .mockResolvedValueOnce(reply(202, { challengeId: CHALLENGE_ID, validForMinutes: 10 }))
    render(<JoinPage />)
    await enterCode("acde-4fgh-7jkl")

    fireEvent.change(screen.getByLabelText(/^Work email/), { target: { value: "ada" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }))
    })

    const [url, init] = mocks.fetch.mock.calls[1]
    expect(url).toBe("/api/v1/join/email-verification/request")
    expect(JSON.parse(String(init.body))).toEqual({ code: "ACDE-4FGH-7JKL", email: "ada@ke.com.pk" })
    expect(screen.getByText("ada@ke.com.pk")).toBeTruthy()
    expect(screen.getByRole("group", { name: "Verification code" })).toBeTruthy()
    // Still no form until the code is entered.
    expect(screen.queryByLabelText(/^First name/)).toBeNull()
  })

  it("refuses an @ in the part before the domain without calling the server", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(200, OPEN_ORGANIZATION))
    render(<JoinPage />)
    await enterCode()

    fireEvent.change(screen.getByLabelText(/^Work email/), { target: { value: "ada@evil.test" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }))
    })
    expect(screen.getByRole("alert")).toBeTruthy()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it("stays on the code step and says so when the code is wrong", async () => {
    mocks.fetch
      .mockResolvedValueOnce(reply(200, OPEN_ORGANIZATION))
      .mockResolvedValueOnce(reply(202, { challengeId: CHALLENGE_ID, validForMinutes: 10 }))
      .mockResolvedValueOnce(reply(400, { error: "The code is invalid or expired. Request a new code and try again." }))
    render(<JoinPage />)
    await enterCode()
    await verifyEmail()

    expect((await screen.findByRole("alert")).textContent).toMatch(/invalid or expired/)
    expect(screen.queryByLabelText(/^First name/)).toBeNull()
    const [url, init] = mocks.fetch.mock.calls[2]
    expect(url).toBe("/api/v1/join/email-verification/verify")
    expect(JSON.parse(String(init.body))).toEqual({ challengeId: CHALLENGE_ID, otp: "123456" })
  })

  it("lets the applicant go back and use a different email", async () => {
    mocks.fetch
      .mockResolvedValueOnce(reply(200, OPEN_ORGANIZATION))
      .mockResolvedValueOnce(reply(202, { challengeId: CHALLENGE_ID, validForMinutes: 10 }))
    render(<JoinPage />)
    await enterCode()
    fireEvent.change(screen.getByLabelText(/^Work email/), { target: { value: "ada" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }))
    })

    fireEvent.click(screen.getByRole("button", { name: "Use a different email" }))
    expect((screen.getByLabelText(/^Work email/) as HTMLInputElement).value).toBe("ada")
    expect(screen.queryByRole("group", { name: "Verification code" })).toBeNull()
  })

  it("opens the form with the verified address fixed, and submits it with the proof", async () => {
    mocks.fetch
      .mockResolvedValueOnce(reply(200, OPEN_ORGANIZATION))
      .mockResolvedValueOnce(reply(202, { challengeId: CHALLENGE_ID, validForMinutes: 10 }))
      .mockResolvedValueOnce(reply(200, { proof: PROOF, validForSeconds: 3600 }))
      .mockResolvedValueOnce(reply(201, { message: "Your request has been sent." }))
    render(<JoinPage />)
    await enterCode("acde-4fgh-7jkl")
    await verifyEmail()

    const email = screen.getByLabelText(/^Work email \(verified\)/) as HTMLInputElement
    expect(email.value).toBe("ada")
    expect(email.readOnly).toBe(true)

    fireEvent.change(screen.getByLabelText(/^First name/), { target: { value: "Ada" } })
    fireEvent.change(screen.getByLabelText(/^Last name/), { target: { value: "Lovelace" } })
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "ada" } })
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "Join-Flow-2026!x" } })
    fireEvent.change(screen.getByLabelText(/^Confirm password/), {
      target: { value: "Join-Flow-2026!x" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Order Initiator" }))
    fireEvent.change(screen.getByLabelText(/^Branch/), { target: { value: "7" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send request" }))
    })

    expect(await screen.findByText("Request sent")).toBeTruthy()

    const [url, init] = mocks.fetch.mock.calls[3]
    expect(url).toBe("/api/v1/join/requests")
    const sent = JSON.parse(String(init.body))
    expect(sent.email).toBe("ada@ke.com.pk")
    expect(sent.emailVerification).toEqual({ challengeId: CHALLENGE_ID, proof: PROOF })
    // The code is resent so the server resolves the tenant — and its domain —
    // again, rather than trusting anything this page was told.
    expect(sent.code).toBe("ACDE-4FGH-7JKL")
    expect(sent).not.toHaveProperty("emailDomain")
    expect(sent).not.toHaveProperty("organizationId")
  })

  it("still answers an unknown code inline, with no prompt", async () => {
    mocks.fetch.mockResolvedValueOnce(reply(404, {
      error: "That join code is not recognised. Check it with your organization's head office.",
    }))
    render(<JoinPage />)
    await enterCode()

    expect((await screen.findByRole("alert")).textContent).toMatch(/not recognised/)
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(screen.queryByLabelText(/^Work email/)).toBeNull()
  })
})
