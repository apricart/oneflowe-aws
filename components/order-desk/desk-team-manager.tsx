"use client"

import { useState } from "react"
import useSWR from "swr"
import { Headset, Loader2, Plus, Search } from "lucide-react"

import { EXECUTIVE_APPROVALS_KEY_PREFIX, ExecutiveApprovals } from "@/components/executive-approvals/executive-approvals"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ExecutiveApproversCard } from "@/components/order-desk/executive-approvers-card"
import { EditApricartAccountDialog } from "@/components/users/edit-apricart-account-dialog"
import { toast } from "@/hooks/use-toast"
import type { ExecutiveApprovalCounts } from "@/lib/executive-approval-query"
import { fetcher } from "@/lib/fetcher"
import {
  describeDeskReach,
  filterReachOrganizations,
  reachDraftFor,
  setVisibleReach,
  toggleReachBranch,
  toggleReachOrganization,
  type DeskReachDraft,
} from "@/lib/order-desk-team-view"

type Member = {
  id: string
  fullName: string | null
  firstName: string | null
  lastName: string | null
  phone: string | null
  username: string | null
  email: string
  isActive: boolean
  mustChangePassword: boolean
  organizationIds: number[]
  branchIds: number[]
}

type ManagedOrganization = {
  id: number
  name: string
  code: string | null
  status: string | null
  branches: { id: number; name: string; status: string | null }[]
}

type DeskTeam = { members: Member[]; managedOrganizations: ManagedOrganization[] }

const TEAM_KEY = "/api/v1/order-desk/team"

async function readError(response: Response, fallback: string) {
  const data = await response.json().catch(() => ({}))
  return typeof data?.error === "string" ? data.error : fallback
}

async function saveReach(userId: string, reach: DeskReachDraft): Promise<string | null> {
  const response = await fetch(`/api/v1/order-desk/team/${userId}/assignments`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ organizationIds: [...reach.organizationIds], branchIds: [...reach.branchIds] }),
  })
  return response.ok ? null : readError(response, "Access could not be saved")
}

/** Ticks for which managed organizations, or single branches, a desk user may order for. */
function ReachEditor({
  organizations,
  value,
  onChange,
  disabled,
}: Readonly<{
  organizations: ManagedOrganization[]
  value: DeskReachDraft
  onChange: (next: DeskReachDraft) => void
  disabled: boolean
}>) {
  const [query, setQuery] = useState("")
  const visible = filterReachOrganizations(organizations, query)

  if (organizations.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        No organization is managed by the Order Desk yet. Switch on &ldquo;Managed by Apricart Order Desk&rdquo; in an
        organization&apos;s Edit Company dialog first.
      </p>
    )
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            aria-label="Search organizations and branches"
            placeholder="Search organizations or branches"
            className="pl-8"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || visible.length === 0}
          onClick={() => onChange(setVisibleReach(value, visible, true))}
        >
          {query.trim() ? "Select shown" : "Select all"}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled || visible.length === 0}
          onClick={() => onChange(setVisibleReach(value, visible, false))}
        >
          {query.trim() ? "Unselect shown" : "Unselect all"}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        {value.organizationIds.size} organization{value.organizationIds.size === 1 ? "" : "s"} whole,{" "}
        {value.branchIds.size} single branch{value.branchIds.size === 1 ? "" : "es"} selected
      </p>
      <div className="max-h-[360px] space-y-3 overflow-y-auto rounded-md border p-3">
        {visible.length === 0 && (
          <p className="py-4 text-center text-sm text-muted-foreground">No organization or branch matches &ldquo;{query.trim()}&rdquo;.</p>
        )}
        {visible.map(({ organization, branches }) => {
          const whole = value.organizationIds.has(organization.id)
          const checkboxId = `reach-org-${organization.id}`
          return (
            <div key={organization.id} className="space-y-2">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={checkboxId}
                  checked={whole}
                  disabled={disabled}
                  onCheckedChange={() => onChange(toggleReachOrganization(value, organization.id, organization.branches.map((branch) => branch.id)))}
                />
                <Label htmlFor={checkboxId} className="font-medium">
                  {organization.name} — all branches
                </Label>
                {organization.status?.toLowerCase() !== "active" && <Badge variant="outline">Inactive</Badge>}
              </div>
              {!whole && branches.length > 0 && (
                <div className="ml-6 grid gap-1 sm:grid-cols-2">
                  {branches.map((branch) => {
                    const branchCheckboxId = `reach-branch-${branch.id}`
                    return (
                      <div key={branch.id} className="flex items-center gap-2">
                        <Checkbox
                          id={branchCheckboxId}
                          checked={value.branchIds.has(branch.id)}
                          disabled={disabled}
                          onCheckedChange={() => onChange(toggleReachBranch(value, branch.id))}
                        />
                        <Label htmlFor={branchCheckboxId} className="text-sm font-normal">{branch.name}</Label>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const EMPTY_REACH: DeskReachDraft = { organizationIds: new Set(), branchIds: new Set() }

function AddDeskUserDialog({
  open,
  onOpenChange,
  organizations,
  onSaved,
}: Readonly<{
  open: boolean
  onOpenChange: (open: boolean) => void
  organizations: ManagedOrganization[]
  onSaved: () => void
}>) {
  const [form, setForm] = useState({ firstName: "", lastName: "", email: "", username: "", password: "" })
  const [reach, setReach] = useState<DeskReachDraft>(EMPTY_REACH)
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const reset = () => {
    setForm({ firstName: "", lastName: "", email: "", username: "", password: "" })
    setReach(EMPTY_REACH)
    setFormError(null)
  }

  const submit = async () => {
    if (saving) return
    setSaving(true)
    setFormError(null)
    try {
      const response = await fetch("/api/v1/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...form, role: "ORDER_DESK", organizationId: null, branchId: null }),
      })
      if (!response.ok) {
        setFormError(await readError(response, "The desk user could not be created"))
        return
      }
      const created = await response.json()
      // A new desk user reaches nothing until access is granted, so a failure
      // here leaves a harmless account the access dialog can finish.
      const reachError = await saveReach(created.item.id, reach)
      toast(reachError
        ? { title: "Desk user created", description: `Access was not saved: ${reachError}`, variant: "destructive" }
        : { title: "Desk user created", description: "They must change their password at first sign-in." })
      reset()
      onOpenChange(false)
      onSaved()
    } catch {
      setFormError("The request could not be sent. Check the connection and try again.")
    } finally {
      setSaving(false)
    }
  }

  const field = (key: keyof typeof form, label: string, type = "text") => (
    <div className="space-y-1">
      <Label htmlFor={`desk-user-${key}`}>{label}</Label>
      <Input
        id={`desk-user-${key}`}
        type={type}
        autoComplete="off"
        value={form[key]}
        disabled={saving}
        onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
      />
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) { if (!next) reset(); onOpenChange(next) } }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Order Desk user</DialogTitle>
          <DialogDescription>
            Apricart staff who key in orders customers send by email or WhatsApp. They can order only for what you tick below.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {field("firstName", "First name")}
          {field("lastName", "Last name")}
          {field("email", "Email", "email")}
          {field("username", "Username")}
          <div className="sm:col-span-2">
            {field("password", "Temporary password", "password")}
            <p className="mt-1 text-xs text-muted-foreground">
              At least 12 characters with upper and lower case letters, a number and a symbol. They change it at first sign-in.
            </p>
          </div>
        </div>
        <div className="space-y-2">
          <Label>May order for</Label>
          <ReachEditor organizations={organizations} value={reach} onChange={setReach} disabled={saving} />
        </div>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button onClick={() => { void submit() }} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Create desk user
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AccessDialog({
  member,
  organizations,
  onClose,
  onSaved,
}: Readonly<{
  member: Member
  organizations: ManagedOrganization[]
  onClose: () => void
  onSaved: () => void
}>) {
  // Only grants the editor can show, so a stale one cannot make every save fail.
  const [reach, setReach] = useState<DeskReachDraft>(() => reachDraftFor(member, organizations))
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const submit = async () => {
    if (saving) return
    setSaving(true)
    setFormError(null)
    try {
      const reachError = await saveReach(member.id, reach)
      if (reachError) {
        setFormError(reachError)
        return
      }
      toast({ title: "Access saved", description: member.fullName ?? member.email })
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
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Access for {member.fullName ?? member.email}</DialogTitle>
          <DialogDescription>
            Tick an organization to grant all of its branches, or untick it and choose single branches.
          </DialogDescription>
        </DialogHeader>
        <ReachEditor organizations={organizations} value={reach} onChange={setReach} disabled={saving} />
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => { void submit() }} disabled={saving}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Super Admin's Order Desk Team, in two tabs. **Team**: who is on the desk,
 * which managed organizations or branches each may order for, whether they
 * can sign in, and the executives who approve. **Desk orders**: every order
 * the desk entered, in every organization, to approve, reject or send back —
 * the executive's own approvals view, unfenced for Super Admin
 * (plans/OF-DESK-TEAM-super-admin-desk-orders-tab.md).
 */
export function DeskTeamManager() {
  const { data, error, isLoading, mutate } = useSWR<DeskTeam>(TEAM_KEY, fetcher)
  // One row is enough: only the waiting count on the tab is read.
  const { data: approvals } = useSWR<{ counts?: ExecutiveApprovalCounts }>(
    `${EXECUTIVE_APPROVALS_KEY_PREFIX}?status=awaiting_approval&limit=1`,
    fetcher,
  )
  const waiting = approvals?.counts?.awaiting_approval ?? 0
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<Member | null>(null)
  const [editingAccount, setEditingAccount] = useState<Member | null>(null)
  const [togglingId, setTogglingId] = useState<string | null>(null)
  const organizations = data?.managedOrganizations ?? []

  const toggleActive = async (member: Member) => {
    if (togglingId) return
    setTogglingId(member.id)
    try {
      const response = await fetch(`/api/v1/users/${member.id}/access`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !member.isActive }),
      })
      if (!response.ok) {
        toast({ title: "Not updated", description: await readError(response, "The user could not be updated"), variant: "destructive" })
        return
      }
      toast({ title: member.isActive ? "Desk user deactivated" : "Desk user activated" })
      await mutate()
    } catch {
      toast({ title: "Not updated", description: "Check the connection and try again.", variant: "destructive" })
    } finally {
      setTogglingId(null)
    }
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Headset className="h-6 w-6 text-indigo-600" />
          <div>
            <h1 className="text-xl font-semibold">Order Desk Team</h1>
            <p className="text-sm text-muted-foreground">
              Apricart staff who enter and fulfil orders for managed organizations, the executives who approve them, and the orders they entered.
            </p>
          </div>
        </div>
      </div>

      <Tabs defaultValue="team" className="space-y-6">
        <TabsList>
          <TabsTrigger value="team">Team</TabsTrigger>
          <TabsTrigger value="orders" className="gap-2">
            Desk orders
            {waiting > 0 && (
              <span className="rounded-full bg-indigo-600 px-1.5 text-xs font-semibold tabular-nums text-white">
                <span className="sr-only">, waiting: </span>{waiting}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="team" className="space-y-6">
          <div className="flex justify-end">
            <Button onClick={() => setAdding(true)} disabled={isLoading}>
              <Plus className="mr-2 h-4 w-4" /> Add desk user
            </Button>
          </div>

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Desk users</CardTitle>
            </CardHeader>
            <CardContent>
              {error && <p role="alert" className="text-sm text-destructive">Could not load the Order Desk team.</p>}
              {isLoading && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                </p>
              )}
              {data && data.members.length === 0 && (
                <p className="py-6 text-center text-sm text-muted-foreground">No desk users yet.</p>
              )}
              {data && data.members.length > 0 && (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[720px] text-sm">
                    <thead className="text-left text-xs uppercase text-muted-foreground">
                      <tr>
                        <th className="py-2 pr-3">Name</th>
                        <th className="py-2 pr-3">May order for</th>
                        <th className="py-2 pr-3">Status</th>
                        <th className="py-2 text-right">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.members.map((member) => (
                        <tr key={member.id} className="border-t align-top">
                          <td className="py-2 pr-3">
                            <div className="font-medium">{member.fullName ?? "—"}</div>
                            <div className="text-xs text-muted-foreground">{member.username} · {member.email}</div>
                          </td>
                          <td className="py-2 pr-3 text-sm">{describeDeskReach(member, organizations)}</td>
                          <td className="py-2 pr-3">
                            <Badge variant={member.isActive ? "default" : "outline"}>{member.isActive ? "Active" : "Inactive"}</Badge>
                          </td>
                          <td className="py-2">
                            <div className="flex justify-end gap-2">
                              <Button size="sm" variant="outline" onClick={() => setEditingAccount(member)}>Edit</Button>
                              <Button size="sm" variant="outline" onClick={() => setEditing(member)}>Access</Button>
                              <Button
                                size="sm"
                                variant="outline"
                                disabled={togglingId !== null}
                                onClick={() => { void toggleActive(member) }}
                              >
                                {togglingId === member.id && <Loader2 className="mr-1 h-3 w-3 animate-spin" />}
                                {member.isActive ? "Deactivate" : "Activate"}
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>

          <ExecutiveApproversCard />
        </TabsContent>

        <TabsContent value="orders">
          <ExecutiveApprovals audience="super-admin" />
        </TabsContent>
      </Tabs>

      {editingAccount && (
        <EditApricartAccountDialog
          key={editingAccount.id}
          account={editingAccount}
          noun="desk user"
          onClose={() => setEditingAccount(null)}
          onSaved={() => { void mutate() }}
        />
      )}
      <AddDeskUserDialog open={adding} onOpenChange={setAdding} organizations={organizations} onSaved={() => { void mutate() }} />
      {editing && (
        <AccessDialog
          key={editing.id}
          member={editing}
          organizations={organizations}
          onClose={() => setEditing(null)}
          onSaved={() => { void mutate() }}
        />
      )}
    </div>
  )
}
