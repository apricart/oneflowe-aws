"use client"
import { useEffect, useState } from "react"
import type React from "react"
import { useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Spinner } from "@/components/ui/skeleton"
import { OTPInput } from "@/components/mfa/otp-input"
import { useToast } from "@/hooks/use-toast"
import Image from "next/image"
import { Eye, EyeOff, MailCheck, ShieldAlert, ShieldCheck } from "lucide-react"
import { isEmailVerificationRequiredForPasswordChange } from "@/lib/password-change-policy"
import { securelySignOut } from "@/lib/session-coordination"

/**
 * Three steps, each enforced by the server regardless of what this page does:
 * a code goes to the address on the account, the code is entered back, and
 * only then is a new password accepted (`lib/server/password-change.ts`).
 *
 * While `lib/password-change-policy.ts` has the emailed code switched off the
 * page opens on the password step and never asks for a code. If the server
 * turns out to want one anyway (a 403 `EMAIL_VERIFICATION_REQUIRED`) the
 * page falls back to the send step, so the two can never strand anyone.
 */
type Step = "send" | "code" | "password"

function initialStep(): Step {
  return isEmailVerificationRequiredForPasswordChange() ? "send" : "password"
}

const EMAIL_UNROUTABLE_CODE = "EMAIL_UNROUTABLE"
const EMAIL_VERIFICATION_REQUIRED_CODE = "EMAIL_VERIFICATION_REQUIRED"
const RESEND_COOLDOWN_SECONDS = 60

async function postJson(path: string, body?: unknown): Promise<{ status: number; data: any }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

function ErrorBanner({ message }: Readonly<{ message: string }>) {
  return (
    <div className="p-3 bg-red-50 border border-red-200 rounded-md" role="alert">
      <p className="text-sm text-red-600 font-medium flex items-center gap-2">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></svg>
        {message}
      </p>
    </div>
  )
}

function PasswordField({
  id,
  label,
  value,
  onChange,
  placeholder,
  minLength,
  autoComplete,
}: Readonly<{
  id: string
  label: string
  value: string
  onChange: (value: string) => void
  placeholder: string
  minLength?: number
  autoComplete: string
}>) {
  const [show, setShow] = useState(false)
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={show ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          required
          minLength={minLength}
          autoComplete={autoComplete}
          placeholder={placeholder}
          className="bg-white/80 border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-blue-500 pr-10"
        />
        <button
          type="button"
          onClick={() => setShow(!show)}
          aria-label={show ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 focus:outline-none"
        >
          {show ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

export default function ChangePasswordPage() {
  const { status } = useSession()
  const { toast } = useToast()

  const [step, setStep] = useState<Step>(initialStep)
  const [emailVerified, setEmailVerified] = useState(false)
  const [emailHint, setEmailHint] = useState<string | null>(null)
  const [validForMinutes, setValidForMinutes] = useState<number | null>(null)
  const [unroutable, setUnroutable] = useState(false)
  const [code, setCode] = useState("")
  const [resendIn, setResendIn] = useState(0)

  const [currentPassword, setCurrentPassword] = useState("")
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")

  const [loading, setLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (resendIn <= 0) return
    const timer = setTimeout(() => setResendIn((seconds) => seconds - 1), 1000)
    return () => clearTimeout(timer)
  }, [resendIn])

  async function sendCode() {
    setFormError(null)
    setLoading(true)
    try {
      const { status: httpStatus, data } = await postJson("/api/v1/users/me/email-verification/send")
      if (httpStatus === 409 && data?.code === EMAIL_UNROUTABLE_CODE) {
        setEmailHint(data?.emailHint ?? null)
        setUnroutable(true)
        return
      }
      if (httpStatus === 429) {
        setResendIn(Number(data?.retryAfterSeconds) || RESEND_COOLDOWN_SECONDS)
        setFormError(data?.error || "Please wait before requesting another code.")
        return
      }
      if (httpStatus !== 200) {
        setFormError(data?.error || "Could not send the verification code. Please try again.")
        return
      }
      setEmailHint(data?.emailHint ?? null)
      setValidForMinutes(typeof data?.validForMinutes === "number" ? data.validForMinutes : null)
      setCode("")
      setResendIn(RESEND_COOLDOWN_SECONDS)
      setStep("code")
    } catch {
      setFormError("An unexpected error occurred. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function verifyCode(value: string) {
    if (loading || value.length !== 6) return
    setFormError(null)
    setLoading(true)
    try {
      const { status: httpStatus, data } = await postJson("/api/v1/users/me/email-verification/verify", { code: value })
      if (httpStatus === 401) {
        await securelySignOut({ callbackUrl: "/login?reason=session-expired" })
        return
      }
      if (httpStatus !== 200) {
        setCode("")
        setFormError(data?.error || "That code was not accepted. Please try again.")
        return
      }
      setEmailVerified(true)
      setStep("password")
    } catch {
      setFormError("An unexpected error occurred. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  async function submitPassword(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError(null)

    if (newPassword !== confirmPassword) {
      setFormError("Passwords do not match.")
      return
    }

    setLoading(true)
    try {
      const { status: httpStatus, data } = await postJson("/api/v1/users/me/change-password", {
        currentPassword,
        password: newPassword,
      })

      if (httpStatus === 403 && data?.code === EMAIL_VERIFICATION_REQUIRED_CODE) {
        // The proof expired or was spent — or the server requires one this
        // page did not ask for; either way, start from the code.
        setEmailVerified(false)
        setStep("send")
        setFormError(
          emailVerified
            ? "Your verification has expired. Please request a new code."
            : "Please verify your email address before setting a new password.",
        )
        return
      }
      if (httpStatus === 401) {
        await securelySignOut({ callbackUrl: "/login?reason=session-expired" })
        return
      }
      if (httpStatus !== 200) {
        setFormError(data?.error || "Failed to change password. Please try again.")
        return
      }

      toast({
        title: "Password changed",
        description: "Please sign in again with your new password.",
      })

      // Session is now invalid (sessionVersion bumped). Sign out cleanly.
      await securelySignOut({ callbackUrl: "/login" })
    } catch {
      setFormError("An unexpected error occurred. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  if (status === "loading") {
    return (
      <main className="min-h-[100svh] flex items-center justify-center">
        <Spinner size={32} />
      </main>
    )
  }

  const title = step === "password" ? "Set New Password" : "Verify Your Email"

  return (
    <main className="min-h-[100svh] flex items-center justify-center relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 z-0">
        <Image
          src="/Background-Login.png"
          alt="Background"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
      </div>

      <div className="relative z-10 w-full max-w-md mx-4">
        <Card className="w-full border-0 shadow-2xl bg-white/95 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className="bg-white rounded-lg p-2 flex items-center justify-center border-2 shadow-lg"
                style={{ borderColor: "var(--color-brand-primary)" }}
              >
                <Image src="/logo-pos.png" alt="Apricart" width={32} height={32} />
              </div>
              <CardTitle className="text-2xl font-semibold text-slate-800">
                {title}
              </CardTitle>
            </div>
          </CardHeader>

          <CardContent>
            {step !== "password" && (
              <div className="mb-5 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                <p className="text-sm text-amber-800 leading-relaxed">
                  Your account requires a new password before you can continue. To confirm it is you, we will first send a verification code to the email address on your account.
                </p>
              </div>
            )}

            {step === "send" && unroutable && (
              <div className="grid gap-4">
                <div className="flex items-start gap-3 rounded-md border border-red-200 bg-red-50 p-3" role="alert">
                  <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-red-600" />
                  <div className="text-sm text-red-800 leading-relaxed">
                    <p className="font-medium">No reachable email address on file{emailHint ? ` (${emailHint})` : ""}.</p>
                    <p className="mt-1">Your administrator must correct the email address on your account before you can set a new password. Please contact them, then sign in again.</p>
                  </div>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => securelySignOut({ callbackUrl: "/login" })}
                  className="w-full"
                >
                  Sign out
                </Button>
              </div>
            )}

            {step === "send" && !unroutable && (
              <div className="grid gap-4">
                <p className="text-sm text-slate-600 leading-relaxed">
                  The code is for this account only. If you hold more than one account on the same email address, each account receives its own code — the email says which account it is for.
                </p>
                {formError && <ErrorBanner message={formError} />}
                <Button
                  type="button"
                  onClick={sendCode}
                  disabled={loading || resendIn > 0}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-lg"
                >
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <Spinner size={16} /> Sending…
                    </span>
                  ) : resendIn > 0 ? (
                    `Send code (${resendIn}s)`
                  ) : (
                    "Send verification code"
                  )}
                </Button>
              </div>
            )}

            {step === "code" && (
              <div className="grid gap-4">
                <div className="flex items-start gap-3 rounded-md border border-blue-200 bg-blue-50 p-3">
                  <MailCheck className="mt-0.5 h-5 w-5 shrink-0 text-blue-600" />
                  <p className="text-sm text-blue-800 leading-relaxed">
                    A 6-digit code was sent to <span className="font-medium">{emailHint ?? "your email address"}</span>
                    {validForMinutes ? ` and is valid for ${validForMinutes} minutes` : ""}. Check that the email names this account before entering the code.
                  </p>
                </div>

                <div className="grid gap-2">
                  <span className="text-sm font-medium text-slate-700">Verification code</span>
                  <OTPInput
                    value={code}
                    onChange={(value) => {
                      setFormError(null)
                      setCode(value)
                    }}
                    onComplete={verifyCode}
                    disabled={loading}
                    error={Boolean(formError)}
                  />
                </div>

                {formError && <ErrorBanner message={formError} />}

                <Button
                  type="button"
                  onClick={() => verifyCode(code)}
                  disabled={loading || code.length !== 6}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-lg"
                >
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <Spinner size={16} /> Verifying…
                    </span>
                  ) : (
                    "Verify code"
                  )}
                </Button>

                <button
                  type="button"
                  onClick={sendCode}
                  disabled={loading || resendIn > 0}
                  className="text-sm text-blue-700 hover:underline disabled:text-slate-400 disabled:no-underline"
                >
                  {resendIn > 0 ? `Resend code in ${resendIn}s` : "Resend code"}
                </button>
              </div>
            )}

            {step === "password" && (
              <form onSubmit={submitPassword} className="grid gap-4">
                {emailVerified ? (
                  <div className="flex items-start gap-3 rounded-md border border-green-200 bg-green-50 p-3">
                    <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-green-600" />
                    <p className="text-sm text-green-800 leading-relaxed">
                      Email verified. Enter your current password and choose a new one you have not used before.
                    </p>
                  </div>
                ) : (
                  <div className="flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
                    <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
                    <p className="text-sm text-amber-800 leading-relaxed">
                      Your account requires a new password before you can continue. Enter your current password and choose a new one you have not used before.
                    </p>
                  </div>
                )}

                <PasswordField
                  id="currentPassword"
                  label="Current Password"
                  value={currentPassword}
                  onChange={setCurrentPassword}
                  placeholder="The password you signed in with"
                  autoComplete="current-password"
                />

                <PasswordField
                  id="newPassword"
                  label="New Password"
                  value={newPassword}
                  onChange={setNewPassword}
                  placeholder="Min. 12 characters"
                  minLength={12}
                  autoComplete="new-password"
                />

                <PasswordField
                  id="confirmPassword"
                  label="Confirm New Password"
                  value={confirmPassword}
                  onChange={setConfirmPassword}
                  placeholder="Repeat your new password"
                  autoComplete="new-password"
                />

                {/* Password requirements hint */}
                <p className="text-xs text-slate-500">
                  Must be at least 12 characters and include uppercase, lowercase, a number, and a special character. It must be different from your current password.
                </p>

                {formError && <ErrorBanner message={formError} />}

                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-lg"
                >
                  {loading ? (
                    <span className="inline-flex items-center gap-2">
                      <Spinner size={16} /> Saving…
                    </span>
                  ) : (
                    "Set New Password"
                  )}
                </Button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
