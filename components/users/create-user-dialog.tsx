"use client"
import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { jsonFetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Dialog, DialogTrigger, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Card } from "@/components/ui/card"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { UserPlus, Shield, Building2, MapPin, AlertCircle, CheckCircle, Eye, EyeOff, ChevronsUpDown, Check } from "lucide-react"
import { useAppContext } from "@/components/context/app-context"
import { handleError } from "@/lib/error-handler"
import { cn } from "../../lib/utils"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { PremiumAlert, AlertType } from "@/components/premium/premium-alert"
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


type CreateUserDialogProps = {
  onSuccess?: () => void
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function getUsernameStatusIcon(status: { available: boolean | null; loading: boolean }) {
  if (status.loading) {
    return <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
  }
  if (status.available === true) return <CheckCircle className="h-4 w-4 text-green-500" />
  if (status.available === false) return <AlertCircle className="h-4 w-4 text-red-500" />
  return null
}

function getOrganizationContextLabel(organizationId: string, isInitialized: boolean, organizationName: string) {
  if (organizationId) return organizationName
  return isInitialized ? "No Organization Found" : "Loading..."
}

function getBranchSelectorLabel(branchId: string, organizationId: string, branchName: string) {
  if (branchId) return branchName
  return organizationId ? "Search branches..." : "Select organization first"
}

function getRoleLabel(role: string) {
  if (role === "HEAD_OFFICE") return "Head Office User"
  if (role === "BRANCH_ADMIN") return "Branch Admin User"
  return "Order Portal User"
}

function getInitialCreateUserForm(
  organizationId?: string | null,
  branchId?: string | null,
  userRole?: string | null,
) {
  return {
    firstName: "",
    lastName: "",
    email: "",
    username: "",
    password: "",
    phone: "",
    role: "",
    organizationId: organizationId || "",
    branchId: userRole === "BRANCH_ADMIN" ? branchId || "" : "",
    mfaEnabled: false,
    isActive: true,
    employeeId: "",
    imprestHolder: "",
    contactPerson: "",
    location: "",
    address: "",
  }
}

type CreateUserForm = ReturnType<typeof getInitialCreateUserForm>

function getEmailError(value: string) {
  if (!value.trim()) return "Email is required"
  return EMAIL_PATTERN.test(value) ? undefined : "Please enter a valid email"
}

function getUsernameError(value: string) {
  if (!value.trim()) return "Username is required"
  return value.length < 3 ? "Username must be at least 3 characters" : undefined
}

function getPhoneError(value: string) {
  if (!value) return undefined
  if (!/^\d+$/.test(value)) return "Phone number must contain only digits"
  return value.length < 7 || value.length > 15
    ? "Phone number must be between 7 and 15 digits"
    : undefined
}

function hasRequiredPasswordCharacters(password: string) {
  return /[A-Z]/.test(password)
    && /[a-z]/.test(password)
    && /\d/.test(password)
    && /[^a-zA-Z0-9]/.test(password)
}

function getPasswordError(password: string) {
  if (!password) return "This field is required"
  if (password.length < 12) return "Use at least 12 characters"
  return hasRequiredPasswordCharacters(password)
    ? undefined
    : "It must include uppercase, lowercase, number, and special character"
}

function getBasicUserErrors(form: CreateUserForm, usernameAvailable: boolean | null) {
  const errors: Record<string, string> = {}
  if (!form.firstName.trim()) errors.firstName = "First name is required"
  if (!form.lastName.trim()) errors.lastName = "Last name is required"

  const usernameError = getUsernameError(form.username)
  if (usernameError) errors.username = usernameError
  if (usernameAvailable === false) errors.username = "This username is already taken"

  const emailError = getEmailError(form.email)
  if (emailError) errors.email = emailError
  const phoneError = getPhoneError(form.phone)
  if (phoneError) errors.phone = phoneError
  if (form.employeeId && !form.employeeId.trim()) errors.employeeId = "Employee number cannot be blank"

  const passwordError = getPasswordError(form.password)
  if (passwordError) errors.password = passwordError
  return errors
}

function getAssignmentErrors(form: CreateUserForm) {
  const errors: Record<string, string> = {}
  if (!form.role) errors.role = "Role is required"
  const needsOrganization = ["HEAD_OFFICE", "BRANCH_ADMIN", "ORDER_PORTAL"].includes(form.role)
  if (needsOrganization && !form.organizationId) {
    errors.organizationId = "Organization is required for this role"
  }
  const needsBranch = ["BRANCH_ADMIN", "ORDER_PORTAL"].includes(form.role)
  if (needsBranch && !form.branchId) {
    errors.branchId = "Branch assignment is required for Branch Admin and Order Portal roles"
  }
  return errors
}

function getCreateUserErrors(form: CreateUserForm, usernameAvailable: boolean | null) {
  return {
    ...getBasicUserErrors(form, usernameAvailable),
    ...getAssignmentErrors(form),
  }
}

export function CreateUserDialog({ onSuccess }: Readonly<CreateUserDialogProps>) {
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [step, setStep] = useState(1)
  const [showPassword, setShowPassword] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [branchSearch, setBranchSearch] = useState("")
  const [discardConfirmationOpen, setDiscardConfirmationOpen] = useState(false)
  const { organizationId, branchId, userRole, isInitialized } = useAppContext()

  const initialForm = useMemo(
    () => getInitialCreateUserForm(organizationId, branchId, userRole),
    [branchId, organizationId, userRole],
  )

  const [form, setForm] = useState(() => initialForm)

  const isDirty = useMemo(
    () =>
      (Object.keys(initialForm) as Array<keyof typeof initialForm>).some(
        (field) => form[field] !== initialForm[field],
      ),
    [form, initialForm],
  )

  const [usernameStatus, setUsernameStatus] = useState<{
    available: boolean | null
    loading: boolean
    suggestions: string[]
  }>({
    available: null,
    loading: false,
    suggestions: []
  })

  const [errors, setErrors] = useState<Record<string, string>>({})
  const [feedback, setFeedback] = useState<{
    message: string
    type: AlertType
    visible: boolean
  }>({
    message: "",
    type: "info",
    visible: false
  })

  // The endpoint scopes non-Super Admins to their assigned organization.
  // Fetch it for every role so the read-only assignment summary has a name.
  const { data: organizationsData } = useSWR(
    userRole ? "/api/v1/organizations" : null,
    jsonFetcher
  )

  // Fetch branches for the selected organization
  const { data: branchesData } = useSWR(
    form.organizationId ? `/api/v1/branches?organizationId=${form.organizationId}` : null,
    jsonFetcher
  )

  const organizations = (organizationsData as any)?.items || []
  const branches = (branchesData as any)?.items || []

  // Initialize form when dialog opens
  useEffect(() => {
    if (open) {
      setForm(initialForm)
      setUsernameStatus({ available: null, loading: false, suggestions: [] })
      setErrors({})
      setFeedback({ message: "", type: "info", visible: false })
      setStep(1)
      setDiscardConfirmationOpen(false)
    }
    // Reset only on a closed -> open transition. Context synchronization while
    // the dialog is open is handled below and must not erase user-entered data.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Sync context changes to form if not manually edited or if forced by role
  useEffect(() => {
    if (open && isInitialized) {
      if (userRole === "HEAD_OFFICE" || userRole === "BRANCH_ADMIN") {
        setForm(prev => ({
          ...prev,
          organizationId: organizationId || prev.organizationId,
          branchId: userRole === "BRANCH_ADMIN" ? (branchId || prev.branchId) : prev.branchId
        }))
      } else if (userRole === "SUPER_ADMIN" && organizationId && !form.organizationId) {
        // Only pre-fill for Super Admin if it's currently empty
        setForm(prev => ({
          ...prev,
          organizationId: organizationId
        }))
      }
    }
  }, [open, isInitialized, organizationId, branchId, userRole])

  const validateField = (name: string, value: string) => {
    const newErrors = { ...errors }
    let fieldError: string | undefined
    if (name === "email") fieldError = getEmailError(value)
    if (name === "username") fieldError = getUsernameError(value)
    if (name === "phone") fieldError = getPhoneError(value)

    if (fieldError) newErrors[name] = fieldError
    else delete newErrors[name]

    setErrors(newErrors)
  }

  // Real-time username check
  useEffect(() => {
    const username = form.username.trim().toLowerCase()
    if (username.length < 3) {
      setUsernameStatus({ available: null, loading: false, suggestions: [] })
      setErrors(prev => {
        if (prev.username !== "This username is already taken") return prev
        const next = { ...prev }
        delete next.username
        return next
      })
      return
    }

    let isCurrent = true
    const timer = setTimeout(async () => {
      setUsernameStatus(prev => ({ ...prev, loading: true }))
      try {
        const res = await fetch(`/api/v1/users/check-username?username=${username}`)
        const data = await res.json()
        if (!isCurrent) return

        setUsernameStatus({
          available: data.available ?? false,
          suggestions: data.suggestions ?? [],
          loading: false
        })

        setErrors(prev => {
          const next = { ...prev }
          if (data.available === false) {
            next.username = "This username is already taken"
          } else if (next.username === "This username is already taken") {
            delete next.username
          }
          return next
        })
      } catch (err) {
        console.error("Failed to check username:", err)
        if (!isCurrent) return
        setUsernameStatus(prev => ({ ...prev, loading: false }))
      }
    }, 500)

    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [form.username])

  // Validate form
  const validateForm = (autoJump = false) => {
    console.debug("[DEBUG] Validating form:", form)
    const newErrors = getCreateUserErrors(form, usernameStatus.available)

    setErrors(newErrors)
    const isValid = Object.keys(newErrors).length === 0
    console.debug("[DEBUG] Validation result:", { isValid, errors: newErrors })

    if (!isValid && autoJump) {
      if (newErrors.firstName || newErrors.lastName || newErrors.email || newErrors.password || newErrors.phone || newErrors.employeeId) {
        setStep(1)
      } else if (newErrors.role || newErrors.organizationId || newErrors.branchId) {
        setStep(2)
      }
    }

    return isValid
  }

  // Handle form submission
  const handleSubmit = async () => {
    if (!validateForm(true)) {
      setFeedback({
        message: "Please fix the errors before submitting.",
        type: "warning",
        visible: true
      })
      return
    }

    setSubmitting(true)
    console.debug("[DEBUG] handleSubmit - form data:", { ...form, password: "***" })
    try {
      const response = await jsonFetcher("/api/v1/users", {
        method: "POST",
        body: JSON.stringify({
          firstName: form.firstName.trim(),
          lastName: form.lastName.trim(),
          username: form.username.trim().toLowerCase(),
          email: form.email.trim(),
          password: form.password,
          phone: form.phone.trim() || null,
          role: form.role,
          organizationId: form.organizationId ? Number.parseInt(form.organizationId) : null,
          branchId: (form.role === "BRANCH_ADMIN" || form.role === "ORDER_PORTAL") && form.branchId ? Number.parseInt(form.branchId) : null,
          mfaEnabled: form.mfaEnabled,
          isActive: form.isActive,
          employeeId: form.employeeId.trim() || null,
          imprestHolder: form.imprestHolder.trim() || null,
          contactPerson: form.contactPerson.trim() || null,
          location: form.location.trim() || null,
          address: form.address.trim() || null
        })
      }) as any

      if (response.error) {
        throw new Error(response.error)
      }

      setFeedback({
        message: "User created successfully.",
        type: "success",
        visible: true
      })

      onSuccess?.()
      // Slightly delay closing to allow user to see success message if desired, 
      // but usually we close immediately and show the portal-level success alert.
      // However, the user asked for a "pop up" here.
      setTimeout(() => setOpen(false), 1500)
    } catch (error: any) {
      const { message, field } = handleError(error, "create user")

      // Show Premium Alert (Pop-up) instead of toast
      setFeedback({
        message,
        type: message.includes("exists") || message.includes("required") ? "warning" : "error",
        visible: true
      })

      // Highlight the problematic field
      if (field) {
        setErrors({ [field]: message })
        // Focus on the problematic field
        setTimeout(() => {
          const fieldElement = (document.getElementById(field) ||
            document.querySelector(`[name="${field}"]`)) as HTMLElement | null
          if (fieldElement) {
            fieldElement.focus()
            fieldElement.scrollIntoView({ behavior: 'smooth', block: 'center' })
          }
        }, 100)
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Get selected organization name
  const getSelectedOrganizationName = () => {
    if (!form.organizationId) return ""
    const org = organizations.find((o: any) => o.id === Number.parseInt(form.organizationId))
    return org?.name || ""
  }

  // Get selected branch name
  const getSelectedBranchName = () => {
    if (!form.branchId) return ""
    const branch = branches.find((b: any) => b.id === Number.parseInt(form.branchId))
    return branch?.name || ""
  }

  const handleDialogOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setOpen(true)
      return
    }

    if (submitting) return

    if (isDirty) {
      setDiscardConfirmationOpen(true)
      return
    }

    setOpen(false)
  }

  const discardChangesAndClose = () => {
    setDiscardConfirmationOpen(false)
    setOpen(false)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={handleDialogOpenChange}>
        <DialogTrigger asChild>
          <Button style={{ background: "var(--color-brand-primary)", color: "white" }}>
            <UserPlus className="mr-2 h-4 w-4" />
            Create User
          </Button>
        </DialogTrigger>
        <DialogContent
          className="max-w-2xl max-h-[90vh] overflow-y-auto"
        >
          <PremiumAlert
            message={feedback.message}
            type={feedback.type}
            isVisible={feedback.visible}
            placement="sticky"
            onClose={() => setFeedback({ ...feedback, visible: false })}
          />
          <DialogHeader>
            <DialogTitle>Create New User</DialogTitle>
            <DialogDescription>
              Add a new Head Office or Branch Admin user to your organization
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Progress Steps */}
            {(() => (
            <div className="flex items-center justify-center space-x-4">
              <div className={`flex items-center gap-2 ${step >= 1 ? 'text-blue-600' : 'text-muted-foreground'}`}>
                <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium ${step >= 1 ? 'bg-blue-100 text-blue-600' : 'bg-muted'
                  }`}>
                  1
                </div>
                <span className="text-sm font-medium">Basic Info</span>
              </div>
              <div className={`h-px w-8 ${step >= 2 ? 'bg-blue-600' : 'bg-muted'}`} />
              <div className={`flex items-center gap-2 ${step >= 2 ? 'text-blue-600' : 'text-muted-foreground'}`}>
                <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium ${step >= 2 ? 'bg-blue-100 text-blue-600' : 'bg-muted'
                  }`}>
                  2
                </div>
                <span className="text-sm font-medium">Role & Assignment</span>
              </div>
              <div className={`h-px w-8 ${step >= 3 ? 'bg-blue-600' : 'bg-muted'}`} />
              <div className={`flex items-center gap-2 ${step >= 3 ? 'text-blue-600' : 'text-muted-foreground'}`}>
                <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-medium ${step >= 3 ? 'bg-blue-100 text-blue-600' : 'bg-muted'
                  }`}>
                  3
                </div>
                <span className="text-sm font-medium">Security</span>
              </div>
            </div>
            ))()}

            {/* Step 1: Basic Information */}
            {step === 1 && (() => (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">Basic Information</h3>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">First Name *</Label>
                    <Input
                      id="firstName"
                      name="createUserFirstName"
                      autoComplete="off"
                      value={form.firstName}
                      onChange={e => setForm({ ...form, firstName: e.target.value })}
                      placeholder="Enter first name"
                      className={errors.firstName ? 'border-red-500' : ''}
                    />
                    {errors.firstName && (
                      <p className="text-xs text-red-600">{errors.firstName}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName">Last Name *</Label>
                    <Input
                      id="lastName"
                      name="createUserLastName"
                      autoComplete="off"
                      value={form.lastName}
                      onChange={e => setForm({ ...form, lastName: e.target.value })}
                      placeholder="Enter last name"
                      className={errors.lastName ? 'border-red-500' : ''}
                    />
                    {errors.lastName && (
                      <p className="text-xs text-red-600">{errors.lastName}</p>
                    )}
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="email">Email Address *</Label>
                  <Input
                    id="email"
                    name="createUserEmail"
                    type="email"
                    autoComplete="off"
                    value={form.email}
                    onChange={e => {
                      const val = e.target.value
                      setForm({ ...form, email: val })
                      validateField("email", val)
                    }}
                    placeholder="Enter email address"
                    className={errors.email ? 'border-red-500' : ''}
                  />
                  {errors.email && (
                    <p className="text-xs text-red-600">{errors.email}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="username">Username *</Label>
                  <div className="relative">
                    <Input
                      id="username"
                      name="createUserUsername"
                      autoComplete="off"
                      value={form.username}
                      onChange={e => {
                        const val = e.target.value.toLowerCase()
                        setForm({ ...form, username: val })
                        validateField("username", val)
                      }}
                      placeholder="Enter unique username"
                      className={errors.username ? 'border-red-500 pr-10' : 'pr-10'}
                    />
                    <div className="absolute right-3 top-1/2 -translate-y-1/2">
                      {getUsernameStatusIcon(usernameStatus)}
                    </div>
                  </div>
                  {errors.username && (
                    <p className="text-xs text-red-600">{errors.username}</p>
                  )}
                  {usernameStatus.available === false && usernameStatus.suggestions.length > 0 && (
                    <div className="mt-2 space-y-1">
                      <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Suggested Lookups:</p>
                      <div className="flex flex-wrap gap-2">
                        {usernameStatus.suggestions.map(s => (
                          <Badge
                            key={s}
                            variant="outline"
                            className="cursor-pointer hover:bg-blue-50 hover:text-blue-700 transition-colors border-blue-200"
                            onClick={() => {
                              setForm({ ...form, username: s })
                              setUsernameStatus(prev => ({ ...prev, available: true, suggestions: [] }))
                              setErrors(prev => {
                                const next = { ...prev }
                                delete next.username
                                return next
                              })
                            }}
                          >
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="phone">Phone Number</Label>
                  <Input
                    id="phone"
                    name="createUserPhone"
                    autoComplete="off"
                    inputMode="numeric"
                    value={form.phone}
                    onChange={e => {
                      const val = e.target.value
                      setForm({ ...form, phone: val })
                      validateField("phone", val)
                    }}
                    placeholder="Enter phone number (e.g. 03001234567)"
                    className={errors.phone ? 'border-red-500' : ''}
                  />
                  {errors.phone && (
                    <p className="text-xs text-red-600">{errors.phone}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="password">Password *</Label>
                  <div className="relative">
                    <Input
                      id="password"
                      name="createUserPassword"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={form.password}
                      onChange={e => {
                        const val = e.target.value
                        setForm({ ...form, password: val })
                        if (val.length >= 12) {
                          setErrors(prev => {
                            const next = { ...prev }
                            delete next.password
                            return next
                          })
                        } else if (val.length > 0) {
                          setErrors(prev => ({ ...prev, password: "Use at least 12 characters" }))
                        }
                      }}
                      placeholder="Enter password (min 12 chars, mixed case, symbols)"
                      className={cn("pr-10", errors.password ? 'border-red-500' : '')}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                      onClick={() => setShowPassword(!showPassword)}
                    >
                      {showPassword ? (
                        <EyeOff className="h-4 w-4 text-muted-foreground" />
                      ) : (
                        <Eye className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                  {errors.password && (
                    <p className="text-xs text-red-600">{errors.password}</p>
                  )}
                </div>

                {/* New Fields: Employee #, Imprest Holder, Contact Person */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="employeeId">Employee #</Label>
                    <Input
                      id="employeeId"
                      name="employeeId"
                      value={form.employeeId}
                      onChange={e => {
                        setForm({ ...form, employeeId: e.target.value })
                        setErrors(prev => {
                          const next = { ...prev }
                          delete next.employeeId
                          return next
                        })
                      }}
                      placeholder="Enter employee number"
                      className={errors.employeeId ? 'border-red-500' : ''}
                    />
                    {errors.employeeId && (
                      <p className="text-xs text-red-600">{errors.employeeId}</p>
                    )}
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="contactPerson">Contact Person</Label>
                    <Input
                      id="contactPerson"
                      name="contactPerson"
                      value={form.contactPerson}
                      onChange={e => setForm({ ...form, contactPerson: e.target.value })}
                      placeholder="Enter contact person"
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="imprestHolder">Imprest Holder</Label>
                    <Input
                      id="imprestHolder"
                      name="imprestHolder"
                      value={form.imprestHolder}
                      onChange={e => setForm({ ...form, imprestHolder: e.target.value })}
                      placeholder="Enter imprest holder name"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="location">Location</Label>
                    <Input
                      id="location"
                      name="location"
                      value={form.location}
                      onChange={e => setForm({ ...form, location: e.target.value })}
                      placeholder="Enter location"
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="address">Address</Label>
                  <Textarea
                    id="address"
                    name="address"
                    value={form.address}
                    onChange={e => setForm({ ...form, address: e.target.value })}
                    placeholder="Enter full address"
                    className="h-20"
                  />
                </div>
              </div>
            ))()}

            {/* Step 2: Role & Assignment */}
            {step === 2 && (() => (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">Role & Assignment</h3>

                {/* Organization Selector - Only for Super Admin */}
                {userRole === "SUPER_ADMIN" && (
                  <div className="space-y-2">
                    <Label htmlFor="organization">Organization *</Label>
                    <Select
                      value={form.organizationId}
                      onValueChange={value => setForm({ ...form, organizationId: value, branchId: "" })}
                    >
                      <SelectTrigger name="organizationId" className={errors.organizationId ? 'border-red-500' : ''}>
                        <SelectValue placeholder="Select organization" />
                      </SelectTrigger>
                      <SelectContent>
                        {organizations
                          .map((org: any) => (
                            <SelectItem key={org.id} value={String(org.id)}>
                              {org.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                    {form.organizationId && (
                      <p className="text-xs text-muted-foreground">
                        Selected: {getSelectedOrganizationName()}
                      </p>
                    )}
                    {errors.organizationId && (
                      <p className="text-xs text-red-600">{errors.organizationId}</p>
                    )}
                  </div>
                )}

                {/* Show current context for non-Super Admin users */}
                {userRole !== "SUPER_ADMIN" && (
                  <div className="p-3 bg-muted/50 rounded-md border space-y-2">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <div className="flex items-center gap-2">
                        <Building2 className="h-4 w-4 text-muted-foreground" />
                        <span className="font-medium">Organization:</span>
                      </div>
                      <span className={form.organizationId ? "text-muted-foreground" : "text-amber-600 font-medium"}>
                        {getOrganizationContextLabel(form.organizationId, isInitialized, getSelectedOrganizationName())}
                      </span>
                    </div>
                    {!form.organizationId && isInitialized && (
                      <p className="text-[10px] text-amber-600">
                        Please select an organization in the header if available.
                      </p>
                    )}
                  </div>
                )}

                {/* Role Selector */}
                <div className="space-y-2">
                  <Label htmlFor="role">Role *</Label>
                  <Select value={form.role} onValueChange={value => setForm({ ...form, role: value, branchId: "" })}>
                    <SelectTrigger name="role" className={errors.role ? 'border-red-500' : ''}>
                      <SelectValue placeholder="Select role" />
                    </SelectTrigger>
                    <SelectContent>
                      {userRole === "SUPER_ADMIN" && (
                        <SelectItem value="HEAD_OFFICE">Head Office</SelectItem>
                      )}
                      <SelectItem value="BRANCH_ADMIN">Branch Admin</SelectItem>
                      <SelectItem value="ORDER_PORTAL">Order Portal User</SelectItem>
                    </SelectContent>
                  </Select>
                  {errors.role && (
                    <p className="text-xs text-red-600">{errors.role}</p>
                  )}
                </div>

                {/* Branch Selector - Only for Branch Admin and Order Portal */}
                {(form.role === "BRANCH_ADMIN" || form.role === "ORDER_PORTAL") && (
                  <div className="space-y-2">
                    <Label htmlFor="branch">Branch Assignment *</Label>
                    <Popover open={branchOpen} onOpenChange={setBranchOpen}>
                      <PopoverTrigger asChild>
                        <Button
                          variant="outline"
                          role="combobox"
                          aria-expanded={branchOpen}
                          disabled={!form.organizationId}
                          className={cn(
                            "w-full justify-between font-normal",
                            !form.branchId && "text-muted-foreground",
                            errors.branchId && "border-red-500"
                          )}
                        >
                          {getBranchSelectorLabel(form.branchId, form.organizationId, getSelectedBranchName())}
                          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-[--radix-popover-trigger-width] p-0" align="start">
                        <Command>
                          <CommandInput
                            placeholder="Search branches..."
                            value={branchSearch}
                            onValueChange={setBranchSearch}
                          />
                          <CommandList>
                            <CommandEmpty>No branch found.</CommandEmpty>
                            <CommandGroup>
                              {branches.map((branch: any) => (
                                <CommandItem
                                  key={branch.id}
                                  value={`${branch.name}__${branch.id}`}
                                  onSelect={() => {
                                    setForm({ ...form, branchId: String(branch.id) })
                                    setBranchOpen(false)
                                    setBranchSearch("")
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      form.branchId === String(branch.id) ? "opacity-100" : "opacity-0"
                                    )}
                                  />
                                  {branch.name}
                                </CommandItem>
                              ))}
                            </CommandGroup>
                          </CommandList>
                        </Command>
                      </PopoverContent>
                    </Popover>
                    {form.branchId && (
                      <p className="text-xs text-muted-foreground">
                        Selected: {getSelectedBranchName()}
                      </p>
                    )}
                    {errors.branchId && (
                      <p className="text-xs text-red-600">{errors.branchId}</p>
                    )}
                  </div>
                )}

                {/* Assignment Summary */}
                {form.role && (
                  <Card className="p-4 bg-muted/50">
                    <div className="flex items-start gap-3">
                      <div className="p-2 rounded-full bg-blue-100">
                        <Shield className="h-4 w-4 text-blue-600" />
                      </div>
                      <div className="flex-1 space-y-1">
                        <p className="text-sm font-medium">
                          {getRoleLabel(form.role)}
                        </p>
                        <div className="text-xs text-muted-foreground space-y-1">
                          {form.organizationId && (
                            <div className="flex items-center gap-1">
                              <Building2 className="h-3 w-3" />
                              <span>Organization: {getSelectedOrganizationName()}</span>
                            </div>
                          )}
                          {(form.role === "BRANCH_ADMIN" || form.role === "ORDER_PORTAL") && form.branchId && (
                            <div className="flex items-center gap-1">
                              <MapPin className="h-3 w-3" />
                              <span>Branch: {getSelectedBranchName()}</span>
                            </div>
                          )}
                          {form.role === "HEAD_OFFICE" && (
                            <p>Can manage organization-wide settings and create branch admins</p>
                          )}
                          {(form.role === "BRANCH_ADMIN" || form.role === "ORDER_PORTAL") && !form.branchId && (
                            <p className="text-amber-600">Please select a branch assignment</p>
                          )}
                        </div>
                      </div>
                      <CheckCircle className="h-5 w-5 text-green-600" />
                    </div>
                  </Card>
                )}
              </div>
            ))()}

            {/* Step 3: Security Settings */}
            {step === 3 && (() => (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">Security Settings</h3>
                <div className="space-y-4">
                  <div className="flex items-center space-x-2">
                    <Checkbox
                      id="mfaEnabled"
                      name="mfaEnabled"
                      checked={form.mfaEnabled}
                      onCheckedChange={checked => setForm({ ...form, mfaEnabled: !!checked })}
                    />
                    <Label htmlFor="mfaEnabled" className="cursor-pointer">
                      Enable Multi-Factor Authentication (MFA)
                    </Label>
                  </div>

                  <div className="flex items-center justify-between p-4 rounded-lg border bg-muted/30">
                    <div className="space-y-0.5">
                      <Label htmlFor="isActive" className="text-base font-medium">Initial Account Status</Label>
                      <p className="text-xs text-muted-foreground">Set whether this account should be active immediately</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={form.isActive ? "default" : "secondary"} className={cn(
                        form.isActive ? "bg-emerald-500 hover:bg-emerald-600" : "bg-red-500 hover:bg-red-600"
                      )}>
                        {form.isActive ? "Active" : "Inactive"}
                      </Badge>
                      <Switch
                        id="isActive"
                        checked={form.isActive}
                        onCheckedChange={(checked) => setForm({ ...form, isActive: checked })}
                      />
                    </div>
                  </div>

                  <div className="p-3 bg-blue-50 border border-blue-200 rounded-md">
                    <p className="text-sm text-blue-700">
                      <strong>MFA Security:</strong> When enabled, users will receive OTP codes via email for secure login verification.
                      This adds an extra layer of protection to their account.
                    </p>
                  </div>
                </div>

                {/* Security Summary */}
                <Card className="p-4 bg-green-50 dark:bg-green-950/30 border-green-200 dark:border-green-800">
                  <div className="flex items-start gap-3">
                    <Shield className="h-5 w-5 text-green-600 mt-0.5" />
                    <div>
                      <div className="text-sm font-medium text-green-900 dark:text-green-100">
                        Security Configuration
                      </div>
                      <div className="text-xs text-green-700 dark:text-green-300 mt-1">
                        {form.mfaEnabled ? "MFA enabled" : "MFA disabled"}
                      </div>
                    </div>
                  </div>
                </Card>
              </div>
            ))()}
          </div>

          {(() => (
          <DialogFooter>
            <Button variant="outline" onClick={() => handleDialogOpenChange(false)}>
              Cancel
            </Button>
            {step > 1 && (
              <Button variant="outline" onClick={() => setStep(step - 1)}>
                Previous
              </Button>
            )}
            {step < 3 ? (
              <Button
                className="disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
                onClick={() => {
                  if (step === 1) {
                    // Check step 1 fields only
                    const step1Valid = form.firstName && form.lastName && form.username && form.email && form.password && 
                      usernameStatus.available !== false &&
                      !errors.email && !errors.phone && !errors.password && !errors.username;
                    if (step1Valid) setStep(2);
                    else validateForm(); // show errors
                  } else if (step === 2) {
                    // Check step 2 fields
                    const step2Valid = form.role && ((form.role !== "BRANCH_ADMIN" && form.role !== "ORDER_PORTAL") || form.branchId);
                    if (step2Valid) setStep(3);
                    else validateForm(); // show errors
                  }
                }}
                disabled={
                  (step === 1 && (!form.firstName.trim() || !form.lastName.trim() || !form.username.trim() || !form.email.trim() || !form.password || usernameStatus.available === false)) ||
                  (step === 2 && (!form.role || ((form.role === "BRANCH_ADMIN" || form.role === "ORDER_PORTAL") && !form.branchId)))
                }
              >
                Next
              </Button>
            ) : (
              <Button
                onClick={handleSubmit}
                disabled={submitting}
                style={{ background: "var(--color-brand-primary)", color: "white" }}
              >
                {submitting ? "Creating..." : "Create User"}
              </Button>
            )}
          </DialogFooter>
          ))()}
        </DialogContent>
      </Dialog>
      <AlertDialog
        open={discardConfirmationOpen}
        onOpenChange={setDiscardConfirmationOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved user details?</AlertDialogTitle>
            <AlertDialogDescription>
              The information entered in this Create User form has not been
              saved. Keep editing to preserve it, or discard it and close the
              form.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={discardChangesAndClose}>
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
