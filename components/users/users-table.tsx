"use client"

import useSWR from "swr"
import { useState, useMemo } from "react"
import { jsonFetcher } from "@/lib/fetcher"
import { Button } from "@/components/ui/button"
import { Table, TableHeader, TableRow, TableHead, TableBody, TableCell } from "@/components/ui/table"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/skeleton"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { Edit, Trash2, ChevronLeft, ChevronRight } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { handleError } from "@/lib/error-handler"

type UserRow = { id: string; firstName: string; lastName: string; email: string; role: string; organizationId?: number | null; branchId?: number | null; phone?: string; mfaEnabled?: boolean; createdAt: string; username?: string | null; employeeId?: string | null }
type UsersResp = { items: UserRow[] }

export function UsersTable() {
  const { data, error, mutate, isLoading } = useSWR<UsersResp>("/api/v1/users", jsonFetcher)
  const { data: orgsData } = useSWR<any>("/api/v1/organizations", jsonFetcher)
  const { data: branchesData } = useSWR<any>("/api/v1/branches", jsonFetcher)
  const { toast } = useToast()

  const PAGE_SIZE = 20
  const [filter, setFilter] = useState("")
  const [page, setPage] = useState(1)
  const [editingUser, setEditingUser] = useState<UserRow | null>(null)
  const [showPasswordReset, setShowPasswordReset] = useState(false)
  const [editForm, setEditForm] = useState({
    firstName: "",
    lastName: "",
    email: "",
    phone: "",
    organizationId: "",
    branchId: "",
    mfaEnabled: false,
    password: "",
    confirmPassword: ""
  })

  const organizations = orgsData?.items || []
  const branches = branchesData?.items || []

  async function deleteUser(u: UserRow) {
    if (!confirm("Delete this user?")) return
    try {
      const response = await jsonFetcher<any>(`/api/v1/users/${u.id}`, { method: "DELETE" })

      if (response.error) {
        throw new Error(response.error)
      }

      toast({
        title: "Success!",
        description: "User deleted successfully.",
        variant: "default",
      })

      mutate()
    } catch (error: any) {
      const { message } = handleError(error, "delete user")

      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      })
    }
  }

  function openEditDialog(user: UserRow) {
    setEditingUser(user)
    setShowPasswordReset(false)
    setEditForm({
      firstName: user.firstName || "",
      lastName: user.lastName || "",
      email: user.email || "",
      phone: user.phone || "",
      organizationId: user.organizationId ? String(user.organizationId) : "",
      branchId: user.branchId ? String(user.branchId) : "",
      mfaEnabled: user.mfaEnabled || false,
      password: "",
      confirmPassword: ""
    })
  }

  function closeEditDialog() {
    setEditingUser(null)
    setShowPasswordReset(false)
    setEditForm({
      firstName: "",
      lastName: "",
      email: "",
      phone: "",
      organizationId: "",
      branchId: "",
      mfaEnabled: false,
      password: "",
      confirmPassword: ""
    })
  }

  async function saveEdit() {
    if (!editingUser) return

    try {
      const profileBody: any = {
        firstName: editForm.firstName,
        lastName: editForm.lastName,
        email: editForm.email,
        phone: editForm.phone || null,
      }
      const accessBody = {
        organizationId: editForm.organizationId ? parseInt(editForm.organizationId) : null,
        branchId: editForm.branchId ? parseInt(editForm.branchId) : null,
        mfaEnabled: editForm.mfaEnabled
      }

      // Include password if password reset is enabled and passwords match
      if (showPasswordReset && editForm.password) {
        if (editForm.password !== editForm.confirmPassword) {
          toast({
            title: "Error",
            description: "Passwords do not match",
            variant: "destructive",
          })
          return
        }
        if (editForm.password.length < 12) {
          toast({
            title: "Error",
            description: "Password must be at least 12 characters",
            variant: "destructive",
          })
          return
        }
        if (!/[A-Z]/.test(editForm.password) || !/[a-z]/.test(editForm.password) || !/\d/.test(editForm.password) || !/[^a-zA-Z0-9]/.test(editForm.password)) {
          toast({
            title: "Error",
            description: "Password must include uppercase, lowercase, number, and special character",
            variant: "destructive",
          })
          return
        }
        profileBody.password = editForm.password
      }

      await jsonFetcher<any>(`/api/v1/users/${editingUser.id}/access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(accessBody)
      })

      const response = await jsonFetcher<any>(`/api/v1/users/${editingUser.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(profileBody)
      })

      if (response.error) {
        throw new Error(response.error)
      }

      toast({
        title: "Success!",
        description: "User updated successfully.",
        variant: "default",
      })

      mutate()
      closeEditDialog()
    } catch (error: any) {
      const { message } = handleError(error, "update user")

      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      })
    }
  }

  if (error)
    return (
      <div className="text-sm" style={{ color: "var(--color-destructive)" }}>
        {error.message}
      </div>
    )

  const f = filter.toLowerCase()
  const filteredRows = useMemo(() => {
    return (data?.items || []).filter((u) =>
      (u.firstName || "").toLowerCase().includes(f) ||
      (u.lastName || "").toLowerCase().includes(f) ||
      (u.email || "").toLowerCase().includes(f)
    )
  }, [data?.items, f])

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE))

  useMemo(() => {
    setPage(1)
  }, [filter])

  useMemo(() => {
    if (page > totalPages) {
      setPage(totalPages)
    }
  }, [totalPages, page])

  const rows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE
    return filteredRows.slice(start, start + PAGE_SIZE)
  }, [filteredRows, page])

  return (
    <div className="grid gap-4">
      <div className="flex items-center justify-between gap-2">
        <Input placeholder="Search by name or email" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs" autoComplete="off" />
        {isLoading && <span className="inline-flex items-center gap-2 text-sm text-muted-foreground"><Spinner size={14} /> Loading…</span>}
      </div>
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between text-sm text-muted-foreground">
        <span>
          Showing{" "}
          <span className="font-medium text-foreground">
            {filteredRows.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
            –
            {Math.min(filteredRows.length, page * PAGE_SIZE)}
          </span>{" "}
          of <span className="font-medium text-foreground">{filteredRows.length}</span> users
        </span>
        <div className="inline-flex items-center gap-2">
          <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs">
            Page <span className="font-medium text-foreground">{page}</span> / {totalPages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page === totalPages || filteredRows.length === 0}
            onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Role</TableHead>
            <TableHead>Org</TableHead>
            <TableHead>Branch</TableHead>
            <TableHead>MFA</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-sm text-muted-foreground">No users found.</TableCell>
            </TableRow>
          ) : (
            rows.map((u) => (
              <TableRow key={u.id}>
                <TableCell>
                  <div className="font-medium">{u.firstName} {u.lastName}</div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-indigo-500 font-bold">@{u.username || "unset"}</span>
                    <span className="text-[10px] text-slate-400 font-mono">#{u.employeeId || u.id.slice(0, 8)}</span>
                  </div>
                </TableCell>
                <TableCell>{u.email}</TableCell>
                <TableCell>{u.phone || "-"}</TableCell>
                <TableCell>{u.role}</TableCell>
                <TableCell>{u.organizationId || "-"}</TableCell>
                <TableCell>{u.branchId || "-"}</TableCell>
                <TableCell>{u.mfaEnabled ? "✓" : "-"}</TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => openEditDialog(u)}>
                      <Edit className="h-4 w-4" />
                    </Button>
                    <Button size="sm" variant="destructive" onClick={() => deleteUser(u)}>
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {/* Edit User Dialog */}
      <Dialog open={!!editingUser} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit User</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="firstName">First Name</Label>
                <Input
                  id="firstName"
                  value={editForm.firstName}
                  onChange={(e) => setEditForm({ ...editForm, firstName: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="lastName">Last Name</Label>
                <Input
                  id="lastName"
                  value={editForm.lastName}
                  onChange={(e) => setEditForm({ ...editForm, lastName: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={editForm.email}
                onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                autoComplete="off"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="phone">Phone</Label>
              <Input
                id="phone"
                value={editForm.phone}
                onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="organization">Organization</Label>
              <select
                id="organization"
                value={editForm.organizationId}
                onChange={(e) => setEditForm({ ...editForm, organizationId: e.target.value, branchId: "" })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
              >
                <option value="">No Organization</option>
                {organizations.map((org: any) => (
                  <option key={org.id} value={org.id}>
                    {org.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="branch">Branch</Label>
              <select
                id="branch"
                value={editForm.branchId}
                onChange={(e) => setEditForm({ ...editForm, branchId: e.target.value })}
                disabled={!editForm.organizationId}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm disabled:opacity-50"
              >
                <option value="">No Branch</option>
                {branches
                  .filter((b: any) => !editForm.organizationId || b.organizationId === parseInt(editForm.organizationId))
                  .map((branch: any) => (
                    <option key={branch.id} value={branch.id}>
                      {branch.name}
                    </option>
                  ))}
              </select>
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="mfaEnabled"
                checked={editForm.mfaEnabled}
                onChange={(e) => setEditForm({ ...editForm, mfaEnabled: e.target.checked })}
                className="rounded"
              />
              <Label htmlFor="mfaEnabled" className="cursor-pointer">Enable MFA</Label>
            </div>

            {/* Password Reset Section */}
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
                    <Label htmlFor="password">New Password</Label>
                    <Input
                      id="password"
                      type="password"
                      value={editForm.password}
                      onChange={(e) => setEditForm({ ...editForm, password: e.target.value })}
                      placeholder="Enter password (min 12 chars, mixed case, symbols)"
                      autoComplete="new-password"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">Confirm Password</Label>
                    <Input
                      id="confirmPassword"
                      type="password"
                      value={editForm.confirmPassword}
                      onChange={(e) => setEditForm({ ...editForm, confirmPassword: e.target.value })}
                      placeholder="Confirm new password"
                      autoComplete="new-password"
                    />
                    {editForm.password && editForm.confirmPassword && editForm.password !== editForm.confirmPassword && (
                      <p className="text-sm text-red-600">Passwords do not match</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeEditDialog}>Cancel</Button>
            <Button
              onClick={saveEdit}
              disabled={!!(showPasswordReset && editForm.password && (
                editForm.password !== editForm.confirmPassword ||
                editForm.password.length < 12 ||
                !/[A-Z]/.test(editForm.password) ||
                !/[a-z]/.test(editForm.password) ||
                !/\d/.test(editForm.password) ||
                !/[^a-zA-Z0-9]/.test(editForm.password)
              ))}
            >
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
