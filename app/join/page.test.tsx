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

describe("JoinPage — an organization with an email domain", () => {
  it("opens the form with the domain fixed, and submits the composed address", async () => {
    mocks.fetch
      .mockResolvedValueOnce(reply(200, OPEN_ORGANIZATION))
      .mockResolvedValueOnce(reply(201, { message: "Your request has been sent." }))
    render(<JoinPage />)
    await enterCode("acde-4fgh-7jkl")

    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(screen.getByText("@ke.com.pk")).toBeTruthy()

    fireEvent.change(screen.getByLabelText(/^First name/), { target: { value: "Ada" } })
    fireEvent.change(screen.getByLabelText(/^Last name/), { target: { value: "Lovelace" } })
    fireEvent.change(screen.getByLabelText(/^Work email/), { target: { value: "ada" } })
    fireEvent.change(screen.getByLabelText(/^Username/), { target: { value: "ada" } })
    fireEvent.change(screen.getByLabelText(/^Password/), { target: { value: "Join-Flow-2026!x" } })
    fireEvent.change(screen.getByLabelText(/^Confirm password/), {
      target: { value: "Join-Flow-2026!x" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Order Portal User" }))
    fireEvent.change(screen.getByLabelText(/^Branch/), { target: { value: "7" } })
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send request" }))
    })

    expect(await screen.findByText("Request sent")).toBeTruthy()

    const [url, init] = mocks.fetch.mock.calls[1]
    expect(url).toBe("/api/v1/join/requests")
    const sent = JSON.parse(String(init.body))
    expect(sent.email).toBe("ada@ke.com.pk")
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
