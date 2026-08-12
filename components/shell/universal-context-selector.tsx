"use client"

import { Building2, GitBranch } from "lucide-react"
import { useState, useMemo } from "react"
import { useBranches, useOrganizations } from "@/lib/hooks/use-api"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { useAppContext } from "@/components/context/app-context"

export function UniversalContextSelector() {
  const { organizationId, branchId, setOrganizationId, setBranchId } = useAppContext()
  // Calculate level based on context
  const level = (() => {
    if (branchId) {
      return "BRANCH"
    }
    if (organizationId) {
      return "ORGANIZATION"
    }
    return "GLOBAL"
  })()
  const { data: orgRes } = useOrganizations()
  const { data: branchRes } = useBranches(organizationId || undefined)
  const orgs = (orgRes?.items || []).filter((o: any) => o.status === "active")
  const branches = (branchRes?.items || []).filter(
    (b: any) => b.status === "active" && (!organizationId || b.organizationId === organizationId)
  )

  const [pending, setPending] = useState<{ organizationId: string | null; branchId: string | null } | null>(null)
  const [confirmOpen, setConfirmOpen] = useState(false)

  const orgOptions = useMemo(() => orgs.map((o: any) => ({ value: String(o.id), label: o.name })), [orgs])
  const branchOptions = useMemo(() => branches.map((b: any) => ({ value: String(b.id), label: b.name })), [branches])

  function requestChange(next: { organizationId: string | null; branchId: string | null }) {
    setPending(next)
    setConfirmOpen(true)
  }
  function applyChange() {
    if (!pending) return
    // Apply org first, then branch
    setOrganizationId(pending.organizationId)
    setBranchId(pending.branchId)
    setConfirmOpen(false)
  }

  return (
    <div className="flex items-center gap-2">
      <div className="hidden md:flex items-center gap-2 px-2 py-1 rounded-md border bg-card text-foreground">
        <Building2 size={16} className="opacity-70" />
        <Select
          value={organizationId ?? undefined}
          onValueChange={(val) => {
            const nextOrg = val === "__ALL_ORGS__" ? null : val
            requestChange({ organizationId: nextOrg, branchId: null })
          }}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="All Organizations" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__ALL_ORGS__">All Organizations</SelectItem>
              {orgOptions.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex items-center gap-2 px-2 py-1 rounded-md border bg-card text-foreground">
        <GitBranch size={16} className="opacity-70" />
        <Select
          value={branchId ?? undefined}
          onValueChange={(val) => {
            const nextBranch = val === "__ALL_BRANCHES__" ? null : val
            requestChange({ organizationId: organizationId || null, branchId: nextBranch })
          }}
          disabled={!organizationId}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder={organizationId ? "All Branches" : "Pick organization first"} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__ALL_BRANCHES__">
                {organizationId ? "All Branches" : "Pick organization first"}
              </SelectItem>
              {branchOptions.map((b) => (
                <SelectItem key={b.value} value={b.value}>
                  {b.label}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <Button size="sm" variant="secondary" className="hidden md:inline-flex">
        {(() => {
          if (level === "BRANCH") {
            return "Branch Mode"
          }
          if (level === "ORGANIZATION") {
            return "Org Mode"
          }
          return "Global"
        })()}
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="Switch working location?"
        description="This will update your active organization/branch across the app. You can override per page if needed."
        confirmText="Switch"
        onConfirm={applyChange}
      />
    </div>
  )
}
