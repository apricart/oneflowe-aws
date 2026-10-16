"use client"

import { useRef, useState } from "react"

import { Loader2, Plus, X } from "lucide-react"

import { Field } from "@/components/join/join-request-form"
import type { JoinOption } from "@/components/join/join-scope-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { jsonFetcher } from "@/lib/fetcher"
import {
  type DepartmentJoinEditDraft,
  type JoinEditSource,
  crcBranchKey,
  crcDraftError,
  departmentJoinEditErrors,
  draftFromReview,
  existingBranchKey,
  toDepartmentJoinUpdatePayload,
} from "@/lib/join-department-edit"
import {
  DEPARTMENTS,
  SIGNUP_MAX_ADDRESSES,
  SIGNUP_MAX_BRANCHES,
  normalizeCrc,
} from "@/lib/join-department-signup"
import { payloadSizeError } from "@/lib/join-department-signup-form"

/**
 * Head Office correcting a pending department sign-up before deciding it
 * (plans/OF-JOIN-department-signup-multi-user.md, "Editing at review").
 *
 * Every field the applicant typed, except the password and the acceptance of
 * the terms. The problems shown here are a courtesy: the endpoint re-validates
 * the whole request, and the review reloaded after saving shows what approving
 * would now do.
 */

const PERSON_FIELDS: Array<{ field: keyof Pick<DepartmentJoinEditDraft, "firstName" | "lastName" | "email" | "username" | "phone" | "ipExtension" | "employeeId">; label: string; type?: string }> = [
  { field: "firstName", label: "First name" },
  { field: "lastName", label: "Last name" },
  { field: "email", label: "Email", type: "email" },
  { field: "username", label: "Username" },
  { field: "phone", label: "Phone" },
  { field: "ipExtension", label: "IP extension" },
  { field: "employeeId", label: "Employee ID" },
]

const selectClass = "h-9 w-full rounded-md border border-slate-300 bg-white px-2 text-sm"

export function DepartmentJoinEditForm({
  requestId,
  review,
  emailDomain,
  organizationBranches,
  onSaved,
  onCancel,
}: Readonly<{
  requestId: number
  review: JoinEditSource
  emailDomain: string | null
  organizationBranches: JoinOption[]
  onSaved: () => void
  onCancel: () => void
}>) {
  const [draft, setDraft] = useState<DepartmentJoinEditDraft>(() => draftFromReview(review))
  const [pickBranchId, setPickBranchId] = useState("")
  const [crc, setCrc] = useState("")
  const [crcProblem, setCrcProblem] = useState<string | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const nextAddressKey = useRef(0)

  const errors = departmentJoinEditErrors(draft, emailDomain)
  const shownError = (key: string) => (showErrors ? errors[key] : undefined)
  const patch = (changes: Partial<DepartmentJoinEditDraft>) => setDraft((previous) => ({ ...previous, ...changes }))

  const listedBranchIds = new Set(draft.branches.flatMap((entry) => (entry.kind === "existing" ? [entry.branchId] : [])))
  const pickable = organizationBranches.filter((branch) => !listedBranchIds.has(branch.id))
  const branchesFull = draft.branches.length >= SIGNUP_MAX_BRANCHES

  const addExistingBranch = () => {
    const branch = organizationBranches.find((option) => String(option.id) === pickBranchId)
    if (!branch || branchesFull) return
    patch({ branches: [...draft.branches, { key: existingBranchKey(branch.id), kind: "existing", branchId: branch.id, label: branch.name }] })
    setPickBranchId("")
  }

  const addCrc = () => {
    const problem = crcDraftError(draft, crc)
    setCrcProblem(problem)
    if (problem) return
    const normalized = normalizeCrc(crc)
    patch({ branches: [...draft.branches, { key: crcBranchKey(normalized), kind: "crc", crc: normalized, label: `New branch for CRC ${normalized}` }] })
    setCrc("")
  }

  const addAddress = () => {
    nextAddressKey.current += 1
    patch({ addresses: [...draft.addresses, { key: `new:${nextAddressKey.current}`, address: "" }] })
  }

  const save = async () => {
    setShowErrors(true)
    setFailure(null)
    if (Object.keys(errors).length > 0) {
      setFailure("Correct the highlighted fields before saving.")
      return
    }
    const payload = toDepartmentJoinUpdatePayload(draft)
    const tooLong = payloadSizeError(payload)
    if (tooLong) {
      setFailure(tooLong)
      return
    }
    setBusy(true)
    try {
      await jsonFetcher(`/api/v1/join-requests/${requestId}`, { method: "PATCH", body: JSON.stringify(payload) })
      onSaved()
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "The changes could not be saved. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold text-slate-900">Person placing the orders</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {PERSON_FIELDS.map(({ field, label, type }) => {
            const id = `edit-${field}`
            const fieldError = shownError(field)
            return (
              <Field key={field} id={id} label={label} required={field !== "lastName"} error={fieldError}>
                <Input
                  id={id}
                  type={type ?? "text"}
                  value={draft[field]}
                  onChange={(event) => patch({ [field]: event.target.value })}
                  aria-invalid={Boolean(fieldError)}
                  aria-describedby={fieldError ? `${id}-error` : undefined}
                />
              </Field>
            )
          })}
          <Field id="edit-department" label="Department" required error={shownError("department")}>
            <select
              id="edit-department"
              value={draft.department}
              onChange={(event) => patch({ department: event.target.value })}
              className={selectClass}
              aria-invalid={Boolean(shownError("department"))}
              aria-describedby={shownError("department") ? "edit-department-error" : undefined}
            >
              <option value="">Select a department</option>
              {DEPARTMENTS.map((department) => <option key={department} value={department}>{department}</option>)}
            </select>
          </Field>
        </div>
        {emailDomain && <p className="text-xs text-slate-500">Email addresses must be at @{emailDomain}.</p>}
        <p className="text-xs text-slate-500">The password stays the one the applicant chose.</p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Branches (CRC)</h3>
        <ul className="space-y-1.5">
          {draft.branches.map((entry) => (
            <li key={entry.key} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-sm">
              <span>{entry.label}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove ${entry.label}`}
                onClick={() => patch({ branches: draft.branches.filter((other) => other.key !== entry.key) })}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
        {shownError("branches") && <p className="text-xs font-medium text-red-600">{shownError("branches")}</p>}
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex gap-2">
            <select
              aria-label="Add an existing branch"
              value={pickBranchId}
              onChange={(event) => setPickBranchId(event.target.value)}
              className={selectClass}
              disabled={branchesFull}
            >
              <option value="">Add an existing branch</option>
              {pickable.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
            </select>
            <Button type="button" variant="outline" onClick={addExistingBranch} disabled={!pickBranchId || branchesFull}>
              Add
            </Button>
          </div>
          <div className="space-y-1">
            <div className="flex gap-2">
              <Input
                aria-label="Add a CRC number"
                placeholder="CRC number"
                value={crc}
                onChange={(event) => { setCrc(event.target.value); setCrcProblem(null) }}
                disabled={branchesFull}
              />
              <Button type="button" variant="outline" onClick={addCrc} disabled={!crc.trim() || branchesFull}>
                Add
              </Button>
            </div>
            {crcProblem && <p className="text-xs font-medium text-red-600">{crcProblem}</p>}
          </div>
        </div>
        <p className="text-xs text-slate-500">
          A CRC that belongs to exactly one of your branches becomes that branch when saved.
        </p>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Delivery addresses</h3>
        <ul className="space-y-1.5">
          {draft.addresses.map((row, index) => (
            <li key={row.key} className="flex items-center gap-2">
              <Input
                aria-label={`Delivery address ${index + 1}`}
                value={row.address}
                onChange={(event) => patch({
                  addresses: draft.addresses.map((other) => (other.key === row.key ? { ...other, address: event.target.value } : other)),
                })}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-label={`Remove delivery address ${index + 1}`}
                onClick={() => patch({ addresses: draft.addresses.filter((other) => other.key !== row.key) })}
              >
                <X className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
        {shownError("addresses") && <p className="text-xs font-medium text-red-600">{shownError("addresses")}</p>}
        <Button type="button" variant="outline" size="sm" onClick={addAddress} disabled={draft.addresses.length >= SIGNUP_MAX_ADDRESSES}>
          <Plus className="mr-1 h-4 w-4" /> Add an address
        </Button>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Financial approvers</h3>
        {draft.approvers.map((approver) => {
          const emailId = `edit-approver-${approver.level}-email`
          const designationId = `edit-approver-${approver.level}-designation`
          const update = (changes: Partial<typeof approver>) => patch({
            approvers: draft.approvers.map((other) => (other.level === approver.level ? { ...other, ...changes } : other)),
          })
          return (
            <div key={approver.level} className="grid gap-2 rounded-md border border-slate-200 p-3 sm:grid-cols-2">
              <Field id={emailId} label={`Level ${approver.level} email`} required error={shownError(`approver${approver.level}Email`)}>
                <Input
                  id={emailId}
                  type="email"
                  value={approver.email}
                  onChange={(event) => update({ email: event.target.value })}
                  aria-invalid={Boolean(shownError(`approver${approver.level}Email`))}
                  aria-describedby={shownError(`approver${approver.level}Email`) ? `${emailId}-error` : undefined}
                />
              </Field>
              <Field id={designationId} label={`Level ${approver.level} designation`} required error={shownError(`approver${approver.level}Designation`)}>
                <Input
                  id={designationId}
                  value={approver.designation}
                  onChange={(event) => update({ designation: event.target.value })}
                  aria-invalid={Boolean(shownError(`approver${approver.level}Designation`))}
                  aria-describedby={shownError(`approver${approver.level}Designation`) ? `${designationId}-error` : undefined}
                />
              </Field>
            </div>
          )
        })}
      </section>

      {failure && <p role="alert" className="text-sm font-medium text-red-600">{failure}</p>}

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="button" onClick={save} disabled={busy}>
          {busy ? <span className="inline-flex items-center gap-2"><Loader2 className="h-4 w-4 animate-spin" /> Saving…</span> : "Save changes"}
        </Button>
      </div>
    </div>
  )
}
