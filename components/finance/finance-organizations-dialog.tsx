"use client"

import { useState } from "react"
import { Building2 } from "lucide-react"

import { OrganizationMultiSelect } from "@/components/finance/organization-multi-select"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { useToast } from "@/hooks/use-toast"
import type { OrganizationOption } from "@/lib/organization-multi-select"

/**
 * Super Admin replaces the organizations one Finance account reads, through
 * `PUT /api/v1/users/{id}/finance-organizations`. Saving none is allowed and
 * leaves the account reading nothing; the dialog says so before it is sent.
 */
export function FinanceOrganizationsDialog({
  open,
  onOpenChange,
  userId,
  userName,
  initialOrganizationIds,
  options,
  onSaved,
}: Readonly<{
  open: boolean
  onOpenChange: (open: boolean) => void
  userId: string
  userName: string
  initialOrganizationIds: number[]
  options: OrganizationOption[]
  onSaved: () => void
}>) {
  const { toast } = useToast()
  // Mounted afresh for each account it edits, so the first value is the only reset needed.
  const [value, setValue] = useState<number[]>(initialOrganizationIds)
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    try {
      const response = await fetch(`/api/v1/users/${userId}/finance-organizations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationIds: [...value].sort((a, b) => a - b) }),
      })
      const result = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(result.error || "Could not save the organizations")
      toast({ title: "Organizations updated", description: `${userName} now reads ${value.length} organization${value.length === 1 ? "" : "s"}.` })
      onSaved()
      onOpenChange(false)
    } catch (saveError) {
      toast({
        title: "Update failed",
        description: saveError instanceof Error ? saveError.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next) }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Building2 className="h-5 w-5" aria-hidden="true" />
            Finance organizations
          </DialogTitle>
          <DialogDescription>
            {userName} reads orders and reports, and marks orders paid or unpaid, in these organizations only.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="finance-organizations-edit">Organizations</Label>
          <OrganizationMultiSelect
            id="finance-organizations-edit"
            options={options}
            value={value}
            onChange={setValue}
            disabled={saving}
          />
          {value.length === 0 && (
            <p className="text-xs text-amber-600" role="status">
              With no organizations this account will see nothing.
            </p>
          )}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={() => { void save() }} disabled={saving}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
