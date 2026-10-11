"use client"

import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { BRANCH_REGIONS, BRANCH_REGION_LABELS, UNKNOWN_REGION_LABEL, type BranchRegion } from "@/lib/branch-region"

const NONE = "none"

/**
 * The branch's delivery region, for the management delivery dashboard. Super
 * Admin only — the branch routes refuse the field from anyone else.
 */
export function BranchRegionSelect({
  id,
  value,
  onChange,
  disabled,
}: Readonly<{
  id: string
  value: BranchRegion | null
  onChange: (value: BranchRegion | null) => void
  disabled?: boolean
}>) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>Delivery region</Label>
      <Select
        value={value ?? NONE}
        onValueChange={(next) => onChange(next === NONE ? null : (next as BranchRegion))}
        disabled={disabled}
      >
        <SelectTrigger id={id}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{UNKNOWN_REGION_LABEL} (not set)</SelectItem>
          {BRANCH_REGIONS.map((region) => (
            <SelectItem key={region} value={region}>{BRANCH_REGION_LABELS[region]}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">Groups this branch on the delivery dashboard.</p>
    </div>
  )
}
