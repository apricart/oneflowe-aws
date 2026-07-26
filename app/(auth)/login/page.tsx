"use client"
import { useState, useEffect, Suspense } from "react"
import type React from "react"

import { useRouter, useSearchParams } from "next/navigation"
import { signIn, getSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent, CardFooter } from "@/components/ui/card"
import { Spinner } from "@/components/ui/skeleton"
import { MFAVerificationDialog } from "@/components/mfa/mfa-verification-dialog"
import { useToast } from "@/hooks/use-toast"
import Image from "next/image"
import { Eye, EyeOff } from "lucide-react"
import { safeInternalRedirectPath } from "@/lib/security"

/**
 * Clear stale NextAuth session cookies to prevent "Invalid URL" errors.
 * After a password/email change the old JWT becomes invalid, but if the cookie
 * still exists NextAuth internals may call `new URL(undefined)` and crash.
 */
function clearAuthCookies() {
  try {
    const cookieNames = [
      "next-auth.session-token",
      "__Secure-next-auth.session-token",
      "next-auth.csrf-token",
      "__Host-next-auth.csrf-token",
      "next-auth.callback-url",
      "__Secure-next-auth.callback-url",
    ]
    cookieNames.forEach((name) => {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/`
      // Also clear with domain variations for Vercel
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; secure`
    })
  } catch (_) {
    // Cookie access may fail in some contexts — safe to ignore
  }
}


/**
 * Detect NextAuth client URL constructor errors.
 * These happen when `signIn()` receives a response that does not include the
 * `url` field expected by next-auth/react.
 */
function isUrlConstructorError(err: any): boolean {
  const msg = String(err?.message || err || "").toLowerCase()
  return msg.includes("url") && (msg.includes("invalid") || msg.includes("undefined") || msg.includes("failed to construct"))
}

const LOGIN_RESPONSE_ERROR = "We couldn't complete sign in. Please try again."
const LOGIN_CONFIRMATION_ERROR = "We couldn't confirm your sign in. Please try again."

async function signInWithRetry(providerId: "credentials" | "employee-credentials", username: string, password: string) {
  try {
    return await signIn(providerId, { redirect: false, username, password })
  } catch (err: any) {
    if (!isUrlConstructorError(err)) throw err

    console.warn("[Login] Invalid NextAuth sign-in response. Clearing stale auth state and retrying once:", err?.message)
    clearAuthCookies()
    return signIn(providerId, { redirect: false, username, password })
  }
}

function getLoginErrorMessage(errorCode: string) {
  if (errorCode === "CredentialsSignin") {
    return "Invalid credentials. Please check your username/email and password."
  }
  if (errorCode === "ORGANIZATION_INACTIVE") {
    return "Company has been de-activated by the Admin."
  }
  if (errorCode === "BRANCH_INACTIVE") {
    return "Branch has been de-activated by the Admin."
  }
  if (errorCode === "USER_INACTIVE") {
    return "Your account has been deactivated. Please contact support."
  }
  if (errorCode === "AUTH_DATABASE_ERROR") {
    return "We couldn't reach the authentication service. Please try again or contact support."
  }
  return errorCode
}

function LoginForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const { toast } = useToast()
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [mfaRequired, setMfaRequired] = useState(false)
  const [isEmployee, setIsEmployee] = useState(false)
  const [pendingUser, setPendingUser] = useState<{ username: string; password: string } | null>(null)
  const [isProcessingMFA, setIsProcessingMFA] = useState(false)

  // Clear theme, app context, and stale client auth cookies on mount. Avoid a
  // background signOut here because it can race with a quick login attempt.
  useEffect(() => {
    localStorage.removeItem("theme")
    localStorage.removeItem("ctx.organizationId")
    localStorage.removeItem("ctx.branchId")

    document.documentElement.classList.remove("dark")
    document.documentElement.style.colorScheme = "light"

    clearAuthCookies()

  }, [])

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError(null)
    setMfaRequired(false)
    setIsEmployee(false)
    setPendingUser(null)

    try {
      // Clear cookies again before sign-in to guarantee a clean state
      clearAuthCookies()

      let result = await signInWithRetry("credentials", username, password)

      if (result?.error) {
        if (result.error === "MFA_REQUIRED") {
          console.log("Login: MFA required for", username)
          setPendingUser({ username, password })
          setMfaRequired(true)
          setIsEmployee(false)
          return
        }

        if (result.error !== "CredentialsSignin") {
          throw new Error(getLoginErrorMessage(result.error))
        }

        // Try employee login fallback only for true credential misses
        console.log("Standard login failed with CredentialsSignin, trying employee login fallback...")
        result = await signInWithRetry("employee-credentials", username, password)

        if (result?.error) {
          console.log(result.error, "resuult error login")
          if (result.error === "MFA_REQUIRED") {
            console.log("Login: MFA required for employee", username)
            setPendingUser({ username, password })
            setMfaRequired(true)
            setIsEmployee(true)
            return
          }
          throw new Error(getLoginErrorMessage(result.error))
        }
      }

      // Fetch session to determine redirect target
      const session = await getSession()
      if (!session?.user) {
        throw new Error(LOGIN_CONFIRMATION_ERROR)
      }

      const userRole = (session?.user as any)?.role
      const mustChangePassword = (session?.user as any)?.mustChangePassword === true

      if (mustChangePassword) {
        window.location.replace("/change-password")
      } else if (userRole === "ORDER_PORTAL" || userRole === "EMPLOYEE") {
        window.location.replace("/shop")
      } else {
        const cb = searchParams.get("callbackUrl")
        const targetUrl = safeInternalRedirectPath(cb)
        window.location.replace(targetUrl)
      }
    } catch (err: any) {
      // Catch malformed NextAuth responses without showing a misleading session-expired message on the login page.
      if (isUrlConstructorError(err)) {
        console.warn("[Login] Invalid NextAuth sign-in response after retry:", err?.message)
        clearAuthCookies()
        setError(LOGIN_RESPONSE_ERROR)
      } else {
        setError(err.message || "An error occurred during login")
      }
    } finally {
      setLoading(false)
    }
  }

  const handleMFASuccess = async () => {
    setIsProcessingMFA(true)
    setMfaRequired(false)
    setIsEmployee(false)
    setPendingUser(null)

    try {
      const session = await getSession()
      if (!session?.user) {
        throw new Error(LOGIN_CONFIRMATION_ERROR)
      }

      const userRole = (session?.user as any)?.role
      const mustChangePassword = (session?.user as any)?.mustChangePassword === true

      if (mustChangePassword) {
        window.location.replace("/change-password")
      } else if (userRole === "ORDER_PORTAL" || userRole === "EMPLOYEE") {
        window.location.replace("/shop")
      } else {
        const cb = searchParams.get("callbackUrl")
        const targetUrl = safeInternalRedirectPath(cb)
        window.location.replace(targetUrl)
      }
    } catch (err: any) {
      if (isUrlConstructorError(err)) {
        clearAuthCookies()
        setError(LOGIN_CONFIRMATION_ERROR)
        setIsProcessingMFA(false)
      } else {
        setError(err.message || "An error occurred")
        setIsProcessingMFA(false)
      }
    }
  }

  const handleMFACancel = () => {
    setMfaRequired(false)
    setPendingUser(null)
    setIsProcessingMFA(false)
  }

  return (
    <>
  
      {/* Loading Overlay for MFA Processing */}
      {isProcessingMFA && (
        <div className="absolute inset-0 bg-black/60 flex items-center justify-center z-50 backdrop-blur-sm">
          <div className="bg-white rounded-lg p-6 max-w-sm mx-4 text-center shadow-2xl">
            <div className="w-12 h-12 border-4 border-blue-200 border-t-blue-600 rounded-full animate-spin mx-auto mb-4"></div>
            <h3 className="text-lg font-semibold text-slate-800 mb-2">Redirecting to Dashboard</h3>
            <p className="text-sm text-slate-600">Please wait while we prepare your workspace...</p>
          </div>
        </div>
      )}

      <Card className="w-full border-0 shadow-2xl bg-white/95 backdrop-blur-sm">
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="bg-white rounded-lg p-2 flex items-center justify-center border-2 shadow-lg" style={{ borderColor: "var(--color-brand-primary)" }}>
              <Image src="/logo-pos.png" alt="Apricart" width={32} height={32} />
            </div>
            <CardTitle className="text-pretty text-2xl font-semibold text-slate-800">
              Apricart OneFlowe
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4" suppressHydrationWarning>
            <div className="grid gap-2">
              <label htmlFor="username" className="text-sm font-medium text-slate-700">
                Username or Email
              </label>
              <Input
                id="username"
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                placeholder="Enter your username or email"
                className="bg-white/80 border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-blue-500"
                suppressHydrationWarning
              />
            </div>
            <div className="grid gap-2">
              <label htmlFor="password" className="text-sm font-medium text-slate-700">
                Password
              </label>
              <div className="relative">
                <Input
                  id="password"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                  className="bg-white/80 border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-blue-500 pr-10"
                  suppressHydrationWarning
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 focus:outline-none"
                  suppressHydrationWarning
                >
                  {showPassword ? (
                    <EyeOff className="h-4 w-4" />
                  ) : (
                    <Eye className="h-4 w-4" />
                  )}
                </button>
              </div>
            </div>
            {error && (
              <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                <p className="text-sm text-red-600 font-medium flex items-center gap-2">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="lucide lucide-alert-circle"><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></svg>
                  {error}
                </p>
              </div>
            )}
            <Button
              type="submit"
              disabled={loading || isProcessingMFA}
              className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-lg"
            >
              {loading ? (
                <span className="inline-flex items-center gap-2"><Spinner size={16} /> Signing in…</span>
              ) : isProcessingMFA ? (
                <span className="inline-flex items-center gap-2"><Spinner size={16} /> Redirecting…</span>
              ) : (
                "Sign In"
              )}
            </Button>
          </form>
        </CardContent>

      </Card>

      {/* MFA Verification Dialog */}
      {mfaRequired && pendingUser && (
        <MFAVerificationDialog
          open={mfaRequired}
          username={pendingUser.username}
          userPassword={pendingUser.password}
          isEmployee={isEmployee}
          onSuccess={handleMFASuccess}
          onClose={handleMFACancel}
          type="LOGIN"
        />
      )}
    </>
  )
}

export default function LoginPage() {
  return (
    <main className="min-h-[100svh] flex items-center justify-center relative overflow-hidden">
      {/* Background Image */}
      <div className="absolute inset-0 z-0">
        <Image
          src="/Background-Login.png"
          alt="Login Background"
          fill
          className="object-cover"
          priority
        />
        {/* Overlay for better text readability */}
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
      </div>

      {/* Content */}
      <div className="relative z-10 w-full max-w-md mx-4">
        <Suspense fallback={
          <Card className="w-full border-0 shadow-2xl bg-white/95 backdrop-blur-sm">
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="bg-white rounded-lg p-2 flex items-center justify-center border-2 shadow-lg" style={{ borderColor: "var(--color-brand-primary)" }}>
                  <Image src="/logo-pos.png" alt="Apricart" width={32} height={32} />
                </div>
                <CardTitle className="text-2xl font-semibold text-slate-800">
                  Loading...
                </CardTitle>
              </div>
            </CardHeader>
          </Card>
        }>
          <LoginForm />
        </Suspense>
      </div>
    </main>
  )
}
