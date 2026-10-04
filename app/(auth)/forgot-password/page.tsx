"use client"

import { useEffect, useState } from "react"
import Image from "next/image"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { CheckCircle2, Eye, EyeOff, KeyRound, MailCheck, ShieldCheck } from "lucide-react"

import { OTPInput } from "@/components/mfa/otp-input"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/skeleton"
import { securelySignOut } from "@/lib/session-coordination"

type Step = "identify" | "verify" | "password" | "complete"

type JsonReply = {
  status: number
  data: Record<string, unknown>
  retryAfter: number | null
}

async function postJson(path: string, body: unknown): Promise<JsonReply> {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  const retryAfterHeader = Number(response.headers.get("Retry-After"))
  return {
    status: response.status,
    data,
    retryAfter: Number.isFinite(retryAfterHeader) && retryAfterHeader > 0
      ? Math.ceil(retryAfterHeader)
      : null,
  }
}

function responseError(reply: JsonReply, fallback: string): string {
  return typeof reply.data.error === "string" ? reply.data.error : fallback
}

function ErrorBanner({ message }: Readonly<{ message: string }>) {
  return (
    <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-medium text-red-700">
      {message}
    </div>
  )
}

function PasswordInput({
  id,
  label,
  value,
  onChange,
}: Readonly<{
  id: string
  label: string
  value: string
  onChange: (value: string) => void
}>) {
  const [visible, setVisible] = useState(false)
  return (
    <div className="grid gap-2">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">{label}</label>
      <div className="relative">
        <Input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="new-password"
          maxLength={128}
          required
          className="border-slate-300 bg-white/80 pr-10 text-slate-900"
        />
        <button
          type="button"
          aria-label={visible ? `Hide ${label.toLowerCase()}` : `Show ${label.toLowerCase()}`}
          onClick={() => setVisible((current) => !current)}
          className="absolute right-3 top-1/2 -translate-y-1/2 rounded text-slate-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
        >
          {visible ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

export default function ForgotPasswordPage() {
  const router = useRouter()
  const [step, setStep] = useState<Step>("identify")
  const [identifier, setIdentifier] = useState("")
  const [challengeId, setChallengeId] = useState("")
  const [code, setCode] = useState("")
  const [resetToken, setResetToken] = useState("")
  const [password, setPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [resendAfter, setResendAfter] = useState(0)

  useEffect(() => {
    if (resendAfter <= 0) return
    const timer = window.setInterval(() => {
      setResendAfter((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendAfter])

  async function sendCode(event?: React.SubmitEvent<HTMLFormElement>) {
    event?.preventDefault()
    if (busy || !identifier.trim()) return
    setBusy(true)
    setError(null)
    try {
      const reply = await postJson("/api/v1/auth/password-reset/request", {
        identifier: identifier.trim(),
      })
      if (reply.status === 429) {
        setResendAfter(reply.retryAfter ?? 60)
        setError(responseError(reply, "Too many requests. Please wait before trying again."))
        return
      }
      if (reply.status !== 202 || typeof reply.data.challengeId !== "string") {
        setError(responseError(reply, "Unable to send a verification code. Please try again."))
        return
      }
      setChallengeId(reply.data.challengeId)
      setCode("")
      setResendAfter(60)
      setStep("verify")
    } catch {
      setError("Unable to reach the password reset service. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  async function verifyCode(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busy || code.length !== 6) return
    setBusy(true)
    setError(null)
    try {
      const reply = await postJson("/api/v1/auth/password-reset/verify", { challengeId, code })
      if (reply.status !== 200 || typeof reply.data.resetToken !== "string") {
        setError(responseError(reply, "The code is invalid or expired."))
        return
      }
      setResetToken(reply.data.resetToken)
      setStep("password")
    } catch {
      setError("Unable to verify the code. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  async function setNewPassword(event: React.SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    if (password !== confirmPassword) {
      setError("Passwords do not match.")
      return
    }
    if (busy) return
    setBusy(true)
    try {
      const reply = await postJson("/api/v1/auth/password-reset/complete", {
        challengeId,
        resetToken,
        password,
        confirmPassword,
      })
      if (reply.status !== 200) {
        setError(responseError(reply, "Unable to reset your password. Please try again."))
        return
      }

      // Remove any pre-existing browser session after the server has revoked
      // every session for this principal. This also handles a reset launched
      // from an authenticated profile menu on a shared Order Portal device.
      setStep("complete")
      try {
        await securelySignOut({ callbackUrl: "/login?password-reset=success" })
      } catch {
        router.replace("/login?password-reset=success")
      }
    } catch {
      setError("Unable to reset your password. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="relative flex min-h-[100svh] items-center justify-center overflow-hidden px-4 py-8">
      <div className="absolute inset-0">
        <Image src="/Background-Login.png" alt="" fill priority className="object-cover" />
        <div className="absolute inset-0 bg-black/45 backdrop-blur-[1px]" />
      </div>

      <Card className="relative z-10 w-full max-w-md border-0 bg-white/95 shadow-2xl backdrop-blur-sm">
        <CardHeader className="space-y-4">
          <div className="flex items-center gap-3">
            <div className="rounded-lg border-2 bg-white p-2 shadow-lg" style={{ borderColor: "var(--color-brand-primary)" }}>
              <Image src="/logo-pos.png" alt="Apricart" width={32} height={32} />
            </div>
            <div>
              <CardTitle className="text-2xl text-slate-800">Reset your password</CardTitle>
              <p className="mt-1 text-sm text-slate-500">Secure account recovery by email</p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {error && <div className="mb-4"><ErrorBanner message={error} /></div>}

          {step === "identify" && (
            <form onSubmit={sendCode} className="grid gap-4">
              <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-800">
                Enter the username for the account you want to recover. You may use an email address when it belongs to only one account.
              </div>
              <div className="grid gap-2">
                <label htmlFor="reset-identifier" className="text-sm font-medium text-slate-700">Username or email</label>
                <Input
                  id="reset-identifier"
                  value={identifier}
                  onChange={(event) => setIdentifier(event.target.value)}
                  autoComplete="username"
                  maxLength={255}
                  required
                  autoFocus
                  placeholder="Enter your username or email"
                  className="border-slate-300 bg-white/80 text-slate-900"
                />
              </div>
              <Button type="submit" disabled={busy || !identifier.trim()} className="w-full gap-2 bg-blue-600 text-white hover:bg-blue-700">
                {busy ? <><Spinner size={16} /> Sending code…</> : <><MailCheck className="h-4 w-4" /> Send verification code</>}
              </Button>
            </form>
          )}

          {step === "verify" && (
            <form onSubmit={verifyCode} className="grid gap-5">
              <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-800">
                If an active account matched, a 6-digit code was sent to its email. The code expires in 10 minutes.
              </div>
              <fieldset disabled={busy} className="grid gap-2">
                <legend className="mb-2 text-sm font-medium text-slate-700">Verification code</legend>
                <OTPInput value={code} onChange={setCode} disabled={busy} error={Boolean(error)} />
              </fieldset>
              <Button type="submit" disabled={busy || code.length !== 6} className="w-full gap-2 bg-blue-600 text-white hover:bg-blue-700">
                {busy ? <><Spinner size={16} /> Verifying…</> : <><ShieldCheck className="h-4 w-4" /> Verify code</>}
              </Button>
              <div className="flex items-center justify-between gap-3 text-sm">
                <button
                  type="button"
                  onClick={() => { setStep("identify"); setError(null); setCode("") }}
                  className="font-medium text-slate-600 hover:text-slate-900"
                >
                  Use another account
                </button>
                <button
                  type="button"
                  disabled={busy || resendAfter > 0}
                  onClick={() => { void sendCode() }}
                  className="font-semibold text-blue-600 hover:text-blue-700 disabled:cursor-not-allowed disabled:text-slate-400"
                >
                  {resendAfter > 0 ? `Resend in ${resendAfter}s` : "Resend code"}
                </button>
              </div>
            </form>
          )}

          {step === "password" && (
            <form onSubmit={setNewPassword} className="grid gap-4">
              <div className="flex items-start gap-2 rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-800">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                Email confirmed. Choose a new password; all existing sessions will be signed out.
              </div>
              <PasswordInput id="new-password" label="New password" value={password} onChange={setPassword} />
              <PasswordInput id="confirm-password" label="Confirm new password" value={confirmPassword} onChange={setConfirmPassword} />
              <p className="text-xs leading-relaxed text-slate-500">
                Use 12–128 characters with uppercase, lowercase, a number, and a special character. Do not reuse your current password.
              </p>
              <Button type="submit" disabled={busy || !password || !confirmPassword} className="w-full gap-2 bg-blue-600 text-white hover:bg-blue-700">
                {busy ? <><Spinner size={16} /> Resetting password…</> : <><KeyRound className="h-4 w-4" /> Reset password</>}
              </Button>
            </form>
          )}

          {step === "complete" && (
            <div className="py-4 text-center" role="status">
              <CheckCircle2 className="mx-auto mb-3 h-10 w-10 text-emerald-600" />
              <p className="font-semibold text-slate-900">Password reset complete</p>
              <p className="mt-1 text-sm text-slate-500">Taking you back to sign in…</p>
            </div>
          )}

          {step !== "complete" && (
            <div className="mt-6 border-t border-slate-200 pt-4 text-center">
              <Link href="/login" className="text-sm font-semibold text-blue-600 hover:text-blue-700">
                Back to sign in
              </Link>
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  )
}
