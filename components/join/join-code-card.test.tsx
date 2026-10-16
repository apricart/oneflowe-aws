import { cleanup, render, screen } from "@testing-library/react"
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
    // The code itself is still shown and manageable.
    expect(screen.getByText("ACDE-4FGH-7JKL")).toBeTruthy()
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
