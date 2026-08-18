"use client"

export const MANUAL_SIGN_OUT_EVENT = "oneflowe:manual-sign-out"

const SIGN_OUT_CANCELLED_EVENT = "oneflowe:sign-out-cancelled"
const SIGN_OUT_INTENT_KEY = "oneflowe.session.signout.intent"
const SIGN_OUT_COMPLETED_KEY = "oneflowe.session.signout.completed"
const SESSION_MUTATION_LOCK = "oneflowe.session.cookie-mutation"
const SIGN_OUT_INTENT_LEASE_MS = 45_000
const SIGN_OUT_REQUEST_TIMEOUT_MS = 20_000

let fallbackLockTail: Promise<void> = Promise.resolve()
let inProcessSignOutIntent: string | null = null

type SecureSignOutOptions = {
  callbackUrl: string
}

type SignOutSubscription = {
  onStart: () => void
  onCancelled?: () => void
  onCompleted?: (callbackUrl: string) => void
}

type SignOutIntent = {
  attemptId: string
  startedAt: number
}

function dispatchWindowEvent(name: string, detail?: unknown): void {
  if (typeof window === "undefined") return
  window.dispatchEvent(new CustomEvent(name, { detail }))
}

function writeStorage(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    // Privacy-restricted contexts still receive same-tab CustomEvents and use
    // the in-process fallback lock when the Web Locks API is unavailable.
  }
}

function readSignOutIntent(raw: string | null): SignOutIntent | null {
  if (!raw) return null

  try {
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      typeof (parsed as SignOutIntent).attemptId === "string" &&
      (parsed as SignOutIntent).attemptId.length > 0 &&
      Number.isFinite((parsed as SignOutIntent).startedAt) &&
      (parsed as SignOutIntent).startedAt > 0
    ) {
      return parsed as SignOutIntent
    }
  } catch {
    // Accept the previous timestamp-only format during a rolling deployment.
  }

  const legacyStartedAt = Number(raw)
  return Number.isFinite(legacyStartedAt) && legacyStartedAt > 0
    ? { attemptId: `legacy-${raw}`, startedAt: legacyStartedAt }
    : null
}

function createAttemptId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function beginSignOut(): string {
  const intent = JSON.stringify({
    attemptId: createAttemptId(),
    startedAt: Date.now(),
  } satisfies SignOutIntent)
  inProcessSignOutIntent = intent
  writeStorage(SIGN_OUT_INTENT_KEY, intent)
  dispatchWindowEvent(MANUAL_SIGN_OUT_EVENT, { intent })
  return intent
}

function clearSignOutIntentIfOwned(intent: string): boolean {
  try {
    const storedIntent = localStorage.getItem(SIGN_OUT_INTENT_KEY)
    if (storedIntent === intent) {
      localStorage.removeItem(SIGN_OUT_INTENT_KEY)
    } else if (storedIntent !== null || inProcessSignOutIntent !== intent) {
      return false
    }
  } catch {
    if (inProcessSignOutIntent !== intent) return false
  }
  if (inProcessSignOutIntent === intent) inProcessSignOutIntent = null
  return true
}

function cancelSignOut(intent: string): void {
  if (!clearSignOutIntentIfOwned(intent)) return
  dispatchWindowEvent(SIGN_OUT_CANCELLED_EVENT, { intent })
}

function completeSignOut(callbackUrl: string, intent: string): void {
  const attemptId = readSignOutIntent(intent)?.attemptId ?? "unknown"
  const payload = JSON.stringify({
    attemptId,
    callbackUrl,
    completedAt: Date.now(),
  })
  // Publish completion first so other tabs can distinguish the following
  // intent removal from a failed/cancelled logout.
  writeStorage(SIGN_OUT_COMPLETED_KEY, payload)
  clearSignOutIntentIfOwned(intent)
}

export function isSessionSignOutInProgress(): boolean {
  try {
    const raw = localStorage.getItem(SIGN_OUT_INTENT_KEY)
    if (raw === null) return false
    const startedAt = readSignOutIntent(raw)?.startedAt
    if (
      !startedAt ||
      Date.now() - startedAt > SIGN_OUT_INTENT_LEASE_MS
    ) {
      localStorage.removeItem(SIGN_OUT_INTENT_KEY)
      return false
    }
    return true
  } catch {
    return false
  }
}

export async function withSessionMutationLock<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError")

  if (typeof navigator !== "undefined" && navigator.locks?.request) {
    return navigator.locks.request(
      SESSION_MUTATION_LOCK,
      { mode: "exclusive", signal },
      task,
    )
  }

  const prior = fallbackLockTail.catch(() => undefined)
  const turn = prior.then(async () => {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError")
    return task()
  })
  // Preserve mutual exclusion even when the waiting caller aborts: the queued
  // turn remains in the chain, skips its task once reached, then releases the
  // following waiter. Rejection is consumed by the tail to keep it reusable.
  fallbackLockTail = turn.then(
    () => undefined,
    () => undefined,
  )

  if (!signal) return turn
  let abortWait!: () => void
  const aborted = new Promise<never>((_resolve, reject) => {
    abortWait = () => reject(new DOMException("Aborted", "AbortError"))
    signal.addEventListener("abort", abortWait, { once: true })
    if (signal.aborted) abortWait()
  })
  try {
    return await Promise.race([turn, aborted])
  } finally {
    signal.removeEventListener("abort", abortWait)
  }
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const payload: unknown = await response.json()
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Malformed authentication response")
  }
  return payload as Record<string, unknown>
}

async function performSecureSignOut(
  callbackUrl: string,
  signal: AbortSignal,
): Promise<string> {
  const csrfResponse = await fetch("/api/auth/csrf", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    signal,
  })
  if (!csrfResponse.ok) throw new Error("Unable to obtain logout CSRF token")

  const csrfPayload = await readJsonObject(csrfResponse)
  const csrfToken = csrfPayload.csrfToken
  if (typeof csrfToken !== "string" || csrfToken.length === 0) {
    throw new Error("Malformed logout CSRF token")
  }

  const response = await fetch("/api/auth/signout", {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      csrfToken,
      callbackUrl,
      json: "true",
    }),
    signal,
  })
  const payload = await readJsonObject(response)
  if (!response.ok) {
    throw new Error(
      typeof payload.error === "string"
        ? payload.error
        : "Secure logout failed",
    )
  }

  const candidate = typeof payload.url === "string" ? payload.url : callbackUrl
  return resolveSessionRedirect(
    candidate,
    callbackUrl,
    window.location.origin,
  )
}

export function resolveSessionRedirect(
  candidate: string,
  fallback: string,
  origin: string,
): string {
  const sameOriginPath = (value: string): string | null => {
    try {
      const redirect = new URL(value, origin)
      return redirect.origin === origin
        ? `${redirect.pathname}${redirect.search}${redirect.hash}`
        : null
    } catch {
      return null
    }
  }

  const safeFallback = sameOriginPath(fallback) ?? "/login"
  try {
    return sameOriginPath(candidate) ?? safeFallback
  } catch {
    return safeFallback
  }
}

export function reloadAfterSessionRecovery(): void {
  window.location.reload()
}

/**
 * Revoke the server-side session before clearing/navigating. The shared browser
 * lock prevents an older activity response in another tab from writing a valid
 * cookie after logout has completed.
 */
export async function securelySignOut({
  callbackUrl,
}: SecureSignOutOptions): Promise<void> {
  const intent = beginSignOut()
  const controller = new AbortController()
  const timeoutId = window.setTimeout(
    () => controller.abort(),
    SIGN_OUT_REQUEST_TIMEOUT_MS,
  )

  try {
    const redirectUrl = await withSessionMutationLock(
      () => performSecureSignOut(callbackUrl, controller.signal),
      controller.signal,
    )
    completeSignOut(redirectUrl, intent)
    window.location.assign(redirectUrl)
  } catch (error) {
    cancelSignOut(intent)
    throw error
  } finally {
    window.clearTimeout(timeoutId)
  }
}

export function subscribeToSessionSignOut({
  onStart,
  onCancelled,
  onCompleted,
}: SignOutSubscription): () => void {
  let leaseTimer: number | null = null
  let completedAttemptId: string | null = null
  const clearLeaseTimer = () => {
    if (leaseTimer !== null) window.clearTimeout(leaseTimer)
    leaseTimer = null
  }
  const scheduleLeaseExpiry = (rawValue: string | null) => {
    clearLeaseTimer()
    const intent = readSignOutIntent(rawValue)
    if (!rawValue || !intent) return

    const remaining = Math.max(
      0,
      intent.startedAt + SIGN_OUT_INTENT_LEASE_MS - Date.now(),
    )
    leaseTimer = window.setTimeout(() => {
      let current: string | null = null
      try {
        current = localStorage.getItem(SIGN_OUT_INTENT_KEY)
      } catch {
        // Treat inaccessible state as an expired best-effort browser intent.
      }
      leaseTimer = null
      if (
        current === rawValue ||
        (current === null && inProcessSignOutIntent === rawValue)
      ) {
        clearSignOutIntentIfOwned(rawValue)
        onCancelled?.()
      } else if (current) {
        scheduleLeaseExpiry(current)
      }
    }, remaining)
  }
  const start = (event?: Event) => {
    onStart()
    const eventIntent = (event as CustomEvent<{ intent?: unknown }> | undefined)
      ?.detail?.intent
    let rawValue = typeof eventIntent === "string" ? eventIntent : null
    try {
      rawValue ??= localStorage.getItem(SIGN_OUT_INTENT_KEY)
    } catch {
      // The bounded network timeout still cancels same-tab attempts.
    }
    scheduleLeaseExpiry(rawValue)
  }
  const cancelled = () => {
    clearLeaseTimer()
    onCancelled?.()
  }
  const storage = (event: StorageEvent) => {
    if (event.key === SIGN_OUT_INTENT_KEY) {
      if (event.newValue === null) {
        const removedAttemptId = readSignOutIntent(event.oldValue)?.attemptId
        if (removedAttemptId !== completedAttemptId) cancelled()
      }
      else {
        onStart()
        scheduleLeaseExpiry(event.newValue)
      }
      return
    }
    if (event.key !== SIGN_OUT_COMPLETED_KEY || !event.newValue) return

    try {
      const payload = JSON.parse(event.newValue) as {
        attemptId?: unknown
        callbackUrl?: unknown
      }
      completedAttemptId =
        typeof payload.attemptId === "string" ? payload.attemptId : null
      clearLeaseTimer()
      onCompleted?.(
        typeof payload.callbackUrl === "string"
          ? payload.callbackUrl
          : "/login",
      )
    } catch {
      completedAttemptId = null
      clearLeaseTimer()
      onCompleted?.("/login")
    }
  }

  window.addEventListener(MANUAL_SIGN_OUT_EVENT, start)
  window.addEventListener(SIGN_OUT_CANCELLED_EVENT, cancelled)
  window.addEventListener("storage", storage)
  if (isSessionSignOutInProgress()) start()

  return () => {
    clearLeaseTimer()
    window.removeEventListener(MANUAL_SIGN_OUT_EVENT, start)
    window.removeEventListener(SIGN_OUT_CANCELLED_EVENT, cancelled)
    window.removeEventListener("storage", storage)
  }
}
