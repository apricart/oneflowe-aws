"use client"

import { useState,useMemo } from "react"
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { Tabs,TabsContent,TabsList,TabsTrigger } from "@/components/ui/tabs"
import { Alert,AlertDescription } from "@/components/ui/alert"
import { useToast } from "@/hooks/use-toast"
import {
  Shield,
  ShieldAlert,
  Save,
  RotateCcw,
  CheckCircle2,
  XCircle,
  Info,
  Search
} from "lucide-react"
import { Input } from "@/components/ui/input"
import {
  PERMISSION_DEFINITIONS,
  PermissionCategory,
  getPermissionsByCategory,
  ROLE_TEMPLATES,
  type PermissionInfo,
} from "@/lib/permissions"
import useSWR,{ mutate } from "swr"

interface RolePermissionsManagerProps {
  roleId?: number
  roleName?: string
}

export function RolePermissionsManager({ roleId, roleName }: Readonly<RolePermissionsManagerProps>) {
  const { toast } = useToast()
  const [selectedRole, setSelectedRole] = useState<number | null>(roleId || null)
  const [permissions, setPermissions] = useState<Set<string>>(new Set())
  const [hasChanges, setHasChanges] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const [showOnlyEnabled, setShowOnlyEnabled] = useState(false)
  const [isSaving, setIsSaving] = useState(false)

  const { data: rolesData } = useSWR("/api/v1/roles")
  const { data: permissionsData } = useSWR(
    selectedRole ? `/api/v1/roles/permissions?roleId=${selectedRole}` : null,
    {
      onSuccess: (data) => {
        if (data?.data) {
          const permKeys = data.data.map((p: any) => p.permissionKey)
          setPermissions(new Set(permKeys))
          setHasChanges(false)
        }
      },
    }
  )

  const roles = rolesData?.data || []
  const selectedRoleData = roles.find((r: any) => r.id === selectedRole)

  const permissionsByCategory = useMemo(() => getPermissionsByCategory(), [])

  const filteredPermissions = useMemo(() => {
    if (!searchQuery && !showOnlyEnabled) return permissionsByCategory

    const filtered = new Map<PermissionCategory, PermissionInfo[]>()
    
    permissionsByCategory.forEach((perms, category) => {
      const matchingPerms = perms.filter((perm) => {
        const matchesSearch = 
          !searchQuery ||
          perm.label.toLowerCase().includes(searchQuery.toLowerCase()) ||
          perm.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
          perm.key.toLowerCase().includes(searchQuery.toLowerCase())
        
        const matchesFilter = !showOnlyEnabled || permissions.has(perm.key)
        
        return matchesSearch && matchesFilter
      })
      
      if (matchingPerms.length > 0) {
        filtered.set(category, matchingPerms)
      }
    })
    
    return filtered
  }, [permissionsByCategory, searchQuery, showOnlyEnabled, permissions])

  const handleTogglePermission = (permissionKey: string) => {
    const newPermissions = new Set(permissions)
    if (newPermissions.has(permissionKey)) {
      newPermissions.delete(permissionKey)
    } else {
      newPermissions.add(permissionKey)
    }
    setPermissions(newPermissions)
    setHasChanges(true)
  }

  const handleSave = async () => {
    if (!selectedRole) return

    setIsSaving(true)
    try {
      const response = await fetch("/api/v1/roles/permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          roleId: selectedRole,
          permissions: Array.from(permissions),
        }),
      })

      if (!response.ok) throw new Error("Failed to save permissions")

      toast({
        title: "Success",
        description: "Permissions updated successfully",
      })
      
      setHasChanges(false)
      mutate(`/api/v1/roles/permissions?roleId=${selectedRole}`)
    } catch (error) {
      console.error("Failed to save role permissions:", error)
      toast({
        title: "Error",
        description: "Failed to save permissions",
        variant: "destructive",
      })
    } finally {
      setIsSaving(false)
    }
  }

  const handleReset = () => {
    if (permissionsData?.data) {
      const permKeys = permissionsData.data.map((p: any) => p.permissionKey)
      setPermissions(new Set(permKeys))
      setHasChanges(false)
    }
  }

  const handleApplyTemplate = (templateKey: keyof typeof ROLE_TEMPLATES) => {
    const template = ROLE_TEMPLATES[templateKey]
    setPermissions(new Set(template.permissions))
    setHasChanges(true)
    toast({
      title: "Template Applied",
      description: `${template.name} permissions template has been applied`,
    })
  }

  const enabledCount = permissions.size
  const totalCount = PERMISSION_DEFINITIONS.length
  const highRiskCount = Array.from(permissions).filter((key) => {
    const perm = PERMISSION_DEFINITIONS.find((p) => p.key === key)
    return perm?.isHighRisk
  }).length

  return (
    <div className="space-y-6">
      {/* Role Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Role Selection
          </CardTitle>
          <CardDescription>
            Select a role to manage its permissions
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {roles.map((role: any) => (
                <button type="button"
                  key={role.id}
                  onClick={() => setSelectedRole(role.id)}
                  className={`p-4 rounded-lg border-2 transition-all text-left ${
                    selectedRole === role.id
                      ? "border-primary bg-primary/5 shadow-sm"
                      : "border-muted hover:border-primary/50"
                  }`}
                >
                  <div className="font-semibold">{role.name}</div>
                  {role.description && (
                    <div className="text-sm text-muted-foreground mt-1">
                      {role.description}
                    </div>
                  )}
                </button>
              ))}
            </div>

            {selectedRole && (
              <div className="flex gap-2 flex-wrap">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleApplyTemplate("SUPER_ADMIN")}
                >
                  Apply Super Admin Template
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleApplyTemplate("HEAD_OFFICE")}
                >
                  Apply Head Office Template
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => handleApplyTemplate("BRANCH_ADMIN")}
                >
                  Apply Branch Admin Template
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {selectedRole && (
        <>
          {/* Stats & Actions */}
          <div className="grid gap-4 md:grid-cols-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-2xl font-bold">{enabledCount}</div>
                    <div className="text-sm text-muted-foreground">
                      Enabled Permissions
                    </div>
                  </div>
                  <CheckCircle2 className="h-8 w-8 text-green-500" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-2xl font-bold">{totalCount - enabledCount}</div>
                    <div className="text-sm text-muted-foreground">
                      Disabled Permissions
                    </div>
                  </div>
                  <XCircle className="h-8 w-8 text-muted-foreground" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-2xl font-bold">{highRiskCount}</div>
                    <div className="text-sm text-muted-foreground">
                      High Risk Enabled
                    </div>
                  </div>
                  <ShieldAlert className="h-8 w-8 text-orange-500" />
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-2xl font-bold">
                      {Math.round((enabledCount / totalCount) * 100)}%
                    </div>
                    <div className="text-sm text-muted-foreground">
                      Coverage
                    </div>
                  </div>
                  <Info className="h-8 w-8 text-blue-500" />
                </div>
              </CardContent>
            </Card>
          </div>

          {hasChanges && (
            <Alert>
              <Info className="h-4 w-4" />
              <AlertDescription className="flex items-center justify-between">
                <span>You have unsaved changes</span>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={handleReset}>
                    <RotateCcw className="h-4 w-4 mr-2" />
                    Reset
                  </Button>
                  <Button size="sm" onClick={handleSave} disabled={isSaving}>
                    <Save className="h-4 w-4 mr-2" />
                    {isSaving ? "Saving..." : "Save Changes"}
                  </Button>
                </div>
              </AlertDescription>
            </Alert>
          )}

          {/* Filters */}
          <Card>
            <CardContent className="p-4">
              <div className="flex gap-4 flex-wrap items-center">
                <div className="flex-1 min-w-[200px]">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                    <Input
                      placeholder="Search permissions..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="pl-10"
                    />
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <Switch
                    id="show-enabled"
                    checked={showOnlyEnabled}
                    onCheckedChange={setShowOnlyEnabled}
                  />
                  <Label htmlFor="show-enabled" className="cursor-pointer">
                    Show only enabled
                  </Label>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Permissions by Category */}
          <Card>
            <CardHeader>
              <CardTitle>Permissions Configuration</CardTitle>
              <CardDescription>
                Enable or disable permissions for {selectedRoleData?.name}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue={Array.from(filteredPermissions.keys())[0]} className="space-y-4">
                <TabsList className="flex-wrap h-auto">
                  {Array.from(filteredPermissions.keys()).map((category) => (
                    <TabsTrigger key={category} value={category} className="flex-1 min-w-fit">
                      {category}
                      <Badge variant="secondary" className="ml-2">
                        {filteredPermissions.get(category)?.filter(p => permissions.has(p.key)).length || 0}
                      </Badge>
                    </TabsTrigger>
                  ))}
                </TabsList>

                {Array.from(filteredPermissions.entries()).map(([category, perms]) => (
                  <TabsContent key={category} value={category} className="space-y-4">
                    <div className="grid gap-3">
                      {perms.map((perm) => {
                        const isEnabled = permissions.has(perm.key)
                        return (
                          <div
                            key={perm.key}
                            className={`p-4 rounded-lg border-2 transition-all ${
                              isEnabled
                                ? "border-primary/30 bg-primary/5"
                                : "border-muted"
                            } ${perm.isHighRisk ? "border-l-4 border-l-orange-500" : ""}`}
                          >
                            <div className="flex items-start justify-between gap-4">
                              <div className="flex-1">
                                <div className="flex items-center gap-2 mb-1">
                                  <Label
                                    htmlFor={perm.key}
                                    className="font-semibold cursor-pointer"
                                  >
                                    {perm.label}
                                  </Label>
                                  {perm.isHighRisk && (
                                    <Badge variant="destructive" className="text-xs">
                                      High Risk
                                    </Badge>
                                  )}
                                </div>
                                <p className="text-sm text-muted-foreground">
                                  {perm.description}
                                </p>
                                <code className="text-xs bg-muted px-2 py-1 rounded mt-2 inline-block">
                                  {perm.key}
                                </code>
                              </div>
                              <Switch
                                id={perm.key}
                                checked={isEnabled}
                                onCheckedChange={() => handleTogglePermission(perm.key)}
                              />
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

