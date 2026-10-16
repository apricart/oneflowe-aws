import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { SWRConfig } from "swr"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { JoinCodeCard } from "./join-code-card"

// The page reads the signed-in role to tell a read-only Viewer apart; with no
// session it renders exactly as before, for the role the test sets up.
vi.mock("next-auth/react", () => ({ useSession: () => ({ data: null, status: "unauthenticated" }) }))

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }))

function reply(body: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => "application/json" },
    json: async () => body,
  }
}

/** A fresh SWR cache per render, so one test's answer cannot leak into the next. */
function renderCard() {
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <JoinCodeCard />
    </SWRConfig>,
  )
}

beforeEach(() => {
  mocks.fetch.mockReset()
  vi.stubGlobal("fetch", mocks.fetch)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe("JoinCodeCard — the organization's email domain", () => {
  it("warns Head Office that a code leads nowhere while no domain is set", async () => {
    mocks.fetch.mockResolvedValue(reply({
      code: "ACDE-4FGH-7JKL",
      updatedAt: null,
      joiningOpen: true,
      emailDomain: null,
    }))
    renderCard()

    const warning = await screen.findByRole("status")
    expect(warning.textContent).toMatch(/email domain is not set/i)
    expect(warning.textContent).toMatch(/platform administrator/i)
    // Existing codes remain visible, but are permanent.
    expect(screen.getByText("ACDE-4FGH-7JKL")).toBeTruthy()
    expect(screen.getByText(/permanent and cannot be edited/i)).toBeTruthy()
    expect(screen.queryByLabelText("Set your organization join code")).toBeNull()
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /close joining/i })).toBeNull()
  })

  it("names the domain applicants must use once it is set", async () => {
    mocks.fetch.mockResolvedValue(reply({
      code: "ACDE-4FGH-7JKL",
      updatedAt: null,
      joiningOpen: true,
      emailDomain: "ke.com.pk",
    }))
    renderCard()

    expect(await screen.findByText("@ke.com.pk")).toBeTruthy()
    expect(screen.queryByText(/email domain is not set/i)).toBeNull()
  })
})

describe("JoinCodeCard — setting the permanent code", () => {
  it("offers one manual entry when the organization has no code", async () => {
    const empty = {
      code: null,
      updatedAt: null,
      joiningOpen: false,
      emailDomain: "ke.com.pk",
    }
    const saved = { ...empty, code: "MANUAL-CODE", joiningOpen: true }
    mocks.fetch
      .mockResolvedValueOnce(reply(empty))
      .mockResolvedValueOnce(reply({ code: saved.code, joiningOpen: true }))
    renderCard()

    const input = await screen.findByLabelText("Set your organization join code")
    expect(screen.queryByRole("button", { name: /generate/i })).toBeNull()
    fireEvent.change(input, { target: { value: "manual-code" } })
    fireEvent.click(screen.getByRole("button", { name: "Save code" }))

    await waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(2))
    expect(mocks.fetch.mock.calls[1][0]).toBe("/api/v1/organizations/join-code")
    expect(mocks.fetch.mock.calls[1][1]).toEqual(expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ code: "MANUAL-CODE" }),
    }))
    expect(await screen.findByText("MANUAL-CODE")).toBeTruthy()
    expect(screen.queryByLabelText("Set your organization join code")).toBeNull()
  })
})
