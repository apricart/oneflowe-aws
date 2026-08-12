"use client"

import { useState } from "react"
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/use-toast"
import {
  Settings,
  Plus,
  Trash2,
  Save,
  Building2,
  Mail,DollarSign,
  Clock,
  Shield
} from "lucide-react"
import useSWR from "swr"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"

const SETTING_CATEGORIES = {
  general: { icon: Settings, label: "General", color: "blue" },
  contact: { icon: Mail, label: "Contact", color: "green" },
  financial: { icon: DollarSign, label: "Financial", color: "amber" },
  security: { icon: Shield, label: "Security", color: "red" },
  operations: { icon: Clock, label: "Operations", color: "purple" },
}

const PREDEFINED_SETTINGS = [
  {
    key: "default_currency",
    label: "Default Currency",
    type: "text",
    category: "financial",
    defaultValue: "PKR",
    description: "Default currency for transactions",
  },
  {
    key: "tax_rate",
    label: "Default Tax Rate",
    type: "number",
    category: "financial",
    defaultValue: "0",
    description: "Tax rate percentage",
  },
  {
    key: "auto_approve_orders",
    label: "Auto-Approve Orders",
    type: "boolean",
    category: "operations",
    defaultValue: false,
    description: "Automatically approve orders below threshold",
  },
  {
    key: "order_approval_threshold",
    label: "Order Approval Threshold",
    type: "number",
    category: "operations",
    defaultValue: "10000",
    description: "Amount requiring manual approval (in cents)",
  },
  {
    key: "support_email",
    label: "Support Email",
    type: "text",
    category: "contact",
    defaultValue: "",
    description: "Support contact email",
  },
  {
    key: "support_phone",
    label: "Support Phone",
    type: "text",
    category: "contact",
    defaultValue: "",
    description: "Support contact phone",
  },
  {
    key: "require_mfa",
    label: "Require MFA",
    type: "boolean",
    category: "security",
    defaultValue: false,
    description: "Enforce multi-factor authentication",
  },
  {
    key: "session_timeout_minutes",
    label: "Session Timeout (minutes)",
    type: "number",
    category: "security",
    defaultValue: "60",
    description: "User session timeout duration",
  },
  {
    key: "low_stock_threshold",
    label: "Low Stock Threshold",
    type: "number",
    category: "operations",
    defaultValue: "10",
    description: "Quantity threshold for low stock alerts",
  },
  {
    key: "enable_notifications",
    label: "Enable Notifications",
    type: "boolean",
    category: "general",
    defaultValue: true,
    description: "Enable system notifications",
  },
]

type SettingDef = {
  key: string
  label: string
  type: string
  category: string
  defaultValue: any
  description: string
}

function SettingEditor({
  setting,
  currentValue,
  onSave,
}: Readonly<{
  setting: SettingDef
  currentValue: any
  onSave: (key: string, value: any) => void
}>) {
  const [localValue, setLocalValue] = useState(
    currentValue ?? setting.defaultValue
  )

  return (
    <div className="p-4 rounded-lg border bg-card">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <Label className="font-semibold">{setting.label}</Label>
          <p className="text-sm text-muted-foreground mt-1">
            {setting.description}
          </p>
          <code className="text-xs bg-muted px-2 py-1 rounded mt-2 inline-block">
            {setting.key}
          </code>
        </div>
        <div className="flex items-center gap-2">
          {setting.type === "boolean" ? (
            <Switch
              checked={localValue === true || localValue === "true"}
              onCheckedChange={(checked) => {
                setLocalValue(checked)
                onSave(setting.key, checked)
              }}
            />
          ) : (
            <div className="flex gap-2">
              <Input
                type={setting.type}
                value={localValue}
                onChange={(e) => setLocalValue(e.target.value)}
                className="w-48"
              />
              <Button size="sm" onClick={() => onSave(setting.key, localValue)}>
                <Save className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export function OrganizationSettingsManager() {
  const { toast } = useToast()
  const [selectedOrg, setSelectedOrg] = useState<number | null>(null)
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [newSetting, setNewSetting] = useState({
    key: "",
    value: "",
    category: "general",
  })

  const { data: orgsData } = useSWR("/api/v1/organizations")
  const { data: settingsData, mutate: mutateSettings } = useSWR(
    selectedOrg ? `/api/v1/settings?organizationId=${selectedOrg}` : null
  )

  const organizations = orgsData?.data || []
  const settings = settingsData?.data || []

  const handleSaveSetting = async (key: string, value: any) => {
    if (!selectedOrg) return

    try {
      const response = await fetch("/api/v1/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId: selectedOrg,
          key,
          value,
        }),
      })

      if (!response.ok) throw new Error("Failed to save setting")

      toast({
        title: "Success",
        description: "Setting saved successfully",
      })
      
      mutateSettings()
    } catch (error) {
      console.error("Failed to save organization setting:", error)
      toast({
        title: "Error",
        description: "Failed to save setting",
        variant: "destructive",
      })
    }
  }

  const handleDeleteSetting = async (id: number) => {
    try {
      const response = await fetch(`/api/v1/settings?id=${id}`, {
        method: "DELETE",
      })

      if (!response.ok) throw new Error("Failed to delete setting")

      toast({
        title: "Success",
        description: "Setting deleted successfully",
      })
      
      mutateSettings()
    } catch (error) {
      console.error("Failed to delete organization setting:", error)
      toast({
        title: "Error",
        description: "Failed to delete setting",
        variant: "destructive",
      })
    }
  }

  const handleAddCustomSetting = async () => {
    if (!selectedOrg || !newSetting.key) return

    await handleSaveSetting(newSetting.key, newSetting.value)
    setIsAddDialogOpen(false)
    setNewSetting({ key: "", value: "", category: "general" })
  }

  const getSettingValue = (key: string) => {
    const setting = settings.find((s: any) => s.key === key)
    return setting?.value
  }

  const settingsByCategory = PREDEFINED_SETTINGS.reduce((acc, setting) => {
    if (!acc[setting.category]) acc[setting.category] = []
    acc[setting.category].push(setting)
    return acc
  }, {} as Record<string, typeof PREDEFINED_SETTINGS>)

  return (
    <div className="space-y-6">
      {/* Organization Selection */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" />
            Organization Selection
          </CardTitle>
          <CardDescription>
            Select an organization to manage its settings
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {organizations.map((org: any) => (
              <button type="button"
                key={org.id}
                onClick={() => setSelectedOrg(org.id)}
                className={`p-4 rounded-lg border-2 transition-all text-left ${
                  selectedOrg === org.id
                    ? "border-primary bg-primary/5 shadow-sm"
                    : "border-muted hover:border-primary/50"
                }`}
              >
                <div className="font-semibold">{org.name}</div>
                {org.code && (
                  <div className="text-sm text-muted-foreground mt-1">
                    Code: {org.code}
                  </div>
                )}
                <Badge
                  variant={org.status === "active" ? "default" : "secondary"}
                  className="mt-2"
                >
                  {org.status}
                </Badge>
              </button>
            ))}
          </div>
        </CardContent>
      </Card>

      {selectedOrg && (
        <>
          {/* Settings by Category */}
          {Object.entries(settingsByCategory).map(([category, categorySettings]) => {
            const categoryInfo = SETTING_CATEGORIES[category as keyof typeof SETTING_CATEGORIES]
            const Icon = categoryInfo.icon

            return (
              <Card key={category}>
                <CardHeader>
                  <CardTitle className="flex items-center gap-2">
                    <Icon className="h-5 w-5" />
                    {categoryInfo.label} Settings
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-4">
                    {categorySettings.map((setting) => (
                      <SettingEditor
                        key={setting.key}
                        setting={setting}
                        currentValue={getSettingValue(setting.key)}
                        onSave={handleSaveSetting}
                      />
                    ))}
                  </div>
                </CardContent>
              </Card>
            )
          })}

          {/* Custom Settings */}
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <div>
                  <CardTitle>Custom Settings</CardTitle>
                  <CardDescription>
                    Organization-specific custom configurations
                  </CardDescription>
                </div>
                <Dialog open={isAddDialogOpen} onOpenChange={setIsAddDialogOpen}>
                  <DialogTrigger asChild>
                    <Button>
                      <Plus className="h-4 w-4 mr-2" />
                      Add Custom Setting
                    </Button>
                  </DialogTrigger>
                  <DialogContent>
                    <DialogHeader>
                      <DialogTitle>Add Custom Setting</DialogTitle>
                      <DialogDescription>
                        Create a new custom setting for this organization
                      </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4">
                      <div>
                        <Label>Setting Key</Label>
                        <Input
                          placeholder="e.g., custom_feature_enabled"
                          value={newSetting.key}
                          onChange={(e) =>
                            setNewSetting({ ...newSetting, key: e.target.value })
                          }
                        />
                      </div>
                      <div>
                        <Label>Value</Label>
                        <Textarea
                          placeholder="Setting value (JSON supported)"
                          value={newSetting.value}
                          onChange={(e) =>
                            setNewSetting({ ...newSetting, value: e.target.value })
                          }
                        />
                      </div>
                    </div>
                    <DialogFooter>
                      <Button variant="outline" onClick={() => setIsAddDialogOpen(false)}>
                        Cancel
                      </Button>
                      <Button onClick={handleAddCustomSetting}>Add Setting</Button>
                    </DialogFooter>
                  </DialogContent>
                </Dialog>
              </div>
            </CardHeader>
            <CardContent>
              {settings.length === 0 ? (
                <div className="text-center py-8 text-muted-foreground">
                  No custom settings configured yet
                </div>
              ) : (
                <div className="grid gap-3">
                  {settings
                    .filter(
                      (s: any) =>
                        !PREDEFINED_SETTINGS.some((ps) => ps.key === s.key)
                    )
                    .map((setting: any) => (
                      <div
                        key={setting.id}
                        className="p-4 rounded-lg border bg-card"
                      >
                        <div className="flex items-start justify-between gap-4">
                          <div className="flex-1">
                            <code className="font-semibold">{setting.key}</code>
                            <pre className="text-sm text-muted-foreground mt-2 bg-muted p-2 rounded overflow-auto">
                              {JSON.stringify(setting.value, null, 2)}
                            </pre>
                          </div>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleDeleteSetting(setting.id)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </div>
                      </div>
                    ))}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  )
}

