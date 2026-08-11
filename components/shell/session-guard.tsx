"use client"

import { getSession, signOut, useSession } from "next-auth/react"
import { useCallback, useEffect, useRef, useState } from "react"
import {
  probeSessionWithRetry,
  type SessionProbeResult,
} from "@/lib/session-probe"

const SESSION_POLL_INTERVAL_MS = 120_000

export const MANUAL_SIGN_OUT_EVENT = "oneflowe:manual-sign-out"

type ConnectivityState = "healthy" | "retrying" | "offline"

/**
 * Monitors the session without allowing a transport failure to mutate the
 * NextAuth client session.
 *
 * Authorization remains server-owned: middleware and every protected API call
 * still validate the JWT, role, tenant, sessionVersion, and active statuses.
 * This guard only decides when the browser has enough evidence to redirect.
 */
export function SessionGuard({ children }: Readonly<{ children: React.ReactNode }>) {
  const { data: session, status } = useSession()
  const [connectivity, setConnectivity] =
    useState<ConnectivityState>("healthy")

  const statusRef = useRef(status)
  const isMountedRef = useRef(true)
  const isLoggingOutRef = useRef(false)
  const inFlightCheckRef = useRef<Promise<void> | null>(null)
  const checkControllerRef = useRef<AbortController | null>(null)

  useEffect(() => {
    statusRef.current = status
    if (status === "authenticated" && session?.user) {
      setConnectivity("healthy")
    }
  }, [session, status])

  useEffect(() => {
    isMountedRef.current = true
    return () => {
      isMountedRef.current = false
      checkControllerRef.current?.abort()
    }
  }, [])

  const setConnectivityIfMounted = useCallback(
    (nextState: ConnectivityState) => {
      if (isMountedRef.current) setConnectivity(nextState)
    },
    [],
  )

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
    clearClientContext()

    try {
      await signOut({
        redirect: true,
        callbackUrl: "/login",
      })
    } catch (error) {
      // The session endpoint already returned a definitive invalid response.
      // Preserve the security redirect even if the sign-out cleanup request is
      // interrupted between validation and navigation.
      console.error("[SessionGuard] Sign-out request failed:", error)
      window.location.replace("/login?reason=session-expired")
    }
  }, [clearClientContext])

  const runSessionCheck = useCallback(
    (trigger: "poll" | "focus" | "online" | "status-change") => {
      if (isLoggingOutRef.current) return Promise.resolve()
      if (inFlightCheckRef.current) return inFlightCheckRef.current

      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        setConnectivityIfMounted("offline")
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

          // This path is only needed when another NextAuth consumer previously
          // collapsed a transport error into `unauthenticated`. A successful
          // raw probe proves the cookie is still valid, so ask SessionProvider
          // to repopulate its client state without redirecting or unmounting.
          if (statusRef.current === "unauthenticated") {
            const refreshedSession = await getSession()
            if (!refreshedSession) {
              setConnectivityIfMounted("retrying")
            }
          }
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
      handleDefinitiveInvalidSession,
      setConnectivityIfMounted,
    ],
  )

  // A manual logout already owns its redirect. Mark it before NextAuth
  // broadcasts the null session so this guard cannot issue a duplicate request.
  useEffect(() => {
    const handleManualSignOut = () => {
      isLoggingOutRef.current = true
      checkControllerRef.current?.abort()
    }

    window.addEventListener(MANUAL_SIGN_OUT_EVENT, handleManualSignOut)
    return () =>
      window.removeEventListener(MANUAL_SIGN_OUT_EVENT, handleManualSignOut)
  }, [])

  // If some other NextAuth consumer publishes `unauthenticated`, verify it
  // independently before redirecting. This covers cross-tab sign-out while
  // remaining safe when the transition came from a failed network request.
  useEffect(() => {
    if (status === "unauthenticated" && !isLoggingOutRef.current) {
      void runSessionCheck("status-change")
    }
  }, [runSessionCheck, status])

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      void runSessionCheck("poll")
    }, SESSION_POLL_INTERVAL_MS)

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void runSessionCheck("focus")
      }
    }

    const handleOnline = () => {
      void runSessionCheck("online")
    }

    const handleOffline = () => {
      checkControllerRef.current?.abort()
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

  return (
    <>
      {connectivity !== "healthy" && (
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
      {children}
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
