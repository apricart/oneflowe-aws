"use client"

import { useState, type SubmitEvent } from "react"
import { GitBranch, Save } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"

export type CreatedBranch = {
  id: number
  organizationId: number
  name: string
  code?: string | null
  status?: string | null
}

type Props = {
  organizationId: number | null
  onCreated: (branch: CreatedBranch) => void
}

const initialForm = {
  name: "",
  province: "",
  city: "",
  address: "",
  costCenterId: "",
  isActive: true,
}

export function HeadOfficeCreateBranchDialog({ organizationId, onCreated }: Readonly<Props>) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(initialForm)

  const normalized = {
    name: form.name.trim(),
    province: form.province.trim(),
    city: form.city.trim(),
    address: form.address.trim(),
    costCenterId: form.costCenterId.trim(),
  }
  const canSubmit = Boolean(
    organizationId &&
    normalized.name.length >= 2 && normalized.name.length <= 100 &&
    normalized.province.length >= 2 && normalized.province.length <= 100 &&
    normalized.city.length >= 2 && normalized.city.length <= 100 &&
    normalized.address.length >= 5 && normalized.address.length <= 500 &&
    normalized.costCenterId.length <= 128
  )

  const updateField = (field: keyof typeof initialForm, value: string | boolean) => {
    setForm((current) => ({ ...current, [field]: value }))
  }

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || !organizationId) return

    setSaving(true)
    try {
      const response = await fetch("/api/v1/branches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          organizationId,
          name: normalized.name,
          province: normalized.province,
          city: normalized.city,
          address: normalized.address,
          costCenterId: normalized.costCenterId || null,
          status: form.isActive ? "active" : "inactive",
        }),
      })

      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || "Failed to create branch")
      }

      setForm(initialForm)
      setOpen(false)
      onCreated(payload.item as CreatedBranch)
      toast({
        title: "Branch created",
        description: `${payload.item.name} was added to your organization.`,
        variant: "success",
      })
    } catch (error) {
      toast({
        title: "Could not create branch",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!saving) setOpen(nextOpen)
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          disabled={!organizationId}
          className="h-9 gap-2 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400"
        >
          <GitBranch className="h-4 w-4" />
          Create Branch
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Branch</DialogTitle>
          <DialogDescription>
            The new branch will be created only inside your assigned Head Office organization.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={submit}>
          <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
            <div className="rounded-md border bg-background px-3 py-2">
              <p className="text-sm font-medium">Organization assignment</p>
              <p className="text-xs text-muted-foreground">
                Fixed by your account permissions and verified again by the server.
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="head-office-branch-name">Branch name</Label>
              <Input
                id="head-office-branch-name"
                value={form.name}
                onChange={(event) => updateField("name", event.target.value)}
                placeholder="Downtown Branch"
                minLength={2}
                maxLength={100}
                disabled={saving}
                required
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="head-office-branch-province">Province</Label>
                <Input
                  id="head-office-branch-province"
                  value={form.province}
                  onChange={(event) => updateField("province", event.target.value)}
                  placeholder="Punjab"
                  minLength={2}
                  maxLength={100}
                  disabled={saving}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="head-office-branch-city">City</Label>
                <Input
                  id="head-office-branch-city"
                  value={form.city}
                  onChange={(event) => updateField("city", event.target.value)}
                  placeholder="Lahore"
                  minLength={2}
                  maxLength={100}
                  disabled={saving}
                  required
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="head-office-branch-address">Address</Label>
              <Textarea
                id="head-office-branch-address"
                value={form.address}
                onChange={(event) => updateField("address", event.target.value)}
                placeholder="Street address, area, building, or landmark"
                className="min-h-20 resize-none"
                minLength={5}
                maxLength={500}
                disabled={saving}
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="head-office-branch-cost-center">Cost center ID</Label>
              <Input
                id="head-office-branch-cost-center"
                value={form.costCenterId}
                onChange={(event) => updateField("costCenterId", event.target.value)}
                placeholder="Optional"
                maxLength={128}
                disabled={saving}
              />
            </div>

            <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
              <div>
                <Label htmlFor="head-office-branch-status">Status</Label>
                <p className="text-xs text-muted-foreground">Make this branch available immediately.</p>
              </div>
              <Switch
                id="head-office-branch-status"
                checked={form.isActive}
                onCheckedChange={(checked) => updateField("isActive", checked)}
                disabled={saving}
                aria-label="Active branch"
              />
            </div>

            <p className="text-xs text-muted-foreground">
              The branch code will be generated automatically.
            </p>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="submit"
              loading={saving}
              disabled={!canSubmit}
              className="gap-2 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
            >
              <Save className="h-4 w-4" />
              Save Branch
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
