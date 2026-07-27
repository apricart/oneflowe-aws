import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  signOut: vi.fn(),
  useSession: vi.fn(),
}))

const probeMocks = vi.hoisted(() => ({
  probeSessionWithRetry: vi.fn(),
}))

vi.mock("next-auth/react", () => authMocks)
vi.mock("@/lib/session-probe", () => probeMocks)

import {
  MANUAL_SIGN_OUT_EVENT,
  SessionGuard,
} from "@/components/shell/session-guard"

describe("SessionGuard", () => {
  beforeEach(() => {
    authMocks.getSession.mockReset()
    authMocks.signOut.mockReset().mockResolvedValue(undefined)
    authMocks.useSession.mockReset().mockReturnValue({
      data: {
        user: {
          id: "user-1",
          role: "SUPER_ADMIN",
          organizationId: null,
          branchId: null,
        },
      },
      status: "authenticated",
    })
    probeMocks.probeSessionWithRetry.mockReset()
  })

  afterEach(() => {
    cleanup()
  })

  it("keeps the current UI mounted and does not sign out after an indeterminate check", async () => {
    probeMocks.probeSessionWithRetry.mockResolvedValue({
      kind: "indeterminate",
      reason: "network",
    })

    render(
      <SessionGuard>
        <div>Unsaved form remains mounted</div>
      </SessionGuard>,
    )

    act(() => {
      window.dispatchEvent(new Event("online"))
    })

    await waitFor(() =>
      expect(probeMocks.probeSessionWithRetry).toHaveBeenCalledTimes(1),
    )

    expect(authMocks.signOut).not.toHaveBeenCalled()
    expect(screen.queryByText("Unsaved form remains mounted")).not.toBeNull()
    expect(screen.getByRole("status").textContent).toContain(
      "Your work remains open",
    )
  })

  it("signs out exactly once for a definitive invalid session", async () => {
    probeMocks.probeSessionWithRetry.mockResolvedValue({
      kind: "invalid",
      status: 200,
    })

    render(
      <SessionGuard>
        <div>Protected portal</div>
      </SessionGuard>,
    )

    act(() => {
      window.dispatchEvent(new Event("online"))
    })

    await waitFor(() =>
      expect(authMocks.signOut).toHaveBeenCalledWith({
        redirect: true,
        callbackUrl: "/login",
      }),
    )
    expect(authMocks.signOut).toHaveBeenCalledTimes(1)
  })

  it("rehydrates NextAuth state when a raw probe proves the session is still valid", async () => {
    authMocks.useSession.mockReturnValue({
      data: null,
      status: "unauthenticated",
    })
    probeMocks.probeSessionWithRetry.mockResolvedValue({
      kind: "authenticated",
      session: {
        user: {
          id: "user-3",
          role: "HEAD_OFFICE",
          organizationId: 9,
          branchId: null,
        },
      },
    })
    authMocks.getSession.mockResolvedValue({
      user: {
        id: "user-3",
        role: "HEAD_OFFICE",
        organizationId: 9,
        branchId: null,
      },
    })

    render(
      <SessionGuard>
        <div>Portal content</div>
      </SessionGuard>,
    )

    await waitFor(() => expect(authMocks.getSession).toHaveBeenCalledTimes(1))
    expect(authMocks.signOut).not.toHaveBeenCalled()
  })

  it("does not duplicate a manual role-portal logout", async () => {
    probeMocks.probeSessionWithRetry.mockResolvedValue({
      kind: "invalid",
      status: 200,
    })

    render(
      <SessionGuard>
        <div>Portal content</div>
      </SessionGuard>,
    )

    act(() => {
      window.dispatchEvent(new Event(MANUAL_SIGN_OUT_EVENT))
      window.dispatchEvent(new Event("online"))
    })

    await Promise.resolve()
    expect(probeMocks.probeSessionWithRetry).not.toHaveBeenCalled()
    expect(authMocks.signOut).not.toHaveBeenCalled()
  })
})
