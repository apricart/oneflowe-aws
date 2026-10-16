"use client"

import { useMemo, useState } from "react"

import { AlertCircle, Eye, EyeOff, Plus, X } from "lucide-react"

import { Field } from "@/components/join/join-request-form"
import type { JoinOption } from "@/components/join/join-scope-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/skeleton"
import {
  CRC_MAX_LENGTH,
  DEPARTMENTS,
  NEW_BRANCH_FIELD_RULES,
  SIGNUP_ADDRESS_MAX_LENGTH,
  SIGNUP_DESIGNATION_MAX_LENGTH,
  deriveUsernameFromEmail,
  normalizeBranchName,
  normalizeCrc,
} from "@/lib/join-department-signup"
import {
  type AddressChip,
  type BranchChip,
  type DepartmentSignupDraft,
  addressDraftError,
  departmentSignupErrors,
  emptyDepartmentSignupDraft,
  newBranchChipError,
  newBranchNameChipError,
  payloadSizeError,
  sameBranchName,
  toDepartmentSignupPayload,
} from "@/lib/join-department-signup-form"
import { type ApprovalLevelBand, approvalLevelBandText } from "@/lib/order-approval-levels"
import { EMAIL_LOCAL_PART_MAX_LENGTH } from "@/lib/organization-email-domain"
import { organizationUsername } from "@/lib/username-prefix"
import { cn } from "@/lib/utils"

/**
 * The department sign-up: the join form of an organization with order
 * approval levels on (plans/OF-JOIN-department-signup-multi-user.md), laid out
 * as the design (`Apricart Department_Signup_Portal.html`) asks.
 *
 * Differences from the design, each deliberate:
 *   * no master code — the join code, checked on the server, was the first step;
 *   * the email domain is the organization's own, fixed as the suffix;
 *   * one approver card per level the organization has, not a fixed three;
 *   * the branch is picked by name from the organization's branches; a new
 *     one is named by the applicant and only then given its CRC. No CRC
 *     number of an existing branch is ever sent to this page.
 *
 * Nothing here decides anything: the server re-validates all of it, and Head
 * Office approves before any account, branch or approver exists.
 */

export type DepartmentSignupOptions = {
  organizationName: string
  emailDomain: string
  branches: JoinOption[]
  approvalLevels: ApprovalLevelBand[]
}

const INPUT_SELECT_CLASS =
  "flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-red-500"

function DomainEmailInput({
  id,
  value,
  onChange,
  domain,
  error,
  placeholder,
}: Readonly<{
  id: string
  value: string
  onChange: (value: string) => void
  domain: string
  error?: string
  placeholder: string
}>) {
  return (
    <div className="flex">
      <Input
        id={id}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={EMAIL_LOCAL_PART_MAX_LENGTH}
        className="min-w-0 rounded-r-none"
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-domain ${id}-error` : `${id}-domain`}
      />
      <span
        id={`${id}-domain`}
        className="inline-flex max-w-[60%] shrink-0 items-center truncate rounded-r-md border border-l-0 border-slate-300 bg-slate-100 px-3 text-sm font-medium text-slate-700"
        title={`@${domain}`}
      >
        @{domain}
      </span>
    </div>
  )
}

function ReadOnlyValue({ id, value, placeholder }: Readonly<{ id: string; value: string; placeholder: string }>) {
  return (
    <Input
      id={id}
      value={value}
      placeholder={placeholder}
      readOnly
      tabIndex={-1}
      className="cursor-not-allowed bg-slate-100 text-slate-600"
    />
  )
}

function ChipRemove({ label, onClick }: Readonly<{ label: string; onClick: () => void }>) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Remove ${label}`}
      className="rounded p-0.5 text-slate-400 hover:text-red-600"
    >
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  )
}

/**
 * The Branch field: the applicant searches the organization's branches by name
 * and picks one. A branch that is not listed is added as new, and only then is
 * its CRC (cost centre) number asked for, so a new branch always has a name of
 * its own and is never named after its CRC.
 */
function BranchChipsField({
  chips,
  onChange,
  branches,
  error,
}: Readonly<{
  chips: BranchChip[]
  onChange: (chips: BranchChip[]) => void
  branches: JoinOption[]
  error?: string
}>) {
  const [text, setText] = useState("")
  // The name of the new branch whose CRC is being asked for, or null.
  const [newBranchName, setNewBranchName] = useState<string | null>(null)
  const [crc, setCrc] = useState("")
  const [problem, setProblem] = useState<{ field: "name" | "crc"; message: string } | null>(null)

  const chosenIds = useMemo(
    () => new Set(chips.flatMap((chip) => (chip.kind === "existing" ? [chip.branchId] : []))),
    [chips],
  )
  const knownNames = useMemo(() => branches.map((branch) => branch.name), [branches])
  const typed = normalizeBranchName(text)
  const exactMatch = typed ? branches.find((branch) => sameBranchName(branch.name, typed)) : undefined
  const suggestions = useMemo(() => {
    const needle = text.trim().toLowerCase()
    if (needle.length < 2) return []
    return branches
      .filter((branch) => !chosenIds.has(branch.id) && branch.name.toLowerCase().includes(needle))
      .slice(0, 6)
  }, [text, branches, chosenIds])
  const offerNew = typed.length >= 2 && !exactMatch

  const addExisting = (branch: JoinOption) => {
    if (!chosenIds.has(branch.id)) {
      onChange([...chips, { key: `b${branch.id}`, kind: "existing", branchId: branch.id, label: branch.name, checked: true }])
    }
    setText("")
    setProblem(null)
  }

  /** Add what was typed: the listed branch when the name is one, else start a new branch. */
  const addTyped = () => {
    if (!typed) return
    if (exactMatch) {
      addExisting(exactMatch)
      return
    }
    const refusal = newBranchNameChipError(chips, knownNames, typed)
    if (refusal) {
      setProblem({ field: "name", message: refusal })
      return
    }
    setNewBranchName(typed)
    setText("")
    setCrc("")
    setProblem(null)
  }

  const addNewBranch = () => {
    if (newBranchName === null) return
    const refusal = newBranchChipError(chips, knownNames, { name: newBranchName, crc })
    if (refusal) {
      setProblem(refusal)
      return
    }
    const normalized = normalizeCrc(crc)
    onChange([...chips, { key: `c${normalized}`, kind: "crc", crc: normalized, name: newBranchName, label: newBranchName, checked: true }])
    setNewBranchName(null)
    setCrc("")
    setProblem(null)
  }

  const cancelNewBranch = () => {
    setText(newBranchName ?? "")
    setNewBranchName(null)
    setCrc("")
    setProblem(null)
  }

  const nameError = problem?.field === "name" ? problem.message : undefined
  const crcProblem = problem?.field === "crc" ? problem.message : undefined
  return (
    <div className="space-y-2">
      {newBranchName === null
        ? (
          <div className="relative">
            <div className="flex gap-2">
              <Input
                id="signup-branch"
                value={text}
                onChange={(event) => {
                  setText(event.target.value)
                  setProblem(null)
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    addTyped()
                  }
                }}
                placeholder="Search your branch by name"
                autoComplete="off"
                maxLength={NEW_BRANCH_FIELD_RULES.name.max}
                aria-invalid={Boolean(nameError)}
                aria-describedby={nameError ? "signup-branch-error" : "signup-branch-hint"}
              />
              <Button type="button" variant="outline" onClick={addTyped} className="shrink-0 gap-1">
                <Plus className="h-4 w-4" aria-hidden="true" /> Add
              </Button>
            </div>
            {(suggestions.length > 0 || offerNew) && (
              <ul className="absolute z-10 mt-1 w-full overflow-hidden rounded-md border border-slate-200 bg-white shadow-lg" role="listbox">
                {suggestions.map((branch) => (
                  <li key={branch.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={() => addExisting(branch)}
                      className="w-full px-3 py-2 text-left text-sm hover:bg-slate-50"
                    >
                      {branch.name}
                    </button>
                  </li>
                ))}
                {offerNew && (
                  <li className={cn(suggestions.length > 0 && "border-t border-slate-100")}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={false}
                      onClick={addTyped}
                      className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-sm font-medium text-blue-700 hover:bg-blue-50"
                    >
                      <Plus className="h-4 w-4" aria-hidden="true" /> Add “{typed}” as a new branch
                    </button>
                  </li>
                )}
              </ul>
            )}
            {nameError && <p id="signup-branch-error" className="mt-1 text-xs font-medium text-red-600">{nameError}</p>}
          </div>
        )
        : (
          <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/60 p-3">
            <p className="text-sm text-slate-700">
              New branch: <span className="font-semibold text-slate-900">{newBranchName}</span>
            </p>
            <div className="space-y-1">
              <label htmlFor="signup-new-branch-crc" className="text-sm font-medium text-slate-700">
                CRC / Cost Centre No<span className="text-red-500"> *</span>
              </label>
              <div className="flex flex-wrap gap-2 sm:flex-nowrap">
                <Input
                  id="signup-new-branch-crc"
                  value={crc}
                  onChange={(event) => {
                    setCrc(event.target.value.toUpperCase())
                    setProblem(null)
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault()
                      addNewBranch()
                    }
                  }}
                  placeholder="e.g. AB-ABC-123"
                  autoComplete="off"
                  autoFocus
                  maxLength={CRC_MAX_LENGTH}
                  className="bg-white"
                  aria-invalid={Boolean(crcProblem)}
                  aria-describedby={crcProblem ? "signup-new-branch-crc-error" : undefined}
                />
                <Button type="button" onClick={addNewBranch} className="shrink-0">Add branch</Button>
                <Button type="button" variant="outline" onClick={cancelNewBranch} className="shrink-0">Cancel</Button>
              </div>
              {crcProblem && <p id="signup-new-branch-crc-error" className="text-xs font-medium text-red-600">{crcProblem}</p>}
            </div>
          </div>
        )}
      <p id="signup-branch-hint" className="text-xs text-slate-500">
        Pick your branch if it is listed. If it is not, add it as a new branch and give its CRC number.
        One branch places your orders through the shop; more than one through the group storefront.
      </p>
      {chips.length === 0
        ? <p className="text-xs text-slate-500">No branches added yet.</p>
        : (
          <ul className="flex flex-wrap gap-2">
            {chips.map((chip) => (
              <li
                key={chip.key}
                className={cn(
                  "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                  chip.checked ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white",
                )}
              >
                <input
                  id={`signup-branch-${chip.key}`}
                  type="checkbox"
                  checked={chip.checked}
                  onChange={() => onChange(chips.map((item) => (item.key === chip.key ? { ...item, checked: !item.checked } : item)))}
                  className="accent-blue-600"
                />
                <label htmlFor={`signup-branch-${chip.key}`} className="cursor-pointer">
                  {chip.label}
                  {chip.kind === "crc" && <span className="ml-1 text-xs text-slate-500">(new · CRC {chip.crc})</span>}
                </label>
                <ChipRemove label={chip.label} onClick={() => onChange(chips.filter((item) => item.key !== chip.key))} />
              </li>
            ))}
          </ul>
        )}
      {error && <p id="signup-branches-error" className="text-xs font-medium text-red-600">{error}</p>}
    </div>
  )
}

function AddressChipsField({
  chips,
  onChange,
  error,
}: Readonly<{ chips: AddressChip[]; onChange: (chips: AddressChip[]) => void; error?: string }>) {
  const [text, setText] = useState("")
  const [problem, setProblem] = useState<string | null>(null)

  const add = () => {
    const refusal = addressDraftError(text)
    if (refusal) {
      setProblem(refusal)
      return
    }
    const address = text.trim()
    if (!chips.some((chip) => chip.address.toLowerCase() === address.toLowerCase())) {
      onChange([...chips, { key: `a${Date.now()}`, address, checked: true }])
    }
    setText("")
    setProblem(null)
  }

  const shownError = problem ?? error
  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <Input
          id="signup-address"
          value={text}
          onChange={(event) => {
            setText(event.target.value)
            setProblem(null)
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault()
              add()
            }
          }}
          placeholder="Enter a delivery address and press Add"
          autoComplete="street-address"
          maxLength={SIGNUP_ADDRESS_MAX_LENGTH}
          aria-invalid={Boolean(shownError)}
          aria-describedby={shownError ? "signup-address-error" : undefined}
        />
        <Button type="button" variant="outline" onClick={add} className="shrink-0 gap-1">
          <Plus className="h-4 w-4" aria-hidden="true" /> Add
        </Button>
      </div>
      {chips.length > 0 && (
        <ul className="space-y-2">
          {chips.map((chip) => (
            <li
              key={chip.key}
              className={cn(
                "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm",
                chip.checked ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white",
              )}
            >
              <input
                id={`signup-address-${chip.key}`}
                type="checkbox"
                checked={chip.checked}
                onChange={() => onChange(chips.map((item) => (item.key === chip.key ? { ...item, checked: !item.checked } : item)))}
                className="accent-blue-600"
              />
              <label htmlFor={`signup-address-${chip.key}`} className="flex-1 cursor-pointer leading-snug">
                {chip.address}
              </label>
              <ChipRemove label={chip.address} onClick={() => onChange(chips.filter((item) => item.key !== chip.key))} />
            </li>
          ))}
        </ul>
      )}
      {shownError && <p id="signup-address-error" className="text-xs font-medium text-red-600">{shownError}</p>}
    </div>
  )
}

/** The username an address will get: the organization's prefix, then the part before the `@`. */
function usernameFromEmail(organizationName: string, emailLocalPart: string): string {
  const base = deriveUsernameFromEmail(emailLocalPart)
  return base ? organizationUsername(organizationName, base) : ""
}

function ApproverLevels({
  draft,
  setDraft,
  bands,
  domain,
  organizationName,
  errors,
}: Readonly<{
  draft: DepartmentSignupDraft
  setDraft: (update: (previous: DepartmentSignupDraft) => DepartmentSignupDraft) => void
  bands: ApprovalLevelBand[]
  domain: string
  organizationName: string
  errors: Record<string, string>
}>) {
  const usernameFor = (emailLocalPart: string) => usernameFromEmail(organizationName, emailLocalPart)
  const update = (level: number, patch: Partial<{ emailLocalPart: string; designation: string }>) =>
    setDraft((previous) => ({
      ...previous,
      approvers: previous.approvers.map((approver) => (approver.level === level ? { ...approver, ...patch } : approver)),
    }))

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4" aria-labelledby="signup-approvers-title">
      <div>
        <h2 id="signup-approvers-title" className="text-sm font-bold text-slate-900">Financial Approver Levels</h2>
        <p className="text-xs text-slate-500">
          Enter the email and designation for each approval level; the username is generated automatically.
        </p>
      </div>
      {draft.approvers.map((approver) => {
        const band = bands[approver.level - 1]
        const emailId = `signup-approver-${approver.level}-email`
        const designationId = `signup-approver-${approver.level}-designation`
        return (
          <div key={approver.level} className="space-y-3 rounded-lg border border-slate-200 bg-white p-3">
            <p className="text-xs font-bold uppercase tracking-wide text-blue-700">
              Level {approver.level}
              {band && <span className="ml-2 font-medium normal-case text-slate-500">orders {approvalLevelBandText(band)}</span>}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field id={emailId} label="Email" required error={errors[`approver${approver.level}Email`]}>
                <DomainEmailInput
                  id={emailId}
                  value={approver.emailLocalPart}
                  onChange={(emailLocalPart) => update(approver.level, { emailLocalPart })}
                  domain={domain}
                  error={errors[`approver${approver.level}Email`]}
                  placeholder="first.last"
                />
              </Field>
              <Field id={`signup-approver-${approver.level}-username`} label="Username">
                <ReadOnlyValue
                  id={`signup-approver-${approver.level}-username`}
                  value={usernameFor(approver.emailLocalPart)}
                  placeholder="Auto-generated"
                />
              </Field>
            </div>
            <Field id={designationId} label="Designation" required error={errors[`approver${approver.level}Designation`]}>
              <Input
                id={designationId}
                value={approver.designation}
                onChange={(event) => update(approver.level, { designation: event.target.value })}
                placeholder="e.g. Manager, Head of Department"
                maxLength={SIGNUP_DESIGNATION_MAX_LENGTH}
                aria-invalid={Boolean(errors[`approver${approver.level}Designation`])}
                aria-describedby={errors[`approver${approver.level}Designation`] ? `${designationId}-error` : undefined}
              />
            </Field>
            <p className="text-xs text-slate-500">Login credentials will be sent to this email.</p>
          </div>
        )
      })}
    </section>
  )
}

export function DepartmentSignupForm({
  options,
  onSubmit,
  onBack,
}: Readonly<{
  options: DepartmentSignupOptions
  onSubmit: (payload: Record<string, unknown>) => Promise<void>
  onBack: () => void
}>) {
  const [draft, setDraftState] = useState<DepartmentSignupDraft>(() => emptyDepartmentSignupDraft(options.approvalLevels.length))
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const setDraft = (update: (previous: DepartmentSignupDraft) => DepartmentSignupDraft) => setDraftState(update)
  const usernameFor = (emailLocalPart: string) => usernameFromEmail(options.organizationName, emailLocalPart)
  const set = <K extends keyof DepartmentSignupDraft>(key: K, value: DepartmentSignupDraft[K]) =>
    setDraftState((previous) => ({ ...previous, [key]: value }))

  const handleSubmit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFailure(null)

    const found = departmentSignupErrors(draft)
    setErrors(found)
    if (Object.keys(found).length > 0) return

    const payload = toDepartmentSignupPayload(draft, options.emailDomain)
    const tooLarge = payloadSizeError(payload)
    if (tooLarge) {
      setFailure(tooLarge)
      return
    }

    setSubmitting(true)
    try {
      await onSubmit(payload)
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "We could not send your request. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-5" noValidate>
      <div className="rounded-lg border border-blue-100 bg-blue-50/70 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Joining</p>
        <p className="text-sm font-semibold text-slate-900">{options.organizationName}</p>
        <p className="text-xs text-slate-600">Create your account to get started.</p>
      </div>

      <Field id="signup-full-name" label="Complete Name" required error={errors.fullName}>
        <Input
          id="signup-full-name"
          value={draft.fullName}
          onChange={(event) => set("fullName", event.target.value)}
          placeholder="Enter your complete name"
          autoComplete="name"
          aria-invalid={Boolean(errors.fullName)}
          aria-describedby={errors.fullName ? "signup-full-name-error" : undefined}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="signup-email" label="Email Address" required error={errors.email}>
          <DomainEmailInput
            id="signup-email"
            value={draft.emailLocalPart}
            onChange={(value) => set("emailLocalPart", value)}
            domain={options.emailDomain}
            error={errors.email}
            placeholder="firstname.lastname"
          />
        </Field>
        <Field id="signup-username" label="Username">
          <ReadOnlyValue id="signup-username" value={usernameFor(draft.emailLocalPart)} placeholder="Auto-generated from your email" />
        </Field>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="signup-phone" label="Phone Number" required error={errors.phone}>
          <Input
            id="signup-phone"
            value={draft.phone}
            onChange={(event) => set("phone", event.target.value.replaceAll(/\D/g, ""))}
            placeholder="e.g. 03001234567"
            inputMode="numeric"
            maxLength={11}
            autoComplete="tel"
            aria-invalid={Boolean(errors.phone)}
            aria-describedby={errors.phone ? "signup-phone-error" : undefined}
          />
        </Field>
        <Field id="signup-ip-extension" label="IP Extension No" required error={errors.ipExtension}>
          <Input
            id="signup-ip-extension"
            value={draft.ipExtension}
            onChange={(event) => set("ipExtension", event.target.value.replaceAll(/\D/g, ""))}
            placeholder="e.g. 1234"
            inputMode="numeric"
            maxLength={6}
            aria-invalid={Boolean(errors.ipExtension)}
            aria-describedby={errors.ipExtension ? "signup-ip-extension-error" : undefined}
          />
        </Field>
        <Field id="signup-employee-id" label="Employee ID" required error={errors.employeeId}>
          <Input
            id="signup-employee-id"
            value={draft.employeeId}
            onChange={(event) => set("employeeId", event.target.value)}
            placeholder="Enter employee ID"
            maxLength={64}
            aria-invalid={Boolean(errors.employeeId)}
            aria-describedby={errors.employeeId ? "signup-employee-id-error" : undefined}
          />
        </Field>
        <Field id="signup-department" label="Department" required error={errors.department}>
          <select
            id="signup-department"
            value={draft.department}
            onChange={(event) => set("department", event.target.value)}
            className={INPUT_SELECT_CLASS}
            aria-invalid={Boolean(errors.department)}
            aria-describedby={errors.department ? "signup-department-error" : undefined}
          >
            <option value="" disabled>Select department</option>
            {DEPARTMENTS.map((department) => <option key={department} value={department}>{department}</option>)}
          </select>
        </Field>
      </div>

      <Field id="signup-role" label="Role">
        <ReadOnlyValue id="signup-role" value="Order Initiator" placeholder="" />
      </Field>

      <ApproverLevels
        draft={draft}
        setDraft={setDraft}
        bands={options.approvalLevels}
        domain={options.emailDomain}
        organizationName={options.organizationName}
        errors={errors}
      />

      <Field id="signup-branch" label="Branch" required>
        <BranchChipsField
          chips={draft.branches}
          onChange={(branches) => set("branches", branches)}
          branches={options.branches}
          error={errors.branches}
        />
      </Field>

      <Field id="signup-address" label="Delivery Address" required>
        <AddressChipsField
          chips={draft.addresses}
          onChange={(addresses) => set("addresses", addresses)}
          error={errors.addresses}
        />
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="signup-password" label="Password" required error={errors.password}>
          <div className="relative">
            <Input
              id="signup-password"
              type={showPassword ? "text" : "password"}
              value={draft.password}
              onChange={(event) => set("password", event.target.value)}
              placeholder="Create a password"
              autoComplete="new-password"
              className="pr-10"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "signup-password-error" : undefined}
            />
            <button
              type="button"
              onClick={() => setShowPassword((shown) => !shown)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>
        <Field id="signup-confirm-password" label="Confirm Password" required error={errors.confirmPassword}>
          <Input
            id="signup-confirm-password"
            type={showPassword ? "text" : "password"}
            value={draft.confirmPassword}
            onChange={(event) => set("confirmPassword", event.target.value)}
            placeholder="Re-enter password"
            autoComplete="new-password"
            aria-invalid={Boolean(errors.confirmPassword)}
            aria-describedby={errors.confirmPassword ? "signup-confirm-password-error" : undefined}
          />
        </Field>
      </div>
      <p className="-mt-3 text-xs text-slate-500">
        At least 12 characters, with an uppercase letter, a lowercase letter, a number and a symbol.
      </p>

      <div className="space-y-1">
        <label htmlFor="signup-terms" className="flex cursor-pointer items-start gap-2 text-sm text-slate-600">
          <input
            id="signup-terms"
            type="checkbox"
            checked={draft.termsAccepted}
            onChange={(event) => set("termsAccepted", event.target.checked)}
            className="mt-0.5 accent-blue-600"
            aria-invalid={Boolean(errors.terms)}
            aria-describedby={errors.terms ? "signup-terms-error" : undefined}
          />
          <span>I agree to the Terms of Service and Privacy Policy</span>
        </label>
        {errors.terms && <p id="signup-terms-error" className="text-xs font-medium text-red-600">{errors.terms}</p>}
      </div>

      {failure && (
        <p role="alert" className="flex items-start gap-1.5 text-sm font-medium text-red-600">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          {failure}
        </p>
      )}

      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
        <Button type="button" variant="outline" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button type="submit" disabled={submitting}>
          {submitting
            ? <span className="inline-flex items-center gap-2"><Spinner size={16} /> Sending…</span>
            : "Sign Up"}
        </Button>
      </div>
    </form>
  )
}
