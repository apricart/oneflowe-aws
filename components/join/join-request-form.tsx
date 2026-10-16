"use client"

import { useMemo, useState } from "react"

import { AlertCircle, Eye, EyeOff } from "lucide-react"

import {
  JoinMultiScopePicker,
  JoinSingleBranchPicker,
  type JoinOption,
} from "@/components/join/join-scope-picker"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/skeleton"
import { Textarea } from "@/components/ui/textarea"
import {
  EMAIL_LOCAL_PART_MAX_LENGTH,
  composeDomainEmail,
  emailLocalPartError,
} from "@/lib/organization-email-domain"
import {
  JOINABLE_ROLES,
  JOINABLE_ROLE_LABELS,
  type JoinableRole,
  isSingleBranchJoinableRole,
} from "@/lib/organization-join"
import { joinPasswordError } from "@/lib/join-department-signup-form"
import { cn } from "@/lib/utils"

/**
 * The join form — the same details the Create User dialog asks an administrator
 * for, minus everything an applicant must not be able to decide.
 *
 * Absent on purpose, not hidden: organization (resolved from the code on the
 * server), active/inactive, MFA, and the Group User budget-allocation right.
 * Hiding a control is presentation; these are simply not fields the endpoint
 * accepts, and sending one is a 400.
 *
 * The email is locked to the organization's domain: the applicant types only
 * the part before the `@`, and the domain is shown as a fixed suffix. The
 * server refuses any other domain whatever this page sends.
 *
 * The validation here is a courtesy so the applicant is not made to wait on a
 * round trip. The server re-validates everything.
 */

export type JoinFormOptions = {
  organizationName: string
  /** Always set here: the join page never renders this form without one. */
  emailDomain: string
  branches: JoinOption[]
  groups: JoinOption[]
}

type FormState = {
  firstName: string
  lastName: string
  /** The part before the `@`. */
  emailLocalPart: string
  username: string
  password: string
  confirmPassword: string
  phone: string
  employeeId: string
  imprestHolder: string
  contactPerson: string
  location: string
  address: string
  role: JoinableRole | ""
  branchId: number | null
  groupIds: number[]
  branchIds: number[]
}

const EMPTY_FORM: FormState = {
  firstName: "",
  lastName: "",
  emailLocalPart: "",
  username: "",
  password: "",
  confirmPassword: "",
  phone: "",
  employeeId: "",
  imprestHolder: "",
  contactPerson: "",
  location: "",
  address: "",
  role: "",
  branchId: null,
  groupIds: [],
  branchIds: [],
}

function phoneError(phone: string) {
  if (!phone) return undefined
  if (!/^\d+$/.test(phone)) return "Digits only"
  return phone.length < 7 || phone.length > 15 ? "Between 7 and 15 digits" : undefined
}

function validate(form: FormState): Record<string, string> {
  const errors: Record<string, string> = {}
  if (!form.firstName.trim()) errors.firstName = "First name is required"
  if (!form.lastName.trim()) errors.lastName = "Last name is required"
  const email = emailLocalPartError(form.emailLocalPart)
  if (email) errors.email = email
  if (form.username.trim().length < 3) errors.username = "At least 3 characters"

  const password = joinPasswordError(form.password)
  if (password) errors.password = password
  else if (form.password !== form.confirmPassword) errors.confirmPassword = "Passwords do not match"

  const phone = phoneError(form.phone.trim())
  if (phone) errors.phone = phone

  if (!form.role) {
    errors.role = "Choose the role you need"
    return errors
  }

  if (isSingleBranchJoinableRole(form.role)) {
    if (!form.branchId) errors.branchId = "Select your branch"
  } else if (form.groupIds.length === 0 && form.branchIds.length === 0) {
    errors.scope = "Select at least one group or branch"
  }

  return errors
}

function toggle(list: number[], id: number) {
  return list.includes(id) ? list.filter((value) => value !== id) : [...list, id]
}

export function Field({
  id,
  label,
  required,
  error,
  children,
}: Readonly<{
  id: string
  label: string
  required?: boolean
  error?: string
  children: React.ReactNode
}>) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-slate-700">
        {label}{required && <span className="text-red-500"> *</span>}
      </label>
      {children}
      {error && (
        <p id={`${id}-error`} className="text-xs font-medium text-red-600">{error}</p>
      )}
    </div>
  )
}

export function JoinRequestForm({
  options,
  onSubmit,
  onBack,
}: Readonly<{
  options: JoinFormOptions
  onSubmit: (payload: Record<string, unknown>) => Promise<void>
  onBack: () => void
}>) {
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((previous) => ({ ...previous, [key]: value }))

  const isGroupRole = useMemo(
    () => Boolean(form.role) && !isSingleBranchJoinableRole(form.role as JoinableRole),
    [form.role],
  )

  /** A role change clears the scope the other shape cannot carry. */
  const chooseRole = (role: JoinableRole) => {
    setForm((previous) => ({ ...previous, role, branchId: null, groupIds: [], branchIds: [] }))
    setErrors((previous) => {
      const next = { ...previous }
      delete next.role
      delete next.branchId
      delete next.scope
      return next
    })
  }

  const handleSubmit = async (event: React.SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    setFailure(null)

    const found = validate(form)
    setErrors(found)
    if (Object.keys(found).length > 0) return

    const role = form.role as JoinableRole
    const singleBranch = isSingleBranchJoinableRole(role)

    setSubmitting(true)
    try {
      await onSubmit({
        firstName: form.firstName.trim(),
        lastName: form.lastName.trim(),
        email: composeDomainEmail(form.emailLocalPart, options.emailDomain),
        username: form.username.trim().toLowerCase(),
        password: form.password,
        role,
        branchId: singleBranch ? form.branchId : null,
        groupIds: singleBranch ? [] : form.groupIds,
        branchIds: singleBranch ? [] : form.branchIds,
        phone: form.phone.trim() || null,
        employeeId: form.employeeId.trim() || null,
        imprestHolder: form.imprestHolder.trim() || null,
        contactPerson: form.contactPerson.trim() || null,
        location: form.location.trim() || null,
        address: form.address.trim() || null,
      })
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "We could not send your request. Please try again.")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <div className="rounded-lg border border-blue-100 bg-blue-50/70 p-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-blue-700">Joining</p>
        <p className="text-sm font-semibold text-slate-900">{options.organizationName}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="join-first-name" label="First name" required error={errors.firstName}>
          <Input
            id="join-first-name"
            value={form.firstName}
            onChange={(event) => set("firstName", event.target.value)}
            aria-invalid={Boolean(errors.firstName)}
            aria-describedby={errors.firstName ? "join-first-name-error" : undefined}
          />
        </Field>
        <Field id="join-last-name" label="Last name" required error={errors.lastName}>
          <Input
            id="join-last-name"
            value={form.lastName}
            onChange={(event) => set("lastName", event.target.value)}
            aria-invalid={Boolean(errors.lastName)}
            aria-describedby={errors.lastName ? "join-last-name-error" : undefined}
          />
        </Field>
        <Field id="join-email" label="Work email" required error={errors.email}>
          <div className="flex">
            <Input
              id="join-email"
              value={form.emailLocalPart}
              onChange={(event) => set("emailLocalPart", event.target.value)}
              placeholder="your.name"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={EMAIL_LOCAL_PART_MAX_LENGTH}
              className="min-w-0 rounded-r-none"
              aria-invalid={Boolean(errors.email)}
              aria-describedby={
                errors.email ? "join-email-domain join-email-error" : "join-email-domain"
              }
            />
            <span
              id="join-email-domain"
              className="inline-flex max-w-[60%] shrink-0 items-center truncate rounded-r-md border border-l-0 border-slate-300 bg-slate-100 px-3 text-sm font-medium text-slate-700"
              title={`@${options.emailDomain}`}
            >
              @{options.emailDomain}
            </span>
          </div>
        </Field>
        <Field id="join-username" label="Username" required error={errors.username}>
          <Input
            id="join-username"
            value={form.username}
            onChange={(event) => set("username", event.target.value.toLowerCase())}
            aria-invalid={Boolean(errors.username)}
            aria-describedby={errors.username ? "join-username-error" : undefined}
          />
        </Field>
        <Field id="join-password" label="Password" required error={errors.password}>
          <div className="relative">
            <Input
              id="join-password"
              type={showPassword ? "text" : "password"}
              value={form.password}
              onChange={(event) => set("password", event.target.value)}
              className="pr-10"
              aria-invalid={Boolean(errors.password)}
              aria-describedby={errors.password ? "join-password-error" : undefined}
            />
            <button
              type="button"
              onClick={() => setShowPassword((previous) => !previous)}
              aria-label={showPassword ? "Hide password" : "Show password"}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700"
            >
              {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
            </button>
          </div>
        </Field>
        <Field
          id="join-confirm-password"
          label="Confirm password"
          required
          error={errors.confirmPassword}
        >
          <Input
            id="join-confirm-password"
            type={showPassword ? "text" : "password"}
            value={form.confirmPassword}
            onChange={(event) => set("confirmPassword", event.target.value)}
            aria-invalid={Boolean(errors.confirmPassword)}
            aria-describedby={errors.confirmPassword ? "join-confirm-password-error" : undefined}
          />
        </Field>
        <Field id="join-phone" label="Phone" error={errors.phone}>
          <Input
            id="join-phone"
            inputMode="numeric"
            value={form.phone}
            onChange={(event) => set("phone", event.target.value)}
            aria-invalid={Boolean(errors.phone)}
            aria-describedby={errors.phone ? "join-phone-error" : undefined}
          />
        </Field>
        <Field id="join-employee-id" label="Employee number">
          <Input
            id="join-employee-id"
            value={form.employeeId}
            onChange={(event) => set("employeeId", event.target.value)}
          />
        </Field>
        <Field id="join-imprest-holder" label="Imprest holder">
          <Input
            id="join-imprest-holder"
            value={form.imprestHolder}
            onChange={(event) => set("imprestHolder", event.target.value)}
          />
        </Field>
        <Field id="join-contact-person" label="Contact person">
          <Input
            id="join-contact-person"
            value={form.contactPerson}
            onChange={(event) => set("contactPerson", event.target.value)}
          />
        </Field>
        <Field id="join-location" label="Location">
          <Input
            id="join-location"
            value={form.location}
            onChange={(event) => set("location", event.target.value)}
          />
        </Field>
      </div>

      <Field id="join-address" label="Address">
        <Textarea
          id="join-address"
          rows={2}
          value={form.address}
          onChange={(event) => set("address", event.target.value)}
        />
      </Field>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-slate-700">
          Role you need <span className="text-red-500">*</span>
        </legend>
        <div className="grid gap-2 sm:grid-cols-2">
          {JOINABLE_ROLES.map((role) => (
            <button
              key={role}
              type="button"
              aria-pressed={form.role === role}
              onClick={() => chooseRole(role)}
              className={cn(
                "rounded-md border px-3 py-2 text-left text-sm font-medium transition",
                form.role === role
                  ? "border-blue-500 bg-blue-50 text-blue-900"
                  : "border-slate-300 bg-white text-slate-700 hover:border-slate-400",
              )}
            >
              {JOINABLE_ROLE_LABELS[role]}
            </button>
          ))}
        </div>
        {errors.role && <p className="text-xs font-medium text-red-600">{errors.role}</p>}
      </fieldset>

      {form.role && !isGroupRole && (
        <JoinSingleBranchPicker
          options={options.branches}
          value={form.branchId}
          onChange={(branchId) => set("branchId", branchId)}
          error={errors.branchId}
        />
      )}

      {isGroupRole && (
        <JoinMultiScopePicker
          groups={options.groups}
          branches={options.branches}
          selectedGroupIds={form.groupIds}
          selectedBranchIds={form.branchIds}
          onToggleGroup={(id) => set("groupIds", toggle(form.groupIds, id))}
          onToggleBranch={(id) => set("branchIds", toggle(form.branchIds, id))}
          error={errors.scope}
        />
      )}

      {failure && (
        <div role="alert" className="flex items-start gap-2 rounded-md border border-red-200 bg-red-50 p-3">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" aria-hidden="true" />
          <p className="text-sm font-medium text-red-700">{failure}</p>
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button type="submit" disabled={submitting} className="sm:flex-1">
          {submitting
            ? <span className="inline-flex items-center gap-2"><Spinner size={16} /> Sending…</span>
            : "Send request"}
        </Button>
        <Button type="button" variant="outline" onClick={onBack} disabled={submitting}>
          Use a different code
        </Button>
      </div>

      <p className="text-xs text-slate-500">
        Your request goes to {options.organizationName}&apos;s head office for approval. No account
        is created until they approve it.
      </p>
    </form>
  )
}
