"use client"

import { useEffect, useMemo, useState } from "react"

import useSWR from "swr"
import { AlertTriangle, Loader2 } from "lucide-react"

import type { JoinOption } from "@/components/join/join-scope-picker"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { fetcher, jsonFetcher } from "@/lib/fetcher"
import type { ApproverResolution } from "@/lib/join-approver-resolution"
import { type ApprovalLevelBand, approvalLevelBandText } from "@/lib/order-approval-levels"

/**
 * Head Office reviewing a department sign-up
 * (plans/OF-JOIN-department-signup-multi-user.md).
 *
 * Everything shown comes from `GET /api/v1/join-requests/[id]`, which runs the
 * same resolution the approval re-runs inside its transaction. Approving sends
 * back what was reviewed per level; if anything changed in between, the
 * server refuses with 409 and the review is reloaded.
 *
 * Disabling Approve while an approver is blocked is presentation: the server
 * refuses a blocked approver whatever this dialog sends.
 */

type Review = {
  id: number
  status: string
  person: {
    firstName: string
    lastName: string
    email: string
    username: string
    usernameTaken: boolean
    phone: string | null
    employeeId: string | null
    department: string | null
    ipExtension: string | null
  }
  initiatorRole: "ORDER_PORTAL" | "GROUP_ORDER_PORTAL"
  branches: Array<{ requestBranchId: number; kind: "existing" | "new"; branchId: number | null; name: string | null; costCenterId: string | null }>
  addresses: Array<{ requestAddressId: number; address: string; branchId: number | null }>
  approvers: Array<{
    level: number
    email: string
    designation: string
    band: ApprovalLevelBand | null
    resolution: ApproverResolution
    existingName: string | null
    recordedResolution: string | null
  }>
  approvalLevelsApply: boolean
  decisionReason: string | null
}

type NewBranchDraft = { mapToBranchId: string; name: string; province: string; city: string; address: string }

const ROLE_LABELS = {
  ORDER_PORTAL: "Order Portal User (one branch)",
  GROUP_ORDER_PORTAL: "Group Order Portal User (several branches)",
} as const

function resolutionText(resolution: ApproverResolution, level: number, existingName: string | null): string {
  switch (resolution.kind) {
    case "create":
      return `No account yet: a Group User is created with Level ${level} and these branches, and a temporary password is emailed.`
    case "assign":
      return `${existingName ?? "Existing account"}: is given Level ${level}${resolution.addBranchIds.length > 0 ? " and the branches they lack" : ""}.`
    case "extend":
      return `${existingName ?? "Existing account"}: already Level ${level}; is given the branches they lack.`
    case "covered":
      return `${existingName ?? "Existing account"}: already Level ${level} at every branch. Nothing changes.`
    default:
      return resolution.reason
  }
}

function resolutionTone(kind: ApproverResolution["kind"]): string {
  if (kind === "blocked") return "border-red-300 bg-red-50 text-red-800"
  if (kind === "not_applied") return "border-amber-300 bg-amber-50 text-amber-900"
  return "border-emerald-200 bg-emerald-50 text-emerald-900"
}

function ReplaceApprover({
  requestId,
  level,
  designation,
  onReplaced,
}: Readonly<{ requestId: number; level: number; designation: string; onReplaced: () => void }>) {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const replace = async () => {
    setBusy(true)
    setFailure(null)
    try {
      await jsonFetcher(`/api/v1/join-requests/${requestId}`, {
        method: "PATCH",
        body: JSON.stringify({ replaceApprover: { level, email: email.trim(), designation } }),
      })
      setEmail("")
      onReplaced()
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "The approver could not be replaced.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Input
          aria-label={`Replacement Level ${level} approver email`}
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="Another approver's email"
          type="email"
        />
        <Button type="button" variant="outline" disabled={busy || !email.trim()} onClick={replace}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Replace"}
        </Button>
      </div>
      {failure && <p className="text-xs font-medium text-red-600">{failure}</p>}
    </div>
  )
}

export function DepartmentJoinReviewDialog({
  requestId,
  organizationId,
  onClose,
  onDecided,
}: Readonly<{
  requestId: number | null
  organizationId: number | null
  onClose: () => void
  onDecided: () => void
}>) {
  const { data, error, mutate } = useSWR<{ item: Review }>(
    requestId ? `/api/v1/join-requests/${requestId}` : null,
    fetcher,
  )
  const { data: branchesData } = useSWR<{ items?: JoinOption[] }>(
    requestId && organizationId ? `/api/v1/branches?organizationId=${organizationId}` : null,
    fetcher,
  )
  const review = data?.item ?? null
  const organizationBranches = useMemo(() => (Array.isArray(branchesData?.items) ? branchesData.items : []), [branchesData])

  const [reason, setReason] = useState("")
  const [username, setUsername] = useState("")
  const [newBranches, setNewBranches] = useState<Record<number, NewBranchDraft>>({})
  const [addressBranches, setAddressBranches] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    setReason("")
    setUsername("")
    setNewBranches({})
    setAddressBranches({})
    setFailure(null)
    setBusy(null)
  }, [requestId])

  if (!requestId) return null

  const pending = review?.status === "pending"
  const blocked = review?.approvers.some((approver) => approver.resolution.kind === "blocked") ?? false
  const branchLabel = (row: Review["branches"][number]) => row.name ?? `New branch for CRC ${row.costCenterId}`
  const draftFor = (requestBranchId: number, crc: string | null): NewBranchDraft =>
    newBranches[requestBranchId] ?? {
      mapToBranchId: "",
      name: crc ?? "",
      province: "",
      city: "",
      address: review?.addresses[0]?.address ?? "",
    }
  const updateDraft = (requestBranchId: number, crc: string | null, patch: Partial<NewBranchDraft>) =>
    setNewBranches((previous) => ({ ...previous, [requestBranchId]: { ...draftFor(requestBranchId, crc), ...patch } }))

  const decide = async (decision: "approve" | "reject") => {
    if (!review) return
    setBusy(decision)
    setFailure(null)
    try {
      const body = decision === "reject"
        ? { decision, reason: reason.trim() || null }
        : {
            decision,
            reason: reason.trim() || null,
            ...(review.person.usernameTaken && username.trim() ? { username: username.trim().toLowerCase() } : {}),
            newBranches: review.branches
              .filter((row) => row.kind === "new" && row.branchId === null)
              .map((row) => {
                const draft = draftFor(row.requestBranchId, row.costCenterId)
                return draft.mapToBranchId
                  ? { requestBranchId: row.requestBranchId, mapToBranchId: Number(draft.mapToBranchId) }
                  : {
                      requestBranchId: row.requestBranchId,
                      name: draft.name.trim(),
                      province: draft.province.trim(),
                      city: draft.city.trim(),
                      address: draft.address.trim(),
                    }
              }),
            addressBranches: review.branches.length > 1
              ? review.addresses.flatMap((address) => (addressBranches[address.requestAddressId]
                ? [{ requestAddressId: address.requestAddressId, requestBranchId: Number(addressBranches[address.requestAddressId]) }]
                : []))
              : [],
            expectedResolutions: review.approvers.map((approver) => ({
              level: approver.level,
              kind: approver.resolution.kind,
              userId: "userId" in approver.resolution ? approver.resolution.userId : null,
            })),
          }
      await jsonFetcher(`/api/v1/join-requests/${review.id}`, { method: "PATCH", body: JSON.stringify(body) })
      onDecided()
      onClose()
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "The decision could not be recorded. Please try again.")
      await mutate()
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && busy === null) onClose() }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {review ? `${review.person.firstName} ${review.person.lastName}` : "Department sign-up"}
          </DialogTitle>
          <DialogDescription>
            Approving creates this person, any new branches, their delivery addresses and their approvers in one
            step. Rejecting creates nothing.
          </DialogDescription>
        </DialogHeader>

        {error && <p role="alert" className="text-sm font-medium text-red-600">This request could not be loaded.</p>}
        {!review && !error && <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" />}

        {review && (
          <div className="space-y-5">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
              <dt className="font-medium text-slate-500">Email</dt>
              <dd className="break-all">{review.person.email}</dd>
              <dt className="font-medium text-slate-500">Username</dt>
              <dd className="font-mono">{review.person.username}</dd>
              <dt className="font-medium text-slate-500">Phone / IP ext.</dt>
              <dd>{review.person.phone ?? "—"} / {review.person.ipExtension ?? "—"}</dd>
              <dt className="font-medium text-slate-500">Employee ID</dt>
              <dd>{review.person.employeeId ?? "—"}</dd>
              <dt className="font-medium text-slate-500">Department</dt>
              <dd>{review.person.department ?? "—"}</dd>
              <dt className="font-medium text-slate-500">Will be</dt>
              <dd>{ROLE_LABELS[review.initiatorRole]}</dd>
            </dl>

            {pending && review.person.usernameTaken && (
              <div className="space-y-1">
                <label htmlFor="review-username" className="text-sm font-medium text-slate-700">
                  The username {review.person.username} is taken. Choose another
                </label>
                <Input id="review-username" value={username} onChange={(event) => setUsername(event.target.value)} />
              </div>
            )}

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900">Branches (CRC)</h3>
              <ul className="space-y-2">
                {review.branches.map((row) => {
                  const draft = draftFor(row.requestBranchId, row.costCenterId)
                  const isNew = row.kind === "new" && row.branchId === null
                  return (
                    <li key={row.requestBranchId} className="rounded-md border border-slate-200 p-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{branchLabel(row)}</span>
                        {row.kind === "new" && <Badge variant="outline">CRC {row.costCenterId}</Badge>}
                      </div>
                      {pending && isNew && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <select
                            aria-label={`Map CRC ${row.costCenterId} to an existing branch`}
                            value={draft.mapToBranchId}
                            onChange={(event) => updateDraft(row.requestBranchId, row.costCenterId, { mapToBranchId: event.target.value })}
                            className="h-9 rounded-md border border-slate-300 px-2 text-sm sm:col-span-2"
                          >
                            <option value="">Create a new branch</option>
                            {organizationBranches.map((branch) => <option key={branch.id} value={branch.id}>Use existing: {branch.name}</option>)}
                          </select>
                          {!draft.mapToBranchId && (
                            <>
                              <Input aria-label="Branch name" placeholder="Branch name" value={draft.name} onChange={(event) => updateDraft(row.requestBranchId, row.costCenterId, { name: event.target.value })} />
                              <Input aria-label="Province" placeholder="Province" value={draft.province} onChange={(event) => updateDraft(row.requestBranchId, row.costCenterId, { province: event.target.value })} />
                              <Input aria-label="City" placeholder="City" value={draft.city} onChange={(event) => updateDraft(row.requestBranchId, row.costCenterId, { city: event.target.value })} />
                              <Input aria-label="Branch address" placeholder="Branch address" value={draft.address} onChange={(event) => updateDraft(row.requestBranchId, row.costCenterId, { address: event.target.value })} />
                            </>
                          )}
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
              {pending && review.branches.some((row) => row.kind === "new") && (
                <p className="text-xs text-slate-500">
                  A new branch starts with no products and no budget. Assign products and allocate a budget after approving.
                </p>
              )}
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900">Delivery addresses</h3>
              <ul className="space-y-2">
                {review.addresses.map((address) => (
                  <li key={address.requestAddressId} className="flex flex-col gap-2 rounded-md border border-slate-200 p-3 text-sm sm:flex-row sm:items-center">
                    <span className="flex-1">{address.address}</span>
                    {pending && review.branches.length > 1 && (
                      <select
                        aria-label={`Branch for ${address.address}`}
                        value={addressBranches[address.requestAddressId] ?? ""}
                        onChange={(event) => setAddressBranches((previous) => ({ ...previous, [address.requestAddressId]: event.target.value }))}
                        className="h-9 rounded-md border border-slate-300 px-2 text-sm"
                      >
                        <option value="">Choose its branch</option>
                        {review.branches.map((row) => <option key={row.requestBranchId} value={row.requestBranchId}>{branchLabel(row)}</option>)}
                      </select>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-900">Financial approvers</h3>
              {!review.approvalLevelsApply && (
                <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  Approval levels are switched off for your organization now. Approving creates this person and their
                  branches, and gives no one a level.
                </p>
              )}
              <ul className="space-y-2">
                {review.approvers.map((approver) => (
                  <li key={approver.level} className="space-y-2 rounded-md border border-slate-200 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-blue-700">Level {approver.level}</span>
                      {approver.band && <span className="text-xs text-slate-500">orders {approvalLevelBandText(approver.band)}</span>}
                    </div>
                    <p className="break-all">{approver.email} <span className="text-slate-500">· {approver.designation}</span></p>
                    <p className={`rounded border px-2 py-1 text-xs ${resolutionTone(approver.resolution.kind)}`}>
                      {pending
                        ? resolutionText(approver.resolution, approver.level, approver.existingName)
                        : `Recorded: ${approver.recordedResolution ?? "—"}`}
                    </p>
                    {pending && ["create", "assign", "extend"].includes(approver.resolution.kind) && (
                      <p className="text-xs text-slate-500">
                        They will approve Level {approver.level} orders for everyone at: {review.branches.map(branchLabel).join(", ")}.
                      </p>
                    )}
                    {pending && approver.resolution.kind === "blocked" && (
                      <ReplaceApprover
                        requestId={review.id}
                        level={approver.level}
                        designation={approver.designation}
                        onReplaced={() => { void mutate() }}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {pending && (
              <div className="space-y-1.5">
                <label htmlFor="review-reason" className="text-sm font-medium text-slate-700">Note for your records</label>
                <Textarea
                  id="review-reason"
                  rows={2}
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  placeholder="Optional. Kept in the audit trail and not sent to the applicant."
                />
              </div>
            )}

            {failure && <p role="alert" className="text-sm font-medium text-red-600">{failure}</p>}
          </div>
        )}

        {review && pending && (
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
            <Button type="button" onClick={() => decide("approve")} disabled={busy !== null || blocked}>
              {busy === "approve"
                ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Approving…</span>
                : "Approve and create accounts"}
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  )
}
