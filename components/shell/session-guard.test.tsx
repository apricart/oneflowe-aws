import { act, cleanup, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const authMocks = vi.hoisted(() => ({
  useSession: vi.fn(),
}))

const probeMocks = vi.hoisted(() => ({
  probeSessionWithRetry: vi.fn(),
  renewSessionActivity: vi.fn(),
}))

const coordinationMocks = vi.hoisted(() => ({
  securelySignOut: vi.fn(),
  isSessionSignOutInProgress: vi.fn(),
  reloadAfterSessionRecovery: vi.fn(),
  withSessionMutationLock: vi.fn(),
}))

vi.mock("next-auth/react", () => authMocks)
vi.mock("@/lib/session-probe", () => probeMocks)
vi.mock("@/lib/session-coordination", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/session-coordination")>()),
  securelySignOut: coordinationMocks.securelySignOut,
  isSessionSignOutInProgress:
    coordinationMocks.isSessionSignOutInProgress,
  reloadAfterSessionRecovery: coordinationMocks.reloadAfterSessionRecovery,
  withSessionMutationLock: coordinationMocks.withSessionMutationLock,
}))

import {
  MANUAL_SIGN_OUT_EVENT,
  SessionGuard,
} from "@/components/shell/session-guard"

describe("SessionGuard", () => {
  beforeEach(() => {
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
    probeMocks.renewSessionActivity.mockReset()
    coordinationMocks.securelySignOut.mockReset().mockResolvedValue(undefined)
    coordinationMocks.isSessionSignOutInProgress.mockReset().mockReturnValue(false)
    coordinationMocks.reloadAfterSessionRecovery.mockReset()
    coordinationMocks.withSessionMutationLock
      .mockReset()
      .mockImplementation(async (task: () => Promise<unknown>) => task())
    localStorage.clear()
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    })
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

    expect(coordinationMocks.securelySignOut).not.toHaveBeenCalled()
    expect(screen.getByText("Unsaved form remains mounted")).not.toBeNull()
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
      expect(coordinationMocks.securelySignOut).toHaveBeenCalledWith({
        callbackUrl: "/login?reason=session-expired",
      }),
    )
    expect(coordinationMocks.securelySignOut).toHaveBeenCalledTimes(1)
  })

  it("reloads through the server boundary when a raw probe disproves client unauthenticated state", async () => {
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
    render(
      <SessionGuard>
        <div>Portal content</div>
      </SessionGuard>,
    )

    await waitFor(() =>
      expect(coordinationMocks.reloadAfterSessionRecovery).toHaveBeenCalledTimes(1),
    )
    expect(screen.getByRole("alert")).not.toBeNull()
    expect(coordinationMocks.securelySignOut).not.toHaveBeenCalled()
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
    expect(coordinationMocks.securelySignOut).not.toHaveBeenCalled()
    // A deliberate logout conceals content under sign-out wording, not the
    // expired-deadline notice.
    expect(screen.getByRole("alert").textContent).toContain("Signing you out")
    expect(
      screen.getByText("Portal content").parentElement?.getAttribute("aria-hidden"),
    ).toBe("true")
  })

  it("keeps logout-cancelled content locked until revalidation succeeds", async () => {
    probeMocks.probeSessionWithRetry.mockResolvedValue({
      kind: "authenticated",
      session: {
        user: { id: "user-1", role: "SUPER_ADMIN" },
        expires: new Date(Date.now() + 15 * 60_000).toISOString(),
        idleTimeoutMinutes: 15,
      },
    })

    render(
      <SessionGuard>
        <div>Protected portal</div>
      </SessionGuard>,
    )

    act(() => window.dispatchEvent(new Event(MANUAL_SIGN_OUT_EVENT)))
    expect(screen.getByRole("alert")).not.toBeNull()

    act(() => window.dispatchEvent(new Event("oneflowe:sign-out-cancelled")))
    await waitFor(() =>
      expect(probeMocks.probeSessionWithRetry).toHaveBeenCalledTimes(1),
    )
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
  })

  it("does not count health, focus, or online checks as user activity", async () => {
    probeMocks.probeSessionWithRetry.mockResolvedValue({
      kind: "authenticated",
      session: {
        user: { id: "user-1", role: "SUPER_ADMIN" },
        expires: new Date(Date.now() + 15 * 60_000).toISOString(),
        idleTimeoutMinutes: 15,
      },
    })

    render(
      <SessionGuard>
        <div>Protected portal</div>
      </SessionGuard>,
    )

    act(() => {
      window.dispatchEvent(new Event("online"))
      document.dispatchEvent(new Event("visibilitychange"))
    })

    await waitFor(() =>
      expect(probeMocks.probeSessionWithRetry).toHaveBeenCalled(),
    )
    expect(probeMocks.renewSessionActivity).not.toHaveBeenCalled()
  })

  it("coalesces the first burst of genuine interaction into one immediate activity renewal", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-08-15T10:00:00.000Z").getTime()
    vi.setSystemTime(now)
    authMocks.useSession.mockReturnValue({
      data: {
        user: { id: "user-1", role: "SUPER_ADMIN" },
        expires: new Date(now + 15 * 60_000).toISOString(),
        idleTimeoutMinutes: 15,
      },
      status: "authenticated",
    })
    probeMocks.renewSessionActivity.mockResolvedValue({
      kind: "authenticated",
      session: {
        user: { id: "user-1", role: "SUPER_ADMIN" },
        expires: new Date(now + 16 * 60_000).toISOString(),
        idleTimeoutMinutes: 15,
      },
    })

    render(
      <SessionGuard>
        <div>Protected portal</div>
      </SessionGuard>,
    )

    act(() => {
      window.dispatchEvent(new Event("pointerdown"))
      window.dispatchEvent(new Event("keydown"))
      window.dispatchEvent(new Event("wheel"))
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(probeMocks.renewSessionActivity).toHaveBeenCalledTimes(1)
    expect(coordinationMocks.securelySignOut).not.toHaveBeenCalled()
  })

  it("renews first activity before a near idle deadline can lock the session", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-08-15T10:00:00.000Z").getTime()
    vi.setSystemTime(now)
    authMocks.useSession.mockReturnValue({
      data: {
        user: { id: "user-1", role: "SUPER_ADMIN" },
        expires: new Date(now + 5_000).toISOString(),
        idleTimeoutMinutes: 15,
      },
      status: "authenticated",
    })
    probeMocks.renewSessionActivity.mockResolvedValue({
      kind: "authenticated",
      session: {
        user: { id: "user-1", role: "SUPER_ADMIN" },
        expires: new Date(now + 15 * 60_000).toISOString(),
        idleTimeoutMinutes: 15,
      },
    })

    render(
      <SessionGuard>
        <div>Protected portal</div>
      </SessionGuard>,
    )

    act(() => {
      window.dispatchEvent(new Event("pointerdown"))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(probeMocks.renewSessionActivity).toHaveBeenCalledTimes(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000)
    })

    expect(screen.queryByRole("alert")).toBeNull()
    expect(coordinationMocks.securelySignOut).not.toHaveBeenCalled()
  })

  it("drains genuine activity that arrives during an in-flight renewal", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-08-15T10:00:00.000Z").getTime()
    vi.setSystemTime(now)
    authMocks.useSession.mockReturnValue({
      data: {
        user: { id: "user-1", role: "SUPER_ADMIN" },
        expires: new Date(now + 15 * 60_000).toISOString(),
        idleTimeoutMinutes: 15,
      },
      status: "authenticated",
    })
    let resolveFirst!: (value: unknown) => void
    const first = new Promise<unknown>((resolve) => {
      resolveFirst = resolve
    })
    probeMocks.renewSessionActivity
      .mockImplementationOnce(() => first)
      .mockResolvedValue({
        kind: "authenticated",
        session: {
          user: { id: "user-1", role: "SUPER_ADMIN" },
          expires: new Date(now + 15 * 60_000).toISOString(),
          idleTimeoutMinutes: 15,
        },
      })

    render(
      <SessionGuard>
        <div>Protected portal</div>
      </SessionGuard>,
    )

    act(() => window.dispatchEvent(new Event("pointerdown")))
    await act(async () => vi.advanceTimersByTimeAsync(0))
    expect(probeMocks.renewSessionActivity).toHaveBeenCalledTimes(1)

    act(() => window.dispatchEvent(new Event("keydown")))
    await act(async () => {
      resolveFirst({
        kind: "authenticated",
        session: {
          user: { id: "user-1", role: "SUPER_ADMIN" },
          expires: new Date(now + 15 * 60_000).toISOString(),
          idleTimeoutMinutes: 15,
        },
      })
      await first
      await vi.advanceTimersByTimeAsync(0)
    })

    expect(probeMocks.renewSessionActivity).toHaveBeenCalledTimes(2)
  })

  it("does not flash the expired-session notice while the provider is still loading", async () => {
    authMocks.useSession.mockReturnValue({ data: null, status: "loading" })

    render(
      <SessionGuard>
        <div>Portal content</div>
      </SessionGuard>,
    )

    expect(screen.queryByRole("alert")).toBeNull()
    expect(
      screen.getByText("Portal content").parentElement?.getAttribute("aria-hidden"),
    ).toBeNull()
  })

  it("still conceals content once the session is definitively unauthenticated", async () => {
    authMocks.useSession.mockReturnValue({ data: null, status: "unauthenticated" })
    probeMocks.probeSessionWithRetry.mockResolvedValue({
      kind: "indeterminate",
      reason: "network",
    })

    render(
      <SessionGuard>
        <div>Portal content</div>
      </SessionGuard>,
    )

    expect(screen.getByRole("alert").textContent).toContain("Session locked")
    expect(
      screen.getByText("Portal content").parentElement?.getAttribute("aria-hidden"),
    ).toBe("true")
  })

  it("conceals protected content at the local deadline while offline", async () => {
    vi.useFakeTimers()
    const now = new Date("2026-08-15T10:00:00.000Z").getTime()
    vi.setSystemTime(now)
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    })
    authMocks.useSession.mockReturnValue({
      data: {
        user: { id: "user-1", role: "SUPER_ADMIN" },
        expires: new Date(now + 1_000).toISOString(),
        idleTimeoutMinutes: 15,
      },
      status: "authenticated",
    })

    render(
      <SessionGuard>
        <div>Highly sensitive content</div>
      </SessionGuard>,
    )

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000)
    })

    expect(screen.getByRole("alert").textContent).toContain("Session locked")
    expect(
      screen
        .getByText("Highly sensitive content")
        .parentElement?.getAttribute("aria-hidden"),
    ).toBe("true")
    expect(coordinationMocks.securelySignOut).not.toHaveBeenCalled()

    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: true,
    })
  })
})
