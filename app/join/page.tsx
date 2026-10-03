"use client"

import { useState } from "react"

import Image from "next/image"
import Link from "next/link"
import { AlertCircle, ArrowLeft, CheckCircle2, KeyRound, MailWarning } from "lucide-react"

import { JoinRequestForm, type JoinFormOptions } from "@/components/join/join-request-form"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/skeleton"
import { jsonFetcher } from "@/lib/fetcher"
import {
  JOIN_CODE_MIN_LENGTH,
  JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE,
  joinCodeError,
  normalizeJoinCode,
} from "@/lib/organization-join"

/**
 * The public join page: `/login` -> "Join an organization" -> here.
 *
 * Three steps. The first asks for the organization's code, because that code is
 * the only thing that decides which organization is being joined — it is sent to
 * the server and the organization is resolved there. Nothing on this page ever
 * holds or sends an organization id, so there is none for a caller to change.
 *
 * An organization that has not set an email domain cannot be joined: its code
 * resolves, but the applicant gets a prompt to contact their organization and
 * never reaches the form. The submit endpoint refuses such an organization too,
 * so the prompt is the explanation, not the control.
 *
 * Reached without a session by design, and outside `protectedPrefixes` in
 * `proxy.ts` for that reason. It can create nothing: the submit endpoint writes
 * a pending request, and only the tenant's head office turns one into an
 * account.
 */

type Step =
  | { kind: "code" }
  | { kind: "details"; code: string; options: JoinFormOptions }
  | { kind: "sent"; message: string }

/** What `POST /api/v1/join/lookup` answers for a valid code. */
type JoinLookupResult = Omit<JoinFormOptions, "emailDomain"> & { emailDomain: string | null }

function PageShell({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="relative flex min-h-[100svh] items-center justify-center overflow-hidden py-10">
      <div className="absolute inset-0 z-0">
        <Image
          src="/Background-Login.png"
          alt=""
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
      </div>
      <div className="relative z-10 mx-4 w-full max-w-2xl">
        <Card className="w-full border-0 bg-white/95 shadow-2xl backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className="flex items-center justify-center rounded-lg border-2 bg-white p-2 shadow-lg"
                style={{ borderColor: "var(--color-brand-primary)" }}
              >
                <Image src="/logo-pos.png" alt="Apricart" width={32} height={32} />
              </div>
              <CardTitle className="text-2xl font-semibold text-slate-800">
                Join an organization
              </CardTitle>
            </div>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </main>
  )
}

/**
 * The prompt for an organization with no email domain. The applicant stays on
 * the code step; the form is never mounted, so there is nothing to fill in.
 */
function EmailDomainMissingPrompt({
  organizationName,
  onClose,
}: Readonly<{ organizationName: string | null; onClose: () => void }>) {
  return (
    <AlertDialog
      open={organizationName !== null}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <div className="flex items-center gap-2">
            <MailWarning className="h-5 w-5 text-amber-600" aria-hidden="true" />
            <AlertDialogTitle>Email domain not set</AlertDialogTitle>
          </div>
          <AlertDialogDescription>{JOIN_EMAIL_DOMAIN_NOT_SET_MESSAGE}</AlertDialogDescription>
        </AlertDialogHeader>
        {organizationName && (
          <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Organization: <span className="font-semibold">{organizationName}</span>
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel asChild>
            <Link href="/login">Back to sign in</Link>
          </AlertDialogCancel>
          <AlertDialogAction>OK</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

function CodeStep({ onResolved }: Readonly<{ onResolved: (code: string, options: JoinFormOptions) => void }>) {
  const [code, setCode] = useState("")
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [domainMissingFor, setDomainMissingFor] = useState<string | null>(null)

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const normalized = normalizeJoinCode(code)
    const localError = joinCodeError(normalized)
    if (localError) {
      setFailure(localError)
      return
    }

    setFailure(null)
    setLoading(true)
    try {
      const result = await jsonFetcher<JoinLookupResult>("/api/v1/join/lookup", {
        method: "POST",
        body: JSON.stringify({ code: normalized }),
      })
      if (!result.emailDomain) {
        setDomainMissingFor(result.organizationName)
        return
      }
      onResolved(normalized, { ...result, emailDomain: result.emailDomain })
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "We could not check that code. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  return (
    <>
      <form onSubmit={submit} className="space-y-5">
        <p className="text-sm leading-relaxed text-slate-600">
          Enter the join code your organization gave you. Only its head office can issue one, and it
          is what tells us which organization you are joining.
        </p>

        <div className="space-y-1.5">
          <label htmlFor="join-code" className="text-sm font-medium text-slate-700">
            Organization join code <span className="text-red-500">*</span>
          </label>
          <div className="relative">
            <KeyRound
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              aria-hidden="true"
            />
            <Input
              id="join-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              placeholder="e.g. ACDE-4FGH-7JKL"
              autoComplete="off"
              spellCheck={false}
              minLength={JOIN_CODE_MIN_LENGTH}
              aria-invalid={Boolean(failure)}
              aria-describedby={failure ? "join-code-error" : undefined}
              className="pl-9 font-mono tracking-wider"
            />
          </div>
          {failure && (
            <p id="join-code-error" role="alert" className="flex items-start gap-1.5 text-xs font-medium text-red-600">
              <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              {failure}
            </p>
          )}
        </div>

        <Button type="submit" disabled={loading} className="w-full">
          {loading
            ? <span className="inline-flex items-center gap-2"><Spinner size={16} /> Checking…</span>
            : "Continue"}
        </Button>

        <Link
          href="/login"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          <ArrowLeft className="h-4 w-4" aria-hidden="true" />
          Back to sign in
        </Link>
      </form>

      <EmailDomainMissingPrompt
        organizationName={domainMissingFor}
        onClose={() => setDomainMissingFor(null)}
      />
    </>
  )
}

function SentStep({ message }: Readonly<{ message: string }>) {
  return (
    <div className="space-y-5 text-center">
      <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-500" aria-hidden="true" />
      <div className="space-y-2">
        <h2 className="text-lg font-semibold text-slate-900">Request sent</h2>
        <p className="text-sm leading-relaxed text-slate-600">{message}</p>
      </div>
      <Button asChild className="w-full">
        <Link href="/login">Back to sign in</Link>
      </Button>
    </div>
  )
}

export default function JoinPage() {
  const [step, setStep] = useState<Step>({ kind: "code" })

  if (step.kind === "sent") {
    return <PageShell><SentStep message={step.message} /></PageShell>
  }

  if (step.kind === "details") {
    return (
      <PageShell>
        <JoinRequestForm
          options={step.options}
          onBack={() => setStep({ kind: "code" })}
          onSubmit={async (payload) => {
            // The code is resent rather than an organization id, so the server
            // resolves the tenant itself on this request too.
            const response = await jsonFetcher<{ message: string }>("/api/v1/join/requests", {
              method: "POST",
              body: JSON.stringify({ ...payload, code: step.code }),
            })
            setStep({ kind: "sent", message: response.message })
          }}
        />
      </PageShell>
    )
  }

  return (
    <PageShell>
      <CodeStep
        onResolved={(code, options) => setStep({ kind: "details", code, options })}
      />
    </PageShell>
  )
}
