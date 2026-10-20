"use client"

import { useEffect, useState } from "react"

import { ArrowLeft, MailCheck, ShieldCheck } from "lucide-react"

import { OTPInput } from "@/components/mfa/otp-input"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/skeleton"
import {
  EMAIL_LOCAL_PART_MAX_LENGTH,
  composeDomainEmail,
  emailLocalPartError,
} from "@/lib/organization-email-domain"
import { JOIN_EMAIL_CODE_VALIDITY_MINUTES } from "@/lib/organization-join"

/**
 * The step between the join code and the join form
 * (plans/OF-JOIN-email-otp-verification.md): the applicant types the part of
 * their address before the `@`, a code is mailed to it, and entering the code
 * answers a proof the form's submission carries.
 *
 * Nothing here is the control. The server mails only an address at the
 * organization's domain, and the submit refuses a request whose proof was not
 * issued for that organization and exactly that address.
 */

/** What the verify step answered, sent back with the form. */
export type JoinEmailVerification = { challengeId: string; proof: string }

export type VerifiedJoinEmail = {
  email: string
  emailLocalPart: string
  verification: JoinEmailVerification
}

const RESEND_COOLDOWN_SECONDS = 60

type Reply = { status: number; data: Record<string, unknown>; retryAfter: number | null }

async function postJson(path: string, body: unknown): Promise<Reply> {
  const response = await fetch(path, {
    method: "POST",
    cache: "no-store",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({})) as Record<string, unknown>
  const retryAfter = Number(response.headers.get("Retry-After"))
  return {
    status: response.status,
    data,
    retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : null,
  }
}

function replyError(reply: Reply, fallback: string): string {
  return typeof reply.data.error === "string" ? reply.data.error : fallback
}

export function JoinEmailVerificationStep({
  joinCode,
  organizationName,
  emailDomain,
  initialEmailLocalPart = "",
  onVerified,
  onBack,
}: Readonly<{
  joinCode: string
  organizationName: string
  emailDomain: string
  initialEmailLocalPart?: string
  onVerified: (verified: VerifiedJoinEmail) => void
  onBack: () => void
}>) {
  const [phase, setPhase] = useState<"email" | "code">("email")
  const [localPart, setLocalPart] = useState(initialEmailLocalPart)
  const [challengeId, setChallengeId] = useState("")
  const [otp, setOtp] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [resendAfter, setResendAfter] = useState(0)

  useEffect(() => {
    if (resendAfter <= 0) return
    const timer = window.setInterval(() => {
      setResendAfter((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [resendAfter])

  const email = composeDomainEmail(localPart, emailDomain)

  const sendCode = async (event?: React.SubmitEvent<HTMLFormElement>) => {
    event?.preventDefault()
    if (busy) return
    const localError = emailLocalPartError(localPart)
    if (localError) {
      setFailure(localError)
      return
    }

    setBusy(true)
    setFailure(null)
    try {
      const reply = await postJson("/api/v1/join/email-verification/request", { code: joinCode, email })
      if (reply.status === 429) {
        setResendAfter(Math.min(reply.retryAfter ?? RESEND_COOLDOWN_SECONDS, 15 * 60))
        setFailure(replyError(reply, "Too many requests. Please wait before trying again."))
        return
      }
      if (reply.status !== 202 || typeof reply.data.challengeId !== "string") {
        setFailure(replyError(reply, "We could not send a code. Please try again."))
        return
      }
      setChallengeId(reply.data.challengeId)
      setOtp("")
      setResendAfter(RESEND_COOLDOWN_SECONDS)
      setPhase("code")
    } catch {
      setFailure("We could not reach the server. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const verifyCode = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (busy || otp.length !== 6) return
    setBusy(true)
    setFailure(null)
    try {
      const reply = await postJson("/api/v1/join/email-verification/verify", { challengeId, otp })
      if (reply.status !== 200 || typeof reply.data.proof !== "string") {
        setFailure(replyError(reply, "The code is invalid or expired."))
        return
      }
      onVerified({
        email,
        emailLocalPart: localPart.trim(),
        verification: { challengeId, proof: reply.data.proof },
      })
    } catch {
      setFailure("We could not verify the code. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const changeEmail = () => {
    setPhase("email")
    setOtp("")
    setChallengeId("")
    setFailure(null)
  }

  const joining = (
    <div className="rounded-lg border border-blue-100 bg-blue-50/70 p-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Joining</p>
      <p className="text-sm font-semibold text-slate-900">{organizationName}</p>
    </div>
  )

  const failureMessage = failure && (
    <p id="join-verify-error" role="alert" className="text-sm font-medium text-red-600">{failure}</p>
  )

  if (phase === "code") {
    return (
      <form onSubmit={verifyCode} className="space-y-5">
        {joining}
        <p className="text-sm leading-relaxed text-slate-600">
          We sent a 6-digit code to <span className="font-semibold text-slate-900">{email}</span>. It
          expires in {JOIN_EMAIL_CODE_VALIDITY_MINUTES} minutes.
        </p>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-sm font-medium text-slate-700">Verification code</legend>
          <OTPInput value={otp} onChange={setOtp} disabled={busy} error={Boolean(failure)} />
        </fieldset>
        {failureMessage}
        <Button type="submit" disabled={busy || otp.length !== 6} className="w-full gap-2">
          {busy
            ? <><Spinner size={16} /> Verifying…</>
            : <><ShieldCheck className="h-4 w-4" aria-hidden="true" /> Verify and continue</>}
        </Button>
        <div className="flex items-center justify-between gap-3 text-sm">
          <button
            type="button"
            onClick={changeEmail}
            disabled={busy}
            className="font-medium text-slate-600 hover:text-slate-900 disabled:opacity-50"
          >
            Use a different email
          </button>
          <button
            type="button"
            onClick={() => { void sendCode() }}
            disabled={busy || resendAfter > 0}
            className="font-medium text-blue-700 hover:text-blue-900 disabled:text-slate-400"
          >
            {resendAfter > 0 ? `Resend code in ${resendAfter}s` : "Resend code"}
          </button>
        </div>
      </form>
    )
  }

  return (
    <form onSubmit={sendCode} className="space-y-5">
      {joining}
      <p className="text-sm leading-relaxed text-slate-600">
        Enter your work email. We will send a code to it to confirm it is yours before you fill in
        the join form.
      </p>
      <div className="space-y-1.5">
        <label htmlFor="join-verify-email" className="text-sm font-medium text-slate-700">
          Work email <span className="text-red-500">*</span>
        </label>
        <div className="flex">
          <Input
            id="join-verify-email"
            value={localPart}
            onChange={(event) => setLocalPart(event.target.value)}
            placeholder="your.name"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={EMAIL_LOCAL_PART_MAX_LENGTH}
            className="min-w-0 rounded-r-none"
            aria-invalid={Boolean(failure)}
            aria-describedby={failure ? "join-verify-email-domain join-verify-error" : "join-verify-email-domain"}
          />
          <span
            id="join-verify-email-domain"
            className="inline-flex max-w-[60%] shrink-0 items-center truncate rounded-r-md border border-l-0 border-slate-300 bg-slate-100 px-3 text-sm font-medium text-slate-700"
            title={`@${emailDomain}`}
          >
            @{emailDomain}
          </span>
        </div>
        {failureMessage}
      </div>
      <Button type="submit" disabled={busy} className="w-full gap-2">
        {busy
          ? <><Spinner size={16} /> Sending code…</>
          : <><MailCheck className="h-4 w-4" aria-hidden="true" /> Send verification code</>}
      </Button>
      <button
        type="button"
        onClick={onBack}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
      >
        <ArrowLeft className="h-4 w-4" aria-hidden="true" />
        Back
      </button>
    </form>
  )
}
