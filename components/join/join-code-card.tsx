"use client"

import { useViewerAccess } from "@/lib/hooks/use-viewer-access"
import { useState } from "react"

import useSWR from "swr"
import { AtSign, Check, Copy, KeyRound, Loader2, MailWarning, RefreshCw, ShieldOff } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { fetcher, jsonFetcher } from "@/lib/fetcher"
import {
  JOIN_CODE_MAX_LENGTH,
  JOIN_CODE_MIN_LENGTH,
  joinCodeError,
  normalizeJoinCode,
} from "@/lib/organization-join"

/**
 * The join code, as Head Office manages it.
 *
 * The place the request asked for: "somewhere in the head office where he can
 * type the code". Typing one is supported; generating one is offered first and
 * recommended, because a code somebody invents is a code somebody can guess.
 *
 * Every button here calls `/api/v1/organizations/join-code`, which admits Head
 * Office alone and always acts on the caller's own organization — this component
 * never sends an organization id, because the endpoint does not accept one.
 */

type JoinCodeResponse = {
  code: string | null
  updatedAt: string | null
  joiningOpen: boolean
  /** Set by Super Admin. Without one, the join form refuses every applicant. */
  emailDomain: string | null
}

export function JoinCodeCard() {
  // The read-only Viewer sees the code and copies it; it issues, replaces and
  // closes nothing.
  const { readOnly } = useViewerAccess()
  const { data, error, isLoading, mutate } = useSWR<JoinCodeResponse>(
    "/api/v1/organizations/join-code",
    fetcher,
  )

  const [typedCode, setTypedCode] = useState("")
  const [busy, setBusy] = useState<"generate" | "save" | "clear" | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const run = async (
    kind: "generate" | "save" | "clear",
    request: () => Promise<unknown>,
  ) => {
    setFailure(null)
    setBusy(kind)
    try {
      await request()
      setTypedCode("")
      await mutate()
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "That did not work. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  const generate = () => run("generate", () =>
    jsonFetcher("/api/v1/organizations/join-code", { method: "PUT", body: JSON.stringify({}) }),
  )

  const save = () => {
    const normalized = normalizeJoinCode(typedCode)
    const localError = joinCodeError(normalized)
    if (localError) {
      setFailure(localError)
      return
    }
    return run("save", () =>
      jsonFetcher("/api/v1/organizations/join-code", {
        method: "PUT",
        body: JSON.stringify({ code: normalized }),
      }),
    )
  }

  const clear = () => run("clear", () =>
    jsonFetcher("/api/v1/organizations/join-code", { method: "DELETE" }),
  )

  const copy = async () => {
    if (!data?.code) return
    try {
      await navigator.clipboard.writeText(data.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      setFailure("Your browser would not let us copy. Select the code and copy it manually.")
    }
  }

  return (
    <Card className="rounded-2xl border-slate-200 shadow-sm dark:border-slate-800">
      <CardHeader className="pb-3">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-950/50 dark:text-blue-400">
            <KeyRound className="h-5 w-5" />
          </div>
          <div>
            <CardTitle className="text-base">Organization join code</CardTitle>
            <p className="text-xs text-slate-500 dark:text-slate-400">
              Anyone with this code can ask to join. Only you can approve them.
            </p>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && <Skeleton className="h-10 w-full" />}

        {error && !isLoading && (
          <p role="alert" className="text-sm font-medium text-red-600">
            The join code could not be loaded. Your code has not been changed.
          </p>
        )}

        {data && !data.emailDomain && (
          <div
            role="status"
            className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/30 dark:text-amber-200"
          >
            <MailWarning className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <p>
              Your organization&apos;s <strong>email domain is not set</strong>, so nobody can use the
              join form yet — even with a code. Ask your platform administrator to set it.
            </p>
          </div>
        )}

        {data?.emailDomain && (
          <p className="flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
            Applicants must use an address at <strong>@{data.emailDomain}</strong>.
          </p>
        )}

        {data && !data.joiningOpen && (
          <p className="rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300">
            Joining is <strong>closed</strong>. Nobody can request to join this organization until you
            issue a code.
          </p>
        )}

        {data?.code && (
          <div className="flex flex-wrap items-center gap-2 rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/60 dark:bg-emerald-950/30">
            <code className="flex-1 break-all font-mono text-lg font-bold tracking-wider text-emerald-900 dark:text-emerald-300">
              {data.code}
            </code>
            <Button type="button" size="sm" variant="outline" onClick={copy} className="gap-1.5">
              {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        )}

        {!readOnly && (
          <>
        <div className="flex flex-col gap-2 sm:flex-row">
          <Button
            type="button"
            onClick={generate}
            disabled={busy !== null}
            className="gap-2 sm:w-auto"
          >
            {busy === "generate"
              ? <Loader2 className="h-4 w-4 animate-spin" />
              : <RefreshCw className="h-4 w-4" />}
            {data?.joiningOpen ? "Generate a new code" : "Generate a code"}
          </Button>
          {data?.joiningOpen && (
            <Button
              type="button"
              variant="outline"
              onClick={clear}
              disabled={busy !== null}
              className="gap-2 text-red-600 hover:text-red-700 sm:w-auto"
            >
              {busy === "clear"
                ? <Loader2 className="h-4 w-4 animate-spin" />
                : <ShieldOff className="h-4 w-4" />}
              Close joining
            </Button>
          )}
        </div>

        <div className="space-y-1.5 border-t border-slate-200 pt-4 dark:border-slate-800">
          <label htmlFor="join-code-input" className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Or set your own code
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="join-code-input"
              value={typedCode}
              onChange={(event) => setTypedCode(event.target.value.toUpperCase())}
              placeholder={`${JOIN_CODE_MIN_LENGTH}-${JOIN_CODE_MAX_LENGTH} characters, A-Z 0-9 and dashes`}
              autoComplete="off"
              spellCheck={false}
              className="font-mono tracking-wider"
            />
            <Button
              type="button"
              variant="secondary"
              onClick={save}
              disabled={busy !== null || typedCode.trim().length === 0}
              className="sm:w-auto"
            >
              {busy === "save" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save code"}
            </Button>
          </div>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            A generated code is far harder to guess than one you invent. Replacing a code stops the
            old one working immediately; requests already waiting are unaffected.
          </p>
        </div>
          </>
        )}

        {failure && (
          <p role="alert" className="text-sm font-medium text-red-600">{failure}</p>
        )}
      </CardContent>
    </Card>
  )
}
