"use client"
import { useState } from "react"
import useSWR from "swr"
import { useToast } from "@/hooks/use-toast"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogFooter,DialogDescription } from "@/components/ui/dialog"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Plus,Trash2,Edit,Copy,Eye,EyeOff } from "lucide-react"

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface EmployeeCredential {
  id: number
  email: string
  firstName?: string
  lastName?: string
  mfaEnabled: boolean
  isActive: boolean
  createdAt: string
}

export function EmployeeCredentialsManager() {
  const { toast } = useToast()
  const [showDialog, setShowDialog] = useState(false)
  const [isCreate, setIsCreate] = useState(true)
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [showPassword, setShowPassword] = useState(false)
  const [isLoading, setIsLoading] = useState(false)

  const [formData, setFormData] = useState({
    email: "",
    password: "",
    firstName: "",
    lastName: "",
    mfaEnabled: false,
  })

  const { data: credentialsData, mutate } = useSWR("/api/v1/employee-credentials", fetcher)
  const credentials: EmployeeCredential[] = credentialsData?.credentials || []

  const handleCreate = () => {
    setIsCreate(true)
    setSelectedId(null)
    setFormData({ email: "", password: "", firstName: "", lastName: "", mfaEnabled: false })
    setShowDialog(true)
  }

  const handleEdit = (cred: EmployeeCredential) => {
    setIsCreate(false)
    setSelectedId(cred.id)
    setFormData({
      email: cred.email,
      password: "",
      firstName: cred.firstName || "",
      lastName: cred.lastName || "",
      mfaEnabled: cred.mfaEnabled,
    })
    setShowDialog(true)
  }

  const handleSubmit = async () => {
    if (!formData.email) return toast({ title: "Email required", variant: "destructive" })
    if (isCreate && !formData.password) return toast({ title: "Password required", variant: "destructive" })

    setIsLoading(true)
    try {
      const method = isCreate ? "POST" : "PUT"
      const body = isCreate 
        ? formData 
        : { id: selectedId, firstName: formData.firstName, lastName: formData.lastName, mfaEnabled: formData.mfaEnabled }

      const res = await fetch("/api/v1/employee-credentials", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const json = await res.json()
        return toast({ title: "Failed", description: json.error, variant: "destructive" })
      }

      toast({ title: isCreate ? "Created" : "Updated" })
      setShowDialog(false)
      mutate()
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" })
    } finally {
      setIsLoading(false)
    }
  }

  const handleDelete = async (id: number) => {
    if (!confirm("Deactivate this employee credential?")) return

    try {
      const res = await fetch(`/api/v1/employee-credentials?id=${id}`, {
        method: "DELETE",
      })

      if (!res.ok) {
        const json = await res.json()
        return toast({ title: "Failed", description: json.error, variant: "destructive" })
      }

      toast({ title: "Deactivated" })
      mutate()
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" })
    }
  }

  const copyPassword = (text: string) => {
    navigator.clipboard.writeText(text)
    toast({ title: "Password copied" })
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Employee Portal Credentials</h2>
        <Button onClick={handleCreate} className="gap-2">
          <Plus className="h-4 w-4" />
          Add Employee
        </Button>
      </div>

      <Card className="overflow-hidden">
        {(() => {
          if (credentials.length === 0) {
            return (
          <div className="p-8 text-center text-muted-foreground">
            <p>No employee credentials yet</p>
          </div>
        )
          }
          return (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Email</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>MFA</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {credentials.map(cred => (
                <TableRow key={cred.id}>
                  <TableCell className="font-mono text-sm">{cred.email}</TableCell>
                  <TableCell>{[cred.firstName, cred.lastName].filter(Boolean).join(" ") || "-"}</TableCell>
                  <TableCell>
                    <Badge variant={cred.mfaEnabled ? "default" : "outline"}>
                      {cred.mfaEnabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={cred.isActive ? "default" : "destructive"}>
                      {cred.isActive ? "Active" : "Inactive"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(cred.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right flex justify-end gap-2">
                    {cred.isActive && (
                      <>
                        <Button size="icon" variant="ghost" onClick={() => handleEdit(cred)}>
                          <Edit className="h-4 w-4" />
                        </Button>
                        <Button size="icon" variant="ghost" onClick={() => handleDelete(cred.id)} className="text-destructive">
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )
        })()}
      </Card>

      {/* Create/Edit Dialog */}
      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{isCreate ? "Add Employee" : "Edit Employee"}</DialogTitle>
            <DialogDescription>
              {isCreate 
                ? "Create a new employee credential for the Order Portal"
                : "Update employee information"}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div>
              <label htmlFor="employee-email" className="block text-sm font-medium mb-1">Email *</label>
              <Input
                id="employee-email"
                type="email"
                placeholder="employee@example.com"
                value={formData.email}
                onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                disabled={!isCreate}
              />
            </div>

            {isCreate && (
              <div>
                <label htmlFor="employee-password" className="block text-sm font-medium mb-1">Password *</label>
                <div className="flex gap-2">
                  <Input
                    id="employee-password"
                    type={showPassword ? "text" : "password"}
                    placeholder="••••••••"
                    value={formData.password}
                    onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                  />
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => setShowPassword(!showPassword)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </Button>
                  <Button
                    type="button"
                    size="icon"
                    variant="outline"
                    onClick={() => {
                      const pwd = crypto.randomUUID().replace(/-/g, "").slice(0, 16)
                      setFormData({ ...formData, password: pwd })
                      copyPassword(pwd)
                    }}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label htmlFor="employee-first-name" className="block text-sm font-medium mb-1">First Name</label>
                <Input
                  id="employee-first-name"
                  placeholder="John"
                  value={formData.firstName}
                  onChange={(e) => setFormData({ ...formData, firstName: e.target.value })}
                />
              </div>
              <div>
                <label htmlFor="employee-last-name" className="block text-sm font-medium mb-1">Last Name</label>
                <Input
                  id="employee-last-name"
                  placeholder="Doe"
                  value={formData.lastName}
                  onChange={(e) => setFormData({ ...formData, lastName: e.target.value })}
                />
              </div>
            </div>

            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                id="mfa"
                checked={formData.mfaEnabled}
                onChange={(e) => setFormData({ ...formData, mfaEnabled: e.target.checked })}
                className="h-4 w-4"
              />
              <label htmlFor="mfa" className="text-sm font-medium">
                Enable Two-Factor Authentication
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isLoading}>
              {(() => {
                if (isLoading) {
                  return "Saving..."
                }
                if (isCreate) {
                  return "Create"
                }
                return "Update"
              })()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
