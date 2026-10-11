"use client"

import { useState } from "react"
import useSWR from "swr"
import { Loader2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { toast } from "@/hooks/use-toast"
import { describeExecutiveOrganizations, toggleExecutiveOrganization } from "@/lib/apricart-executive-team-view"
import { fetcher } from "@/lib/fetcher"

type Executive = {
  id: string
  fullName: string | null
  username: string | null
  email: string
  isActive: boolean
  organizationIds: number[]
}

type AssignableOrganization = {
  id: number
  name: string
  code: string | null
  status: string | null
  managedOrdering: boolean
}

type ExecutiveTeam = { members: Executive[]; organizations: AssignableOrganization[] }

export const EXECUTIVE_TEAM_KEY = "/api/v1/apricart-executives"

function OrganizationsDialog({
  executive,
  organizations,
  onClose,
  onSaved,
}: Readonly<{
  executive: Executive
  organizations: AssignableOrganization[]
  onClose: () => void
  onSaved: () => void
}>) {
  const [selected, setSelected] = useState<number[]>(executive.organizationIds)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async () => {
    if (saving) return
    setSaving(true)
    setFormError(null)
    try {
      const response = await fetch(`${EXECUTIVE_TEAM_KEY}/${executive.id}/organizations`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationIds: selected }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setFormError(typeof data?.error === "string" ? data.error : "The organizations could not be saved")
        return
      }
      toast({ title: "Approvals saved", description: executive.fullName ?? executive.email })
      onSaved()
      onClose()
    } catch {
      setFormError("The request could not be sent. Check the connection and try again.")
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Approvals for {executive.fullName ?? executive.email}</DialogTitle>
          <DialogDescription>
            They approve, reject or send back the Order Desk&apos;s orders for the organizations ticked here, and no others.
          </DialogDescription>
        </DialogHeader>
        <fieldset className="max-h-80 space-y-1 overflow-y-auto rounded-md border p-2" disabled={saving}>
          <legend className="sr-only">Organizations</legend>
          {organizations.map((organization) => {
            const id = `executive-org-${organization.id}`
            return (
              <div key={organization.id} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted/50">
                <Checkbox
                  id={id}
                  checked={selected.includes(organization.id)}
                  onCheckedChange={() => setSelected((current) => toggleExecutiveOrganization(current, organization.id))}
                />
                <label htmlFor={id} className="flex flex-1 flex-wrap items-center gap-2 text-sm">
                  {organization.name}
                  {organization.managedOrdering && <Badge variant="secondary">Order Desk</Badge>}
                  {organization.status?.toLowerCase() !== "active" && <Badge variant="outline">{organization.status ?? "inactive"}</Badge>}
                </label>
              </div>
            )
          })}
        </fieldset>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => { void submit() }} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Super Admin's list of Apricart Executives and the organizations whose Order
 * Desk orders each one approves. Executive accounts themselves are created
 * from Users.
 */
export function ExecutiveApproversCard() {
  const { data, error, isLoading, mutate } = useSWR<ExecutiveTeam>(EXECUTIVE_TEAM_KEY, fetcher)
  const [editing, setEditing] = useState<Executive | null>(null)
  const organizations = data?.organizations ?? []

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Order approvers (Apricart Executive)</CardTitle>
        <CardDescription>
          Every Order Desk order waits for an executive assigned to its organization. Create executive accounts from Users.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p role="alert" className="text-sm text-destructive">Could not load the approvers.</p>}
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {data && data.members.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No Apricart Executive accounts yet.</p>
        )}
        {data && data.members.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Approves for</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.members.map((executive) => (
                  <tr key={executive.id} className="border-t align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{executive.fullName ?? "—"}</div>
                      <div className="text-xs text-muted-foreground">{executive.username} · {executive.email}</div>
                    </td>
                    <td className="py-2 pr-3">{describeExecutiveOrganizations(executive.organizationIds, organizations)}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={executive.isActive ? "default" : "outline"}>{executive.isActive ? "Active" : "Inactive"}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => setEditing(executive)}>Organizations</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {editing && (
        <OrganizationsDialog
          key={editing.id}
          executive={editing}
          organizations={organizations}
          onClose={() => setEditing(null)}
          onSaved={() => { void mutate() }}
        />
      )}
    </Card>
  )
}
