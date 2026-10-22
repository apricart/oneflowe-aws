"use client"

import { type ReactNode, useEffect, useMemo, useState } from "react"

import useSWR from "swr"
import { AlertTriangle, Loader2, Pencil } from "lucide-react"

import { DepartmentJoinEditForm } from "@/components/join/department-join-edit-form"
import { EmailVerifiedNote } from "@/components/join/email-verified-note"
import { PakistanCityCombobox } from "@/components/join/pakistan-city-combobox"
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
import {
  type ApproverResolution,
  branchCountAfterReview,
  newApproverRole,
} from "@/lib/join-approver-resolution"
import {
  NEW_BRANCH_FIELDS,
  type NewBranchField,
  initiatorRoleForBranchCount,
  newBranchDraftErrors,
} from "@/lib/join-department-signup"
import {
  BRANCH_HIERARCHY_LABELS,
  BRANCH_HIERARCHY_ROLES,
  DEFAULT_BRANCH_HIERARCHY_ROLE,
  type BranchHierarchyRole,
  isBranchHierarchyRole,
} from "@/lib/branch-hierarchy"
import { type ApprovalLevelBand, approvalLevelBandText } from "@/lib/order-approval-levels"
import { findPakistanCity } from "@/lib/pakistan-cities"
import { ROLE_DISPLAY_NAMES } from "@/lib/role-display-names"

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
 *
 * "Edit details" lets Head Office correct anything the applicant typed before
 * deciding (`DepartmentJoinEditForm`); the review is reloaded after saving, so
 * what Approve then sends is judged on the corrected request.
 */

type Review = {
  id: number
  status: string
  person: {
    firstName: string
    lastName: string
    email: string
    emailVerified?: boolean
    username: string
    usernameTaken: boolean
    phone: string | null
    employeeId: string | null
    department: string | null
    ipExtension: string | null
  }
  initiatorRole: "ORDER_PORTAL" | "GROUP_ORDER_PORTAL"
  branches: Array<{
    requestBranchId: number
    kind: "existing" | "new"
    branchId: number | null
    name: string | null
    costCenterId: string | null
    requestedName: string | null
    /** The listed city and its province the applicant gave; absent from older responses. */
    requestedCity?: string | null
    requestedProvince?: string | null
    /** An existing branch already carrying this CRC; Head Office must choose it or a new branch. */
    crcMatch?: { branchId: number; name: string } | null
    /** The type the applicant proposed; absent from older responses. */
    requestedHierarchyRole?: BranchHierarchyRole | null
    requestedParentBranchId?: number | null
    requestedParentBranchName?: string | null
    requestedParentCrc?: string | null
  }>
  addresses: Array<{ requestAddressId: number; address: string; branchId: number | null }>
  approvers: Array<{
    level: number
    email: string
    designation: string
    band: ApprovalLevelBand | null
    resolution: ApproverResolution
    existingName: string | null
    existingRole: string | null
    recordedResolution: string | null
  }>
  approvalLevelsApply: boolean
  emailDomain: string | null
  /** Listed cities an Apricart warehouse serves, and how many; absent from older responses. */
  warehouseCities?: Array<{ city: string; warehouseCount: number }>
  decisionReason: string | null
}

/**
 * `mapToBranchId`: a branch id to use instead, `CREATE_NEW_BRANCH` to create
 * one, or `UNDECIDED` while a CRC another branch carries awaits Head Office's
 * choice (plans/OF-JOIN-crc-match-at-review.md).
 *
 * `hierarchyRole` and `parent` are the created branch's type and a child's
 * parent: `branch:<id>` an existing branch, `request:<id>` another branch this
 * approval creates as Parent, "" none yet
 * (plans/OF-JOIN-new-branch-parent-child.md).
 */
type NewBranchDraft = { mapToBranchId: string; hierarchyRole: BranchHierarchyRole; parent: string } & Record<NewBranchField, string>

/** A problem with a new branch's draft, by field; `parent` is the child's parent. */
type DraftErrors = Partial<Record<NewBranchField | "parent", string>>

const CREATE_NEW_BRANCH = ""
const UNDECIDED = "undecided"
const EXISTING_PARENT = "branch:"
const CREATED_PARENT = "request:"

/** The branch a draft maps its CRC onto, or null when it creates one or has not chosen. */
function mappedBranchIdOf(draft: NewBranchDraft): number | null {
  return draft.mapToBranchId === CREATE_NEW_BRANCH || draft.mapToBranchId === UNDECIDED ? null : Number(draft.mapToBranchId)
}

/** The parent the applicant proposed, as the dialog's select holds it. */
function requestedParentValue(row: Review["branches"][number], rows: Review["branches"]): string {
  if (row.requestedHierarchyRole !== "CHILD") return ""
  if (row.requestedParentBranchId) return `${EXISTING_PARENT}${row.requestedParentBranchId}`
  const parentRow = rows.find((other) => other.kind === "new" && other.costCenterId === row.requestedParentCrc)
  return parentRow ? `${CREATED_PARENT}${parentRow.requestBranchId}` : ""
}

/** The created branch's type and parent as the decision body names them. */
function hierarchyBody(draft: NewBranchDraft): {
  hierarchyRole: BranchHierarchyRole
  parentBranchId?: number
  parentRequestBranchId?: number
} {
  if (draft.hierarchyRole !== "CHILD") return { hierarchyRole: draft.hierarchyRole }
  if (draft.parent.startsWith(EXISTING_PARENT)) {
    return { hierarchyRole: "CHILD", parentBranchId: Number(draft.parent.slice(EXISTING_PARENT.length)) }
  }
  return { hierarchyRole: "CHILD", parentRequestBranchId: Number(draft.parent.slice(CREATED_PARENT.length)) }
}

const NEW_BRANCH_FIELD_LABELS: Record<NewBranchField | "parent", string> = {
  name: "Branch name",
  province: "Province",
  city: "City",
  address: "Branch address",
  parent: "Parent branch",
}

/** The city before its province, which is filled in from it. */
const NEW_BRANCH_FIELD_ORDER: readonly NewBranchField[] = ["name", "city", "province", "address"]

/**
 * The draft's errors, without a blank province while the city is missing too:
 * the province comes from the city, so the city is the one thing to fix.
 */
function draftErrors(draft: NewBranchDraft, parentValues: ReadonlySet<string>): DraftErrors {
  const errors: DraftErrors = newBranchDraftErrors(draft)
  if (errors.city && !draft.province.trim()) delete errors.province
  // A child's parent must be one the select offers now: an organization's
  // parent branch, or a branch created here as Parent. The applicant's choice
  // may no longer be one. The server re-checks both.
  if (draft.hierarchyRole === "CHILD" && !parentValues.has(draft.parent)) {
    errors.parent = draft.parent ? "That branch is not a parent branch now. Choose another." : "Choose the parent branch"
  }
  return errors
}

/**
 * The city and province a new branch's draft starts from: the applicant's
 * listed city and the list's own province, else blank for Head Office to
 * choose (plans/OF-JOIN-applicant-new-branch-city.md).
 */
function requestedLocationDraft(city: string | null | undefined): Pick<NewBranchDraft, "city" | "province"> {
  const listed = findPakistanCity(city)
  return listed ? { city: listed.name, province: listed.province } : { city: "", province: "" }
}

/**
 * What approving means for deliveries from the new branch's city
 * (plans/OF-JOIN-new-branch-city-warehouse.md). Counts only: Head Office is
 * never told which Apricart account serves it.
 */
function WarehouseCoverageNote({ city, served }: Readonly<{ city: string; served: Review["warehouseCities"] }>) {
  const listed = findPakistanCity(city)
  if (!listed || served === undefined) return null
  const count = served.find((entry) => entry.city === listed.name)?.warehouseCount ?? 0
  if (count > 0) {
    return (
      <p className="text-xs text-emerald-800 sm:col-span-2">
        {listed.name} is served by {count === 1 ? "an Apricart warehouse" : `${count} Apricart warehouses`}. Approving
        adds this branch to {count === 1 ? "its" : "their"} deliveries.
      </p>
    )
  }
  return (
    <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 sm:col-span-2">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      No Apricart warehouse serves {listed.name} yet. This branch&apos;s orders will not reach a warehouse until
      Apricart assigns one.
    </p>
  )
}

/**
 * A created branch's type, and a child's parent, as on Create Branch. Starts
 * from the applicant's proposal, named under the select when it was one; a
 * label only (plans/OF-JOIN-new-branch-parent-child.md).
 */
function BranchTypeChoice({
  row,
  draft,
  parentOptions,
  parentError,
  onChange,
}: Readonly<{
  row: Review["branches"][number]
  draft: NewBranchDraft
  parentOptions: Array<{ value: string; label: string }>
  parentError?: string
  onChange: (patch: Partial<NewBranchDraft>) => void
}>) {
  const id = `review-branch-${row.requestBranchId}-type`
  const parentErrorId = `review-branch-${row.requestBranchId}-parent-error`
  const proposedParent = row.requestedParentBranchName
    ?? (row.requestedParentCrc ? `the new branch for CRC ${row.requestedParentCrc}` : null)
  let proposal: string | null = null
  if (row.requestedHierarchyRole === "CHILD") proposal = `The applicant proposed: Child of ${proposedParent ?? "a parent branch"}.`
  else if (row.requestedHierarchyRole) proposal = `The applicant proposed: ${BRANCH_HIERARCHY_LABELS[row.requestedHierarchyRole]}.`
  return (
    <>
      <select
        id={id}
        aria-label={`Branch type for CRC ${row.costCenterId}`}
        value={draft.hierarchyRole}
        onChange={(event) => {
          if (isBranchHierarchyRole(event.target.value)) onChange({ hierarchyRole: event.target.value, parent: "" })
        }}
        className="h-9 rounded-md border border-slate-300 px-2 text-sm"
      >
        {BRANCH_HIERARCHY_ROLES.map((role) => <option key={role} value={role}>Branch type: {BRANCH_HIERARCHY_LABELS[role]}</option>)}
      </select>
      {draft.hierarchyRole === "CHILD" && (
        <div className="space-y-1">
          <select
            aria-label={`Parent branch for CRC ${row.costCenterId}`}
            value={draft.parent}
            onChange={(event) => onChange({ parent: event.target.value })}
            aria-invalid={Boolean(parentError)}
            aria-describedby={parentError ? parentErrorId : undefined}
            className="h-9 w-full rounded-md border border-slate-300 px-2 text-sm"
          >
            <option value="">Select the parent branch</option>
            {draft.parent && !parentOptions.some((option) => option.value === draft.parent) && (
              <option value={draft.parent} disabled>{proposedParent ?? "The proposed parent"} (not a parent branch now)</option>
            )}
            {parentOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {parentError && <p id={parentErrorId} className="text-xs font-medium text-red-600">{parentError}</p>}
        </div>
      )}
      {proposal && <p className="text-xs text-slate-500 sm:col-span-2">{proposal}</p>}
    </>
  )
}

const ROLE_LABELS = {
  ORDER_PORTAL: `${ROLE_DISPLAY_NAMES.ORDER_PORTAL} (one branch)`,
  GROUP_ORDER_PORTAL: `${ROLE_DISPLAY_NAMES.GROUP_ORDER_PORTAL} (several branches)`,
} as const

const CONVERTED_NOTE = "They become a Group Financial Approver instead of a Financial Approver, keep their own branch, and are signed out."

/**
 * What approving does with one approver. `branchCount` is the count after
 * Head Office's choices in this dialog, so a new approver's role shown here is
 * the one the approval will give (Levels 1 and 2: Group User; other levels:
 * Branch Admin for one branch, Group User for more).
 */
function resolutionText(
  resolution: ApproverResolution,
  level: number,
  existingName: string | null,
  branchCount: number,
  onlyBranch: string,
): string {
  const who = existingName ?? "Existing account"
  switch (resolution.kind) {
    case "create":
      return newApproverRole(level, branchCount) === "BRANCH_ADMIN"
        ? `No account yet: a Financial Approver of ${onlyBranch} is created with Level ${level}, and a temporary password is emailed.`
        : `No account yet: a Group Financial Approver is created with Level ${level} and these branches, and a temporary password is emailed.`
    case "assign":
      return resolution.becomesGroupUser
        ? `${who}: is given Level ${level} and these branches. ${CONVERTED_NOTE}`
        : `${who}: is given Level ${level}${resolution.addBranchIds.length > 0 ? " and the branches they lack" : ""}.`
    case "extend":
      return resolution.becomesGroupUser
        ? `${who}: already Level ${level}; is given these branches. ${CONVERTED_NOTE}`
        : `${who}: already Level ${level}; is given the branches they lack.`
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
  const { data: branchesData } = useSWR<{ items?: Array<JoinOption & { hierarchyRole?: string | null }> }>(
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
  const [showBranchErrors, setShowBranchErrors] = useState(false)
  const [editing, setEditing] = useState(false)

  useEffect(() => {
    setReason("")
    setUsername("")
    setNewBranches({})
    setAddressBranches({})
    setFailure(null)
    setShowBranchErrors(false)
    setBusy(null)
    setEditing(false)
  }, [requestId])

  if (!requestId) return null

  const pending = review?.status === "pending"
  const blocked = review?.approvers.some((approver) => approver.resolution.kind === "blocked") ?? false
  const branchLabel = (row: Review["branches"][number]) =>
    row.name ?? row.requestedName ?? `New branch for CRC ${row.costCenterId}`
  // A new branch starts from the name and city the applicant gave it, never
  // from its CRC; Head Office may change either. A CRC another branch already
  // carries starts undecided: neither choice is made for Head Office.
  // Its type starts from the applicant's proposal too, Standalone when none.
  const draftFor = (row: Review["branches"][number]): NewBranchDraft =>
    newBranches[row.requestBranchId] ?? {
      mapToBranchId: row.crcMatch ? UNDECIDED : CREATE_NEW_BRANCH,
      name: row.requestedName ?? "",
      ...requestedLocationDraft(row.requestedCity),
      address: review?.addresses[0]?.address ?? "",
      hierarchyRole: row.requestedHierarchyRole ?? DEFAULT_BRANCH_HIERARCHY_ROLE,
      parent: requestedParentValue(row, review?.branches ?? []),
    }
  const updateDraft = (row: Review["branches"][number], patch: Partial<NewBranchDraft>) =>
    setNewBranches((previous) => ({ ...previous, [row.requestBranchId]: { ...draftFor(row), ...patch } }))
  /**
   * The parents a child created here may name: the organization's parent
   * branches, and the other branches this approval creates as Parent.
   */
  const parentOptionsFor = (row: Review["branches"][number]): Array<{ value: string; label: string }> => [
    ...organizationBranches
      .filter((branch) => branch.hierarchyRole === "PARENT")
      .map((branch) => ({ value: `${EXISTING_PARENT}${branch.id}`, label: branch.name })),
    ...(review?.branches ?? []).flatMap((other) => {
      if (other.requestBranchId === row.requestBranchId || other.kind !== "new" || other.branchId !== null) return []
      const otherDraft = draftFor(other)
      return otherDraft.mapToBranchId === CREATE_NEW_BRANCH && otherDraft.hierarchyRole === "PARENT"
        ? [{ value: `${CREATED_PARENT}${other.requestBranchId}`, label: `${otherDraft.name.trim() || branchLabel(other)} (created here)` }]
        : []
    }),
  ]
  /**
   * The new branches Head Office still has to settle: a CRC another branch
   * carries needs a choice, and a branch to create needs its details. Mapping
   * a CRC onto an existing branch needs no details.
   */
  const incompleteNewBranches = (review?.branches ?? []).flatMap((row) => {
    if (row.kind !== "new" || row.branchId !== null) return []
    const draft = draftFor(row)
    if (draft.mapToBranchId === UNDECIDED) return [{ row, errors: {} as DraftErrors, undecided: true }]
    if (draft.mapToBranchId !== CREATE_NEW_BRANCH) return []
    const errors = draftErrors(draft, new Set(parentOptionsFor(row).map((option) => option.value)))
    return Object.keys(errors).length > 0 ? [{ row, errors, undecided: false }] : []
  })
  // The count the approval will see once each CRC's choice here is applied.
  const mappedBranchIds = Object.fromEntries(Object.entries(newBranches).map(([requestBranchId, draft]) => [
    Number(requestBranchId),
    mappedBranchIdOf(draft),
  ]))
  const reviewedBranchCount = review?.branches.length ?? 0
  const finalBranchCount = review ? branchCountAfterReview(review.branches, mappedBranchIds) : 0
  const onlyBranchLabel = (() => {
    const row = review?.branches[0]
    if (!row) return "the branch"
    const mapped = mappedBranchIds[row.requestBranchId]
    const mappedName = mapped ? organizationBranches.find((branch) => branch.id === mapped)?.name : null
    return mappedName ?? branchLabel(row)
  })()
  const branchErrorsFor = (requestBranchId: number) =>
    (showBranchErrors && incompleteNewBranches.find((entry) => entry.row.requestBranchId === requestBranchId)?.errors) || {}

  const decide = async (decision: "approve" | "reject") => {
    if (!review) return
    if (decision === "approve" && incompleteNewBranches.length > 0) {
      // Presentation only: the decision schema refuses the same fields.
      const [{ row, errors, undecided }] = incompleteNewBranches
      setShowBranchErrors(true)
      if (undecided && row.crcMatch) {
        setFailure(`CRC ${row.costCenterId} already belongs to ${row.crcMatch.name}. Choose whether to use ${row.crcMatch.name} or create a new branch before approving.`)
        return
      }
      const fields = [...NEW_BRANCH_FIELDS, "parent" as const]
        .filter((field) => errors[field])
        .map((field) => NEW_BRANCH_FIELD_LABELS[field].toLowerCase())
      setFailure(`Complete the new branch for CRC ${row.costCenterId} before approving: ${fields.join(", ")}.`)
      return
    }
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
                const draft = draftFor(row)
                const mapToBranchId = mappedBranchIdOf(draft)
                return mapToBranchId !== null
                  ? { requestBranchId: row.requestBranchId, mapToBranchId }
                  : {
                      requestBranchId: row.requestBranchId,
                      name: draft.name.trim(),
                      province: draft.province.trim(),
                      city: draft.city.trim(),
                      address: draft.address.trim(),
                      ...hierarchyBody(draft),
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

        {review && pending && editing && (
          <DepartmentJoinEditForm
            requestId={review.id}
            review={review}
            emailDomain={review.emailDomain}
            organizationBranches={organizationBranches}
            onCancel={() => setEditing(false)}
            onSaved={() => {
              setEditing(false)
              setFailure(null)
              setShowBranchErrors(false)
              void mutate()
            }}
          />
        )}

        {review && !editing && (
          <div className="space-y-5">
            {pending && (
              <div className="flex justify-end">
                <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)} disabled={busy !== null}>
                  <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" /> Edit details
                </Button>
              </div>
            )}
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm">
              <dt className="font-medium text-slate-500">Email</dt>
              <dd className="break-all">
                {review.person.email}
                <EmailVerifiedNote verified={review.person.emailVerified === true} />
              </dd>
              <dt className="font-medium text-slate-500">Username</dt>
              <dd className="font-mono">{review.person.username}</dd>
              <dt className="font-medium text-slate-500">Phone / IP ext.</dt>
              <dd>{review.person.phone ?? "—"} / {review.person.ipExtension ?? "—"}</dd>
              <dt className="font-medium text-slate-500">Employee ID</dt>
              <dd>{review.person.employeeId ?? "—"}</dd>
              <dt className="font-medium text-slate-500">Department</dt>
              <dd>{review.person.department ?? "—"}</dd>
              <dt className="font-medium text-slate-500">Will be</dt>
              <dd>{ROLE_LABELS[pending ? initiatorRoleForBranchCount(finalBranchCount) : review.initiatorRole]}</dd>
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
                  const draft = draftFor(row)
                  const isNew = row.kind === "new" && row.branchId === null
                  const match = isNew ? row.crcMatch ?? null : null
                  const undecided = draft.mapToBranchId === UNDECIDED
                  const crcMatchNoteId = `review-branch-${row.requestBranchId}-crc-match`
                  return (
                    <li key={row.requestBranchId} className="rounded-md border border-slate-200 p-3 text-sm">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{branchLabel(row)}</span>
                        {row.kind === "new" && <Badge variant="outline">CRC {row.costCenterId}</Badge>}
                      </div>
                      {pending && match && (
                        <p id={crcMatchNoteId} className="mt-2 flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                          <span>
                            CRC {row.costCenterId} already belongs to <strong>{match.name}</strong>. The applicant asked
                            for a new branch{row.requestedName ? ` named "${row.requestedName}"` : ""}. Use {match.name},
                            or create a new branch.
                          </span>
                        </p>
                      )}
                      {pending && isNew && (
                        <div className="mt-2 grid gap-2 sm:grid-cols-2">
                          <select
                            aria-label={`Map CRC ${row.costCenterId} to an existing branch`}
                            value={draft.mapToBranchId}
                            onChange={(event) => updateDraft(row, { mapToBranchId: event.target.value })}
                            aria-invalid={showBranchErrors && undecided}
                            aria-describedby={match ? crcMatchNoteId : undefined}
                            className="h-9 rounded-md border border-slate-300 px-2 text-sm sm:col-span-2"
                          >
                            {match && <option value={UNDECIDED} disabled>Choose: use {match.name} or create a new branch</option>}
                            {match && <option value={match.branchId}>Use existing: {match.name} (has CRC {row.costCenterId})</option>}
                            <option value={CREATE_NEW_BRANCH}>Create a new branch</option>
                            {organizationBranches
                              .filter((branch) => branch.id !== match?.branchId)
                              .map((branch) => <option key={branch.id} value={branch.id}>Use existing: {branch.name}</option>)}
                          </select>
                          {draft.mapToBranchId === CREATE_NEW_BRANCH && NEW_BRANCH_FIELD_ORDER.map((field) => {
                            const fieldError = branchErrorsFor(row.requestBranchId)[field]
                            const errorId = `review-branch-${row.requestBranchId}-${field}-error`
                            let control: ReactNode
                            if (field === "city") {
                              control = (
                                <PakistanCityCombobox
                                  value={draft.city}
                                  onSelect={(city) => updateDraft(row, { city: city.name, province: city.province })}
                                  invalid={Boolean(fieldError)}
                                  describedBy={fieldError ? errorId : undefined}
                                />
                              )
                            } else {
                              control = (
                                <Input
                                  aria-label={NEW_BRANCH_FIELD_LABELS[field]}
                                  placeholder={field === "province" ? "Filled in from the city" : NEW_BRANCH_FIELD_LABELS[field]}
                                  value={draft[field]}
                                  // The province is the city's own; it follows the city chosen.
                                  readOnly={field === "province"}
                                  className={field === "province" ? "bg-slate-50" : undefined}
                                  onChange={(event) => updateDraft(row, { [field]: event.target.value })}
                                  aria-invalid={Boolean(fieldError)}
                                  aria-describedby={fieldError ? errorId : undefined}
                                />
                              )
                            }
                            return (
                              <div key={field} className="space-y-1">
                                {control}
                                {fieldError && <p id={errorId} className="text-xs font-medium text-red-600">{fieldError}</p>}
                              </div>
                            )
                          })}
                          {draft.mapToBranchId === CREATE_NEW_BRANCH && (
                            <BranchTypeChoice
                              row={row}
                              draft={draft}
                              parentOptions={parentOptionsFor(row)}
                              parentError={branchErrorsFor(row.requestBranchId).parent}
                              onChange={(patch) => updateDraft(row, patch)}
                            />
                          )}
                          {draft.mapToBranchId === CREATE_NEW_BRANCH && draft.city && (
                            <WarehouseCoverageNote city={draft.city} served={review.warehouseCities} />
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
              {pending && finalBranchCount !== reviewedBranchCount && (
                <p className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  With your branch choices this person has {finalBranchCount} branch{finalBranchCount === 1 ? "" : "es"}, not {reviewedBranchCount}.
                  Approver roles follow the final branches: one branch makes a Financial Approver, more make a Group Financial Approver.
                </p>
              )}
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
                        ? resolutionText(approver.resolution, approver.level, approver.existingName, finalBranchCount, onlyBranchLabel)
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

        {review && pending && !editing && (
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
