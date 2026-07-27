export const SESSION_CHECK_PATH = "/api/auth/session"
export const SESSION_CHECK_ATTEMPTS = 3
export const SESSION_CHECK_BACKOFF_MS = 1_000
export const SESSION_CHECK_TIMEOUT_MS = 8_000

export type SessionPayload = {
  user?: Record<string, unknown> | null
  expires?: string
  [key: string]: unknown
}

export type SessionProbeResult =
  | { kind: "authenticated"; session: SessionPayload }
  | { kind: "invalid"; status?: number }
  | {
      kind: "indeterminate"
      reason: "network" | "timeout" | "http" | "malformed"
      status?: number
    }
  | { kind: "cancelled" }

type SessionFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>

type ProbeSessionOptions = {
  fetchImpl?: SessionFetch
  signal?: AbortSignal
  timeoutMs?: number
}

type ProbeSessionWithRetryOptions = ProbeSessionOptions & {
  attempts?: number
  baseDelayMs?: number
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<boolean>
  onRetry?: (
    result: Extract<SessionProbeResult, { kind: "indeterminate" }>,
    nextAttempt: number,
    delayMs: number,
  ) => void
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDefinitivelyEmptySession(value: unknown): boolean {
  return value === null || (isObject(value) && Object.keys(value).length === 0)
}

async function abortableSleep(
  delayMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false

  return new Promise((resolve) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener("abort", handleAbort)
      resolve(true)
    }, delayMs)

    const handleAbort = () => {
      clearTimeout(timeoutId)
      signal?.removeEventListener("abort", handleAbort)
      resolve(false)
    }

    signal?.addEventListener("abort", handleAbort, { once: true })
  })
}

/**
 * Fetches the raw NextAuth session response without mutating SessionProvider.
 *
 * This distinction is important: NextAuth v4 maps both an empty session and a
 * network error to `null`. The application must only sign out for a definitive
 * empty/401 response, never for a transport or server failure.
 */
export async function probeSession({
  fetchImpl = globalThis.fetch,
  signal,
  timeoutMs = SESSION_CHECK_TIMEOUT_MS,
}: ProbeSessionOptions = {}): Promise<SessionProbeResult> {
  if (signal?.aborted) return { kind: "cancelled" }

  const controller = new AbortController()
  let timedOut = false

  const handleExternalAbort = () => controller.abort()
  signal?.addEventListener("abort", handleExternalAbort, { once: true })

  const timeoutId = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const response = await fetchImpl(SESSION_CHECK_PATH, {
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        Accept: "application/json",
      },
      signal: controller.signal,
    })

    // A 401 from the session endpoint definitively means there is no usable
    // session. Other non-2xx responses can be transient infrastructure errors.
    if (response.status === 401) {
      return { kind: "invalid", status: response.status }
    }

    if (!response.ok) {
      return {
        kind: "indeterminate",
        reason: "http",
        status: response.status,
      }
    }

    let payload: unknown
    try {
      payload = await response.json()
    } catch {
      return {
        kind: "indeterminate",
        reason: "malformed",
        status: response.status,
      }
    }

    if (isDefinitivelyEmptySession(payload)) {
      return { kind: "invalid", status: response.status }
    }

    if (isObject(payload) && isObject(payload.user)) {
      return {
        kind: "authenticated",
        session: payload as SessionPayload,
      }
    }

    // A non-empty but unexpected payload must not revoke a user session.
    return {
      kind: "indeterminate",
      reason: "malformed",
      status: response.status,
    }
  } catch {
    if (signal?.aborted) return { kind: "cancelled" }

    return {
      kind: "indeterminate",
      reason: timedOut ? "timeout" : "network",
    }
  } finally {
    clearTimeout(timeoutId)
    signal?.removeEventListener("abort", handleExternalAbort)
  }
}

export async function probeSessionWithRetry({
  attempts = SESSION_CHECK_ATTEMPTS,
  baseDelayMs = SESSION_CHECK_BACKOFF_MS,
  sleep = abortableSleep,
  onRetry,
  ...probeOptions
}: ProbeSessionWithRetryOptions = {}): Promise<SessionProbeResult> {
  const totalAttempts = Math.max(1, Math.floor(attempts))
  let lastResult: SessionProbeResult = {
    kind: "indeterminate",
    reason: "network",
  }

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const result = await probeSession(probeOptions)
    lastResult = result

    if (result.kind !== "indeterminate" || attempt === totalAttempts) {
      return result
    }

    const delayMs = baseDelayMs * 2 ** (attempt - 1)
    onRetry?.(result, attempt + 1, delayMs)

    const shouldContinue = await sleep(delayMs, probeOptions.signal)
    if (!shouldContinue) return { kind: "cancelled" }
  }

  return lastResult
}
