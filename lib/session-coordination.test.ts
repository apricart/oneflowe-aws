import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  isSessionSignOutInProgress,
  resolveSessionRedirect,
  securelySignOut,
  subscribeToSessionSignOut,
  withSessionMutationLock,
} from "@/lib/session-coordination"

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("browser session mutation coordination", () => {
  beforeEach(() => {
    localStorage.clear()
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: undefined,
    })
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    localStorage.clear()
  })

  it("serializes the fallback lock and releases it after rejection", async () => {
    const releaseFirst = deferred<void>()
    const order: string[] = []
    const first = withSessionMutationLock(async () => {
      order.push("first-start")
      await releaseFirst.promise
      order.push("first-end")
    })
    await vi.waitFor(() => expect(order).toEqual(["first-start"]))

    const second = withSessionMutationLock(async () => {
      order.push("second")
    })
    await Promise.resolve()
    expect(order).toEqual(["first-start"])

    releaseFirst.resolve()
    await Promise.all([first, second])
    expect(order).toEqual(["first-start", "first-end", "second"])

    await expect(
      withSessionMutationLock(async () => {
        throw new Error("expected")
      }),
    ).rejects.toThrow("expected")
    await expect(withSessionMutationLock(async () => "released")).resolves.toBe(
      "released",
    )
  })

  it("uses the named Web Lock and propagates results, errors, and aborts", async () => {
    const request = vi.fn(
      async (
        _name: string,
        _options: LockOptions,
        task: () => Promise<unknown>,
      ) => task(),
    )
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: { request },
    })
    const controller = new AbortController()

    await expect(
      withSessionMutationLock(async () => "locked", controller.signal),
    ).resolves.toBe("locked")
    expect(request).toHaveBeenCalledWith(
      "oneflowe.session.cookie-mutation",
      { mode: "exclusive", signal: controller.signal },
      expect.any(Function),
    )

    await expect(
      withSessionMutationLock(async () => {
        throw new Error("task failed")
      }),
    ).rejects.toThrow("task failed")

    request.mockImplementationOnce(
      async (_name: string, options: LockOptions) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"))
          })
        }),
    )
    const pendingController = new AbortController()
    const pending = withSessionMutationLock(
      async () => "never",
      pendingController.signal,
    )
    pendingController.abort()
    await expect(pending).rejects.toMatchObject({ name: "AbortError" })
  })

  it("expires and clears a stale cross-tab sign-out lease", async () => {
    vi.useFakeTimers()
    const now = 2_000_000_000_000
    vi.setSystemTime(now)
    localStorage.setItem(
      "oneflowe.session.signout.intent",
      JSON.stringify({ attemptId: "attempt-1", startedAt: now }),
    )
    const onStart = vi.fn()
    const onCancelled = vi.fn()
    const unsubscribe = subscribeToSessionSignOut({ onStart, onCancelled })

    expect(onStart).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(45_000)

    expect(onCancelled).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("oneflowe.session.signout.intent")).toBeNull()
    expect(isSessionSignOutInProgress()).toBe(false)
    unsubscribe()
  })

  it("does not classify a completed cross-tab attempt as cancellation", () => {
    const intent = JSON.stringify({
      attemptId: "attempt-complete",
      startedAt: Date.now(),
    })
    const completion = JSON.stringify({
      attemptId: "attempt-complete",
      callbackUrl: "/login?done=1",
      completedAt: Date.now(),
    })
    const onStart = vi.fn()
    const onCancelled = vi.fn()
    const onCompleted = vi.fn()
    const unsubscribe = subscribeToSessionSignOut({
      onStart,
      onCancelled,
      onCompleted,
    })

    localStorage.setItem("oneflowe.session.signout.intent", intent)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "oneflowe.session.signout.intent",
        newValue: intent,
      }),
    )
    localStorage.setItem("oneflowe.session.signout.completed", completion)
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "oneflowe.session.signout.completed",
        newValue: completion,
      }),
    )
    localStorage.removeItem("oneflowe.session.signout.intent")
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: "oneflowe.session.signout.intent",
        oldValue: intent,
        newValue: null,
      }),
    )

    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onCompleted).toHaveBeenCalledWith("/login?done=1")
    expect(onCancelled).not.toHaveBeenCalled()
    unsubscribe()
  })

  it("cancels immediately after failure when browser storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("privacy mode")
    })
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("privacy mode")
    })
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("privacy mode")
    })
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(jsonResponse({ csrfToken: "csrf" }))
        .mockResolvedValueOnce(jsonResponse({ error: "unavailable" }, 503)),
    )
    const onStart = vi.fn()
    const onCancelled = vi.fn()
    const unsubscribe = subscribeToSessionSignOut({ onStart, onCancelled })

    await expect(
      securelySignOut({ callbackUrl: "/login" }),
    ).rejects.toThrow("unavailable")

    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onCancelled).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("an older failed attempt cannot erase a newer sign-out intent", async () => {
    const firstSignOut = deferred<Response>()
    const secondSignOut = deferred<Response>()
    let signOutCalls = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith("/csrf")) return jsonResponse({ csrfToken: "csrf" })
        signOutCalls += 1
        return signOutCalls === 1
          ? firstSignOut.promise
          : secondSignOut.promise
      }),
    )

    const first = securelySignOut({ callbackUrl: "/login" }).then(
      () => null,
      (error: unknown) => error,
    )
    const second = securelySignOut({ callbackUrl: "/login" }).then(
      () => null,
      (error: unknown) => error,
    )
    await vi.waitFor(() => expect(signOutCalls).toBe(1))

    firstSignOut.resolve(jsonResponse({ error: "first failed" }, 503))
    await expect(first).resolves.toBeInstanceOf(Error)
    expect(localStorage.getItem("oneflowe.session.signout.intent")).not.toBeNull()

    await vi.waitFor(() => expect(signOutCalls).toBe(2))
    secondSignOut.resolve(jsonResponse({ error: "second failed" }, 503))
    await expect(second).resolves.toBeInstanceOf(Error)
    expect(localStorage.getItem("oneflowe.session.signout.intent")).toBeNull()
  })

  it("aborts a hung sign-out after 20 seconds and releases its intent", async () => {
    vi.useFakeTimers()
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (fetchMock.mock.calls.length === 1) {
          return jsonResponse({ csrfToken: "csrf" })
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"))
          })
        })
      },
    )
    vi.stubGlobal("fetch", fetchMock)
    const onStart = vi.fn()
    const onCancelled = vi.fn()
    const unsubscribe = subscribeToSessionSignOut({ onStart, onCancelled })
    const result = securelySignOut({ callbackUrl: "/login" }).then(
      () => null,
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(20_000)

    await expect(result).resolves.toMatchObject({ name: "AbortError" })
    expect(localStorage.getItem("oneflowe.session.signout.intent")).toBeNull()
    expect(onStart).toHaveBeenCalledTimes(1)
    expect(onCancelled).toHaveBeenCalledTimes(1)
    await expect(withSessionMutationLock(async () => "released")).resolves.toBe(
      "released",
    )
    unsubscribe()
  })

  it("aborts a sign-out queued behind a fallback lock without running it", async () => {
    vi.useFakeTimers()
    const releaseHolder = deferred<void>()
    const holder = withSessionMutationLock(async () => releaseHolder.promise)
    await vi.advanceTimersByTimeAsync(0)
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    const onCancelled = vi.fn()
    const unsubscribe = subscribeToSessionSignOut({
      onStart: vi.fn(),
      onCancelled,
    })
    const result = securelySignOut({ callbackUrl: "/login" }).then(
      () => null,
      (error: unknown) => error,
    )

    await vi.advanceTimersByTimeAsync(20_000)

    await expect(result).resolves.toMatchObject({ name: "AbortError" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onCancelled).toHaveBeenCalledTimes(1)
    expect(localStorage.getItem("oneflowe.session.signout.intent")).toBeNull()

    releaseHolder.resolve()
    await holder
    await expect(withSessionMutationLock(async () => "healthy")).resolves.toBe(
      "healthy",
    )
    unsubscribe()
  })

  it("rejects cross-origin and malformed logout redirects", () => {
    expect(
      resolveSessionRedirect(
        "https://evil.test/phish",
        "/login",
        "https://app.test",
      ),
    ).toBe("/login")
    expect(
      resolveSessionRedirect(
        "/login?reason=manual#done",
        "/fallback",
        "https://app.test",
      ),
    ).toBe("/login?reason=manual#done")
    expect(resolveSessionRedirect("http://[", "/login", "https://app.test")).toBe(
      "/login",
    )
    expect(
      resolveSessionRedirect(
        "https://evil.test/one",
        "https://evil.test/two",
        "https://app.test",
      ),
    ).toBe("/login")
  })
})
