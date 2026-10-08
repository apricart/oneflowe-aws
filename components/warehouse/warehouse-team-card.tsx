"use client"

import { useMemo, useState } from "react"
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
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import {
  branchesInOrganization,
  cityCoveringBranch,
  cityLabel,
  describeWarehouseReach,
  toggleAllBranches,
  toggleBranch,
} from "@/lib/warehouse-team-view"

type Member = {
  id: string
  fullName: string | null
  username: string | null
  email: string
  isActive: boolean
  branchIds: number[]
  cityKeys: string[]
}

type Organization = { id: number; name: string; code: string | null; status: string | null }
type Branch = {
  id: number
  organizationId: number
  name: string
  city: string | null
  cityKey: string | null
  status: string | null
}
type City = { key: string; label: string; branchCount: number; organizationCount: number }
type WarehouseTeam = { members: Member[]; organizations: Organization[]; branches: Branch[]; cities: City[] }

export const WAREHOUSE_TEAM_KEY = "/api/v1/warehouse-team"

const plural = (count: number, word: string, many = `${word}s`) => `${count} ${count === 1 ? word : many}`

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({}))
  return typeof data?.error === "string" ? data.error : fallback
}

/**
 * Whole cities: ticking one saves at once, one city per request, and covers
 * every branch in it — in every organization, including branches opened there
 * later. See plans/OF-WAREHOUSE-city-assignments.md.
 */
function CitiesPanel({
  member,
  cities,
  cityKeys,
  onChanged,
}: Readonly<{ member: Member; cities: City[]; cityKeys: string[]; onChanged: (cityKeys: string[]) => void }>) {
  const [filter, setFilter] = useState("")
  const [pending, setPending] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const needle = filter.trim().toLowerCase()
  const shown = cities.filter((city) => city.label.toLowerCase().includes(needle))

  const toggle = async (city: City) => {
    if (pending) return
    const assigned = !cityKeys.includes(city.key)
    setPending(city.key)
    setFormError(null)
    try {
      const response = await fetch(`${WAREHOUSE_TEAM_KEY}/${member.id}/cities`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ city: city.key, assigned }),
      })
      if (!response.ok) {
        setFormError(await errorMessage(response, "The city could not be saved"))
        return
      }
      onChanged(assigned
        ? [...cityKeys, city.key].sort((a, b) => a.localeCompare(b))
        : cityKeys.filter((key) => key !== city.key))
      toast({
        title: assigned ? `${city.label} assigned` : `${city.label} withdrawn`,
        description: `${member.fullName ?? member.email} · ${plural(city.branchCount, "branch", "branches")}`,
      })
    } catch {
      setFormError("The request could not be sent. Check the connection and try again.")
    } finally {
      setPending(null)
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        A ticked city covers every branch in it, in every organization — including branches opened there later.
        Each tick is saved at once.
      </p>
      <Input placeholder="Filter cities" value={filter} onChange={(event) => setFilter(event.target.value)} maxLength={100} />
      <fieldset className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2">
        <legend className="sr-only">Cities</legend>
        {shown.length === 0 && <p className="p-2 text-sm text-muted-foreground">No cities.</p>}
        {shown.map((city) => {
          const id = `warehouse-city-${encodeURIComponent(city.key)}`
          return (
            <div key={city.key} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted/50">
              <Checkbox
                id={id}
                checked={cityKeys.includes(city.key)}
                disabled={pending !== null}
                onCheckedChange={() => { void toggle(city) }}
              />
              <label htmlFor={id} className="flex flex-1 flex-wrap items-center gap-2 text-sm">
                {city.label}
                <span className="text-xs text-muted-foreground">
                  {city.branchCount === 0
                    ? "no branches now"
                    : `${plural(city.branchCount, "branch", "branches")} · ${plural(city.organizationCount, "organization")}`}
                </span>
                {pending === city.key && <Loader2 className="h-3 w-3 animate-spin" aria-label="Saving" />}
              </label>
            </div>
          )
        })}
      </fieldset>
      <p className="text-xs text-muted-foreground">{plural(cityKeys.length, "city", "cities")} assigned.</p>
      {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
    </div>
  )
}

/**
 * One member's reach. Whole cities are saved one at a time from their tab;
 * single branches are picked one organization at a time, and that save
 * replaces that organization's single branches only. A branch a city already
 * covers is shown ticked and locked, because unticking it would not remove it.
 */
function BranchesDialog({
  member,
  team,
  onClose,
  onSaved,
}: Readonly<{ member: Member; team: WarehouseTeam; onClose: () => void; onSaved: () => void }>) {
  const firstAssigned = team.branches.find((branch) => member.branchIds.includes(branch.id))?.organizationId
  const [organizationId, setOrganizationId] = useState<number | null>(firstAssigned ?? team.organizations[0]?.id ?? null)
  const [assigned, setAssigned] = useState<number[]>(member.branchIds)
  const [cityKeys, setCityKeys] = useState<string[]>(member.cityKeys)
  const [selected, setSelected] = useState<number[]>(
    organizationId === null ? [] : branchesInOrganization(member.branchIds, team.branches, organizationId),
  )
  const [filter, setFilter] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const organizationBranches = useMemo(
    () => team.branches.filter((branch) => branch.organizationId === organizationId),
    [team.branches, organizationId],
  )
  const coveredIds = new Set(
    organizationBranches.filter((branch) => cityCoveringBranch(branch, cityKeys)).map((branch) => branch.id),
  )
  const uncoveredIds = organizationBranches.map((branch) => branch.id).filter((id) => !coveredIds.has(id))
  const served = organizationBranches.filter((branch) => coveredIds.has(branch.id) || selected.includes(branch.id)).length
  const shown = organizationBranches.filter((branch) => branch.name.toLowerCase().includes(filter.trim().toLowerCase()))
  const saved = organizationId === null ? [] : branchesInOrganization(assigned, team.branches, organizationId)
  const dirty = saved.join(",") !== [...selected].sort((a, b) => a - b).join(",")

  const switchOrganization = (value: string) => {
    const next = Number(value)
    setOrganizationId(next)
    setSelected(branchesInOrganization(assigned, team.branches, next))
    setFilter("")
    setFormError(null)
  }

  // All / none acts on the branches no city covers; a single assignment that
  // overlaps a city is kept, so withdrawing the city later does not drop it.
  const toggleAll = () => setSelected((current) => [
    ...current.filter((id) => coveredIds.has(id)),
    ...toggleAllBranches(current.filter((id) => !coveredIds.has(id)), uncoveredIds),
  ].sort((a, b) => a - b))

  const changeCities = (next: string[]) => {
    setCityKeys(next)
    onSaved()
  }

  const save = async () => {
    if (saving || organizationId === null) return
    setSaving(true)
    setFormError(null)
    try {
      const response = await fetch(`${WAREHOUSE_TEAM_KEY}/${member.id}/branches`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ organizationId, branchIds: selected }),
      })
      if (!response.ok) {
        setFormError(await errorMessage(response, "The branches could not be saved"))
        return
      }
      const others = assigned.filter((id) => !organizationBranches.some((branch) => branch.id === id))
      setAssigned([...others, ...selected].sort((a, b) => a - b))
      toast({ title: "Branches saved", description: member.fullName ?? member.email })
      onSaved()
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
          <DialogTitle>Branches for {member.fullName ?? member.email}</DialogTitle>
          <DialogDescription>
            They pick, dispatch and deliver the approved orders of the branches assigned here, and no others —
            whole cities, or single branches.
          </DialogDescription>
        </DialogHeader>
        <Tabs defaultValue="cities">
          <TabsList className="grid w-full grid-cols-2">
            <TabsTrigger value="cities">By city</TabsTrigger>
            <TabsTrigger value="branches">By branch</TabsTrigger>
          </TabsList>
          <TabsContent value="cities">
            <CitiesPanel member={member} cities={team.cities} cityKeys={cityKeys} onChanged={changeCities} />
          </TabsContent>
          <TabsContent value="branches" className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="warehouse-team-org">Organization</Label>
              <Select value={organizationId === null ? undefined : String(organizationId)} onValueChange={switchOrganization} disabled={saving || dirty}>
                <SelectTrigger id="warehouse-team-org"><SelectValue placeholder="Choose an organization" /></SelectTrigger>
                <SelectContent>
                  {team.organizations.map((organization) => (
                    <SelectItem key={organization.id} value={String(organization.id)}>
                      {organization.name} ({branchesInOrganization(assigned, team.branches, organization.id).length})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {dirty && <p className="text-xs text-amber-600">Save or reset this organization first.</p>}
            </div>
            <div className="flex items-center gap-2">
              <Input placeholder="Filter branches" value={filter} onChange={(event) => setFilter(event.target.value)} maxLength={100} />
              <Button type="button" variant="outline" size="sm" onClick={toggleAll} disabled={saving || uncoveredIds.length === 0}>
                All / none
              </Button>
            </div>
            <fieldset className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2" disabled={saving}>
              <legend className="sr-only">Branches</legend>
              {shown.length === 0 && <p className="p-2 text-sm text-muted-foreground">No branches.</p>}
              {shown.map((branch) => {
                const id = `warehouse-branch-${branch.id}`
                const viaCity = cityCoveringBranch(branch, cityKeys)
                return (
                  <div key={branch.id} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted/50">
                    <Checkbox
                      id={id}
                      checked={viaCity !== null || selected.includes(branch.id)}
                      disabled={viaCity !== null}
                      onCheckedChange={() => setSelected((current) => toggleBranch(current, branch.id))}
                    />
                    <label htmlFor={id} className="flex flex-1 flex-wrap items-center gap-2 text-sm">
                      {branch.name}
                      {branch.city && <span className="text-xs text-muted-foreground">{branch.city}</span>}
                      {viaCity && <Badge variant="secondary">via {cityLabel(viaCity, team.cities)}</Badge>}
                      {branch.status && branch.status.toLowerCase() !== "active" && <Badge variant="outline">{branch.status}</Badge>}
                    </label>
                  </div>
                )
              })}
            </fieldset>
            <p className="text-xs text-muted-foreground">
              {served} of {organizationBranches.length} served in this organization
              {coveredIds.size > 0 && ` (${coveredIds.size} through a city)`}.
            </p>
            {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
            <div className="flex justify-end gap-2">
              {dirty && (
                <Button variant="secondary" onClick={() => setSelected(saved)} disabled={saving}>Reset</Button>
              )}
              <Button onClick={() => { void save() }} disabled={saving || !dirty || organizationId === null}>
                {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
            </div>
          </TabsContent>
        </Tabs>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Super Admin's list of warehouse accounts and the cities and branches each
 * one serves. Warehouse accounts themselves are created from Users.
 */
export function WarehouseTeamCard() {
  const { data, error, isLoading, mutate } = useSWR<WarehouseTeam>(WAREHOUSE_TEAM_KEY, fetcher)
  const [editing, setEditing] = useState<Member | null>(null)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Warehouse users</CardTitle>
        <CardDescription>
          Each warehouse user sees and works only the approved orders of the cities and branches assigned here.
          Create warehouse accounts from Users, choosing the Warehouse (Apricart) role.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {error && <p role="alert" className="text-sm text-destructive">Could not load the warehouse team.</p>}
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {data && data.members.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No warehouse accounts yet.</p>
        )}
        {data && data.members.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Name</th>
                  <th className="py-2 pr-3">Serves</th>
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
                    <td className="py-2 pr-3">{describeWarehouseReach(member, data.branches, data.organizations, data.cities)}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={member.isActive ? "default" : "outline"}>{member.isActive ? "Active" : "Inactive"}</Badge>
                    </td>
                    <td className="py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => setEditing(member)}>Branches</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
      {editing && data && (
        <BranchesDialog
          key={editing.id}
          member={editing}
          team={data}
          onClose={() => setEditing(null)}
          onSaved={() => { void mutate() }}
        />
      )}
    </Card>
  )
}
