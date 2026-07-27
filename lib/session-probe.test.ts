import { describe, expect, it, vi } from "vitest"

import {
  probeSession,
  probeSessionWithRetry,
  SESSION_CHECK_PATH,
} from "@/lib/session-probe"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  })
}

describe("session probe", () => {
  it("returns the authenticated session without changing role or tenant claims", async () => {
    const session = {
      user: {
        id: "user-1",
        role: "HEAD_OFFICE",
        organizationId: 17,
        branchId: null,
      },
      expires: "2026-07-28T12:00:00.000Z",
    }
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(session))

    const result = await probeSession({ fetchImpl })

    expect(result).toEqual({ kind: "authenticated", session })
    expect(fetchImpl).toHaveBeenCalledWith(
      SESSION_CHECK_PATH,
      expect.objectContaining({
        cache: "no-store",
        credentials: "same-origin",
      }),
    )
  })

  it("treats an empty successful response as a definitive invalid session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}))
    const sleep = vi.fn().mockResolvedValue(true)

    const result = await probeSessionWithRetry({ fetchImpl, sleep })

    expect(result).toEqual({ kind: "invalid", status: 200 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it("treats a 401 as definitive without retrying", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: "Unauthorized" }, 401))

    const result = await probeSessionWithRetry({ fetchImpl })

    expect(result).toEqual({ kind: "invalid", status: 401 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it("retries network failures with exponential backoff and never converts them to invalid", async () => {
    const fetchImpl = vi
      .fn()
      .mockRejectedValue(new TypeError("network disconnected"))
    const sleep = vi.fn().mockResolvedValue(true)
    const onRetry = vi.fn()

    const result = await probeSessionWithRetry({
      fetchImpl,
      sleep,
      onRetry,
    })

    expect(result).toEqual({
      kind: "indeterminate",
      reason: "network",
    })
    expect(fetchImpl).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenNthCalledWith(1, 1_000, undefined)
    expect(sleep).toHaveBeenNthCalledWith(2, 2_000, undefined)
    expect(onRetry).toHaveBeenCalledTimes(2)
  })

  it("recovers when a retry receives a valid role-scoped session", async () => {
    const session = {
      user: {
        id: "user-2",
        role: "BRANCH_ADMIN",
        organizationId: 21,
        branchId: 34,
      },
    }
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("temporary network failure"))
      .mockResolvedValueOnce(jsonResponse(session))
    const sleep = vi.fn().mockResolvedValue(true)

    const result = await probeSessionWithRetry({ fetchImpl, sleep })

    expect(result).toEqual({ kind: "authenticated", session })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it("keeps server and malformed responses indeterminate after retries", async () => {
    const serverFetch = vi.fn().mockResolvedValue(jsonResponse({}, 503))
    const malformedFetch = vi
      .fn()
      .mockResolvedValue(
        new Response("<html>upstream error</html>", { status: 200 }),
      )
    const sleep = vi.fn().mockResolvedValue(true)

    const serverResult = await probeSessionWithRetry({
      fetchImpl: serverFetch,
      sleep,
    })
    const malformedResult = await probeSessionWithRetry({
      fetchImpl: malformedFetch,
      sleep,
    })

    expect(serverResult).toEqual({
      kind: "indeterminate",
      reason: "http",
      status: 503,
    })
    expect(malformedResult).toEqual({
      kind: "indeterminate",
      reason: "malformed",
      status: 200,
    })
    expect(serverFetch).toHaveBeenCalledTimes(3)
    expect(malformedFetch).toHaveBeenCalledTimes(3)
  })
})
