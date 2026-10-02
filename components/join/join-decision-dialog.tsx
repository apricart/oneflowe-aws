"use client"

import { useEffect, useMemo, useState } from "react"

import useSWR from "swr"
import { Loader2 } from "lucide-react"

import {
  JoinMultiScopePicker,
  JoinSingleBranchPicker,
  type JoinOption,
} from "@/components/join/join-scope-picker"
import type { JoinRequestRow } from "@/components/join/join-request-row"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { fetcher, jsonFetcher } from "@/lib/fetcher"
import {
  JOINABLE_ROLES,
  JOINABLE_ROLE_LABELS,
  type JoinableRole,
  isSingleBranchJoinableRole,
} from "@/lib/organization-join"
import { cn } from "@/lib/utils"

/**
 * Approving or rejecting one request.
 *
 * Approving is what creates the account — there is no other path from a request
 * to a user. Head Office may correct the role and the assignment first, because
 * what an applicant asked for is a request and not a decision; every override
 * goes back through the same allowlist and the same tenant validation the
 * submission did, so it cannot reach further than the submission could.
 *
 * `budgetAllocationEnabled` appears only here and only for a Group User. It is
 * the right to allocate money, so it is granted deliberately by an
 * administrator and is not a field the public form has at all.
 */

type ScopeOverride = {
  role: JoinableRole
  branchId: number | null
  groupIds: number[]
  branchIds: number[]
  budgetAllocationEnabled: boolean
}

function initialOverride(request: JoinRequestRow): ScopeOverride {
  return {
    role: request.requestedRole,
    branchId: request.requestedBranchId,
    groupIds: request.requestedGroupIds ?? [],
    branchIds: request.requestedBranchIds ?? [],
    budgetAllocationEnabled: false,
  }
}

function toggle(list: number[], id: number) {
  return list.includes(id) ? list.filter((value) => value !== id) : [...list, id]
}

export function JoinDecisionDialog({
  request,
  organizationId,
  onClose,
  onDecided,
}: Readonly<{
  request: JoinRequestRow | null
  organizationId: number | null
  onClose: () => void
  onDecided: () => void
}>) {
  const [override, setOverride] = useState<ScopeOverride | null>(null)
  const [reason, setReason] = useState("")
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    setOverride(request ? initialOverride(request) : null)
    setReason("")
    setFailure(null)
    setBusy(null)
  }, [request])

  const { data: branchesData } = useSWR<{ items?: JoinOption[] }>(
    request && organizationId ? `/api/v1/branches?organizationId=${organizationId}` : null,
    fetcher,
  )
  const { data: groupsData } = useSWR<{ groups?: JoinOption[] }>(
    request && organizationId ? `/api/v1/groups?organizationId=${organizationId}` : null,
    fetcher,
  )

  const branches = useMemo(() => branchesData?.items ?? [], [branchesData])
  const groups = useMemo(() => groupsData?.groups ?? [], [groupsData])

  const isGroupRole = override ? !isSingleBranchJoinableRole(override.role) : false

  const decide = async (decision: "approve" | "reject") => {
    if (!request || !override) return
    setFailure(null)
    setBusy(decision)
    try {
      const body: Record<string, unknown> = { decision }
      if (reason.trim()) body.reason = reason.trim()
      if (decision === "approve") {
        body.role = override.role
        body.branchId = isGroupRole ? null : override.branchId
        body.groupIds = isGroupRole ? override.groupIds : []
        body.branchIds = isGroupRole ? override.branchIds : []
        if (override.role === "GROUP_USER") {
          body.budgetAllocationEnabled = override.budgetAllocationEnabled
        }
      }

      await jsonFetcher(`/api/v1/join-requests/${request.id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
      onDecided()
      onClose()
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "The decision could not be recorded. Please try again.")
    } finally {
      setBusy(null)
    }
  }

  if (!request || !override) return null

  return (
    <Dialog open onOpenChange={(open) => { if (!open && busy === null) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {request.firstName} {request.lastName}
          </DialogTitle>
          <DialogDescription>
            Approving this creates the account immediately. Rejecting it creates nothing.
          </DialogDescription>
        </DialogHeader>

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-800 dark:bg-slate-900">
          <dt className="font-medium text-slate-500">Username</dt>
          <dd className="font-mono text-slate-900 dark:text-slate-100">{request.username}</dd>
          <dt className="font-medium text-slate-500">Email</dt>
          <dd className="break-all text-slate-900 dark:text-slate-100">{request.email}</dd>
          {request.phone && (
            <>
              <dt className="font-medium text-slate-500">Phone</dt>
              <dd className="text-slate-900 dark:text-slate-100">{request.phone}</dd>
            </>
          )}
          {request.employeeId && (
            <>
              <dt className="font-medium text-slate-500">Employee no.</dt>
              <dd className="text-slate-900 dark:text-slate-100">{request.employeeId}</dd>
            </>
          )}
          <dt className="font-medium text-slate-500">Asked for</dt>
          <dd className="text-slate-900 dark:text-slate-100">
            {JOINABLE_ROLE_LABELS[request.requestedRole]}
            {request.requestedBranchName ? ` — ${request.requestedBranchName}` : ""}
          </dd>
        </dl>

        <fieldset className="space-y-2">
          <legend className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Role to grant
          </legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {JOINABLE_ROLES.map((role) => (
              <button
                key={role}
                type="button"
                aria-pressed={override.role === role}
                onClick={() => setOverride({
                  role,
                  // A different shape cannot keep the old assignment.
                  branchId: role === request.requestedRole ? request.requestedBranchId : null,
                  groupIds: role === request.requestedRole ? (request.requestedGroupIds ?? []) : [],
                  branchIds: role === request.requestedRole ? (request.requestedBranchIds ?? []) : [],
                  budgetAllocationEnabled: false,
                })}
                className={cn(
                  "rounded-md border px-3 py-2 text-left text-sm font-medium transition",
                  override.role === role
                    ? "border-blue-500 bg-blue-50 text-blue-900 dark:bg-blue-950/50 dark:text-blue-200"
                    : "border-slate-300 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-300",
                )}
              >
                {JOINABLE_ROLE_LABELS[role]}
              </button>
            ))}
          </div>
        </fieldset>

        {isGroupRole ? (
          <JoinMultiScopePicker
            groups={groups}
            branches={branches}
            selectedGroupIds={override.groupIds}
            selectedBranchIds={override.branchIds}
            onToggleGroup={(id) => setOverride({ ...override, groupIds: toggle(override.groupIds, id) })}
            onToggleBranch={(id) => setOverride({ ...override, branchIds: toggle(override.branchIds, id) })}
          />
        ) : (
          <JoinSingleBranchPicker
            options={branches}
            value={override.branchId}
            onChange={(branchId) => setOverride({ ...override, branchId })}
          />
        )}

        {override.role === "GROUP_USER" && (
          <div className="flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-950/30">
            <div>
              <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                Allow budget allocation
              </p>
              <p className="text-xs text-slate-600 dark:text-slate-400">
                Lets this Group User allocate money to the branches assigned to them. Off unless you
                turn it on — an applicant can never ask for it.
              </p>
            </div>
            <Switch
              checked={override.budgetAllocationEnabled}
              onCheckedChange={(checked) =>
                setOverride({ ...override, budgetAllocationEnabled: checked === true })}
              aria-label="Allow budget allocation"
            />
          </div>
        )}

        <div className="space-y-1.5">
          <label htmlFor="join-decision-reason" className="text-sm font-medium text-slate-700 dark:text-slate-300">
            Note for your records
          </label>
          <Textarea
            id="join-decision-reason"
            rows={2}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Optional. Kept in the audit trail and not sent to the applicant."
          />
        </div>

        {failure && (
          <p role="alert" className="text-sm font-medium text-red-600">{failure}</p>
        )}

        <DialogFooter className="gap-2 sm:justify-between">
          <Button
            type="button"
            variant="outline"
            onClick={() => decide("reject")}
            disabled={busy !== null}
            className="text-red-600 hover:text-red-700"
          >
            {busy === "reject" ? <Loader2 className="h-4 w-4 animate-spin" /> : "Reject"}
          </Button>
          <Button type="button" onClick={() => decide("approve")} disabled={busy !== null}>
            {busy === "approve"
              ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Approving…</span>
              : "Approve and create account"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
