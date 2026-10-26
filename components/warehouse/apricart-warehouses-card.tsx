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
import { toast } from "@/hooks/use-toast"
import { fetcher } from "@/lib/fetcher"
import {
  APRICART_WAREHOUSE_ADDRESS_MAX_LENGTH,
  APRICART_WAREHOUSE_CITY_MAX_LENGTH,
  APRICART_WAREHOUSE_CODE_MAX_LENGTH,
  APRICART_WAREHOUSE_NAME_MAX_LENGTH,
  APRICART_WAREHOUSE_PHONE_MAX_LENGTH,
  BRANCH_COVERAGE_KINDS,
  BRANCH_COVERAGE_LABELS,
  WAREHOUSE_RESPONSIBILITIES,
  WAREHOUSE_RESPONSIBILITY_LABELS,
  inactiveAccountsHoldingReach,
  routedBranchIdsInOrganization,
  suggestedBranchIdsFor,
  type ApricartWarehouseStatus,
  type BranchCoverageKind,
  type WarehouseResponsibility,
} from "@/lib/apricart-warehouses"
import { toggleAllBranches, toggleBranch } from "@/lib/warehouse-team-view"
import { WAREHOUSE_TEAM_KEY } from "@/components/warehouse/warehouse-team-card"
import { OrganizationCombobox } from "@/components/warehouse/organization-combobox"

type Warehouse = {
  id: number
  code: string
  name: string
  city: string | null
  address: string | null
  contactPhone: string | null
  status: ApricartWarehouseStatus
  members: Array<{ userId: string; responsibility: WarehouseResponsibility }>
  routedBranchCount: number
  executiveGapOrganizationIds: number[]
}
type Account = {
  id: string
  fullName: string | null
  username: string | null
  email: string
  isActive: boolean
  responsibility: WarehouseResponsibility
}
type CoverageEntry = {
  branchId: number
  organizationId: number
  kind: BranchCoverageKind
  routeWarehouseId: number | null
  routeMatchesReach: boolean | null
  suggestedWarehouseId: number | null
  candidateWarehouseIds: number[]
  servingAccountIds: string[]
}
type Configuration = {
  warehouses: Warehouse[]
  accounts: Account[]
  routes: Array<{ branchId: number; warehouseId: number }>
  coverage: { summary: Record<BranchCoverageKind, number>; branches: CoverageEntry[] }
}
/** The parts of the Warehouse Team read this section uses; the same SWR key, so one request serves both. */
type Team = {
  members: Array<{ id: string; fullName: string | null; email: string; isActive: boolean; branchIds: number[]; cityKeys: string[] }>
  organizations: Array<{ id: number; name: string }>
  branches: Array<{ id: number; organizationId: number; name: string; city: string | null; status: string | null }>
}

export const APRICART_WAREHOUSES_KEY = "/api/v1/apricart-warehouses"

/** How many problem branches the coverage panel lists before it summarises. */
const COVERAGE_LIST_LIMIT = 50

async function errorMessage(response: Response, fallback: string): Promise<string> {
  const data = await response.json().catch(() => ({}))
  return typeof data?.error === "string" ? data.error : fallback
}

async function send(url: string, method: string, body: unknown, fallback: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    return response.ok ? null : await errorMessage(response, fallback)
  } catch {
    return "The request could not be sent. Check the connection and try again."
  }
}

const accountName = (account: { fullName: string | null; email: string }) => account.fullName ?? account.email

/** Create a warehouse, or change one; the code is set once. */
function WarehouseFormDialog({
  warehouse,
  onClose,
  onSaved,
}: Readonly<{ warehouse: Warehouse | null; onClose: () => void; onSaved: () => void }>) {
  const [code, setCode] = useState(warehouse?.code ?? "")
  const [name, setName] = useState(warehouse?.name ?? "")
  const [city, setCity] = useState(warehouse?.city ?? "")
  const [address, setAddress] = useState(warehouse?.address ?? "")
  const [contactPhone, setContactPhone] = useState(warehouse?.contactPhone ?? "")
  const [status, setStatus] = useState<ApricartWarehouseStatus>(warehouse?.status ?? "ACTIVE")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const save = async () => {
    if (saving) return
    setSaving(true)
    setFormError(null)
    try {
      const details = { name, city, address, contactPhone }
      const failure = warehouse
        ? await send(`${APRICART_WAREHOUSES_KEY}/${warehouse.id}`, "PATCH", { ...details, status }, "The warehouse could not be saved")
        : await send(APRICART_WAREHOUSES_KEY, "POST", { code, ...details }, "The warehouse could not be created")
      if (failure) {
        setFormError(failure)
        return
      }
      toast({ title: warehouse ? "Warehouse saved" : "Warehouse created", description: name })
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{warehouse ? `Edit ${warehouse.code}` : "New warehouse"}</DialogTitle>
          <DialogDescription>
            A warehouse is a place, not an account: its staff can change and it stays. The code cannot be changed later.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="apricart-warehouse-code">Code</Label>
            <Input
              id="apricart-warehouse-code"
              value={code}
              onChange={(event) => setCode(event.target.value.toUpperCase())}
              maxLength={APRICART_WAREHOUSE_CODE_MAX_LENGTH}
              placeholder="KHI-01"
              disabled={warehouse !== null || saving}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="apricart-warehouse-name">Name</Label>
            <Input id="apricart-warehouse-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={APRICART_WAREHOUSE_NAME_MAX_LENGTH} disabled={saving} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="apricart-warehouse-city">City</Label>
            <Input id="apricart-warehouse-city" value={city} onChange={(event) => setCity(event.target.value)} maxLength={APRICART_WAREHOUSE_CITY_MAX_LENGTH} disabled={saving} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="apricart-warehouse-address">Address</Label>
            <Input id="apricart-warehouse-address" value={address} onChange={(event) => setAddress(event.target.value)} maxLength={APRICART_WAREHOUSE_ADDRESS_MAX_LENGTH} disabled={saving} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="apricart-warehouse-phone">Contact phone</Label>
            <Input id="apricart-warehouse-phone" value={contactPhone} onChange={(event) => setContactPhone(event.target.value)} maxLength={APRICART_WAREHOUSE_PHONE_MAX_LENGTH} disabled={saving} />
          </div>
          {warehouse && (
            <div className="space-y-1">
              <Label htmlFor="apricart-warehouse-status">Status</Label>
              <Select value={status} onValueChange={(value) => setStatus(value as ApricartWarehouseStatus)} disabled={saving}>
                <SelectTrigger id="apricart-warehouse-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ACTIVE">Active</SelectItem>
                  <SelectItem value="INACTIVE">Inactive</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">A warehouse with branches routed to it cannot be deactivated.</p>
            </div>
          )}
          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={() => { void save() }} disabled={saving || name.trim().length < 2 || (!warehouse && code.trim().length < 2)}>
            {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            {warehouse ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Who works at a warehouse. Each tick saves at once, one request at a time. */
function MembersDialog({
  warehouse,
  accounts,
  onClose,
  onSaved,
}: Readonly<{ warehouse: Warehouse; accounts: Account[]; onClose: () => void; onSaved: () => void }>) {
  const [memberIds, setMemberIds] = useState<string[]>(warehouse.members.map((member) => member.userId))
  const [pending, setPending] = useState<string | null>(null)
  const [formError, setFormError] = useState<string | null>(null)

  const toggle = async (account: Account) => {
    if (pending) return
    const assigned = !memberIds.includes(account.id)
    setPending(account.id)
    setFormError(null)
    try {
      const failure = await send(
        `${APRICART_WAREHOUSES_KEY}/${warehouse.id}/members`,
        "PUT",
        { userId: account.id, assigned },
        "The member could not be saved",
      )
      if (failure) {
        setFormError(failure)
        return
      }
      setMemberIds((current) => (assigned ? [...current, account.id] : current.filter((id) => id !== account.id)))
      onSaved()
    } finally {
      setPending(null)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && pending === null) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Members of {warehouse.code}</DialogTitle>
          <DialogDescription>
            Membership does not change what anyone sees yet: each account keeps the branches assigned to it below, and
            each executive its organizations on Order Desk Team.
          </DialogDescription>
        </DialogHeader>
        {WAREHOUSE_RESPONSIBILITIES.map((responsibility) => {
          const group = accounts.filter((account) => account.responsibility === responsibility)
          return (
            <section key={responsibility} aria-labelledby={`apricart-members-${responsibility}`} className="space-y-2">
              <h3 id={`apricart-members-${responsibility}`} className="text-sm font-medium">
                {WAREHOUSE_RESPONSIBILITY_LABELS[responsibility]}s
              </h3>
              <fieldset className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
                <legend className="sr-only">{WAREHOUSE_RESPONSIBILITY_LABELS[responsibility]}s</legend>
                {group.length === 0 && <p className="p-2 text-sm text-muted-foreground">No accounts with this role.</p>}
                {group.map((account) => {
                  const id = `apricart-member-${warehouse.id}-${account.id}`
                  const isMember = memberIds.includes(account.id)
                  return (
                    <div key={account.id} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted/50">
                      <Checkbox
                        id={id}
                        checked={isMember}
                        // An inactive account is offered only to remove it.
                        disabled={pending !== null || (!account.isActive && !isMember)}
                        onCheckedChange={() => { void toggle(account) }}
                      />
                      <label htmlFor={id} className="flex flex-1 flex-wrap items-center gap-2 text-sm">
                        {accountName(account)}
                        <span className="text-xs text-muted-foreground">{account.username ?? account.email}</span>
                        {!account.isActive && <Badge variant="outline">Inactive</Badge>}
                        {pending === account.id && <Loader2 className="h-3 w-3 animate-spin" aria-label="Saving" />}
                      </label>
                    </div>
                  )
                })}
              </fieldset>
            </section>
          )
        })}
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending !== null}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * The branches whose new orders will default to this warehouse, one
 * organization at a time. The coverage report's suggestion is shown, and
 * applied only when ticked.
 */
function RoutesDialog({
  warehouse,
  configuration,
  team,
  onClose,
  onSaved,
}: Readonly<{ warehouse: Warehouse; configuration: Configuration; team: Team; onClose: () => void; onSaved: () => void }>) {
  const branchOrganization = useMemo(
    () => new Map(team.branches.map((branch) => [branch.id, branch.organizationId])),
    [team.branches],
  )
  const [routes, setRoutes] = useState(configuration.routes)
  const routedHere = (organizationId: number) => routedBranchIdsInOrganization({
    routes, branchOrganization, warehouseId: warehouse.id, organizationId,
  })
  const firstRouted = routes.find((route) => route.warehouseId === warehouse.id)
  const [organizationId, setOrganizationId] = useState<number | null>(
    (firstRouted && branchOrganization.get(firstRouted.branchId)) ?? team.organizations[0]?.id ?? null,
  )
  const [selected, setSelected] = useState<number[]>(organizationId === null ? [] : routedHere(organizationId))
  const [filter, setFilter] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const warehouseCode = new Map(configuration.warehouses.map((entry) => [entry.id, entry.code]))
  const routeOf = new Map(routes.map((route) => [route.branchId, route.warehouseId]))
  const organizationBranches = team.branches.filter((branch) => branch.organizationId === organizationId)
  const branchNeedle = filter.trim().toLowerCase()
  const shown = organizationBranches.filter((branch) => (
    `${branch.name} ${branch.city ?? ""}`.toLowerCase().includes(branchNeedle)
  ))
  const shownIds = shown.map((branch) => branch.id)
  const allShownSelected = shownIds.length > 0 && shownIds.every((id) => selected.includes(id))
  const saved = organizationId === null ? [] : routedHere(organizationId)
  const sortedSelected = [...selected].sort((a, b) => a - b)
  const dirty = saved.join(",") !== sortedSelected.join(",")
  const suggested = organizationId === null
    ? []
    : suggestedBranchIdsFor({ coverage: configuration.coverage.branches, warehouseId: warehouse.id, organizationId })
  const movingIn = sortedSelected.filter((id) => routeOf.has(id) && routeOf.get(id) !== warehouse.id)

  const switchOrganization = (next: number) => {
    setOrganizationId(next)
    setSelected(routedHere(next))
    setFilter("")
    setFormError(null)
  }

  const save = async () => {
    if (saving || organizationId === null) return
    setSaving(true)
    setFormError(null)
    try {
      const failure = await send(
        `${APRICART_WAREHOUSES_KEY}/${warehouse.id}/branches`,
        "PUT",
        { organizationId, branchIds: sortedSelected },
        "The branches could not be saved",
      )
      if (failure) {
        setFormError(failure)
        return
      }
      const organizationIds = new Set(organizationBranches.map((branch) => branch.id))
      setRoutes([
        ...routes.filter((route) => !organizationIds.has(route.branchId) || (route.warehouseId !== warehouse.id && !selected.includes(route.branchId))),
        ...sortedSelected.map((branchId) => ({ branchId, warehouseId: warehouse.id })),
      ])
      toast({ title: "Routes saved", description: warehouse.name })
      onSaved()
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Branches routed to {warehouse.code}</DialogTitle>
          <DialogDescription>
            The default warehouse for each branch&apos;s future orders. Routes are recorded only — no order and no
            account&apos;s access follows them yet.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="apricart-routes-org">Organization</Label>
            <OrganizationCombobox
              id="apricart-routes-org"
              value={organizationId}
              options={team.organizations.map((organization) => ({
                id: organization.id,
                label: organization.name,
                hint: `(${routedHere(organization.id).length})`,
              }))}
              disabled={saving || dirty}
              onValueChange={switchOrganization}
            />
            {dirty && <p className="text-xs text-amber-600">Save or reset this organization first.</p>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input placeholder="Filter branches" aria-label="Filter branches" value={filter} onChange={(event) => setFilter(event.target.value)} maxLength={100} className="flex-1" />
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected((current) => [...new Set([...current, ...suggested])])}
              disabled={saving || warehouse.status !== "ACTIVE" || suggested.every((id) => selected.includes(id))}
            >
              Tick suggested ({suggested.length})
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected((current) => toggleAllBranches(current, shownIds))}
              disabled={saving || warehouse.status !== "ACTIVE" || shownIds.length === 0}
            >
              {allShownSelected ? "Unselect" : "Select"} all{branchNeedle ? " shown" : ""}
            </Button>
          </div>
          <fieldset className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2" disabled={saving}>
            <legend className="sr-only">Branches</legend>
            {shown.length === 0 && <p className="p-2 text-sm text-muted-foreground">No branches.</p>}
            {shown.map((branch) => {
              const id = `apricart-route-${warehouse.id}-${branch.id}`
              const elsewhere = routeOf.get(branch.id)
              const isSelected = selected.includes(branch.id)
              return (
                <div key={branch.id} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted/50">
                  <Checkbox
                    id={id}
                    checked={isSelected}
                    // An inactive warehouse may only lose branches.
                    disabled={warehouse.status !== "ACTIVE" && !isSelected}
                    onCheckedChange={() => setSelected((current) => toggleBranch(current, branch.id))}
                  />
                  <label htmlFor={id} className="flex flex-1 flex-wrap items-center gap-2 text-sm">
                    {branch.name}
                    {branch.city && <span className="text-xs text-muted-foreground">{branch.city}</span>}
                    {suggested.includes(branch.id) && <Badge variant="secondary">Suggested</Badge>}
                    {elsewhere !== undefined && elsewhere !== warehouse.id && (
                      <Badge variant="outline">routed to {warehouseCode.get(elsewhere) ?? "another warehouse"}</Badge>
                    )}
                    {branch.status && branch.status.toLowerCase() !== "active" && <Badge variant="outline">{branch.status}</Badge>}
                  </label>
                </div>
              )
            })}
          </fieldset>
          {movingIn.length > 0 && (
            <p className="text-xs text-amber-600">
              {movingIn.length} ticked {movingIn.length === 1 ? "branch is" : "branches are"} routed to another warehouse and will move here.
            </p>
          )}
          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
          <div className="flex justify-end gap-2">
            {dirty && <Button variant="secondary" onClick={() => setSelected(saved)} disabled={saving}>Reset</Button>}
            <Button onClick={() => { void save() }} disabled={saving || !dirty || organizationId === null}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** What has to be settled before orders can belong to a warehouse. */
function CoveragePanel({ configuration, team }: Readonly<{ configuration: Configuration; team: Team }>) {
  const branchById = new Map(team.branches.map((branch) => [branch.id, branch]))
  const organizationName = new Map(team.organizations.map((organization) => [organization.id, organization.name]))
  const warehouseCode = new Map(configuration.warehouses.map((warehouse) => [warehouse.id, warehouse.code]))
  const accountById = new Map(configuration.accounts.map((account) => [account.id, account]))
  const problems = configuration.coverage.branches.filter((entry) => entry.kind === "AMBIGUOUS"
    || entry.kind === "UNMAPPED"
    || (entry.kind === "ROUTED" && entry.routeMatchesReach === false))
  const inactiveHolding = inactiveAccountsHoldingReach(team.members)
  const gaps = configuration.warehouses.filter((warehouse) => warehouse.executiveGapOrganizationIds.length > 0)

  const describe = (entry: CoverageEntry): string => {
    const serving = entry.servingAccountIds.map((id) => accountById.get(id)).filter((account) => account !== undefined).map(accountName)
    if (entry.kind === "ROUTED") return `Routed to ${warehouseCode.get(entry.routeWarehouseId ?? 0) ?? "?"}, served today by ${serving.join(", ")}`
    if (entry.kind === "AMBIGUOUS") return `Served by ${serving.join(", ")} at ${entry.candidateWarehouseIds.map((id) => warehouseCode.get(id) ?? "?").join(", ")}`
    return `Served by ${serving.join(", ")}, who belong to no warehouse`
  }

  return (
    <section aria-labelledby="apricart-coverage" className="space-y-3 rounded-md border p-3">
      <h3 id="apricart-coverage" className="text-sm font-medium">Coverage of active branches</h3>
      <div className="flex flex-wrap gap-2">
        {BRANCH_COVERAGE_KINDS.map((kind) => (
          <Badge key={kind} variant={kind === "AMBIGUOUS" || kind === "UNMAPPED" ? "destructive" : "secondary"}>
            {BRANCH_COVERAGE_LABELS[kind]}: {configuration.coverage.summary[kind]}
          </Badge>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Suggested: the staff serving a branch today all work at one warehouse — tick it in that warehouse&apos;s
        branches. Ambiguous and No warehouse need a decision; nothing is routed automatically.
      </p>
      {problems.length > 0 && (
        <ul className="space-y-1 text-sm">
          {problems.slice(0, COVERAGE_LIST_LIMIT).map((entry) => {
            const branch = branchById.get(entry.branchId)
            return (
              <li key={entry.branchId}>
                <span className="font-medium">{branch?.name ?? `Branch ${entry.branchId}`}</span>
                <span className="text-muted-foreground"> · {organizationName.get(entry.organizationId) ?? ""} · {describe(entry)}</span>
              </li>
            )
          })}
          {problems.length > COVERAGE_LIST_LIMIT && (
            <li className="text-muted-foreground">and {problems.length - COVERAGE_LIST_LIMIT} more.</li>
          )}
        </ul>
      )}
      {gaps.length > 0 && (
        <div className="space-y-1 text-sm">
          {gaps.map((warehouse) => (
            <p key={warehouse.id}>
              <span className="font-medium">{warehouse.code}</span>
              <span className="text-muted-foreground">
                {" "}has no executive member for {warehouse.executiveGapOrganizationIds.map((id) => organizationName.get(id) ?? `#${id}`).join(", ")}.
              </span>
            </p>
          ))}
        </div>
      )}
      {inactiveHolding.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Inactive accounts still holding assignments: {inactiveHolding.map(accountName).join(", ")}.
        </p>
      )}
    </section>
  )
}

/**
 * Super Admin's Apricart warehouses: the places orders will be fulfilled from,
 * who works at each, and the default warehouse of each branch — with the
 * coverage report that maps today's account-based reach onto them.
 * Members who are operators fulfil the orders transferred to their warehouse;
 * routes are configuration only. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */
export function ApricartWarehousesCard() {
  const { data, error, isLoading, mutate } = useSWR<Configuration>(APRICART_WAREHOUSES_KEY, fetcher)
  const { data: team } = useSWR<Team>(WAREHOUSE_TEAM_KEY, fetcher)
  const [editing, setEditing] = useState<Warehouse | "new" | null>(null)
  const [membersOf, setMembersOf] = useState<Warehouse | null>(null)
  const [routesOf, setRoutesOf] = useState<Warehouse | null>(null)

  const refresh = () => { void mutate() }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Warehouses</CardTitle>
          <CardDescription>
            Apricart&apos;s warehouses, who works at each, and the default warehouse of each branch. A warehouse&apos;s
            operators fulfil the orders Super Admin transfers to it from the order page; every other order is still
            worked by the accounts serving its branch, and default warehouses do not move any order.
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}>New warehouse</Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <p role="alert" className="text-sm text-destructive">Could not load the warehouses.</p>}
        {isLoading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {data && data.warehouses.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No warehouses yet.</p>
        )}
        {data && data.warehouses.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="text-left text-xs uppercase text-muted-foreground">
                <tr>
                  <th className="py-2 pr-3">Warehouse</th>
                  <th className="py-2 pr-3">Members</th>
                  <th className="py-2 pr-3">Branches</th>
                  <th className="py-2 pr-3">Status</th>
                  <th className="py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {data.warehouses.map((warehouse) => (
                  <tr key={warehouse.id} className="border-t align-top">
                    <td className="py-2 pr-3">
                      <div className="font-medium">{warehouse.code} · {warehouse.name}</div>
                      {warehouse.city && <div className="text-xs text-muted-foreground">{warehouse.city}</div>}
                    </td>
                    <td className="py-2 pr-3">
                      {WAREHOUSE_RESPONSIBILITIES.map((responsibility) => {
                        const total = warehouse.members.filter((member) => member.responsibility === responsibility).length
                        return <div key={responsibility}>{total} {WAREHOUSE_RESPONSIBILITY_LABELS[responsibility].toLowerCase()}{total === 1 ? "" : "s"}</div>
                      })}
                    </td>
                    <td className="py-2 pr-3">{warehouse.routedBranchCount}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={warehouse.status === "ACTIVE" ? "default" : "outline"}>
                        {warehouse.status === "ACTIVE" ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="space-x-2 whitespace-nowrap py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => setEditing(warehouse)}>Edit</Button>
                      <Button size="sm" variant="outline" onClick={() => setMembersOf(warehouse)}>Members</Button>
                      <Button size="sm" variant="outline" onClick={() => setRoutesOf(warehouse)} disabled={!team}>Branches</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && team && <CoveragePanel configuration={data} team={team} />}
      </CardContent>
      {editing && (
        <WarehouseFormDialog
          key={editing === "new" ? "new" : editing.id}
          warehouse={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={refresh}
        />
      )}
      {membersOf && data && (
        <MembersDialog
          key={membersOf.id}
          warehouse={membersOf}
          accounts={data.accounts}
          onClose={() => setMembersOf(null)}
          onSaved={refresh}
        />
      )}
      {routesOf && data && team && (
        <RoutesDialog
          key={routesOf.id}
          warehouse={routesOf}
          configuration={data}
          team={team}
          onClose={() => setRoutesOf(null)}
          onSaved={refresh}
        />
      )}
    </Card>
  )
}
