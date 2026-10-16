"use client"

import { useEffect, useState, type SubmitEvent } from "react"
import { Pencil, Save } from "lucide-react"

import { BranchHeadCountField, headCountFieldValue } from "@/components/branches/branch-head-count-field"
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
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { parseHeadCountInput } from "@/lib/branch-head-count"

/**
 * Head Office editing one of its own branches (plans/OF-BRANCH-head-count.md).
 *
 * Exactly the fields `PATCH /api/v1/branches/[id]` already lets Head Office
 * write, on its own organization's branches: name, province, city, address,
 * cost center and head count. The delivery region is Super Admin's and is not
 * offered; status keeps its own toggle on the page. The server re-checks the
 * tenant and the role whatever this form sends.
 *
 * Only changed fields are sent, so the `UPDATE_BRANCH` audit row names exactly
 * what was edited.
 */
export type EditableBranch = {
  id: number
  name: string
  province?: string | null
  city?: string | null
  address?: string | null
  costCenterId?: string | null
  headCount?: number | null
}

function formFor(branch: EditableBranch) {
  return {
    name: branch.name,
    province: branch.province ?? "",
    city: branch.city ?? "",
    address: branch.address ?? "",
    costCenterId: branch.costCenterId ?? "",
    headCount: headCountFieldValue(branch.headCount),
  }
}

/** A blank optional text field is cleared to null, as the branch route stores it. */
function textOrNull(value: string): string | null {
  const trimmed = value.trim()
  return trimmed || null
}

export function HeadOfficeEditBranchDialog({
  branch,
  onSaved,
  triggerClassName,
}: Readonly<{
  branch: EditableBranch
  onSaved: () => void
  triggerClassName?: string
}>) {
  const { toast } = useToast()
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState(() => formFor(branch))

  useEffect(() => {
    if (open) setForm(formFor(branch))
  }, [open, branch])

  const name = form.name.trim()
  const province = form.province.trim()
  const city = form.city.trim()
  const address = form.address.trim()
  const costCenterId = form.costCenterId.trim()
  const headCount = parseHeadCountInput(form.headCount)

  const lengthOk = (value: string, min: number, max: number) =>
    value === "" || (value.length >= min && value.length <= max)
  const canSubmit = name.length >= 2 && name.length <= 100
    && lengthOk(province, 2, 100)
    && lengthOk(city, 2, 100)
    && lengthOk(address, 5, 500)
    && costCenterId.length <= 128
    && headCount !== undefined

  const update = (field: keyof ReturnType<typeof formFor>, value: string) =>
    setForm((current) => ({ ...current, [field]: value }))

  const submit = async (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!canSubmit || saving) return

    const next = {
      name,
      province: textOrNull(province),
      city: textOrNull(city),
      address: textOrNull(address),
      costCenterId: textOrNull(costCenterId),
      headCount: headCount ?? null,
    }
    const previous = {
      name: branch.name,
      province: branch.province ?? null,
      city: branch.city ?? null,
      address: branch.address ?? null,
      costCenterId: branch.costCenterId ?? null,
      headCount: branch.headCount ?? null,
    }
    const changed = Object.fromEntries(
      (Object.keys(next) as (keyof typeof next)[])
        .filter((key) => next[key] !== previous[key])
        .map((key) => [key, next[key]]),
    )
    if (Object.keys(changed).length === 0) {
      setOpen(false)
      return
    }

    setSaving(true)
    try {
      const response = await fetch(`/api/v1/branches/${branch.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(changed),
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.message || payload?.error || "Failed to update branch")
      }
      setOpen(false)
      onSaved()
      toast({ title: "Branch updated", description: `${name} was saved.`, variant: "success" })
    } catch (caughtError) {
      toast({
        title: "Could not update branch",
        description: caughtError instanceof Error ? caughtError.message : "Please try again.",
        variant: "destructive",
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!saving) setOpen(nextOpen) }}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm" className={triggerClassName}>
          <Pencil className="h-4 w-4" aria-hidden="true" />
          Edit Branch
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit Branch</DialogTitle>
          <DialogDescription>
            Changes apply to this branch in your organization only.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-5" onSubmit={submit}>
          <div className="space-y-4 rounded-lg border bg-muted/20 p-4">
            <div className="space-y-2">
              <Label htmlFor="head-office-edit-branch-name">Branch name</Label>
              <Input
                id="head-office-edit-branch-name"
                value={form.name}
                onChange={(event) => update("name", event.target.value)}
                minLength={2}
                maxLength={100}
                disabled={saving}
                required
              />
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="head-office-edit-branch-province">Province</Label>
                <Input
                  id="head-office-edit-branch-province"
                  value={form.province}
                  onChange={(event) => update("province", event.target.value)}
                  maxLength={100}
                  disabled={saving}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="head-office-edit-branch-city">City</Label>
                <Input
                  id="head-office-edit-branch-city"
                  value={form.city}
                  onChange={(event) => update("city", event.target.value)}
                  maxLength={100}
                  disabled={saving}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="head-office-edit-branch-address">Address</Label>
              <Textarea
                id="head-office-edit-branch-address"
                value={form.address}
                onChange={(event) => update("address", event.target.value)}
                className="min-h-20 resize-none"
                maxLength={500}
                disabled={saving}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="head-office-edit-branch-cost-center">Cost center ID</Label>
              <Input
                id="head-office-edit-branch-cost-center"
                value={form.costCenterId}
                onChange={(event) => update("costCenterId", event.target.value)}
                placeholder="Optional"
                maxLength={128}
                disabled={saving}
              />
            </div>

            <BranchHeadCountField
              id="head-office-edit-branch-head-count"
              value={form.headCount}
              onChange={(value) => update("headCount", value)}
              disabled={saving}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button type="submit" loading={saving} disabled={!canSubmit} className="gap-2">
              <Save className="h-4 w-4" aria-hidden="true" />
              Save Changes
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
