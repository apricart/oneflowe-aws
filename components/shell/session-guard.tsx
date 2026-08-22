"use client"

import { useSession } from "next-auth/react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  probeSessionWithRetry,
  renewSessionActivity,
  type SessionPayload,
  type SessionProbeResult,
} from "@/lib/session-probe"
import {
  SESSION_ACTIVITY_SYNC_INTERVAL_MS,
  SESSION_IDLE_TIMEOUT_MINUTES_MAX,
  SESSION_IDLE_TIMEOUT_MINUTES_MIN,
} from "@/lib/session-policy"
import {
  isSessionSignOutInProgress,
  reloadAfterSessionRecovery,
  securelySignOut,
  subscribeToSessionSignOut,
  withSessionMutationLock,
} from "@/lib/session-coordination"

export { MANUAL_SIGN_OUT_EVENT } from "@/lib/session-coordination"

const SESSION_POLL_INTERVAL_MS = 120_000
const MIN_ACTIVITY_SYNC_INTERVAL_MS = 10_000

type ConnectivityState = "healthy" | "retrying" | "offline"
type SessionCheckTrigger =
  | "poll"
  | "focus"
  | "online"
  | "status-change"
  | "deadline"

/**
 * Content stays concealed either way; only the wording differs. A deliberate
 * sign-out is not an expired deadline, and saying so was alarming users during
 * an ordinary logout.
 */
function sessionLockNotice(isSigningOut: boolean): { title: string; description: string } {
  if (isSigningOut) {
    return {
      title: "Signing you out",
      description: "Ending your session securely. You will be redirected in a moment.",
    }
  }

  return {
    title: "Session locked",
    description:
      "Your session deadline was reached. We are securely verifying whether it was renewed in another tab.",
  }
}

function parsedSessionDeadline(payload: SessionPayload | null | undefined): number | null {
  if (typeof payload?.expires !== "string") return null
  const parsed = Date.parse(payload.expires)
  return Number.isFinite(parsed) ? parsed : null
}

function activitySyncInterval(payload: SessionPayload | null | undefined): number {
  const timeoutMinutes = payload?.idleTimeoutMinutes
  if (
    typeof timeoutMinutes !== "number" ||
    !Number.isInteger(timeoutMinutes) ||
    timeoutMinutes < SESSION_IDLE_TIMEOUT_MINUTES_MIN ||
    timeoutMinutes > SESSION_IDLE_TIMEOUT_MINUTES_MAX
  ) {
    return SESSION_ACTIVITY_SYNC_INTERVAL_MS
  }

  return Math.min(
    SESSION_ACTIVITY_SYNC_INTERVAL_MS,
    Math.max(
      MIN_ACTIVITY_SYNC_INTERVAL_MS,
      Math.floor((timeoutMinutes * 60_000) / 3),
    ),
  )
}

/**
 * Monitors and renews the signed idle deadline without treating health polls,
 * focus changes, SWR traffic, or background requests as user activity.
 *
 * Authorization remains server-owned. At a locally known deadline the guard
 * immediately conceals the protected UI—even while offline—then asks the
 * server whether another tab renewed the shared browser session.
 */
export function SessionGuard({ children }: Readonly<{ children: React.ReactNode }>) {
  const { data: session, status } = useSession()
  const [connectivity, setConnectivity] =
    useState<ConnectivityState>("healthy")
  const [sessionDeadline, setSessionDeadline] = useState<number | null>(null)
  // Lock only on a definitive answer. "loading" is the brief phase every full
  // page load starts in — including the redirect straight after sign-in — and
  // treating it as locked flashed a false "session deadline reached" panel
  // before the provider had resolved. The server already gated this render, and
  // the unauthenticated, deadline, and poll paths below still lock normally.
  const [isSessionLocked, setIsSessionLocked] = useState(
    status === "unauthenticated",
  )
  const [isSigningOut, setIsSigningOut] = useState(false)

  const statusRef = useRef(status)
  const isMountedRef = useRef(true)
  const isLoggingOutRef = useRef(false)
  const inFlightCheckRef = useRef<Promise<void> | null>(null)
  const checkControllerRef = useRef<AbortController | null>(null)
  const activityControllerRef = useRef<AbortController | null>(null)
  const activityInFlightRef = useRef<Promise<void> | null>(null)
  const activityTimerRef = useRef<number | null>(null)
  const deadlineTimerRef = useRef<number | null>(null)
  const pendingActivityRef = useRef(false)
  const activityQueuedDuringFlightRef = useRef(false)
  const lastActivitySyncAtRef = useRef(0)
  const activitySyncIntervalRef = useRef(SESSION_ACTIVITY_SYNC_INTERVAL_MS)
  const sessionDeadlineRef = useRef<number | null>(null)

  const setConnectivityIfMounted = useCallback(
    (nextState: ConnectivityState) => {
      if (isMountedRef.current) setConnectivity(nextState)
    },
    [],
  )

  const applySessionPayload = useCallback((payload: SessionPayload) => {
    const deadline = parsedSessionDeadline(payload)
    activitySyncIntervalRef.current = activitySyncInterval(payload)

    if (deadline === null) return
    sessionDeadlineRef.current = deadline
    if (isMountedRef.current) {
      setSessionDeadline(deadline)
      if (deadline > Date.now()) setIsSessionLocked(false)
    }
  }, [])

  useEffect(() => {
    statusRef.current = status
    if (status === "authenticated" && session?.user) {
      setConnectivity("healthy")
      applySessionPayload(session as SessionPayload)
    } else if (status === "unauthenticated" && !isLoggingOutRef.current) {
      setIsSessionLocked(true)
    }
  }, [applySessionPayload, session, status])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      checkControllerRef.current?.abort()
      activityControllerRef.current?.abort()
      if (activityTimerRef.current !== null) {
        window.clearTimeout(activityTimerRef.current)
      }
      if (deadlineTimerRef.current !== null) {
        window.clearTimeout(deadlineTimerRef.current)
      }
    }
  }, [])

  const clearClientContext = useCallback(() => {
    try {
      localStorage.removeItem("theme")
      localStorage.removeItem("ctx.organizationId")
      localStorage.removeItem("ctx.branchId")
    } catch {
      // Storage can be unavailable in privacy-restricted browser contexts.
    }
  }, [])

  const handleDefinitiveInvalidSession = useCallback(async () => {
    if (isLoggingOutRef.current) return

    isLoggingOutRef.current = true
    if (isMountedRef.current) setIsSessionLocked(true)
    checkControllerRef.current?.abort()
    activityControllerRef.current?.abort()
    clearClientContext()

    try {
      await securelySignOut({ callbackUrl: "/login?reason=session-expired" })
    } catch (error) {
      // Do not claim logout or clear the local lock screen until the server-side
      // registry confirms revocation. The next poll/online event can retry.
      console.error("[SessionGuard] Secure sign-out request failed:", error)
      isLoggingOutRef.current = false
      setConnectivityIfMounted("retrying")
    }
  }, [clearClientContext, setConnectivityIfMounted])

  const runSessionCheck = useCallback(
    (trigger: SessionCheckTrigger) => {
      if (isLoggingOutRef.current) return Promise.resolve()
      if (inFlightCheckRef.current) return inFlightCheckRef.current

      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setConnectivityIfMounted("offline")
        if (trigger === "deadline" && isMountedRef.current) {
          setIsSessionLocked(true)
        }
        return Promise.resolve()
      }

      const controller = new AbortController()
      checkControllerRef.current = controller

      const check = (async () => {
        const result = await probeSessionWithRetry({
          signal: controller.signal,
          onRetry: () => setConnectivityIfMounted("retrying"),
        })

        if (result.kind === "cancelled") return

        if (result.kind === "authenticated") {
          setConnectivityIfMounted("healthy")

          // NextAuth v4 getSession() cannot update its own provider in the same
          // document. A rare false-unauthenticated recovery therefore reloads
          // through the server boundary after raw validation proves the cookie.
          if (statusRef.current === "unauthenticated") {
            if (isMountedRef.current) setIsSessionLocked(true)
            reloadAfterSessionRecovery()
            return
          }
          applySessionPayload(result.session)
          return
        }

        if (result.kind === "invalid") {
          await handleDefinitiveInvalidSession()
          return
        }

        logIndeterminateSessionCheck(trigger, result)
        setConnectivityIfMounted(
          typeof navigator !== "undefined" && navigator.onLine === false
            ? "offline"
            : "retrying",
        )
      })()

      inFlightCheckRef.current = check
      void check.finally(() => {
        if (inFlightCheckRef.current === check) {
          inFlightCheckRef.current = null
        }
        if (checkControllerRef.current === controller) {
          checkControllerRef.current = null
        }
      })

      return check
    },
    [
      applySessionPayload,
      handleDefinitiveInvalidSession,
      setConnectivityIfMounted,
    ],
  )

  const runActivitySync = useCallback(() => {
    if (
      isLoggingOutRef.current ||
      statusRef.current !== "authenticated" ||
      activityInFlightRef.current ||
      !pendingActivityRef.current
    ) {
      return activityInFlightRef.current ?? Promise.resolve()
    }

    if (
      sessionDeadlineRef.current !== null &&
      Date.now() >= sessionDeadlineRef.current
    ) {
      if (isMountedRef.current) setIsSessionLocked(true)
      return runSessionCheck("deadline")
    }

    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setConnectivityIfMounted("offline")
      return Promise.resolve()
    }

    pendingActivityRef.current = false
    activityQueuedDuringFlightRef.current = false
    const controller = new AbortController()
    activityControllerRef.current = controller

    const sync = (async () => {
      let result: SessionProbeResult
      try {
        result = await withSessionMutationLock(async () => {
          if (isSessionSignOutInProgress()) return { kind: "cancelled" }
          return renewSessionActivity({ signal: controller.signal })
        }, controller.signal)
      } catch {
        result = controller.signal.aborted
          ? { kind: "cancelled" }
          : { kind: "indeterminate", reason: "network" }
      }

      if (result.kind === "authenticated") {
        lastActivitySyncAtRef.current = Date.now()
        applySessionPayload(result.session)
        setConnectivityIfMounted("healthy")
        return
      }

      if (result.kind === "invalid") {
        await handleDefinitiveInvalidSession()
        return
      }

      if (!isLoggingOutRef.current && isMountedRef.current) {
        // A failed transport never counts as renewal. Keep the activity dirty
        // so the next genuine event can retry without extending locally.
        pendingActivityRef.current = true
      }

      if (result.kind === "indeterminate") {
        logIndeterminateSessionCheck("activity", result)
        setConnectivityIfMounted(
          typeof navigator !== "undefined" && navigator.onLine === false
            ? "offline"
            : "retrying",
        )
      }
    })()

    activityInFlightRef.current = sync
    void sync.finally(() => {
      if (activityInFlightRef.current === sync) {
        activityInFlightRef.current = null
      }
      if (activityControllerRef.current === controller) {
        activityControllerRef.current = null
      }
      if (
        activityQueuedDuringFlightRef.current &&
        pendingActivityRef.current &&
        !isLoggingOutRef.current &&
        statusRef.current === "authenticated" &&
        activityTimerRef.current === null
      ) {
        activityQueuedDuringFlightRef.current = false
        // This is a distinct interaction that arrived after the request began.
        // Drain it promptly so server time does not overstate when activity
        // occurred; at most one trailing request is queued per in-flight sync.
        const delay = 0
        activityTimerRef.current = window.setTimeout(() => {
          activityTimerRef.current = null
          void runActivitySync()
        }, delay)
      }
    })

    return sync
  }, [
    applySessionPayload,
    handleDefinitiveInvalidSession,
    runSessionCheck,
    setConnectivityIfMounted,
  ])

  const scheduleActivitySync = useCallback(() => {
    if (isLoggingOutRef.current || statusRef.current !== "authenticated") return

    pendingActivityRef.current = true
    if (activityInFlightRef.current) {
      activityQueuedDuringFlightRef.current = true
      return
    }
    if (activityTimerRef.current !== null) return

    const elapsed = Date.now() - lastActivitySyncAtRef.current
    const delay = Math.max(0, activitySyncIntervalRef.current - elapsed)
    activityTimerRef.current = window.setTimeout(() => {
      activityTimerRef.current = null
      void runActivitySync()
    }, delay)
  }, [runActivitySync])

  // A manual logout already owns its redirect. Mark it before NextAuth
  // broadcasts the null session so this guard cannot issue a duplicate request.
  useEffect(() =>
    subscribeToSessionSignOut({
      onStart: () => {
        isLoggingOutRef.current = true
        setIsSessionLocked(true)
        setIsSigningOut(true)
        checkControllerRef.current?.abort()
        activityControllerRef.current?.abort()
      },
      onCancelled: () => {
        isLoggingOutRef.current = false
        setIsSigningOut(false)
        // Keep sensitive content concealed until the server proves that the
        // shared browser session is still live. A failed logout must never
        // make a previously locked tree visible on client state alone.
        void runSessionCheck("status-change")
      },
      onCompleted: (callbackUrl) => {
        isLoggingOutRef.current = true
        clearClientContext()
        window.location.assign(callbackUrl)
      },
    }),
  [clearClientContext, runSessionCheck])

  // If some other NextAuth consumer publishes `unauthenticated`, verify it
  // independently before redirecting. This covers cross-tab sign-out while
  // remaining safe when the transition came from a failed network request.
  useEffect(() => {
    if (status === "unauthenticated" && !isLoggingOutRef.current) {
      void runSessionCheck("status-change")
    }
  }, [runSessionCheck, status])

  // Lock at the effective server deadline. A fresh validation can unlock the
  // same mounted tree when another tab legitimately renewed the shared cookie.
  useEffect(() => {
    if (deadlineTimerRef.current !== null) {
      window.clearTimeout(deadlineTimerRef.current)
      deadlineTimerRef.current = null
    }

    if (status !== "authenticated" || sessionDeadline === null) return

    const lockAndValidate = () => {
      if (isMountedRef.current) setIsSessionLocked(true)
      void runSessionCheck("deadline")
    }
    const remaining = sessionDeadline - Date.now()
    if (remaining <= 0) {
      lockAndValidate()
      return
    }

    deadlineTimerRef.current = window.setTimeout(lockAndValidate, remaining)
    return () => {
      if (deadlineTimerRef.current !== null) {
        window.clearTimeout(deadlineTimerRef.current)
        deadlineTimerRef.current = null
      }
    }
  }, [runSessionCheck, sessionDeadline, status])

  // Only explicit interaction renews the idle deadline. Visibility/focus and
  // background network traffic are intentionally excluded.
  useEffect(() => {
    if (status !== "authenticated") return

    const activityEvents: Array<keyof WindowEventMap> = [
      "keydown",
      "pointerdown",
      "scroll",
      "touchstart",
      "wheel",
    ]
    const handleActivity = () => scheduleActivitySync()

    for (const eventName of activityEvents) {
      window.addEventListener(eventName, handleActivity, { passive: true })
    }

    return () => {
      for (const eventName of activityEvents) {
        window.removeEventListener(eventName, handleActivity)
      }
      if (activityTimerRef.current !== null) {
        window.clearTimeout(activityTimerRef.current)
        activityTimerRef.current = null
      }
    }
  }, [scheduleActivitySync, status])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void runSessionCheck("poll")
    }, SESSION_POLL_INTERVAL_MS)

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        if (
          sessionDeadlineRef.current !== null &&
          Date.now() >= sessionDeadlineRef.current &&
          isMountedRef.current
        ) {
          setIsSessionLocked(true)
        }
        void runSessionCheck("focus")
      }
    }

    const handleOnline = () => {
      void runSessionCheck("online")
    }

    const handleOffline = () => {
      checkControllerRef.current?.abort()
      activityControllerRef.current?.abort()
      if (
        sessionDeadlineRef.current !== null &&
        Date.now() >= sessionDeadlineRef.current &&
        isMountedRef.current
      ) {
        setIsSessionLocked(true)
      }
      setConnectivityIfMounted("offline")
    }

    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("online", handleOnline)
    window.addEventListener("offline", handleOffline)

    return () => {
      window.clearInterval(intervalId)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("online", handleOnline)
      window.removeEventListener("offline", handleOffline)
    }
  }, [runSessionCheck, setConnectivityIfMounted])

  const lockNotice = sessionLockNotice(isSigningOut)

  return (
    <>
      {isSessionLocked && (
        <div
          role="alert"
          aria-live="assertive"
          className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-950 px-6 text-center text-white"
        >
          <div className="max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
            <p className="text-lg font-semibold">{lockNotice.title}</p>
            <p className="mt-2 text-sm text-slate-300">{lockNotice.description}</p>
          </div>
        </div>
      )}
      {connectivity !== "healthy" && !isSessionLocked && (
        <div
          role="status"
          aria-live="polite"
          className="fixed left-1/2 top-3 z-[100] max-w-[calc(100vw-2rem)] -translate-x-1/2 rounded-full border border-amber-300 bg-amber-50 px-4 py-2 text-center text-sm font-medium text-amber-950 shadow-lg dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100"
        >
          {connectivity === "offline"
            ? "You are offline. Your work remains open; session checks will resume when the connection returns."
            : "Connection interrupted. Your work remains open while we retry the session check."}
        </div>
      )}
      <div
        aria-hidden={isSessionLocked ? "true" : undefined}
        className={
          isSessionLocked
            ? "invisible pointer-events-none select-none"
            : "contents"
        }
      >
        {children}
      </div>
    </>
  )
}

function logIndeterminateSessionCheck(
  trigger: string,
  result: Extract<SessionProbeResult, { kind: "indeterminate" }>,
) {
  console.warn("[SessionGuard] Session check was inconclusive; keeping session", {
    trigger,
    reason: result.reason,
    status: result.status,
  })
}
