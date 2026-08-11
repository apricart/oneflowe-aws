"use client"

import * as React from "react"
import useSWR from "swr"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { ConfirmDialog } from "@/components/ui/confirm-dialog"
import { useAppContext } from "@/components/context/app-context"

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error("Failed to load")
  return res.json()
}

export function LocalContextSelectors({
  onChange,
}: Readonly<{
  onChange?: (ctx: { organizationId?: string | null; branchId?: string | null }) => void
}>) {
  const { organizationId: globalOrgId, branchId: globalBranchId } = useAppContext()
  const [localSel, setLocalSel] = React.useState<{ organizationId?: string | null; branchId?: string | null }>({
    organizationId: globalOrgId ?? null,
    branchId: globalBranchId ?? null,
  })
  const [confirmOpen, setConfirmOpen] = React.useState(false)
  const [pending, setPending] = React.useState<{ organizationId?: string | null; branchId?: string | null } | null>(
    null,
  )

  const { data: orgs } = useSWR("/api/v1/organizations", fetcher)
  const { data: branches } = useSWR(
    localSel.organizationId ? `/api/v1/branches?organizationId=${localSel.organizationId}` : null,
    fetcher,
  )

  React.useEffect(() => {
    onChange?.(localSel)
  }, [localSel, onChange])

  function request(next: { organizationId?: string | null; branchId?: string | null }) {
    setPending(next)
    setConfirmOpen(true)
  }

  function confirm() {
    if (!pending) return
    setLocalSel(pending)
    setPending(null)
    setConfirmOpen(false)
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <Label>Organization</Label>
        <Select
          value={pending?.organizationId ?? localSel.organizationId ?? undefined}
          onValueChange={(val) => request({ organizationId: val || null, branchId: null })}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Select organization" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {(orgs?.items ?? []).map((o: any) => (
                <SelectItem key={o.id} value={o.id}>
                  {o.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label>Branch</Label>
        <Select
          value={pending?.branchId ?? localSel.branchId ?? undefined}
          onValueChange={(val) =>
            request({ organizationId: localSel.organizationId ?? null, branchId: val === "__ALL__" ? null : val })
          }
          disabled={!localSel.organizationId}
        >
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder={localSel.organizationId ? "Select branch (optional)" : "Select organization"} />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="__ALL__">All branches</SelectItem>
              {(branches?.items ?? []).map((b: any) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <Button
        variant="outline"
        onClick={() => request({ organizationId: globalOrgId ?? null, branchId: globalBranchId ?? null })}
        className="bg-card"
      >
        Use Global
      </Button>

      <ConfirmDialog
        open={confirmOpen}
        onConfirm={confirm}
        onOpenChange={(v) => {
          if (!v) setPending(null)
          setConfirmOpen(v)
        }}
        title="Use different context for this page?"
        description="This will only change filters for this page or form."
        confirmText="Use this here"
        cancelText="Cancel"
      />
    </div>
  )
}
