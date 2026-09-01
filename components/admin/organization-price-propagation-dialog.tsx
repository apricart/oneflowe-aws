"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR from "swr"
import { AlertCircle, ArrowRight, Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  groupsWithChangedPrice,
  planGroupPricePropagation,
  type PropagationMode,
} from "@/lib/group-price-propagation"
import { formatPKR } from "@/lib/utils"

const fetcher = async (url: string) => {
  const res = await fetch(url)
  const data = await res.json().catch(() => null)
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`)
  return data
}

type ImpactGroup = {
  groupId: number
  name: string
  groupPriceCents: number | null
  branchCount: number
}

type ImpactResponse = {
  item: {
    organizationInventoryId: number
    name: string
    basePriceCents: number
    organizationPriceCents: number | null
  }
  groups: ImpactGroup[]
}

export type PropagationChoice = { mode: PropagationMode; groupIds?: number[] }

const MODE_LABELS: Record<PropagationMode, { title: string; detail: string }> = {
  all: {
    title: "Apply to all groups",
    detail: "Every group pays the new organization price. Group prices for this product are removed.",
  },
  selected: {
    title: "Apply to specific groups",
    detail: "The groups you pick take the new price. Every other group keeps paying exactly what it pays today.",
  },
  none: {
    title: "Organization price only",
    detail: "Groups with their own price keep it. Groups without one follow the new organization price.",
  },
}

/**
 * Asks what a pending organization price change should do to group prices.
 *
 * The preview is computed with `planGroupPricePropagation` — the same function
 * the server uses to decide what to write — so what is shown here and what
 * happens cannot disagree. Only the chosen mode and group ids are sent; the
 * server rebuilds the plan from its own rows.
 *
 * The screen is only reachable from a price edit, which is Super Admin only.
 */
export function OrganizationPricePropagationDialog({
  organizationInventoryId,
  nextPriceCents,
  open,
  isSaving,
  onCancel,
  onConfirm,
}: Readonly<{
  organizationInventoryId: number | null
  /** The organization price about to be saved; null clears it to the base price. */
  nextPriceCents: number | null
  open: boolean
  isSaving: boolean
  onCancel: () => void
  onConfirm: (choice: PropagationChoice) => void
}>) {
  const [mode, setMode] = useState<PropagationMode>("none")
  const [selectedGroupIds, setSelectedGroupIds] = useState<number[]>([])

  const { data, error, isLoading } = useSWR<ImpactResponse>(
    open && organizationInventoryId
      ? `/api/v1/admin/organization-assignments/price-impact?organizationInventoryId=${organizationInventoryId}`
      : null,
    fetcher,
    { revalidateOnFocus: false },
  )

  // A different product, or a reopened dialog, must not inherit the last answer.
  useEffect(() => {
    setMode("none")
    setSelectedGroupIds([])
  }, [organizationInventoryId, open])

  const groups = useMemo(() => data?.groups ?? [], [data])

  const plan = useMemo(() => {
    if (!data) return null
    return planGroupPricePropagation({
      mode,
      selectedGroupIds,
      basePriceCents: data.item.basePriceCents,
      currentOrganizationPriceCents: data.item.organizationPriceCents,
      nextOrganizationPriceCents: nextPriceCents,
      groups: groups.map((group) => ({
        groupId: group.groupId,
        name: group.name,
        groupPriceCents: group.groupPriceCents,
      })),
    })
  }, [data, groups, mode, nextPriceCents, selectedGroupIds])

  const changed = plan ? groupsWithChangedPrice(plan) : []
  const branchCountById = new Map(groups.map((group) => [group.groupId, group.branchCount]))

  const toggleGroup = (groupId: number) => {
    setSelectedGroupIds((current) => current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId])
  }

  const confirm = () => {
    onConfirm(mode === "selected" ? { mode, groupIds: selectedGroupIds } : { mode })
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && !isSaving && onCancel()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Apply this price to groups?</DialogTitle>
          <DialogDescription>
            {data
              ? `${data.item.name} — organization price ${formatPKR((data.item.organizationPriceCents ?? data.item.basePriceCents) / 100)} → ${formatPKR((nextPriceCents ?? data.item.basePriceCents) / 100)}`
              : "Choose what happens to this product's group prices."}
          </DialogDescription>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-500">
            <Loader2 className="h-4 w-4 animate-spin" />
            Working out what this changes…
          </div>
        )}

        {error && (
          <div className="flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-300">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{error instanceof Error ? error.message : "Could not load group prices."}</span>
          </div>
        )}

        {data && groups.length === 0 && (
          <p className="py-6 text-sm text-slate-500">
            This organization has no groups, so there is nothing else to decide. Saving will change
            the organization price only.
          </p>
        )}

        {data && groups.length > 0 && (
          <>
            <RadioGroup value={mode} onValueChange={(value) => setMode(value as PropagationMode)}>
              {(["all", "selected", "none"] as const).map((option) => (
                <div key={option} className="flex items-start gap-3 rounded-xl border border-slate-100 p-3 dark:border-slate-800">
                  <RadioGroupItem value={option} id={`propagation-${option}`} className="mt-1" />
                  <div>
                    <Label htmlFor={`propagation-${option}`} className="font-medium">
                      {MODE_LABELS[option].title}
                    </Label>
                    <p className="text-xs text-slate-500">{MODE_LABELS[option].detail}</p>
                  </div>
                </div>
              ))}
            </RadioGroup>

            {mode === "selected" && (
              <ScrollArea className="h-40 rounded-xl border border-slate-100 p-2 dark:border-slate-800">
                {groups.map((group) => (
                  <label
                    key={group.groupId}
                    className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-slate-50 dark:hover:bg-slate-800/40"
                  >
                    <Checkbox
                      checked={selectedGroupIds.includes(group.groupId)}
                      onCheckedChange={() => toggleGroup(group.groupId)}
                    />
                    <span className="text-sm">{group.name}</span>
                    <span className="text-xs text-slate-500">
                      {group.branchCount} branch{group.branchCount === 1 ? "" : "es"}
                    </span>
                    {group.groupPriceCents !== null && (
                      <Badge variant="outline" className="text-xs">own price</Badge>
                    )}
                  </label>
                ))}
              </ScrollArea>
            )}

            <div className="rounded-xl border border-slate-100 p-3 dark:border-slate-800">
              <p className="mb-2 text-sm font-medium">
                {changed.length === 0
                  ? "No group's price changes."
                  : `${changed.length} group${changed.length === 1 ? "" : "s"} change price:`}
              </p>
              <ScrollArea className="max-h-32">
                {changed.map((action) => (
                  <div key={action.groupId} className="flex items-center gap-2 py-1 text-sm">
                    <span className="min-w-32 font-medium">{action.name}</span>
                    <span className="text-slate-500">{formatPKR(action.beforeCents / 100)}</span>
                    <ArrowRight className="h-3 w-3 text-slate-400" />
                    <span className="font-semibold">{formatPKR(action.afterCents / 100)}</span>
                    <span className="text-xs text-slate-500">
                      ({branchCountById.get(action.groupId) ?? 0} branches)
                    </span>
                  </div>
                ))}
              </ScrollArea>
              {plan && plan.pins.length > 0 && (
                <p className="mt-2 text-xs text-slate-500">
                  {plan.pins.length} group{plan.pins.length === 1 ? "" : "s"} will be given their
                  current price so they stay where they are.
                </p>
              )}
            </div>
          </>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={onCancel} disabled={isSaving}>
            Cancel
          </Button>
          <Button onClick={confirm} disabled={isSaving || isLoading || Boolean(error)}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save price
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
