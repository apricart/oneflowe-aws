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
  UNROUTED_ORDER_LIST_LIMIT,
  WAREHOUSE_MEMBER_SCOPE_LABELS,
  WAREHOUSE_RESPONSIBILITIES,
  WAREHOUSE_RESPONSIBILITY_LABELS,
  inactiveAccountsHoldingReach,
  routedBranchIdsInOrganization,
  suggestedBranchIdsFor,
  type ApricartWarehouseStatus,
  type BranchCoverageKind,
  type WarehouseMemberScope,
  type WarehouseResponsibility,
} from "@/lib/apricart-warehouses"
import { readsWarehouseMembership, type WarehouseOrderOwnershipMode } from "@/lib/warehouse-ownership-policy"
import { toggleAllBranches, toggleBranch } from "@/lib/warehouse-team-view"
import { WAREHOUSE_TEAM_KEY } from "@/components/warehouse/warehouse-team-card"
import { OrganizationCombobox } from "@/components/warehouse/organization-combobox"

type Member = {
  userId: string
  responsibility: WarehouseResponsibility
  branchScope: WarehouseMemberScope
  selectedBranchIds: number[]
}
type Warehouse = {
  id: number
  code: string
  name: string
  city: string | null
  address: string | null
  contactPhone: string | null
  status: ApricartWarehouseStatus
  members: Member[]
  routedBranchCount: number
  ruleCount: number
  branchCount: number
  executiveGapOrganizationIds: number[]
}
type Rule = {
  id: number
  warehouseId: number
  organizationId: number
  cityKey: string | null
  cityLabel: string | null
  branchCount: number
}
type UnroutedOrder = {
  id: number
  tid: string
  organizationId: number
  branchId: number
  status: string
  fulfillmentStatus: string | null
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
  ownershipMode: WarehouseOrderOwnershipMode
  warehouses: Warehouse[]
  accounts: Account[]
  routes: Array<{ branchId: number; warehouseId: number }>
  rules: Rule[]
  cityOptions: Array<{ organizationId: number; cityKey: string; label: string; branchCount: number }>
  branchWarehouses: Array<{ branchId: number; warehouseId: number }>
  unrouted: { count: number; orders: UnroutedOrder[] }
  coverage: { summary: Record<BranchCoverageKind, number>; branches: CoverageEntry[] }
}
type ReachDifference = { accountId: string; lost: number[]; gained: number[] }
type OwnershipCheck = {
  checkedAt: string
  accounts: Array<{ id: string; username: string | null; branchCount: number }>
  differences: Record<"membership-fallback" | "membership", ReachDifference[]>
  unroutedOpenOrders: number
  strandedBranches: Array<{ warehouseId: number; code: string; branches: number }>
  ready: Record<"membership-fallback" | "membership", boolean>
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
  ownershipMode,
  onScope,
  onClose,
  onSaved,
}: Readonly<{
  warehouse: Warehouse
  accounts: Account[]
  ownershipMode: WarehouseOrderOwnershipMode
  onScope: (userId: string) => void
  onClose: () => void
  onSaved: () => void
}>) {
  const scopeOf = new Map(warehouse.members.map((member) => [member.userId, member]))
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
            {readsWarehouseMembership(ownershipMode)
              ? "An operator works this warehouse's branches — all of them, or the ones chosen under its scope — and the orders transferred here."
              : "An operator works the orders transferred here. For every other order, each account still keeps the branches assigned to it on Warehouse Team until warehouses take over; the scope below applies from then."}{" "}
            Each executive keeps its organizations on Order Desk Team.
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
                      {isMember && responsibility === "WAREHOUSE_OPERATOR" && (
                        <Button
                          type="button"
                          size="sm"
                          variant="ghost"
                          onClick={() => onScope(account.id)}
                          disabled={pending !== null || !scopeOf.has(account.id)}
                        >
                          {WAREHOUSE_MEMBER_SCOPE_LABELS[scopeOf.get(account.id)?.branchScope ?? "ALL"]}
                        </Button>
                      )}
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
          <DialogTitle>Branches put in {warehouse.code} by hand</DialogTitle>
          <DialogDescription>
            A branch ticked here is in this warehouse whatever its organization&apos;s rules say. Use rules for whole
            organizations or cities, and this list for the exceptions.
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

/** The Select value that stands for "every city of the organization" (an organization rule). */
const ALL_CITIES = "__all__"

/**
 * Whole organizations, or an organization in one city, in this warehouse. A
 * rule is read whenever a branch's warehouse is, so branches opened or
 * re-citied later follow it. Each change saves at once.
 */
function RulesDialog({
  warehouse,
  configuration,
  team,
  onClose,
  onSaved,
}: Readonly<{ warehouse: Warehouse; configuration: Configuration; team: Team; onClose: () => void; onSaved: () => void }>) {
  const organizationName = new Map(team.organizations.map((organization) => [organization.id, organization.name]))
  const warehouseCode = new Map(configuration.warehouses.map((entry) => [entry.id, entry.code]))
  const [organizationId, setOrganizationId] = useState<number | null>(team.organizations[0]?.id ?? null)
  const [city, setCity] = useState<string>(ALL_CITIES)
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const rulesHere = configuration.rules.filter((rule) => rule.warehouseId === warehouse.id)
  const cities = configuration.cityOptions.filter((option) => option.organizationId === organizationId)
  const cityKey = city === ALL_CITIES ? null : city
  const holder = organizationId === null
    ? undefined
    : configuration.rules.find((rule) => rule.organizationId === organizationId && rule.cityKey === cityKey)
  const canAdd = organizationId !== null && warehouse.status === "ACTIVE" && holder?.warehouseId !== warehouse.id

  const change = async (body: { organizationId: number; city: string | null; assigned: boolean }) => {
    if (pending) return
    setPending(true)
    setFormError(null)
    try {
      const failure = await send(`${APRICART_WAREHOUSES_KEY}/${warehouse.id}/rules`, "PUT", body, "The rule could not be saved")
      if (failure) {
        setFormError(failure)
        return
      }
      toast({ title: body.assigned ? "Rule added" : "Rule removed", description: warehouse.name })
      onSaved()
    } finally {
      setPending(false)
    }
  }

  const describeRule = (rule: Rule) => `${organizationName.get(rule.organizationId) ?? `Organization ${rule.organizationId}`} · ${
    rule.cityKey === null ? "all cities" : rule.cityLabel ?? rule.cityKey}`

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Rules of {warehouse.code}</DialogTitle>
          <DialogDescription>
            Every branch of an organization, or of an organization in one city, belongs to this warehouse — including
            branches opened there later. A branch put in a warehouse by hand ignores the rules.
          </DialogDescription>
        </DialogHeader>
        <section aria-labelledby={`apricart-rules-${warehouse.id}`} className="space-y-2">
          <h3 id={`apricart-rules-${warehouse.id}`} className="text-sm font-medium">Rules ({rulesHere.length})</h3>
          {rulesHere.length === 0 && <p className="text-sm text-muted-foreground">No rules yet.</p>}
          <ul className="max-h-56 space-y-1 overflow-y-auto">
            {rulesHere.map((rule) => (
              <li key={rule.id} className="flex items-center justify-between gap-2 rounded px-2 py-1 text-sm hover:bg-muted/50">
                <span>
                  {describeRule(rule)}
                  <span className="text-xs text-muted-foreground"> · {rule.branchCount} active branch{rule.branchCount === 1 ? "" : "es"}</span>
                </span>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={pending}
                  onClick={() => { void change({ organizationId: rule.organizationId, city: rule.cityKey, assigned: false }) }}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby={`apricart-rule-add-${warehouse.id}`} className="space-y-3 rounded-md border p-3">
          <h3 id={`apricart-rule-add-${warehouse.id}`} className="text-sm font-medium">Add a rule</h3>
          <div className="space-y-1">
            <Label htmlFor={`apricart-rule-org-${warehouse.id}`}>Organization</Label>
            <OrganizationCombobox
              id={`apricart-rule-org-${warehouse.id}`}
              value={organizationId}
              options={team.organizations.map((organization) => ({ id: organization.id, label: organization.name }))}
              disabled={pending}
              onValueChange={(next) => { setOrganizationId(next); setCity(ALL_CITIES); setFormError(null) }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`apricart-rule-city-${warehouse.id}`}>City</Label>
            <Select value={city} onValueChange={setCity} disabled={pending || organizationId === null}>
              <SelectTrigger id={`apricart-rule-city-${warehouse.id}`}><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_CITIES}>All cities of this organization</SelectItem>
                {cities.map((option) => (
                  <SelectItem key={option.cityKey} value={option.cityKey}>
                    {option.label} ({option.branchCount})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {holder && holder.warehouseId !== warehouse.id && (
            <p className="text-xs text-amber-600">
              Now in {warehouseCode.get(holder.warehouseId) ?? "another warehouse"} — adding it moves its branches here.
            </p>
          )}
          {holder?.warehouseId === warehouse.id && <p className="text-xs text-muted-foreground">Already a rule of this warehouse.</p>}
          {warehouse.status !== "ACTIVE" && <p className="text-xs text-muted-foreground">An inactive warehouse takes no new rules.</p>}
          <div className="flex justify-end">
            <Button
              onClick={() => { if (organizationId !== null) void change({ organizationId, city: cityKey, assigned: true }) }}
              disabled={pending || !canAdd}
            >
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Add rule
            </Button>
          </div>
        </section>
        {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/**
 * Which of this warehouse's branches one operator works: all of them, or a
 * selection made one organization at a time from the branches in the warehouse now.
 */
function MemberScopeDialog({
  warehouse,
  member,
  account,
  configuration,
  team,
  onClose,
  onSaved,
}: Readonly<{
  warehouse: Warehouse
  member: Member
  account: Account | undefined
  configuration: Configuration
  team: Team
  onClose: () => void
  onSaved: () => void
}>) {
  const inWarehouse = new Set(configuration.branchWarehouses
    .filter((entry) => entry.warehouseId === warehouse.id)
    .map((entry) => entry.branchId))
  const warehouseBranches = team.branches.filter((branch) => inWarehouse.has(branch.id))
  const organizations = team.organizations.filter((organization) => warehouseBranches.some((branch) => branch.organizationId === organization.id))
  const [organizationId, setOrganizationId] = useState<number | null>(organizations[0]?.id ?? null)
  const organizationBranches = warehouseBranches.filter((branch) => branch.organizationId === organizationId)
  const savedHere = member.selectedBranchIds.filter((id) => organizationBranches.some((branch) => branch.id === id))
  const [selected, setSelected] = useState<number[]>(savedHere)
  const [pending, setPending] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const shownIds = organizationBranches.map((branch) => branch.id)
  const sortedSelected = [...selected].sort((a, b) => a - b)
  const dirty = member.branchScope !== "SELECTED" || savedHere.join(",") !== sortedSelected.join(",")

  const save = async (body: { scope: "ALL" } | { scope: "SELECTED"; organizationId: number; branchIds: number[] }) => {
    if (pending) return
    setPending(true)
    setFormError(null)
    try {
      const failure = await send(
        `${APRICART_WAREHOUSES_KEY}/${warehouse.id}/member-scope`,
        "PUT",
        { userId: member.userId, ...body },
        "The scope could not be saved",
      )
      if (failure) {
        setFormError(failure)
        return
      }
      toast({ title: "Scope saved", description: account ? accountName(account) : undefined })
      onSaved()
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !pending) onClose() }}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{account ? accountName(account) : "Operator"} at {warehouse.code}</DialogTitle>
          <DialogDescription>
            Now: {WAREHOUSE_MEMBER_SCOPE_LABELS[member.branchScope]}
            {member.branchScope === "SELECTED" ? ` (${member.selectedBranchIds.length})` : ""}. With selected branches,
            the operator works only the branches ticked, across every organization; orders transferred to the warehouse
            are always theirs.
          </DialogDescription>
        </DialogHeader>
        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => { void save({ scope: "ALL" }) }}
            disabled={pending || (member.branchScope === "ALL" && member.selectedBranchIds.length === 0)}
          >
            Work all branches
          </Button>
        </div>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor={`apricart-scope-org-${member.userId}`}>Organization</Label>
            <OrganizationCombobox
              id={`apricart-scope-org-${member.userId}`}
              value={organizationId}
              options={organizations.map((organization) => ({ id: organization.id, label: organization.name }))}
              disabled={pending}
              onValueChange={(next) => {
                setOrganizationId(next)
                setSelected(member.selectedBranchIds.filter((id) => warehouseBranches.some((branch) => branch.id === id && branch.organizationId === next)))
                setFormError(null)
              }}
            />
          </div>
          <div className="flex justify-end">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setSelected((current) => toggleAllBranches(current, shownIds))}
              disabled={pending || shownIds.length === 0}
            >
              {shownIds.length > 0 && shownIds.every((id) => selected.includes(id)) ? "Unselect" : "Select"} all
            </Button>
          </div>
          <fieldset className="max-h-72 space-y-1 overflow-y-auto rounded-md border p-2" disabled={pending}>
            <legend className="sr-only">Branches</legend>
            {organizationBranches.length === 0 && <p className="p-2 text-sm text-muted-foreground">No branches of this warehouse here.</p>}
            {organizationBranches.map((branch) => {
              const id = `apricart-scope-${member.userId}-${branch.id}`
              return (
                <div key={branch.id} className="flex items-center gap-3 rounded px-2 py-1.5 hover:bg-muted/50">
                  <Checkbox id={id} checked={selected.includes(branch.id)} onCheckedChange={() => setSelected((current) => toggleBranch(current, branch.id))} />
                  <label htmlFor={id} className="flex flex-1 flex-wrap items-center gap-2 text-sm">
                    {branch.name}
                    {branch.city && <span className="text-xs text-muted-foreground">{branch.city}</span>}
                  </label>
                </div>
              )
            })}
          </fieldset>
          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
          <div className="flex justify-end">
            <Button
              onClick={() => { if (organizationId !== null) void save({ scope: "SELECTED", organizationId, branchIds: sortedSelected }) }}
              disabled={pending || organizationId === null || !dirty}
            >
              {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Work only the ticked branches
            </Button>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={pending}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Open orders whose branch is in no warehouse — nobody would work them once warehouses decide. */
function UnroutedPanel({ configuration, team }: Readonly<{ configuration: Configuration; team: Team }>) {
  const { unrouted } = configuration
  const branchName = new Map(team.branches.map((branch) => [branch.id, branch.name]))
  const organizationName = new Map(team.organizations.map((organization) => [organization.id, organization.name]))
  return (
    <section aria-labelledby="apricart-unrouted" className="space-y-2 rounded-md border p-3">
      <h3 id="apricart-unrouted" className="text-sm font-medium">
        Open orders whose branch is in no warehouse: {unrouted.count}
      </h3>
      <p className="text-xs text-muted-foreground">
        {readsWarehouseMembership(configuration.ownershipMode)
          ? "No warehouse operator sees these until their branch is put in a warehouse, or Super Admin transfers the order."
          : "Still worked by the accounts assigned their branch. Once warehouses decide, nobody would see them — add a rule, put the branch in by hand, or transfer the order."}
      </p>
      {unrouted.orders.length > 0 && (
        <ul className="space-y-1 text-sm">
          {unrouted.orders.map((order) => (
            <li key={order.id}>
              <span className="font-medium">{order.tid}</span>
              <span className="text-muted-foreground">
                {" "}· {organizationName.get(order.organizationId) ?? ""} · {branchName.get(order.branchId) ?? `Branch ${order.branchId}`} · {order.status}
                {order.fulfillmentStatus ? ` / ${order.fulfillmentStatus}` : ""}
              </span>
            </li>
          ))}
          {unrouted.count > UNROUTED_ORDER_LIST_LIMIT && (
            <li className="text-muted-foreground">and {unrouted.count - UNROUTED_ORDER_LIST_LIMIT} more.</li>
          )}
        </ul>
      )}
    </section>
  )
}

const OWNERSHIP_MODE_LABELS: Record<"membership-fallback" | "membership", string> = {
  "membership-fallback": "Warehouses decide, own assignments kept for branches in no warehouse",
  membership: "Warehouses decide",
}

/**
 * Would any warehouse account see a different set of branches if warehouses
 * decided? Run on demand; the same report as `npm run check:warehouse-ownership`.
 */
function OwnershipCheckPanel({ configuration }: Readonly<{ configuration: Configuration }>) {
  const [check, setCheck] = useState<OwnershipCheck | null>(null)
  const [running, setRunning] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const username = new Map(configuration.accounts.map((account) => [account.id, account.username ?? account.email]))

  const run = async () => {
    if (running) return
    setRunning(true)
    setFailure(null)
    try {
      const response = await fetch(`${APRICART_WAREHOUSES_KEY}/ownership-check`)
      if (!response.ok) {
        setFailure(await errorMessage(response, "The check could not be run"))
        return
      }
      setCheck(await response.json() as OwnershipCheck)
    } catch {
      setFailure("The request could not be sent. Check the connection and try again.")
    } finally {
      setRunning(false)
    }
  }

  return (
    <section aria-labelledby="apricart-ownership-check" className="space-y-2 rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 id="apricart-ownership-check" className="text-sm font-medium">Would anyone&apos;s work change?</h3>
        <Button size="sm" variant="outline" onClick={() => { void run() }} disabled={running}>
          {running && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Run check
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Compares the branches each warehouse account works today with the branches its warehouses would give it.
      </p>
      {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
      {check && (["membership-fallback", "membership"] as const).map((mode) => (
        <div key={mode} className="space-y-1 text-sm">
          <p>
            <Badge variant={check.ready[mode] ? "secondary" : "destructive"}>{check.ready[mode] ? "No change" : "Changes"}</Badge>{" "}
            {OWNERSHIP_MODE_LABELS[mode]}
          </p>
          {check.differences[mode].map((difference) => (
            <p key={difference.accountId} className="pl-2 text-muted-foreground">
              {username.get(difference.accountId) ?? difference.accountId}: loses {difference.lost.length}, gains {difference.gained.length} branch(es)
            </p>
          ))}
        </div>
      ))}
      {check && (
        <p className="text-xs text-muted-foreground">
          Open orders in no warehouse: {check.unroutedOpenOrders}.
          {check.strandedBranches.length > 0 && ` Branches no operator works: ${check.strandedBranches.map((entry) => `${entry.code} ${entry.branches}`).join(", ")}.`}
          {" "}Checked {new Date(check.checkedAt).toLocaleString()}.
        </p>
      )}
    </section>
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
 * Super Admin's Apricart warehouses: the places orders are fulfilled from, who
 * works at each (and which of its branches), and which branches each holds —
 * by organization/city rule or by hand — with the coverage report, the open
 * orders in no warehouse, and the check that no account's work would change
 * when warehouses decide. See plans/OF-WAREHOUSE-order-ownership-and-transfer.md.
 */
export function ApricartWarehousesCard() {
  const { data, error, isLoading, mutate } = useSWR<Configuration>(APRICART_WAREHOUSES_KEY, fetcher)
  const { data: team } = useSWR<Team>(WAREHOUSE_TEAM_KEY, fetcher)
  const [editing, setEditing] = useState<Warehouse | "new" | null>(null)
  const [membersOf, setMembersOf] = useState<number | null>(null)
  const [routesOf, setRoutesOf] = useState<Warehouse | null>(null)
  const [rulesOf, setRulesOf] = useState<number | null>(null)
  const [scopeOf, setScopeOf] = useState<{ warehouseId: number; userId: string } | null>(null)

  const refresh = () => { void mutate() }
  // Dialogs read the warehouse from the latest load, so a save shows at once.
  const warehouseById = (id: number | null) => (id === null ? undefined : data?.warehouses.find((warehouse) => warehouse.id === id))
  const membersWarehouse = warehouseById(membersOf)
  const rulesWarehouse = warehouseById(rulesOf)
  const scopeWarehouse = warehouseById(scopeOf?.warehouseId ?? null)
  const scopeMember = scopeWarehouse?.members.find((member) => member.userId === scopeOf?.userId)
  const membershipDecides = data ? readsWarehouseMembership(data.ownershipMode) : false

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4 space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="text-base">Warehouses</CardTitle>
          <CardDescription>
            {membershipDecides
              ? "Apricart's warehouses decide who works each order: a branch's orders go to the operators of the warehouse it is in, by rule or by hand, and a transferred order to its new warehouse."
              : "Apricart's warehouses, who works at each, and which branches each holds by rule or by hand. Today every order is still worked by the accounts assigned its branch on Warehouse Team (and a transferred order by its warehouse's operators); run the check below to see whether anyone's work would change when warehouses decide."}
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
                    <td className="py-2 pr-3">
                      <div>{warehouse.branchCount} active</div>
                      <div className="text-xs text-muted-foreground">
                        {warehouse.ruleCount} rule{warehouse.ruleCount === 1 ? "" : "s"} · {warehouse.routedBranchCount} by hand
                      </div>
                    </td>
                    <td className="py-2 pr-3">
                      <Badge variant={warehouse.status === "ACTIVE" ? "default" : "outline"}>
                        {warehouse.status === "ACTIVE" ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="space-x-2 whitespace-nowrap py-2 text-right">
                      <Button size="sm" variant="outline" onClick={() => setEditing(warehouse)}>Edit</Button>
                      <Button size="sm" variant="outline" onClick={() => setMembersOf(warehouse.id)}>Members</Button>
                      <Button size="sm" variant="outline" onClick={() => setRulesOf(warehouse.id)} disabled={!team}>Rules</Button>
                      <Button size="sm" variant="outline" onClick={() => setRoutesOf(warehouse)} disabled={!team}>By hand</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {data && <OwnershipCheckPanel configuration={data} />}
        {data && team && <UnroutedPanel configuration={data} team={team} />}
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
      {membersWarehouse && data && (
        <MembersDialog
          key={membersWarehouse.id}
          warehouse={membersWarehouse}
          accounts={data.accounts}
          ownershipMode={data.ownershipMode}
          onScope={(userId) => setScopeOf({ warehouseId: membersWarehouse.id, userId })}
          onClose={() => setMembersOf(null)}
          onSaved={refresh}
        />
      )}
      {scopeWarehouse && scopeMember && data && team && (
        <MemberScopeDialog
          key={`${scopeWarehouse.id}-${scopeMember.userId}`}
          warehouse={scopeWarehouse}
          member={scopeMember}
          account={data.accounts.find((account) => account.id === scopeMember.userId)}
          configuration={data}
          team={team}
          onClose={() => setScopeOf(null)}
          onSaved={refresh}
        />
      )}
      {rulesWarehouse && data && team && (
        <RulesDialog
          key={rulesWarehouse.id}
          warehouse={rulesWarehouse}
          configuration={data}
          team={team}
          onClose={() => setRulesOf(null)}
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
