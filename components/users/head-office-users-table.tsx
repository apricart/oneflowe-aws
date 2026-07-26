"use client"
import { useEffect, useState, useMemo } from "react"
import { jsonFetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Textarea } from "@/components/ui/textarea"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Command, CommandInput, CommandList, CommandEmpty, CommandGroup, CommandItem } from "@/components/ui/command"
import { Edit, Trash2, Search, User, Mail, Phone, Shield, ShieldCheck, Building2, MapPin, AlertCircle, CheckCircle, ChevronLeft, ChevronRight, RefreshCw, Power, Eye, EyeOff, Upload, FileText, Table as TableIcon, FileJson, Info, MoreHorizontal, ShieldAlert, KeyRound, UserMinus, UserCheck, Calendar, LayoutGrid, List, Check, ChevronsUpDown } from "lucide-react"
import { cn } from "@/lib/utils"
import { motion, AnimatePresence } from "framer-motion"
import { Switch } from "@/components/ui/switch"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger, SheetFooter } from "@/components/ui/sheet"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { PremiumAlert, type AlertType } from "@/components/premium/premium-alert"
import jsPDF from "jspdf"
import autoTable from "jspdf-autotable"
import * as XLSX from "xlsx"
import { handleError } from "@/lib/error-handler"
import {
  createCsv,
  sanitizeSpreadsheetRecords,
} from "@/lib/spreadsheet"

type UserRow = {
  id: string
  firstName: string
  lastName: string
  fullName: string
  email: string
  role: string
  organizationId?: number | null
  branchId?: number | null
  phone?: string
  mfaEnabled?: boolean
  isActive: boolean
  createdAt: string
  employeeId?: string | null
  imprestHolder?: string | null
  contactPerson?: string | null
  address?: string | null
  username?: string | null
}

type HeadOfficeUsersTableProps = {
  users: UserRow[]
  branches: any[]
  organizations: any[]
  userRole?: string
  onUserUpdate: () => void
}

const normalizeSearchValue = (value: string | null | undefined) =>
  (value || "").toLowerCase().trim().replace(/\s+/g, " ")

const userMatchesSearch = (user: UserRow, rawQuery: string) => {
  const query = normalizeSearchValue(rawQuery)
  if (!query) return true

  const displayName = user.fullName || `${user.firstName || ""} ${user.lastName || ""}`
  const searchableText = normalizeSearchValue([
    displayName,
    user.firstName,
    user.lastName,
    user.email,
    user.username,
  ].filter(Boolean).join(" "))

  const queryWithoutSpaces = query.replace(/\s/g, "")
  const searchableWithoutSpaces = searchableText.replace(/\s/g, "")
  const queryTokens = query.split(" ").filter(Boolean)

  return (
    searchableText.includes(query) ||
    searchableWithoutSpaces.includes(queryWithoutSpaces) ||
    queryTokens.every(token => searchableText.includes(token))
  )
}

export function HeadOfficeUsersTable({ users, branches, organizations, userRole, onUserUpdate }: HeadOfficeUsersTableProps) {
  const PAGE_SIZE = 20
  const [viewMode, setViewMode] = useState<"grid" | "table">("table")
  const [searchQuery, setSearchQuery] = useState("")
  const [roleFilter, setRoleFilter] = useState("all")
  const [page, setPage] = useState(1)
  const [editingUser, setEditingUser] = useState<UserRow | null>(null)
  const [viewingUser, setViewingUser] = useState<UserRow | null>(null)
  const [editErrors, setEditErrors] = useState<Record<string, string>>({})
  const [submittingUserId, setSubmittingUserId] = useState<string | null>(null)
  const [statusSubmittingUserId, setStatusSubmittingUserId] = useState<string | null>(null)
  const [deleteConfirm, setDeleteConfirm] = useState<UserRow | null>(null)
  const [editFeedback, setEditFeedback] = useState<{
    message: string
    type: AlertType
    visible: boolean
  }>({
    message: "",
    type: "info",
    visible: false
  })

  const [showPasswordReset, setShowPasswordReset] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmPassword, setShowConfirmPassword] = useState(false)
  const [branchOpen, setBranchOpen] = useState(false)
  const [editUsernameStatus, setEditUsernameStatus] = useState<{
    available: boolean | null
    loading: boolean
    suggestions: string[]
  }>({
    available: null,
    loading: false,
    suggestions: []
  })
  const [editForm, setEditForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    username: "",
    phone: "",
    role: "",
    organizationId: "",
    branchId: "",
    mfaEnabled: false,
    isActive: true,
    password: "",
    confirmPassword: "",
    employeeId: "",
    imprestHolder: "",
    contactPerson: "",
    address: ""
  })

  const showEditFeedback = (message: string, type: AlertType = "warning") => {
    setEditFeedback({ message, type, visible: true })
  }

  // Filter users
  const filteredUsers = useMemo(() => {
    let filtered = users

    // Apply role filter
    if (roleFilter !== "all") {
      filtered = filtered.filter(user => user.role === roleFilter)
    }

    // Apply search
    if (searchQuery) {
      filtered = filtered.filter(user => userMatchesSearch(user, searchQuery))
    }

    return filtered
  }, [users, searchQuery, roleFilter])

  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / PAGE_SIZE))

  useMemo(() => {
    setPage(1)
  }, [searchQuery, roleFilter])

  useMemo(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [totalPages, page])

  const paginatedUsers = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return filteredUsers.slice(start, start + PAGE_SIZE)
  }, [filteredUsers, page])

  const organizationMap = useMemo(() => {
    const map = new Map<number, string>()
    organizations.forEach((org: any) => {
      if (org?.id) {
        map.set(org.id, org.name)
      }
    })
    return map
  }, [organizations])

  const orgStatusMap = useMemo(() => {
    const map = new Map<number, string>()
    organizations.forEach((org: any) => {
      if (org?.id) {
        map.set(org.id, org.status || "active")
      }
    })
    return map
  }, [organizations])

  const branchMap = useMemo(() => {
    const map = new Map<number, string>()
    branches.forEach((branch: any) => {
      if (branch?.id) {
        map.set(branch.id, branch.name)
      }
    })
    return map
  }, [branches])

  const getBranchName = (branchId: number | null | undefined) => {
    if (!branchId) return "—"
    return branchMap.get(branchId as number) || "Unknown"
  }

  const getOrganizationName = (organizationId: number | null | undefined) => {
    if (!organizationId) return "—"
    return organizationMap.get(organizationId as number) || "Unknown"
  }

  // Open edit dialog
  const openEditDialog = (user: UserRow) => {
    setEditingUser(user)
    setEditErrors({})
    setEditFeedback({ message: "", type: "info", visible: false })
    setShowPasswordReset(false)
    setEditForm({
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      email: user.email || "",
      username: user.username || "",
      phone: user.phone || "",
      role: user.role || "",
      organizationId: user.organizationId ? String(user.organizationId) : "",
      branchId: user.branchId ? String(user.branchId) : "",
      mfaEnabled: user.mfaEnabled || false,
      isActive: user.isActive,
      password: "",
      confirmPassword: "",
      employeeId: user.employeeId || "",
      imprestHolder: user.imprestHolder || "",
      contactPerson: user.contactPerson || "",
      address: user.address || ""
    })
    setEditUsernameStatus({ available: null, loading: false, suggestions: [] })
  }

  // Close edit dialog
  const closeEditDialog = () => {
    setEditingUser(null)
    setEditErrors({})
    setEditFeedback({ message: "", type: "info", visible: false })
    setShowPasswordReset(false)
    setEditForm({
      firstName: "",
      lastName: "",
      email: "",
      username: "",
      phone: "",
      role: "",
      organizationId: "",
      branchId: "",
      mfaEnabled: false,
      isActive: true,
      password: "",
      confirmPassword: "",
      employeeId: "",
      imprestHolder: "",
      contactPerson: "",
      address: ""
    })
    setEditUsernameStatus({ available: null, loading: false, suggestions: [] })
  }

  useEffect(() => {
    if (!editingUser) return

    const username = editForm.username.trim().toLowerCase()
    const originalUsername = (editingUser.username || "").trim().toLowerCase()

    if (username.length < 3 || username === originalUsername) {
      setEditUsernameStatus({ available: null, loading: false, suggestions: [] })
      setEditErrors(prev => {
        if (prev.username !== "This username is already taken") return prev
        const next = { ...prev }
        delete next.username
        return next
      })
      return
    }

    let isCurrent = true
    const timer = setTimeout(async () => {
      setEditUsernameStatus(prev => ({ ...prev, loading: true }))
      try {
        const res = await fetch(`/api/v1/users/check-username?username=${username}`)
        const data = await res.json()
        if (!isCurrent) return

        setEditUsernameStatus({
          available: data.available ?? false,
          loading: false,
          suggestions: data.suggestions ?? []
        })

        setEditErrors(prev => {
          const next = { ...prev }
          if (data.available === false) {
            next.username = "This username is already taken"
          } else if (next.username === "This username is already taken") {
            delete next.username
          }
          return next
        })
      } catch (error) {
        console.error("Failed to check username:", error)
        if (!isCurrent) return
        setEditUsernameStatus(prev => ({ ...prev, loading: false }))
      }
    }, 500)

    return () => {
      isCurrent = false
      clearTimeout(timer)
    }
  }, [editForm.username, editingUser])

  // Save user changes
  const saveUser = async () => {
    if (!editingUser) return

    const nextErrors: Record<string, string> = {}
    if (!editForm.username.trim()) {
      nextErrors.username = "Username is required"
    } else if (editForm.username.trim().length < 3) {
      nextErrors.username = "Username must be at least 3 characters"
    } else if (editUsernameStatus.available === false) {
      nextErrors.username = "This username is already taken"
    }
    if (!editForm.email.trim()) {
      nextErrors.email = "Email is required"
    } else if (!/\S+@\S+\.\S+/.test(editForm.email)) {
      nextErrors.email = "Please enter a valid email"
    }
    if (editForm.phone && !/^\d+$/.test(editForm.phone)) {
      nextErrors.phone = "Phone number must contain only digits"
    } else if (editForm.phone && (editForm.phone.length < 7 || editForm.phone.length > 15)) {
      nextErrors.phone = "Phone number must be between 7 and 15 digits"
    }
    if (Object.keys(nextErrors).length > 0) {
      setEditErrors(nextErrors)
      showEditFeedback("Please fix the errors before saving.", "warning")
      return
    }

    // Validate password if reset is enabled
    if (showPasswordReset && editForm.password) {
      if (editForm.password !== editForm.confirmPassword) {
        showEditFeedback("Passwords do not match", "warning")
        return
      }
      if (editForm.password.length < 12) {
        showEditFeedback("Password must be at least 12 characters", "warning")
        return
      }
      if (!/[A-Z]/.test(editForm.password) || !/[a-z]/.test(editForm.password) || !/\d/.test(editForm.password) || !/[^a-zA-Z0-9]/.test(editForm.password)) {
        showEditFeedback("Password must include uppercase, lowercase, number, and special character", "warning")
        return
      }
    }

    setSubmittingUserId(editingUser.id)
    try {
      setEditErrors({})
      const body: any = {}

      const nextFirstName = editForm.firstName.trim()
      const nextLastName = editForm.lastName.trim()
      const nextEmail = editForm.email.trim()
      const nextUsername = editForm.username.trim().toLowerCase()
      const nextPhone = editForm.phone.trim() || null
      const nextOrganizationId = editForm.organizationId ? parseInt(editForm.organizationId) : null
      const nextBranchId = editForm.branchId ? parseInt(editForm.branchId) : null
      const nextEmployeeId = editForm.employeeId.trim() || null
      const nextImprestHolder = editForm.imprestHolder.trim() || null
      const nextContactPerson = editForm.contactPerson.trim() || null
      const nextAddress = editForm.address.trim() || null

      if (nextFirstName !== (editingUser.firstName || "").trim()) body.firstName = nextFirstName
      if (nextLastName !== (editingUser.lastName || "").trim()) body.lastName = nextLastName
      if (nextEmail !== (editingUser.email || "").trim()) body.email = nextEmail
      if (nextUsername !== ((editingUser.username || "").trim().toLowerCase())) body.username = nextUsername
      if (nextPhone !== (editingUser.phone?.trim() || null)) body.phone = nextPhone
      if (editForm.role !== (editingUser.role || "")) body.role = editForm.role
      if (nextOrganizationId !== (editingUser.organizationId ?? null)) body.organizationId = nextOrganizationId
      if (nextBranchId !== (editingUser.branchId ?? null)) body.branchId = nextBranchId
      if (editForm.mfaEnabled !== Boolean(editingUser.mfaEnabled)) body.mfaEnabled = editForm.mfaEnabled
      if (editForm.isActive !== editingUser.isActive) body.isActive = editForm.isActive
      if (nextEmployeeId !== (editingUser.employeeId?.trim() || null)) body.employeeId = nextEmployeeId
      if (nextImprestHolder !== (editingUser.imprestHolder?.trim() || null)) body.imprestHolder = nextImprestHolder
      if (nextContactPerson !== (editingUser.contactPerson?.trim() || null)) body.contactPerson = nextContactPerson
      if (nextAddress !== (editingUser.address?.trim() || null)) body.address = nextAddress

      // Include password if password reset is enabled
      if (showPasswordReset && editForm.password) {
        body.password = editForm.password
      }

      const accessBody: Record<string, unknown> = {}
      const profileBody: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(body)) {
        if (["role", "organizationId", "branchId", "mfaEnabled", "isActive"].includes(key)) {
          accessBody[key] = value
        } else {
          profileBody[key] = value
        }
      }

      if (Object.keys(accessBody).length > 0) {
        await jsonFetcher(`/api/v1/users/${editingUser.id}/access`, {
          method: "PATCH",
          body: JSON.stringify(accessBody)
        })
      }
      if (Object.keys(profileBody).length > 0) {
        await jsonFetcher(`/api/v1/users/${editingUser.id}`, {
          method: "PATCH",
          body: JSON.stringify(profileBody)
        })
      }

      onUserUpdate()
      closeEditDialog()
    } catch (error: any) {
      console.error("Error updating user:", error)
      const parsed = handleError(error, "update user")
      if (parsed.field) {
        setEditErrors({ [parsed.field]: parsed.message })
      }
      showEditFeedback(parsed.message || "Failed to update user", parsed.field ? "warning" : "error")
    } finally {
      setSubmittingUserId(null)
    }
  }

  // Delete user
  const deleteUser = async (user: UserRow) => {
    setSubmittingUserId(user.id)
    try {
      await jsonFetcher(`/api/v1/users/${user.id}`, { method: "DELETE" })
      onUserUpdate()
      setDeleteConfirm(null)
    } catch (error: any) {
      console.error("Error deleting user:", error)
      alert("Failed to delete user: " + error.message)
    } finally {
      setSubmittingUserId(null)
    }
  }

  // Toggle user status
  const toggleUserStatus = async (user: UserRow) => {
    const nextIsActive = !user.isActive
    setStatusSubmittingUserId(user.id)
    setViewingUser(prev => (
      prev && prev.id === user.id
        ? { ...prev, isActive: nextIsActive }
        : prev
    ))
    try {
      await jsonFetcher(`/api/v1/users/${user.id}/access`, {
        method: "PATCH",
        body: JSON.stringify({ isActive: nextIsActive })
      })
      onUserUpdate()
    } catch (error: any) {
      setViewingUser(prev => (
        prev && prev.id === user.id
          ? { ...prev, isActive: user.isActive }
          : prev
      ))
      console.error("Error toggling user status:", error)
      alert("Failed to update user status: " + error.message)
    } finally {
      setStatusSubmittingUserId(null)
    }
  }

  // Get role badge variant
  const getRoleBadge = (role: string) => {
    switch (role) {
      case "HEAD_OFFICE":
        return <Badge className="bg-blue-100 text-blue-800">Head Office</Badge>
      case "BRANCH_ADMIN":
        return <Badge className="bg-green-100 text-green-800">Branch Admin</Badge>
      case "SUPER_ADMIN":
        return <Badge className="bg-purple-100 text-purple-800">Super Admin</Badge>
      case "ORDER_PORTAL":
        return <Badge className="bg-orange-100 text-orange-800">Order Portal</Badge>
      default:
        return <Badge variant="outline">{role}</Badge>
    }
  }

  // Export handlers
  const exportToCSV = () => {
    const headers = ["Name", "Email", "Phone", "Role", "Organization", "Branch", "Company Status", "User Status", "Security (MFA)"]
    const rows = filteredUsers.map(user => [
      user.fullName || `${user.firstName} ${user.lastName}`,
      user.email,
      user.phone || "—",
      user.role,
      getOrganizationName(user.organizationId) || "—",
      getBranchName(user.branchId),
      orgStatusMap.get(user.organizationId as number) || "—",
      user.isActive ? "Active" : "Inactive",
      user.mfaEnabled ? "Enabled" : "Disabled"
    ])

    const csvContent = createCsv(headers, rows)
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" })
    const url = URL.createObjectURL(blob)
    const link = document.createElement("a")
    link.setAttribute("href", url)
    link.setAttribute("download", `users-export-${new Date().getTime()}.csv`)
    link.style.visibility = "hidden"
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
  }

  const exportToExcel = () => {
    const data = filteredUsers.map(user => ({
      "Name": user.fullName || `${user.firstName} ${user.lastName}`,
      "Email": user.email,
      "Phone": user.phone || "—",
      "Role": user.role,
      "Organization": getOrganizationName(user.organizationId) || "—",
      "Branch": getBranchName(user.branchId),
      "Company Status": orgStatusMap.get(user.organizationId as number) || "—",
      "User Status": user.isActive ? "Active" : "Inactive",
      "Security (MFA)": user.mfaEnabled ? "Enabled" : "Disabled"
    }))

    const worksheet = XLSX.utils.json_to_sheet(sanitizeSpreadsheetRecords(data))
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, "Users")
    XLSX.writeFile(workbook, `users-export-${new Date().getTime()}.xlsx`)
  }

  const exportToPDF = () => {
    const doc = new jsPDF({ orientation: "landscape" })
    doc.setFontSize(18)
    doc.text("User Directory Report", 14, 20)
    doc.setFontSize(10)
    doc.text(`Generated: ${new Date().toLocaleString()}`, 14, 28)
    doc.text(`Total Users: ${filteredUsers.length}`, 14, 34)

    const headers = ["Name", "Email", "Phone", "Role", "Org", "Branch", "Co. Status", "User Status", "MFA"]
    const tableData = filteredUsers.map(user => [
      user.fullName || `${user.firstName} ${user.lastName}`,
      user.email,
      user.phone || "—",
      user.role,
      getOrganizationName(user.organizationId) || "—",
      getBranchName(user.branchId),
      orgStatusMap.get(user.organizationId as number) || "—",
      user.isActive ? "Active" : "Inactive",
      user.mfaEnabled ? "Enabled" : "Disabled"
    ])

    autoTable(doc, {
      startY: 40,
      head: [headers],
      body: tableData,
      theme: 'grid',
      headStyles: { fillColor: [66, 66, 66] },
      styles: { fontSize: 8 }
    })

    doc.save(`users-export-${new Date().getTime()}.pdf`)
  }

  return (
    <div className="space-y-4">
      {/* Search and Filter Bar */}
      <div className="flex flex-col md:flex-row gap-4">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-[44%] -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search users by name or email..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="pl-9"
            autoComplete="off"
          />
        </div>
        <Select value={roleFilter} onValueChange={setRoleFilter}>
          <SelectTrigger className="w-[180px]">
            <SelectValue placeholder="Filter by role" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Roles</SelectItem>
            <SelectItem value="HEAD_OFFICE">Head Office</SelectItem>
            <SelectItem value="BRANCH_ADMIN">Branch Admin</SelectItem>
            <SelectItem value="ORDER_PORTAL">Order Portal User</SelectItem>
          </SelectContent>
        </Select>

        <div className="flex bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-1 shadow-sm">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setViewMode("table")}
            className={cn("h-8 px-3 rounded-md transition-all", viewMode === "table" ? "bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-semibold shadow-sm" : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-300")}
          >
            <List className="h-4 w-4 mr-2" />
            Table
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setViewMode("grid")}
            className={cn("h-8 px-3 rounded-md transition-all", viewMode === "grid" ? "bg-slate-100 dark:bg-slate-800 text-indigo-600 dark:text-indigo-400 font-semibold shadow-sm" : "text-slate-500 hover:text-slate-900 dark:hover:text-slate-300")}
          >
            <LayoutGrid className="h-4 w-4 mr-2" />
            Grid
          </Button>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" className="gap-2 h-10 border-slate-200 bg-white dark:bg-slate-900 shadow-sm">
              <Upload className="h-4 w-4" />
              Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-[180px]">
            <DropdownMenuLabel>Export Directory</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={exportToCSV} className="gap-2 cursor-pointer">
              <FileText className="h-4 w-4 text-orange-500" />
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportToExcel} className="gap-2 cursor-pointer">
              <TableIcon className="h-4 w-4 text-green-600" />
              Export as Excel
            </DropdownMenuItem>
            <DropdownMenuItem onClick={exportToPDF} className="gap-2 cursor-pointer">
              <FileJson className="h-4 w-4 text-red-500" />
              Export as PDF
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <AnimatePresence mode="wait">
        {viewMode === "grid" ? (
          <motion.div
            key="grid-view"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4"
          >
            {filteredUsers.length === 0 ? (
              <div className="col-span-full border-2 border-dashed border-slate-200 dark:border-slate-800 rounded-2xl p-16 flex flex-col items-center justify-center text-center bg-slate-50/50 dark:bg-slate-900/50 hover:bg-slate-50 dark:hover:bg-slate-900 transition-colors">
                <div className="h-20 w-20 rounded-full bg-white dark:bg-slate-950 shadow-sm flex items-center justify-center mb-5 ring-1 ring-slate-200 dark:ring-slate-800">
                   <User className="h-8 w-8 text-slate-400" />
                </div>
                <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">No users found</p>
                <p className="text-sm text-slate-500 dark:text-slate-400 mt-2 max-w-sm">We couldn't find any users matching your current search or role filters. Try adjusting them to see more results.</p>
              </div>
            ) : (
              paginatedUsers.map((user, idx) => (
                <motion.div 
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2, delay: idx * 0.05 }}
                  key={user.id}
                  onClick={() => setViewingUser(user)}
                  className="group relative flex flex-col bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-5 hover:border-indigo-500/50 dark:hover:border-indigo-500/50 hover:-translate-y-1 hover:shadow-xl hover:shadow-indigo-500/10 transition-all duration-300 cursor-pointer overflow-hidden"
                >
                  <div className="absolute inset-0 bg-gradient-to-br from-indigo-50/50 to-purple-50/50 dark:from-indigo-900/10 dark:to-purple-900/10 opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
                  {user.isActive && (
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-emerald-400 to-teal-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                  )}
                  
                  <div className="flex justify-between items-start mb-5 relative z-10">
                    <Avatar className="h-14 w-14 ring-4 ring-slate-50 dark:ring-slate-950 group-hover:ring-white dark:group-hover:ring-slate-900 transition-all shadow-sm">
                      <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white font-bold text-lg">
                        {user.firstName?.[0]}{user.lastName?.[0]}
                      </AvatarFallback>
                    </Avatar>
                    <Badge
                      variant="outline"
                      className={cn(
                        "py-1 px-2.5 text-[10px] uppercase font-bold tracking-wider rounded-lg border",
                        user.isActive
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-400 dark:border-emerald-800/60"
                          : "bg-slate-50 text-slate-600 border-slate-200 dark:bg-slate-800/50 dark:text-slate-400 dark:border-slate-800"
                      )}
                    >
                      <span className={cn("mr-1.5 inline-block h-1.5 w-1.5 rounded-full animate-pulse", user.isActive ? "bg-emerald-500" : "bg-slate-400")} />
                      {user.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                  
                  <div className="space-y-1.5 mb-6 relative z-10">
                    <h3 className="font-bold text-lg text-slate-900 dark:text-slate-100 truncate group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                      {user.fullName || `${user.firstName} ${user.lastName}`}
                    </h3>
                    <div className="text-[11px] font-bold text-indigo-500/80 uppercase tracking-wider -mt-1">
                      @{user.username || "unset"}
                    </div>
                    <div className="flex items-center gap-2 text-sm text-slate-500 dark:text-slate-400">
                      <Mail className="h-3.5 w-3.5" />
                      <span className="truncate">{user.email}</span>
                    </div>
                  </div>

                  <div className="mt-auto pt-4 border-t border-slate-100 dark:border-slate-800 flex items-center justify-between relative z-10">
                    <div>
                      {getRoleBadge(user.role)}
                    </div>
                    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-50 dark:bg-slate-800 text-slate-400 group-hover:bg-indigo-100 dark:group-hover:bg-indigo-900/50 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-all group-hover:translate-x-1 shadow-sm">
                      <ChevronRight className="h-4 w-4" />
                    </div>
                  </div>
                </motion.div>
              ))
            )}
          </motion.div>
        ) : (
          <motion.div
            key="table-view"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98 }}
            transition={{ duration: 0.2 }}
            className="border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden bg-white dark:bg-slate-900 shadow-sm"
          >
            <Table>
              <TableHeader>
                <TableRow className="bg-slate-50/50 dark:bg-slate-800/50 hover:bg-slate-50/50">
                  <TableHead className="py-4 pl-6">User</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Branch</TableHead>
                  <TableHead className="text-right pr-6">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredUsers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center py-20">
                      <div className="flex flex-col items-center gap-3 text-muted-foreground">
                        <div className="h-16 w-16 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-2">
                           <User className="h-8 w-8 opacity-20" />
                        </div>
                        <p className="text-base font-medium text-slate-600 dark:text-slate-400">No users found</p>
                        <p className="text-sm opacity-70">Try adjusting your search or role filters</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  paginatedUsers.map((user, idx) => (
                    <motion.tr 
                      initial={{ opacity: 0, x: -10 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ duration: 0.2, delay: idx * 0.03 }}
                      key={user.id} 
                      className="group cursor-pointer hover:bg-indigo-50/30 dark:hover:bg-indigo-950/20 transition-colors border-b border-slate-100 dark:border-slate-800"
                      onClick={() => setViewingUser(user)}
                    >
                      <TableCell className="py-4 pl-6">
                        <div className="flex items-center gap-4">
                          <Avatar className="h-10 w-10 border border-slate-200 dark:border-slate-700 shadow-sm group-hover:scale-105 transition-transform">
                            <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white font-semibold">
                              {user.firstName?.[0]}{user.lastName?.[0]}
                            </AvatarFallback>
                          </Avatar>
                          <div>
                            <div className="font-semibold text-slate-900 dark:text-slate-100 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">{user.fullName || `${user.firstName} ${user.lastName}`}</div>
                            <div className="flex items-center gap-1.5">
                              <span className="text-[10px] font-bold text-indigo-500 uppercase tracking-tight">@{user.username || "unset"}</span>
                              <span className="text-[10px] font-medium text-slate-400 uppercase tracking-tight opacity-50">•</span>
                              <span className="font-mono text-[11px] text-slate-400">#{user.employeeId || user.id.slice(0, 8)}</span>
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                          <Mail className="h-3.5 w-3.5 opacity-60" />
                          {user.email}
                        </div>
                      </TableCell>
                      <TableCell>
                        {getRoleBadge(user.role)}
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                          <Building2 className="h-3.5 w-3.5 opacity-60 shrink-0" />
                          <span className="truncate max-w-[140px]" title={branches.find((b: any) => b.id === user.branchId)?.name || 'Head Office'}>
                            {branches.find((b: any) => b.id === user.branchId)?.name || 'Head Office'}
                          </span>
                        </div>
                      </TableCell>
                      <TableCell className="text-right pr-6">
                        <Badge
                          variant="outline"
                          className={cn(
                            "py-0.5 px-2 font-medium",
                            user.isActive
                              ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800/50"
                              : "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800/50"
                          )}
                        >
                          {user.isActive ? "Active" : "Inactive"}
                        </Badge>
                      </TableCell>
                    </motion.tr>
                  ))
                )}
              </TableBody>
            </Table>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Pagination and Info */}
      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between px-2 pt-2">
        <div className="flex items-center gap-2 text-sm text-slate-500 font-medium">
          <span className="flex h-6 w-6 items-center justify-center rounded-md bg-slate-100 dark:bg-slate-800 text-[10px] text-slate-600 dark:text-slate-400">
            {filteredUsers.length}
          </span>
          <span>Users found in directory</span>
        </div>
        
        <div className="flex items-center gap-3 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 p-1 rounded-lg shadow-sm">
          <Button 
            variant="ghost" 
            size="sm" 
            disabled={page === 1} 
            onClick={() => setPage((prev) => Math.max(1, prev - 1))}
            className="h-8 w-8 p-0"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          
          <div className="flex items-center gap-1.5 px-2">
            <span className="text-xs font-bold text-slate-900 dark:text-slate-100">{page}</span>
            <span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter self-end mb-0.5">of {totalPages}</span>
          </div>

          <Button
            variant="ghost"
            size="sm"
            disabled={page === totalPages || filteredUsers.length === 0}
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
            className="h-8 w-8 p-0"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* User Detail Drawer */}
      <Sheet open={!!viewingUser} onOpenChange={(open) => !open && setViewingUser(null)}>
        <SheetContent className="sm:max-w-md border-l border-slate-200 dark:border-slate-800 p-0 overflow-hidden flex flex-col bg-white dark:bg-slate-950">
          {viewingUser && (
            <>
              <div className="absolute top-0 left-0 w-full h-32 bg-gradient-to-r from-indigo-600 via-indigo-500 to-purple-600 opacity-10 dark:opacity-20 pointer-events-none" />
              
              <SheetHeader className="p-8 pb-4 relative z-10">
                <div className="flex items-start justify-between">
                  <Avatar className="h-20 w-20 border-4 border-white dark:border-slate-900 shadow-xl">
                    <AvatarFallback className="bg-gradient-to-br from-indigo-500 to-purple-600 text-white text-2xl font-bold">
                      {viewingUser.firstName?.[0]}{viewingUser.lastName?.[0]}
                    </AvatarFallback>
                  </Avatar>
                  <div className="flex gap-2">
                    <Badge variant="outline" className={cn(
                      "font-semibold",
                      viewingUser.isActive 
                        ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800"
                        : "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/30 dark:text-red-400 dark:border-red-800"
                    )}>
                      {viewingUser.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </div>
                </div>
                <div className="mt-4 space-y-1">
                  <SheetTitle className="text-2xl font-bold text-slate-900 dark:text-slate-100">
                    {viewingUser.fullName || `${viewingUser.firstName} ${viewingUser.lastName}`}
                  </SheetTitle>
                  <SheetDescription className="text-sm font-medium text-slate-500 flex items-center gap-2">
                    <span className="bg-slate-100 dark:bg-slate-800 px-2 py-0.5 rounded text-[10px] tracking-widest uppercase">
                      ID: {viewingUser.id}
                    </span>
                    <span className="bg-indigo-50 dark:bg-indigo-950/40 text-indigo-700 dark:text-indigo-400 px-2 py-0.5 rounded text-[10px] font-bold tracking-wider">
                      @{viewingUser.username || "no-username"}
                    </span>
                  </SheetDescription>
                </div>
              </SheetHeader>

              <div className="flex-1 overflow-y-auto px-8 py-4 space-y-8 pb-48">
                {/* Status and Primary Roles */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Current Role</p>
                    <div className="flex items-center gap-2">
                      {getRoleBadge(viewingUser.role)}
                    </div>
                  </div>
                  <div className="space-y-1">
                    <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400">Security Status</p>
                    <div className="flex items-center gap-2">
                      {viewingUser.mfaEnabled ? (
                        <Badge className="bg-indigo-100 text-indigo-700 hover:bg-indigo-100 dark:bg-indigo-950/50 dark:text-indigo-400 border-transparent">
                          <ShieldCheck className="mr-1.5 h-3.5 w-3.5" />
                          MFA Enabled
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-slate-400 border-slate-200 dark:border-slate-800">
                           MFA Disabled
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>

                {/* Job Information */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                    <Building2 className="h-4 w-4 text-indigo-500" />
                    <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200 tracking-tight">Assignment Details</h3>
                  </div>
                  <div className="grid gap-4">
                    <div className="flex items-start justify-between">
                      <div className="space-y-0.5">
                         <p className="text-xs text-muted-foreground">Organization</p>
                         <p className="text-sm font-semibold">{getOrganizationName(viewingUser.organizationId)}</p>
                      </div>
                      <div className="space-y-0.5 text-right">
                         <p className="text-xs text-muted-foreground">Branch</p>
                         <p className="text-sm font-semibold">{getBranchName(viewingUser.branchId)}</p>
                      </div>
                    </div>
                    <div className="flex items-start justify-between">
                      <div className="space-y-0.5">
                         <p className="text-xs text-muted-foreground">Employee #</p>
                         <p className="text-sm font-semibold">{viewingUser.employeeId || "Not Set"}</p>
                      </div>
                      <div className="space-y-0.5 text-right">
                         <p className="text-xs text-muted-foreground">Username</p>
                         <p className="text-sm font-bold text-indigo-600 dark:text-indigo-400">@{viewingUser.username || "Not Set"}</p>
                      </div>
                    </div>
                    <div className="flex items-start justify-between">
                      <div className="space-y-0.5">
                         <p className="text-xs text-muted-foreground">Imprest Holder</p>
                         <p className="text-sm font-semibold">{viewingUser.imprestHolder || "Not Applicable"}</p>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Contact Information */}
                <div className="space-y-4">
                  <div className="flex items-center gap-2 border-b border-slate-100 dark:border-slate-800 pb-2">
                    <Mail className="h-4 w-4 text-indigo-500" />
                    <h3 className="text-sm font-bold text-slate-800 dark:text-slate-200 tracking-tight">Contact & Personal</h3>
                  </div>
                  <div className="grid gap-4">
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Email Address</p>
                      <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-sm font-medium">
                        <Mail className="h-3.5 w-3.5 opacity-50 text-indigo-500" />
                        {viewingUser.email}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Phone Number</p>
                      <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-sm font-medium">
                        <Phone className="h-3.5 w-3.5 opacity-50 text-indigo-500" />
                        {viewingUser.phone || "No phone listed"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Contact Person</p>
                      <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-sm font-medium">
                        <User className="h-3.5 w-3.5 opacity-50 text-indigo-500" />
                        {viewingUser.contactPerson || "Not Set"}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-muted-foreground">Address</p>
                      <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-100 dark:border-slate-800 text-sm font-medium min-h-[60px]">
                        <MapPin className="h-3.5 w-3.5 opacity-50 text-indigo-500 mt-0.5" />
                        <span className="leading-tight">{viewingUser.address || "No address provided"}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Timestamps */}
                <div className="pt-4 border-t border-slate-100 dark:border-slate-800">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Calendar className="h-3 w-3" />
                    <span>Joined on {new Date(viewingUser.createdAt).toLocaleDateString(undefined, { dateStyle: 'long' })}</span>
                  </div>
                </div>
              </div>

              <SheetFooter className="mt-auto p-6 bg-white dark:bg-slate-950 border-t border-slate-200 dark:border-slate-800 flex flex-col gap-3 sticky bottom-0 z-20">
                <div className="grid grid-cols-2 gap-3 w-full">
                  <Button 
                    variant="outline" 
                    className="gap-2 border-slate-200 dark:border-slate-800 h-10 shadow-sm"
                    onClick={() => {
                        if (viewingUser) openEditDialog(viewingUser)
                    }}
                  >
                    <Edit className="h-4 w-4" />
                    Edit Profile
                  </Button>
                  <Button 
                    variant="outline" 
                    className="gap-2 border-slate-200 dark:border-slate-800 text-indigo-600 dark:text-indigo-400 h-10 shadow-sm"
                    disabled={viewingUser ? statusSubmittingUserId === viewingUser.id : false}
                    onClick={() => {
                        if (viewingUser) toggleUserStatus(viewingUser)
                    }}
                  >
                    <RefreshCw className={cn("h-4 w-4", viewingUser && statusSubmittingUserId === viewingUser.id && "animate-spin")} />
                    {viewingUser.isActive ? "Deactivate" : "Activate"}
                  </Button>
                  <Button 
                    variant="destructive" 
                    className="gap-2 h-10 shadow-md"
                    onClick={() => {
                        if (viewingUser) setDeleteConfirm(viewingUser)
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                    Delete User
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                       <Button variant="secondary" className="gap-2 h-10 shadow-sm">
                          <MoreHorizontal className="h-4 w-4" />
                          More
                       </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="w-[200px]">
                       <DropdownMenuLabel>Account Security</DropdownMenuLabel>
                       <DropdownMenuSeparator />
                       <DropdownMenuItem onClick={() => {
                           if (viewingUser) {
                               openEditDialog(viewingUser)
                               setShowPasswordReset(true)
                           }
                       }} className="gap-2 cursor-pointer">
                          <KeyRound className="h-4 w-4 text-amber-500" />
                          Reset Password
                       </DropdownMenuItem>
                       {/* <DropdownMenuItem className="gap-2 cursor-pointer">
                          <ShieldAlert className="h-4 w-4 text-red-500" />
                          Revoke Access
                       </DropdownMenuItem> */}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                <Button 
                  variant="ghost" 
                  className="w-full text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors h-9 text-xs"
                  onClick={() => setViewingUser(null)}
                >
                  Close Drawer
                </Button>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      {/* Edit User Dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
          <PremiumAlert
            message={editFeedback.message}
            type={editFeedback.type}
            isVisible={editFeedback.visible}
            placement="sticky"
            onClose={() => setEditFeedback(prev => ({ ...prev, visible: false }))}
          />
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
            <DialogDescription>
              Update user information and permissions
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-6 py-4">
            {/* Basic Information */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Basic Information</h3>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">First Name *</Label>
                  <Input
                    id="firstName"
                    value={editForm.firstName}
                    onChange={e => setEditForm({ ...editForm, firstName: e.target.value })}
                    placeholder="Enter first name"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">Last Name *</Label>
                  <Input
                    id="lastName"
                    value={editForm.lastName}
                    onChange={e => setEditForm({ ...editForm, lastName: e.target.value })}
                    placeholder="Enter last name"
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="email">Email Address *</Label>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  value={editForm.email}
                  onChange={e => {
                    setEditForm({ ...editForm, email: e.target.value })
                    setEditErrors(prev => {
                      const next = { ...prev }
                      delete next.email
                      return next
                    })
                  }}
                  placeholder="Enter email address"
                  autoComplete="off"
                  className={editErrors.email ? "border-red-500" : ""}
                />
                {editErrors.email && (
                  <p className="text-xs text-red-600">{editErrors.email}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-username">Username *</Label>
                <div className="relative">
                  <Input
                    id="edit-username"
                    name="username"
                    value={editForm.username}
                    onChange={e => {
                      const value = e.target.value.toLowerCase()
                      setEditForm({ ...editForm, username: value })
                      setEditErrors(prev => {
                        const next = { ...prev }
                        if (!value.trim()) {
                          next.username = "Username is required"
                        } else if (value.trim().length < 3) {
                          next.username = "Username must be at least 3 characters"
                        } else if (next.username !== "This username is already taken") {
                          delete next.username
                        }
                        return next
                      })
                    }}
                    placeholder="Enter unique username"
                    autoComplete="off"
                    className={editErrors.username ? "border-red-500 pr-10" : "pr-10"}
                  />
                  <div className="absolute right-3 top-1/2 -translate-y-1/2">
                    {editUsernameStatus.loading ? (
                      <div className="h-4 w-4 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    ) : editUsernameStatus.available === true ? (
                      <CheckCircle className="h-4 w-4 text-green-500" />
                    ) : editUsernameStatus.available === false ? (
                      <AlertCircle className="h-4 w-4 text-red-500" />
                    ) : null}
                  </div>
                </div>
                {editErrors.username && (
                  <p className="text-xs text-red-600">{editErrors.username}</p>
                )}
                {editUsernameStatus.available === false && editUsernameStatus.suggestions.length > 0 && (
                  <div className="mt-2 space-y-1">
                    <p className="text-[10px] text-muted-foreground uppercase font-bold tracking-wider">Suggested Lookups:</p>
                    <div className="flex flex-wrap gap-2">
                      {editUsernameStatus.suggestions.map((suggestion) => (
                        <Badge
                          key={suggestion}
                          variant="outline"
                          className="cursor-pointer hover:bg-blue-50 hover:text-blue-700 transition-colors border-blue-200"
                          onClick={() => {
                            setEditForm({ ...editForm, username: suggestion })
                            setEditUsernameStatus(prev => ({ ...prev, available: true, suggestions: [] }))
                            setEditErrors(prev => {
                              const next = { ...prev }
                              delete next.username
                              return next
                            })
                          }}
                        >
                          {suggestion}
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
                  name="phone"
                  value={editForm.phone}
                  onChange={e => {
                    setEditForm({ ...editForm, phone: e.target.value })
                    setEditErrors(prev => {
                      const next = { ...prev }
                      delete next.phone
                      return next
                    })
                  }}
                  placeholder="Enter phone number"
                  className={editErrors.phone ? "border-red-500" : ""}
                />
                {editErrors.phone && (
                  <p className="text-xs text-red-600">{editErrors.phone}</p>
                )}
              </div>
              {/* New Fields: Employee #, Imprest Holder, Contact Person */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="edit-employeeId">Employee #</Label>
                  <Input
                    id="edit-employeeId"
                    name="employeeId"
                    value={editForm.employeeId}
                    onChange={e => {
                      setEditForm({ ...editForm, employeeId: e.target.value })
                      setEditErrors(prev => {
                        const next = { ...prev }
                        delete next.employeeId
                        return next
                      })
                    }}
                    placeholder="Enter employee number"
                    className={editErrors.employeeId ? "border-red-500" : ""}
                  />
                  {editErrors.employeeId && (
                    <p className="text-xs text-red-600">{editErrors.employeeId}</p>
                  )}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="edit-contactPerson">Contact Person</Label>
                  <Input
                  id="edit-contactPerson"
                  value={editForm.contactPerson}
                  onChange={e => setEditForm({ ...editForm, contactPerson: e.target.value })}
                  placeholder="Enter contact person"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-address">Address</Label>
              <Textarea
                id="edit-address"
                value={editForm.address}
                onChange={e => setEditForm({ ...editForm, address: e.target.value })}
                placeholder="Enter full address"
                className="h-20"
              />
            </div>
            <div className="space-y-2">
                <Label htmlFor="edit-imprestHolder">Imprest Holder</Label>
                <Input
                  id="edit-imprestHolder"
                  value={editForm.imprestHolder}
                  onChange={e => setEditForm({ ...editForm, imprestHolder: e.target.value })}
                  placeholder="Enter imprest holder name"
                />
              </div>
            </div>

            {/* Role and Assignment */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Role & Assignment</h3>
              <div className="space-y-2">
                <Label htmlFor="role">Role *</Label>
                <Select disabled value={editForm.role} onValueChange={value => setEditForm({ ...editForm, role: value, branchId: "" })}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="HEAD_OFFICE">Head Office</SelectItem>
                    <SelectItem value="BRANCH_ADMIN">Branch Admin</SelectItem>
                    <SelectItem value="ORDER_PORTAL">Order Portal User</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {(editForm.role === "BRANCH_ADMIN" || editForm.role === "ORDER_PORTAL") && (
                <div className="space-y-2">
                  <Label htmlFor="branch">Branch Assignment *</Label>
                  <Popover open={branchOpen} onOpenChange={setBranchOpen}>
                    <PopoverTrigger asChild>
                      <Button
                        variant="outline"
                        role="combobox"
                        className={cn(
                          "w-full justify-between",
                          !editForm.branchId && "text-muted-foreground"
                        )}
                      >
                        {editForm.branchId
                          ? branches.find((b) => b.id === parseInt(editForm.branchId))?.name
                          : "Select branch"}
                        <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-[200px] p-0">
                      <Command>
                        <CommandInput placeholder="Search branches..." />
                        <CommandList>
                          <CommandEmpty>No branch found.</CommandEmpty>
                          <CommandGroup>
                            {branches
                              .filter(branch => !editForm.organizationId || branch.organizationId === parseInt(editForm.organizationId))
                              .map((branch) => (
                                <CommandItem
                                  key={branch.id}
                                  value={branch.name}
                                  onSelect={() => {
                                    setEditForm({ ...editForm, branchId: String(branch.id) })
                                    setBranchOpen(false)
                                  }}
                                >
                                  <Check
                                    className={cn(
                                      "mr-2 h-4 w-4",
                                      branch.id === parseInt(editForm.branchId)
                                        ? "opacity-100"
                                        : "opacity-0"
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
                </div>
              )}
            </div>

            {/* Security & Access */}
            <div className="space-y-4">
              <h3 className="text-sm font-semibold">Security & Access</h3>
              <div className="flex flex-col gap-4 rounded-lg border p-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-0.5">
                    <Label htmlFor="isActive" className="text-base">Account Status</Label>
                    <p className="text-sm text-muted-foreground">
                      Enable or disable this user's ability to log in
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant={editForm.isActive ? "default" : "secondary"} className={cn(
                      editForm.isActive ? "bg-emerald-500 hover:bg-emerald-600" : "bg-red-500 hover:bg-red-600"
                    )}>
                      {editForm.isActive ? "Active" : "Inactive"}
                    </Badge>
                    <Switch
                      id="isActive"
                      checked={editForm.isActive}
                      onCheckedChange={(checked) => setEditForm({ ...editForm, isActive: checked })}
                    />
                  </div>
                </div>

                <div className="flex items-center justify-between border-t pt-4">
                  <div className="space-y-0.5">
                    <Label htmlFor="edit-mfa" className="text-base">Two-Factor Authentication</Label>
                    <p className="text-sm text-muted-foreground">
                      Require MFA for this user
                    </p>
                  </div>
                  <Switch
                    id="edit-mfa"
                    checked={editForm.mfaEnabled}
                    onCheckedChange={(checked) => setEditForm({ ...editForm, mfaEnabled: checked })}
                  />
                </div>
              </div>
            </div>

            {/* Password Reset */}
            <div className="space-y-4 pt-4 border-t">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">Password Reset</h3>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setShowPasswordReset(!showPasswordReset)
                    if (showPasswordReset) {
                      setEditForm({ ...editForm, password: "", confirmPassword: "" })
                    }
                  }}
                >
                  {showPasswordReset ? "Cancel" : "Reset Password"}
                </Button>
              </div>
              {showPasswordReset && (
                <div className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="password">New Password *</Label>
                    <div className="relative">
                      <Input
                        id="password"
                        type={showPassword ? "text" : "password"}
                        value={editForm.password}
                        onChange={e => setEditForm({ ...editForm, password: e.target.value })}
                        placeholder="Enter password (min 12 chars, mixed case, symbols)"
                        className="pr-10"
                        autoComplete="new-password"
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
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirm Password *</Label>
                    <div className="relative">
                      <Input
                        id="confirmPassword"
                        type={showConfirmPassword ? "text" : "password"}
                        value={editForm.confirmPassword}
                        onChange={e => setEditForm({ ...editForm, confirmPassword: e.target.value })}
                        placeholder="Confirm new password"
                        className="pr-10"
                        autoComplete="new-password"
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="absolute right-0 top-0 h-full px-3 py-2 hover:bg-transparent"
                        onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      >
                        {showConfirmPassword ? (
                          <EyeOff className="h-4 w-4 text-muted-foreground" />
                        ) : (
                          <Eye className="h-4 w-4 text-muted-foreground" />
                        )}
                      </Button>
                    </div>
                    {editForm.password && editForm.confirmPassword && editForm.password !== editForm.confirmPassword && (
                      <p className="text-sm text-red-600">Passwords do not match</p>
                    )}
                    {editForm.password && editForm.password.length > 0 && editForm.password.length < 12 && (
                      <p className="text-sm text-red-600">Password must be at least 12 characters</p>
                    )}
                    {editForm.password && editForm.password.length >= 12 && (!/[A-Z]/.test(editForm.password) || !/[a-z]/.test(editForm.password) || !/\d/.test(editForm.password) || !/[^a-zA-Z0-9]/.test(editForm.password)) && (
                      <p className="text-sm text-red-600">Password must include uppercase, lowercase, number, and special character</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={closeEditDialog}>
              Cancel
            </Button>
            <Button
              onClick={saveUser}
              disabled={
                !!submittingUserId ||
                !editForm.firstName ||
                !editForm.lastName ||
                !editForm.email ||
                !editForm.username ||
                editUsernameStatus.available === false ||
                !editForm.role ||
                ((editForm.role === "BRANCH_ADMIN" || editForm.role === "ORDER_PORTAL") && !editForm.branchId) ||
                (showPasswordReset && (
                  !editForm.password ||
                  !editForm.confirmPassword ||
                  editForm.password !== editForm.confirmPassword ||
                  editForm.password.length < 12 ||
                  !/[A-Z]/.test(editForm.password) ||
                  !/[a-z]/.test(editForm.password) ||
                  !/\d/.test(editForm.password) ||
                  !/[^a-zA-Z0-9]/.test(editForm.password)
                ))
              }
              style={{ background: "var(--color-brand-primary)", color: "white" }}
            >
              {submittingUserId ? "Saving..." : "Save Changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={!!deleteConfirm} onOpenChange={(open) => !open && setDeleteConfirm(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertCircle className="h-5 w-5 text-red-600" />
              Delete User
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete <strong>{deleteConfirm?.fullName || `${deleteConfirm?.firstName} ${deleteConfirm?.lastName}`}</strong>?
              This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteConfirm(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteConfirm && deleteUser(deleteConfirm)}
              disabled={!!submittingUserId}
            >
              {submittingUserId ? "Deleting..." : "Delete User"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
