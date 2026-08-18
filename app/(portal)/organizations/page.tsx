"use client"
import { useAppContext } from "@/components/context/app-context"
import { BranchExcelExportButton } from "@/components/organizations/branch-excel-export-button"
import { BranchListExcelExportButton } from "@/components/organizations/branch-list-excel-export-button"
import { OrganizationExcelExportButton } from "@/components/organizations/organization-excel-export-button"
import { OrganizationListExcelExportButton } from "@/components/organizations/organization-list-excel-export-button"
import {
PrivateNetworkLoginFields,
createNetworkEntryDraft,
privateNetworkDraftError,
toPrivateNetworkLoginPayload,
type PrivateNetworkEntryDraft,
} from "@/components/organizations/private-network-login-fields"
import { PremiumAlert,type AlertType } from "@/components/premium/premium-alert"
import { PremiumConfirmDialog } from "@/components/premium/premium-confirm-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle,DialogTrigger } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
BUDGET_ALLOCATION_MODE_SETTING_KEY,
parseBudgetAllocationMode,
type BudgetAllocationMode,
} from "@/lib/budget-allocation-mode"
import { formatCountLabel } from "@/lib/count-label"
import { useBranches,useOrganizations } from "@/lib/hooks/use-api"
import {
DEFAULT_ORDER_APPROVER_ROLE,
ORDER_APPROVER_ROLE_LABELS,
parseOrderApproverRole,
type OrderApproverRole,
} from "@/lib/order-approver-role"
import { cn } from "@/lib/utils"
import { Building2,GitBranch,Loader,Pencil,Save,Search,Trash2 } from "lucide-react"
import { useSession } from "next-auth/react"
import { ReactNode,useEffect,useMemo,useRef,useState } from "react"
type Organization = {
  id: number
  name: string
  code: string
  status?: "active" | "inactive"
  budgetAllocationMode?: BudgetAllocationMode
  orderApproverRole?: OrderApproverRole
}
type Branch = {
  id: number
  name: string
  code: string
  organizationId: number
  province?: string | null
  city?: string | null
  address?: string | null
  costCenterId?: string | null
  status?: "active" | "inactive"
}

const LEGACY_HIDE_PRICES_SETTING_KEY = "hide_prices_for_branch_and_order_portal"
const HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY = "hide_prices_for_branch_admin"
const HIDE_ORDER_PORTAL_PRICES_SETTING_KEY = "hide_prices_for_order_portal"
const BUDGET_ALLOCATION_MODE_LABELS: Record<BudgetAllocationMode, string> = {
  money: "Money-based",
  quantity: "Quantity-based",
}

type PriceVisibilitySettings = {
  hideBranchAdminPrices: boolean
  hideOrderPortalPrices: boolean
}

type OrgsRes = { items: Organization[] }
type BranchesRes = { items: Branch[] }


export default function OrganizationsPage() {
  const { data: session } = useSession()
  const { data: orgs, mutate: refetchOrgs, isLoading: loadingOrgs } = useOrganizations()
  const { data: branches, mutate: refetchBranches, isLoading: loadingBranches } = useBranches()
  const { organizationId: contextOrgId } = useAppContext()
  const userRole = (session?.user as any)?.role

  const [openOrg, setOpenOrg] = useState(false)
  const [openBranch, setOpenBranch] = useState(false)
  const [feedback, setFeedback] = useState<{ message: string; type: AlertType; visible: boolean }>({
    message: "",
    type: "info",
    visible: false,
  })

  const showFeedback = (message: string, type: AlertType) => {
    setFeedback({ message, type, visible: true })
  }
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null)
  const hasInitializedOrgSelectionRef = useRef(false)
  const previousContextOrgIdRef = useRef<string | null | undefined>(undefined)
  const [orgSearch, setOrgSearch] = useState("")
  const [branchStatusFilter, setBranchStatusFilter] = useState<"all" | "active" | "inactive">("all")
  const [branchSearch, setBranchSearch] = useState("")
  const [confirmDelete, setConfirmDelete] = useState<{ open: boolean; id: string | null; name: string | null }>({
    open: false,
    id: null,
    name: null,
  })
  const [confirmDeleteBranch, setConfirmDeleteBranch] = useState<{ open: boolean; id: string | null; name: string | null }>({
    open: false,
    id: null,
    name: null,
  })
  const [isDeleting, setIsDeleting] = useState(false)

  // Helper to add a new organization to the cache optimistically
  const addOrganizationOptimistic = async (newOrg: Organization) => {
    console.log("[OrganizationsPage] 🚀 Adding org optimistically:", newOrg)
    const currentOrgs = orgs?.items || []
    await refetchOrgs({ items: [newOrg, ...currentOrgs] }, { revalidate: true })
    console.log("[OrganizationsPage] ✅ Org added, revalidating in background")
  }

  // Helper to remove an organization from the cache optimistically
  const removeOrganizationOptimistic = async (id: string) => {
    console.log("[OrganizationsPage] 🚀 Removing org optimistically:", id)
    const currentOrgs = orgs?.items || []
    const updatedOrgs = currentOrgs.filter(o => String(o.id) !== String(id))
    await refetchOrgs({ items: updatedOrgs }, { revalidate: true })
    console.log("[OrganizationsPage] ✅ Org removed, revalidating in background")
  }

  // Helper to edit an organization in the cache optimistically
  const editOrganizationOptimistic = async (id: string, payload: Partial<Organization>) => {
    console.log("[OrganizationsPage] 🚀 Editing org optimistically:", id, payload)
    const currentOrgs = orgs?.items || []
    const updatedOrgs = currentOrgs.map(o => String(o.id) === String(id) ? { ...o, ...payload } : o)
    await refetchOrgs({ items: updatedOrgs }, { revalidate: true })
    console.log("[OrganizationsPage] ✅ Org edited, revalidating in background")
  }

  // Helper to add a new branch to the cache optimistically
  const addBranchOptimistic = async (newBranch: Branch) => {
    console.log("[OrganizationsPage] 🚀 Adding branch optimistically:", newBranch)
    const currentBranches = branches?.items || []
    await refetchBranches({ items: [newBranch, ...currentBranches] }, { revalidate: true })
    console.log("[OrganizationsPage] ✅ Branch added, revalidating in background")
  }

  // Helper to remove a branch from the cache optimistically
  const removeBranchOptimistic = async (id: string) => {
    console.log("[OrganizationsPage] 🚀 Removing branch optimistically:", id)
    const currentBranches = branches?.items || []
    const updatedBranches = currentBranches.filter(b => String(b.id) !== String(id))
    await refetchBranches({ items: updatedBranches }, { revalidate: true })
    console.log("[OrganizationsPage] ✅ Branch removed, revalidating in background")
  }

  // Helper to edit a branch in the cache optimistically
  const editBranchOptimistic = async (id: string, payload: Partial<Branch>) => {
    console.log("[OrganizationsPage] 🚀 Editing branch optimistically:", id, payload)
    const currentBranches = branches?.items || []
    const updatedBranches = currentBranches.map(b => String(b.id) === String(id) ? { ...b, ...payload } : b)
    await refetchBranches({ items: updatedBranches }, { revalidate: true })
    console.log("[OrganizationsPage] ✅ Branch edited, revalidating in background")
  }

  // Combined refresh helper
  const refreshAll = async () => {
    console.log("[OrganizationsPage] 🔄 Triggering full refresh...")
    console.log("[OrganizationsPage] Current orgs count:", orgs?.items?.length)
    console.log("[OrganizationsPage] Current branches count:", branches?.items?.length)

    // Trigger revalidation
    await Promise.all([
      refetchOrgs(),
      refetchBranches()
    ])

    console.log("[OrganizationsPage] ✅ Refresh complete")
    console.log("[OrganizationsPage] New orgs count:", orgs?.items?.length)
    console.log("[OrganizationsPage] New branches count:", branches?.items?.length)
  }

  useEffect(() => {
    const organizations = orgs?.items
    if (!organizations) return

    const normalizedContextOrgId = contextOrgId ? String(contextOrgId) : null
    const isInitialSelection = !hasInitializedOrgSelectionRef.current
    const contextChanged =
      previousContextOrgIdRef.current !== undefined &&
      previousContextOrgIdRef.current !== normalizedContextOrgId

    previousContextOrgIdRef.current = normalizedContextOrgId

    if (organizations.length === 0) {
      setSelectedOrgId(null)
      return
    }

    setSelectedOrgId((currentSelection) => {
      const hasOrganization = (id: string) =>
        organizations.some((organization) => String(organization.id) === id)

      if (contextChanged && normalizedContextOrgId && hasOrganization(normalizedContextOrgId)) {
        return normalizedContextOrgId
      }

      if (isInitialSelection) {
        if (normalizedContextOrgId && hasOrganization(normalizedContextOrgId)) {
          return normalizedContextOrgId
        }
        return String(organizations[0].id)
      }

      if (currentSelection === null || hasOrganization(currentSelection)) {
        return currentSelection
      }

      if (normalizedContextOrgId && hasOrganization(normalizedContextOrgId)) {
        return normalizedContextOrgId
      }

      return String(organizations[0].id)
    })

    hasInitializedOrgSelectionRef.current = true
  }, [contextOrgId, orgs?.items])

  async function removeOrganization(id: string) {
    try {
      setIsDeleting(true)
      const res = await fetch(`/api/v1/organizations/${id}`, { method: "DELETE" })
      const data = await res.json()

      if (!res.ok) {
        if (res.status === 404) {
          // If already deleted, just sync UI
          await removeOrganizationOptimistic(id)
          showFeedback("Organization already deleted. Syncing state.", "success")
          return
        }
        throw new Error(data.error || "Failed to delete organization")
      }

      showFeedback("Organization deleted successfully.", "success")
      await removeOrganizationOptimistic(id)
    } catch (e: any) {
      showFeedback(e.message, "error")
      await refreshAll() // Rollback/Restore on error
    } finally {
      setIsDeleting(false)
      setConfirmDelete({ open: false, id: null, name: null })
    }
  }

  async function removeBranch(id: string) {
    try {
      setIsDeleting(true)
      const res = await fetch(`/api/v1/branches/${id}`, { method: "DELETE" })
      const data = await res.json()

      if (!res.ok) {
        if (res.status === 404) {
          // If already deleted, just sync UI
          await removeBranchOptimistic(id)
          showFeedback("Branch already deleted. Syncing state.", "success")
          return
        }
        throw new Error(data.error || "Failed to delete branch")
      }

      showFeedback("Branch deleted successfully.", "success")
      await removeBranchOptimistic(id)
    } catch (e: any) {
      showFeedback(e.message, "error")
      await refreshAll() // Rollback/Restore on error
    } finally {
      setIsDeleting(false)
      setConfirmDeleteBranch({ open: false, id: null, name: null })
    }
  }

  async function editOrganization(
    id: string,
    payload: Partial<Organization>,
    priceVisibility?: PriceVisibilitySettings,
    privateNetworkLogin?: ReturnType<typeof toPrivateNetworkLoginPayload>,
  ): Promise<boolean> {
    try {
      const res = await fetch(`/api/v1/organizations/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" }
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to update organization")

      if (priceVisibility) {
        const settingsPayload = [
          {
            key: HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY,
            value: priceVisibility.hideBranchAdminPrices,
          },
          {
            key: HIDE_ORDER_PORTAL_PRICES_SETTING_KEY,
            value: priceVisibility.hideOrderPortalPrices,
          },
        ]

        for (const setting of settingsPayload) {
          const settingsRes = await fetch("/api/v1/settings", {
            method: "POST",
            body: JSON.stringify({
              organizationId: Number(id),
              key: setting.key,
              value: setting.value,
            }),
            headers: { "Content-Type": "application/json" },
          })
          const settingsData = await settingsRes.json()
          if (!settingsRes.ok) throw new Error(settingsData.error || "Failed to update price visibility setting")
        }
      }

      if (privateNetworkLogin) {
        const networkRes = await fetch(`/api/v1/organizations/${id}/network-policy`, {
          method: "PUT",
          body: JSON.stringify(privateNetworkLogin),
          headers: { "Content-Type": "application/json" },
        })
        const networkData = await networkRes.json()
        if (!networkRes.ok) {
          throw new Error(networkData.error || "Failed to update private network login")
        }
      }

      showFeedback("Organization updated successfully.", "success")
      await editOrganizationOptimistic(id, payload)
      return true
    } catch (e: any) {
      showFeedback(e.message, "error")
      await refreshAll() // Rollback on error
      return false
    }
  }

  const filteredOrganizations = useMemo(() => {
    if (!orgs?.items) return []
    if (!orgSearch.trim()) return orgs.items
    const query = orgSearch.toLowerCase()
    return orgs.items.filter((org) => org.name.toLowerCase().includes(query) || org.code.toLowerCase().includes(query))
  }, [orgs?.items, orgSearch])

  const branchesByOrgId = useMemo(() => {
    const map = new Map<number, Branch[]>()
    if (branches?.items) {
      branches.items.forEach((branch) => {
        const list = map.get(branch.organizationId) || []
        list.push(branch)
        map.set(branch.organizationId, list)
      })
    }
    return map
  }, [branches?.items])

  const selectedOrg = selectedOrgId ? orgs?.items?.find((org) => String(org.id) === String(selectedOrgId)) : null
  const visibleBranches = useMemo(() => {
    if (!branches?.items) return []
    if (!selectedOrgId) return branches.items
    return branches.items.filter((branch) => String(branch.organizationId) === String(selectedOrgId))
  }, [branches?.items, selectedOrgId])

  const filteredBranches = useMemo(() => {
    let result = visibleBranches
    if (branchStatusFilter !== "all") {
      result = result.filter((branch) =>
        branchStatusFilter === "active" ? isActiveStatus(branch.status) : !isActiveStatus(branch.status)
      )
    }
    if (branchSearch.trim()) {
      const q = branchSearch.toLowerCase()
      result = result.filter((b) =>
        b.name.toLowerCase().includes(q) ||
        b.code.toLowerCase().includes(q) ||
        (b.costCenterId || "").toLowerCase().includes(q)
      )
    }
    return result
  }, [visibleBranches, branchStatusFilter, branchSearch])

  const orgCount = orgs?.items.length ?? 0
  const branchCount = branches?.items.length ?? 0

  return (
    <>
      <PremiumAlert
        message={feedback.message}
        type={feedback.type}
        isVisible={feedback.visible}
        onClose={() => setFeedback({ ...feedback, visible: false })}
      />
      <main className="min-h-[calc(100vh-4rem)] bg-slate-50/50 dark:bg-slate-950 p-4 md:p-8 space-y-6">
        {/* Compact Page Header */}
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-indigo-100 to-emerald-100 dark:from-indigo-900/50 dark:to-emerald-900/50 flex items-center justify-center border border-indigo-50/50 dark:border-indigo-800/50 shadow-inner">
              <Building2 className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Organization Settings</h1>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Manage companies &amp; branches</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <CreateOrgDialog
              open={openOrg}
              onOpenChange={setOpenOrg}
              showFeedback={showFeedback}
              variant="outline"
              className="h-9 gap-2 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 shadow-sm"
              onCreated={async (newOrg) => {
                setOpenOrg(false)
                await addOrganizationOptimistic(newOrg)
              }}
            />
            <CreateBranchDialog
              organizations={orgs?.items || []}
              open={openBranch}
              onOpenChange={setOpenBranch}
              showFeedback={showFeedback}
              variant="default"
              className="h-9 gap-2 bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm"
              onCreated={async (newBranch) => {
                setOpenBranch(false)
                await addBranchOptimistic(newBranch)
              }}
            />
          </div>
        </div>

        {/* Compact Colorful Stats */}
        <div className="grid gap-4 md:grid-cols-2">
          <CompactStatCard
            label="Companies"
            value={orgCount}
            icon={<Building2 className="h-5 w-5" />}
            gradient="bg-gradient-to-br from-indigo-50/80 to-blue-50/80 border-indigo-100/50 text-indigo-700 dark:from-indigo-900/20 dark:to-blue-900/20 dark:border-indigo-800/30 dark:text-indigo-400"
            iconBadge="bg-white/80 text-indigo-600 shadow-sm border border-indigo-100 dark:bg-slate-800 dark:border-indigo-800"
          />
          <CompactStatCard
            label="Branches"
            value={branchCount}
            icon={<GitBranch className="h-5 w-5" />}
            gradient="bg-gradient-to-br from-emerald-50/80 to-teal-50/80 border-emerald-100/50 text-emerald-700 dark:from-emerald-900/20 dark:to-teal-900/20 dark:border-emerald-800/30 dark:text-emerald-400"
            iconBadge="bg-white/80 text-emerald-600 shadow-sm border border-emerald-100 dark:bg-slate-800 dark:border-emerald-800"
          />
        </div>

        <section className="grid gap-10 2xl:grid-cols-[minmax(460px,5fr)_minmax(0,7fr)] 2xl:gap-6 shrink-0 animate-in fade-in slide-in-from-bottom-8 duration-1000 delay-300 fill-mode-both">
          <div className="min-w-0">
            <Card className="h-full border-none shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-[2rem] overflow-hidden">
              <CardHeader className="pb-4">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-1.5">
                    <CardTitle className="text-xl font-semibold tracking-tight">Company List</CardTitle>
                    <OrganizationListExcelExportButton
                      organizations={orgs?.items || []}
                      branches={branches?.items || []}
                      isLoading={loadingOrgs || loadingBranches}
                      onSuccess={(message) => showFeedback(message, "success")}
                      onError={(message) => showFeedback(message, "error")}
                    />
                  </div>
                  <Badge variant="outline" className="bg-indigo-50/50 text-indigo-700 border-indigo-100 dark:bg-indigo-500/10 dark:text-indigo-400 dark:border-indigo-500/20 rounded-lg px-2.5 py-1">
                    {orgCount}
                  </Badge>
                </div>
                <p className="text-sm text-slate-500 dark:text-slate-400 font-medium leading-relaxed">Select a company to view its details and branches.</p>
              </CardHeader>
              <CardContent className="space-y-6 px-4 pb-6">
                <div className="relative group">
                  <Search className="absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-indigo-500" />
                  <Input
                    placeholder="Search companies..."
                    value={orgSearch}
                    onChange={(e) => setOrgSearch(e.target.value)}
                    className="pl-11 h-12 bg-slate-50/50 dark:bg-slate-950/50 border-transparent focus:border-indigo-500/30 focus:ring-4 focus:ring-indigo-500/10 rounded-xl transition-all"
                  />
                </div>
                <ScrollArea className="h-[500px] xl:h-[600px] w-full">
                  <div className="space-y-3 pr-4">
                    <OrganizationListItem
                      isActive={!selectedOrgId}
                      onClick={() => setSelectedOrgId(null)}
                      title="All Companies"
                      subtitle={`${formatCountLabel(orgCount, "company", "companies")}, ${formatCountLabel(branchCount, "branch", "branches")}`}
                      badgeLabel="Global"
                    />
                    {filteredOrganizations.map((org) => (
                      <OrganizationListItem
                        key={org.id}
                        isActive={String(org.id) === String(selectedOrgId)}
                        onClick={() => setSelectedOrgId(String(org.id))}
                        title={org.name}
                        subtitle={`${org.code} • ${formatCountLabel(branchesByOrgId.get(org.id)?.length || 0, "branch", "branches")}`}
                        status={isActiveStatus(org.status)}
                        budgetAllocationMode={org.budgetAllocationMode}
                      >
                        <EditOrgDialog
                          org={org}
                          isSuperAdmin={userRole === "SUPER_ADMIN"}
                          // Forwarded as a rest spread so a newly added argument cannot be
                          // silently dropped here: omitting one skips its save step while the
                          // dialog still reports success.
                          onSave={(...args) => editOrganization(String(org.id), ...args)}
                        />
                        <OrganizationExcelExportButton
                          organization={org}
                          branches={branchesByOrgId.get(org.id) || []}
                          onSuccess={(message) => showFeedback(message, "success")}
                          onError={(message) => showFeedback(message, "error")}
                        />
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10 rounded-lg"
                          onClick={(event) => {
                            event.stopPropagation()
                            setConfirmDelete({ open: true, id: String(org.id), name: org.name })
                          }}
                          title="Delete company"
                        >
                          <Trash2 size={16} />
                        </Button>
                      </OrganizationListItem>
                    ))}
                    {filteredOrganizations.length === 0 && (
                      <div className="flex flex-col items-center justify-center py-10 text-center space-y-2">
                        <div className="h-10 w-10 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center">
                          <Search className="h-5 w-5 text-slate-400" />
                        </div>
                        <p className="text-sm font-medium text-slate-500">No results found</p>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>

          <div className="min-w-0 space-y-10">
            <div className="grid gap-6 sm:grid-cols-2">
              <SummaryStat
                label={selectedOrg ? "Parent Identity" : "Infrastructure"}
                value={selectedOrg ? selectedOrg.name : `${orgCount} Entities`}
                helper={selectedOrg ? `ID: ${selectedOrg.code}` : "Active Tenants"}
                icon={<Building2 className="h-5 w-5" />}
              />
              <SummaryStat
                label="Operational Reach"
                value={formatCountLabel(filteredBranches.length, "Branch", "Branches")}
                // helper={branchStatusFilter === "all" ? "Full Distribution" : `${branchStatusFilter} Subset`}
                icon={<GitBranch className="h-5 w-5" />}
              />
            </div>

            <Card className="border-none shadow-[0_8px_30px_rgb(0,0,0,0.04)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.2)] bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl rounded-[2rem] overflow-hidden">
              <CardHeader className="flex flex-col gap-4 px-5 pb-5 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <CardTitle className="text-2xl font-bold tracking-tight">Branches Management</CardTitle>
                    <BranchListExcelExportButton
                      branches={branches?.items || []}
                      organizations={orgs?.items || []}
                      selectedOrganization={selectedOrg}
                      isLoading={loadingOrgs || loadingBranches}
                      onSuccess={(message) => showFeedback(message, "success")}
                      onError={(message) => showFeedback(message, "error")}
                    />
                  </div>
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">
                    {selectedOrg ? `Strategic units for ${selectedOrg.name}` : `Full enterprise distribution`}
                  </p>
                </div>
                <div className="flex items-center gap-3 flex-wrap">
                  <div className="relative group">
                    <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 transition-colors group-focus-within:text-indigo-500" />
                    <Input
                      placeholder="Search branches or cost centers..."
                      value={branchSearch}
                      onChange={(e) => setBranchSearch(e.target.value)}
                      className="pl-8 h-10 w-[180px] bg-slate-50/50 dark:bg-slate-950/50 border-slate-200 dark:border-slate-700 focus:border-indigo-500/30 focus:ring-4 focus:ring-indigo-500/10 rounded-xl text-sm transition-all"
                    />
                  </div>
                  <div className="flex h-10 items-center px-4 rounded-xl bg-slate-100/50 dark:bg-slate-800/50 border border-slate-200/50 dark:border-slate-700/50 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    Filter by status
                  </div>
                  <Select value={branchStatusFilter} onValueChange={(value) => setBranchStatusFilter(value as typeof branchStatusFilter)}>
                    <SelectTrigger className="w-[180px] h-10 rounded-xl border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-950 shadow-sm focus:ring-4 focus:ring-indigo-500/10 transition-all">
                      <SelectValue placeholder="Status Distribution" />
                    </SelectTrigger>
                    <SelectContent className="rounded-xl border-slate-200 dark:border-slate-800">
                      <SelectItem value="all">All Status</SelectItem>
                      <SelectItem value="active">Active only</SelectItem>
                      <SelectItem value="inactive">Inactive only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[450px] xl:h-[550px] w-full">
                  <div className="w-full px-5 pb-6 pt-2">
                    <BranchesTable
                      items={filteredBranches}
                      organizations={orgs?.items || []}
                      showCompanyColumn={!selectedOrg}
                      showFeedback={showFeedback}
                      onDelete={(id, name) => setConfirmDeleteBranch({ open: true, id, name })}
                      onRefresh={refreshAll}
                      onEdit={editBranchOptimistic}
                    />
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </section>


        {loadingOrgs && <div className="text-sm text-muted-foreground">Loading...</div>}

        <PremiumConfirmDialog
          open={confirmDelete.open}
          onOpenChange={(open) => setConfirmDelete((prev) => ({ ...prev, open }))}
          onConfirm={() => confirmDelete.id && removeOrganization(confirmDelete.id)}
          title={`Delete "${confirmDelete.name}"?`}
          description={selectedOrg?.status === "active"
            ? "This action cannot be undone. Active organizations with branches or users cannot be deleted directly. Please deactivate the organization first to allow automatic cleanup."
            : "This action cannot be undone. Deleting this inactive organization will automatically remove its associated branches, users, and non-financial data."}
          confirmText="Delete Company"
          type="danger"
          isLoading={isDeleting}
        />

        <PremiumConfirmDialog
          open={confirmDeleteBranch.open}
          onOpenChange={(open) => setConfirmDeleteBranch((prev) => ({ ...prev, open }))}
          onConfirm={() => confirmDeleteBranch.id && removeBranch(confirmDeleteBranch.id)}
          title={`Delete Branch "${confirmDeleteBranch.name}"?`}
          description="This action cannot be undone. Branch inventory, orders, and staff records will be permanently removed. If the branch is active, ensure all users are reassigned first."
          confirmText="Delete Branch"
          type="danger"
          isLoading={isDeleting}
        />
      </main>
    </>
  )
}

function isActiveStatus(status: unknown): boolean {
  if (typeof status === "string") return status.toLowerCase().trim() === "active"
  if (typeof status === "number") return status === 1
  return Boolean(status)
}


function BranchesTable({
  items,
  organizations,
  showCompanyColumn = true,
  showFeedback,
  onDelete,
  onRefresh,
  onEdit,
}: Readonly<{
  items: Branch[]
  organizations: Organization[]
  showCompanyColumn?: boolean
  showFeedback: (msg: string, type: AlertType) => void
  onDelete: (id: string, name: string) => void
  onRefresh: () => Promise<void>
  onEdit: (id: string, payload: Partial<Branch>) => Promise<void>
}>) {
  const orgById = useMemo(() => Object.fromEntries(organizations.map((o) => [o.id, o])), [organizations])

  async function edit(id: string, payload: Partial<Branch>) {
    try {
      const res = await fetch(`/api/v1/branches/${id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" }
      })
      if (!res.ok) throw new Error("Failed to update branch")
      showFeedback("Branch updated successfully.", "success")
      await onEdit(id, payload)
    } catch (e: any) {
      showFeedback(e.message, "error")
      await onRefresh() // Rollback on error
    }
  }
  return (
    <div className="w-full">
      <table className="w-full text-sm border-collapse table-fixed">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-[0.2em] text-slate-400 font-semibold border-b border-slate-100 dark:border-slate-800/60">
            <th className="pb-4 pr-2 font-semibold w-[26%]">Strategic Branch</th>
            <th className="pb-4 pr-2 font-semibold w-[14%]">Code</th>
            <th className="pb-4 pr-2 font-semibold w-[16%]">Cost Center</th>
            {showCompanyColumn && <th className="pb-4 pr-2 font-semibold w-[17%]">Parent</th>}
            <th className="pb-4 pr-2 font-semibold w-[12%] text-center">Lifecycle</th>
            <th className="pb-4 w-[15%] text-right">Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50 dark:divide-slate-800/40">
          {items.map((b) => (
            <tr key={b.id} className="group hover:bg-slate-50/80 dark:hover:bg-indigo-500/[0.03] transition-all duration-300">
              <td className="py-5 pr-3">
                <div className="flex items-center gap-3">
                  <div className="h-9 w-9 rounded-xl bg-indigo-50 dark:bg-indigo-500/10 flex items-center justify-center text-indigo-600 dark:text-indigo-400 font-semibold border border-indigo-100/50 dark:border-indigo-500/20 group-hover:scale-110 transition-transform">
                    {b.name.charAt(0)}
                  </div>
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-900 dark:text-slate-100 tracking-tight">{b.name}</p>
                    {(b.province || b.city || b.address) && (
                      <p className="mt-1 truncate text-xs font-medium text-slate-500 dark:text-slate-400">
                        {[b.province, b.city].filter(Boolean).join(", ")}
                        {(() => {
                          if (b.address) {
                            return `${b.province || b.city ? " • " : ""}${b.address}`
                          }
                          return ""
                        })()}
                      </p>
                    )}
                  </div>
                </div>
              </td>
              <td className="py-5 pr-3">
                <code className="inline-block whitespace-nowrap px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider border border-slate-200/50 dark:border-slate-700/50">
                  {b.code}
                </code>
              </td>
              <td className="py-5 pr-3">
                <code className="inline-block max-w-full truncate whitespace-nowrap px-2 py-1 rounded-lg bg-slate-100 dark:bg-slate-800 text-[11px] font-semibold text-slate-600 dark:text-slate-400 uppercase tracking-wider border border-slate-200/50 dark:border-slate-700/50">
                  {b.costCenterId || "—"}
                </code>
              </td>
              {showCompanyColumn && (
                <td className="py-5 pr-4">
                  <span className="font-semibold text-slate-500 dark:text-slate-400">{orgById[b.organizationId]?.name || "—"}</span>
                </td>
              )}
              <td className="py-5 pr-2 text-center">
                <Badge
                  variant={isActiveStatus(b.status) ? "outline" : "destructive"}
                  className={cn(
                    "px-2 py-0.5 text-[8px] uppercase font-semibold tracking-widest rounded-full border",
                    isActiveStatus(b.status)
                      ? "border-emerald-500/20 bg-emerald-500/5 text-emerald-500"
                      : "border-rose-500/20 bg-rose-500/5 text-rose-500"
                  )}
                >
                  {isActiveStatus(b.status) ? "Active" : "Inactive"}
                </Badge>
              </td>
              <td className="py-5 text-right">
                <div className="inline-flex min-w-[124px] items-center justify-end gap-1">
                  <EditBranchDialog branch={b} onSave={(payload) => edit(String(b.id), payload)} />
                  <BranchExcelExportButton
                    branch={b}
                    onSuccess={(message) => showFeedback(message, "success")}
                    onError={(message) => showFeedback(message, "error")}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-9 w-9 rounded-xl text-slate-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-500/10"
                    aria-label={`Delete ${b.name}`}
                    onClick={() => onDelete(String(b.id), b.name)}
                  >
                    <Trash2 size={16} />
                  </Button>
                </div>
              </td>
            </tr>
          ))}
          {items.length === 0 && (
            <tr>
              <td className="py-12 text-center" colSpan={showCompanyColumn ? 6 : 5}>
                <div className="flex flex-col items-center justify-center space-y-3">
                  <div className="h-12 w-12 rounded-full bg-slate-50 dark:bg-slate-800 flex items-center justify-center">
                    <GitBranch className="h-6 w-6 text-slate-300" />
                  </div>
                  <p className="text-sm font-semibold text-slate-400">No operational units detected</p>
                </div>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function OrganizationListItem({
  title,
  subtitle,
  onClick,
  isActive,
  children,
  status,
  badgeLabel,
  budgetAllocationMode,
}: Readonly<{
  title: string
  subtitle: string
  onClick: () => void
  isActive: boolean
  children?: ReactNode
  status?: boolean
  badgeLabel?: string
  budgetAllocationMode?: BudgetAllocationMode
}>) {
  const initials = title
    .split(" ")
    .filter(Boolean)
    .map((word) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase()
  const normalizedBudgetAllocationMode = budgetAllocationMode
    ? parseBudgetAllocationMode(budgetAllocationMode)
    : null

  return (
    <article
      className={cn(
        "group w-full rounded-[1.25rem] border-2 p-4 text-left transition-all duration-300",
        isActive
          ? "border-indigo-500/30 bg-indigo-50 shadow-[0_4px_20px_rgba(79,70,229,0.08)] dark:border-indigo-500/40 dark:bg-indigo-500/10"
          : "border-transparent bg-slate-50/50 hover:bg-white hover:border-slate-200 hover:shadow-lg hover:shadow-slate-200/40 dark:bg-slate-950/40 dark:hover:bg-slate-800/60 dark:hover:border-slate-700 dark:hover:shadow-none"
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className={cn(
          "flex w-full flex-wrap items-start gap-4 rounded-xl text-left outline-none focus-visible:ring-4 focus-visible:ring-indigo-500/20 sm:flex-nowrap sm:items-center",
          isActive ? "border-indigo-500/30" : "border-transparent",
        )}
      >
        <div
          className={cn(
            "flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl text-[13px] font-semibold transition-all duration-500",
            (() => {
              if (isActive) {
                return "bg-gradient-to-br from-indigo-600 to-indigo-700 text-white shadow-lg shadow-indigo-600/30 scale-110 rotate-3"
              }
              if (badgeLabel === "Global") {
                return "bg-slate-900 text-white shadow-md dark:bg-white dark:text-slate-900"
              }
              return "bg-white text-slate-600 border border-slate-100 dark:bg-slate-800 dark:text-slate-300 dark:border-slate-700 group-hover:scale-105"
            })()
          )}
        >
          {badgeLabel === "Global" ? "∞" : initials || "?"}
        </div>
        <div className="min-w-0 flex-1 basis-[calc(100%-4rem)] sm:basis-auto">
          <div className="flex items-center gap-2 mb-0.5">
            <p className={cn("font-semibold truncate tracking-tight", isActive ? "text-indigo-950 dark:text-indigo-100" : "text-slate-700 dark:text-slate-200")}>{title}</p>
            {typeof status === "boolean" && (
              <span
                className={cn(
                  "h-2 w-2 rounded-full shrink-0",
                  status ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" : "bg-rose-500 shadow-[0_0_10px_rgba(244,63,94,0.5)]"
                )}
              />
            )}
          </div>
          <p className="text-[11px] font-semibold text-slate-400 dark:text-slate-500 uppercase tracking-wider truncate">{subtitle}</p>
        </div>
        <div className="flex w-full shrink-0 flex-col items-end gap-2 pt-1 sm:w-auto sm:pt-0">
          <div className="flex w-full flex-wrap items-center justify-between gap-2 sm:w-auto sm:justify-end">
            {normalizedBudgetAllocationMode && (
              <Badge
                variant="outline"
                className={cn(
                  "text-[9px] uppercase font-semibold tracking-widest px-2 py-0.5 rounded-md whitespace-nowrap",
                  normalizedBudgetAllocationMode === "quantity"
                    ? "border-indigo-200/70 bg-indigo-50/70 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300"
                    : "border-sky-200/70 bg-sky-50/70 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300"
                )}
              >
                {BUDGET_ALLOCATION_MODE_LABELS[normalizedBudgetAllocationMode]}
              </Badge>
            )}
            {(() => {
              if (typeof status === "boolean") {
                return (
              <Badge variant={status ? "outline" : "secondary"} className={cn(
                "text-[9px] uppercase font-semibold tracking-widest px-2 py-0.5 rounded-md",
                status
                  ? "border-emerald-200/50 bg-emerald-50/50 text-emerald-700 dark:border-emerald-500/20 dark:bg-emerald-500/10 dark:text-emerald-400"
                  : "bg-slate-100 text-slate-500 dark:bg-slate-800/50 dark:text-slate-400"
              )}>
                {status ? "Active" : "Inactive"}
              </Badge>
            )
              }
              if (badgeLabel) {
                return (
              <Badge variant="secondary" className="text-[9px] uppercase font-semibold tracking-widest px-2 py-0.5 bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400 rounded-md border-transparent shadow-none">
                {badgeLabel}
              </Badge>
            )
              }
              return null
            })()}
          </div>
        </div>
      </button>
      {children && (
        <div className="mt-2 flex min-w-[72px] items-center justify-end gap-1">
          {children}
        </div>
      )}
    </article>
  )
}

function HeroStat({ label, value, helper, icon }: Readonly<{ label: string; value: string | number; helper?: string; icon?: ReactNode }>) {
  return (
    <div className="min-w-[180px] rounded-3xl border border-white/10 bg-white/5 p-6 backdrop-blur-2xl shadow-[0_8px_32px_0_rgba(31,38,135,0.07)] dark:shadow-[0_8px_32px_0_rgba(0,0,0,0.3)] transition-all duration-300 hover:bg-white/[0.08] hover:border-white/20 group">
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <div className="h-10 w-10 rounded-xl bg-white/10 flex items-center justify-center border border-white/10 group-hover:scale-110 transition-transform duration-500">
            {icon}
          </div>
          <p className="text-3xl font-semibold text-white tracking-tighter">{value}</p>
        </div>
        <div>
          <p className="text-xs font-semibold text-white uppercase tracking-[0.2em]">{label}</p>
          {helper && <p className="mt-1 text-[10px] text-white/50 font-medium uppercase tracking-widest">{helper}</p>}
        </div>
      </div>
    </div>
  )
}

function CompactStatCard({
  label,
  value,
  icon,
  gradient,
  iconBadge,
}: Readonly<{
  label: string
  value: string | number
  icon: ReactNode
  gradient: string
  iconBadge: string
}>) {
  return (
    <Card className={cn("border rounded-2xl shadow-sm transition-all duration-300 hover:shadow-md hover:-translate-y-0.5", gradient)}>
      <CardContent className="p-5 flex items-center justify-between">
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold opacity-80 uppercase tracking-widest">
            {label}
          </p>
          <p className="text-4xl font-black tracking-tight">
            {value}
          </p>
        </div>
        <div className={cn("flex h-12 w-12 items-center justify-center rounded-xl", iconBadge)}>
           {icon}
        </div>
      </CardContent>
    </Card>
  )
}

function SummaryStat({ label, value, icon, helper }: Readonly<{ label: string; value: string | number; icon?: ReactNode; helper?: string }>) {
  return (
    <div className="relative overflow-hidden group flex flex-col justify-between rounded-2xl border border-slate-200/50 dark:border-slate-800/50 bg-white dark:bg-slate-950 p-6 shadow-sm transition-all duration-300 hover:shadow-md hover:border-indigo-500/20">
      <div className="absolute top-0 right-0 p-3 opacity-5 group-hover:opacity-10 transition-opacity translate-x-1/4 -translate-y-1/4">
        <div className="scale-[3]">
          {icon}
        </div>
      </div>

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 dark:bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border border-indigo-100 dark:border-indigo-500/20 shadow-sm transition-transform group-hover:scale-110">
            {icon}
          </div>
          <span className="text-[10px] font-semibold uppercase tracking-[0.2em] text-slate-500 dark:text-slate-400">{label}</span>
        </div>

        <div className="space-y-1">
          <div className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white truncate">
            {value}
          </div>
          {helper && <p className="text-xs font-semibold text-indigo-600 dark:text-indigo-400/80 uppercase tracking-wider">{helper}</p>}
        </div>
      </div>
    </div>
  )
}

function CreateOrgDialog({
  open,
  onOpenChange,
  onCreated,
  showFeedback,
  variant,
  className,
}: Readonly<{
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (item: Organization) => void
  showFeedback: (msg: string, type: AlertType) => void
  variant?: NonNullable<React.ComponentProps<typeof Button>["variant"]>
  className?: string
}>) {
  const [name, setName] = useState("")
  const [code, setCode] = useState("")
  const [status, setStatus] = useState<boolean>(true)
  const [budgetAllocationMode, setBudgetAllocationMode] = useState<BudgetAllocationMode>("money")
  const [orderApproverRole, setOrderApproverRole] = useState<OrderApproverRole>(DEFAULT_ORDER_APPROVER_ROLE)
  const [hideBranchAdminPrices, setHideBranchAdminPrices] = useState(false)
  const [hideOrderPortalPrices, setHideOrderPortalPrices] = useState(false)
  const [privateNetworkEnabled, setPrivateNetworkEnabled] = useState(false)
  const [networkEntries, setNetworkEntries] = useState<PrivateNetworkEntryDraft[]>([])
  const [confirmModeOpen, setConfirmModeOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const networkError = privateNetworkDraftError(privateNetworkEnabled, networkEntries)

  async function createCompany() {
    setSaving(true)
    try {
      const res = await fetch("/api/v1/organizations", {
        method: "POST",
        body: JSON.stringify({
          name,
          code,
          status: status ? "active" : "inactive",
          budgetAllocationMode,
          orderApproverRole,
          priceVisibility: {
            hideBranchAdminPrices,
            hideOrderPortalPrices,
          },
          privateNetworkLogin: toPrivateNetworkLoginPayload(
            privateNetworkEnabled,
            networkEntries,
          ),
        }),
        headers: { "Content-Type": "application/json" }
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to create company")

      showFeedback("Company created successfully.", "success")
      setName("")
      setCode("")
      setStatus(true)
      setBudgetAllocationMode("money")
      setOrderApproverRole(DEFAULT_ORDER_APPROVER_ROLE)
      setHideBranchAdminPrices(false)
      setHideOrderPortalPrices(false)
      setPrivateNetworkEnabled(false)
      setNetworkEntries([])
      setConfirmModeOpen(false)
      onCreated(data.item)
    } catch (e: any) {
      showFeedback(e.message, "error")
    } finally {
      setSaving(false)
    }
  }

  function submit() {
    if (!name || !code || saving || networkError) return
    setConfirmModeOpen(true)
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <Button variant={variant} className={cn("gap-2", className)}>
            <Building2 className="h-4 w-4" />
            Create Company
          </Button>
        </DialogTrigger>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Create Company</DialogTitle>
            <DialogDescription>
              Set up a new tenant with a memorable code, status, and budget allocation model.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
            <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="name">Company name</Label>
                  <Input
                    id="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Acme Inc."
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="code">Code</Label>
                  <Input
                    id="code"
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="ACME"
                    disabled={saving}
                  />
                  <p className="text-xs text-muted-foreground">Short & unique ID used in reports and APIs.</p>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Budget allocation model</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setBudgetAllocationMode("money")}
                    disabled={saving}
                    className={cn(
                      "rounded-md border bg-background p-3 text-left transition-colors",
                      budgetAllocationMode === "money" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50"
                    )}
                  >
                    <span className="text-sm font-semibold">Money value</span>
                    <span className="mt-1 block text-xs text-muted-foreground">Allocate budgets directly in PKR.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setBudgetAllocationMode("quantity")}
                    disabled={saving}
                    className={cn(
                      "rounded-md border bg-background p-3 text-left transition-colors",
                      budgetAllocationMode === "quantity" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50"
                    )}
                  >
                    <span className="text-sm font-semibold">Quantity</span>
                    <span className="mt-1 block text-xs text-muted-foreground">Allocate product quantities that calculate budget value.</span>
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label>Order approver</Label>
                <p className="text-xs text-muted-foreground">
                  Exactly one role can approve or reject pending orders for this company.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setOrderApproverRole("BRANCH_ADMIN")}
                    disabled={saving}
                    className={cn(
                      "rounded-md border bg-background p-3 text-left transition-colors",
                      orderApproverRole === "BRANCH_ADMIN" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50",
                    )}
                  >
                    <span className="text-sm font-semibold">Branch Admin</span>
                    <span className="mt-1 block text-xs text-muted-foreground">Each Branch Admin decides orders for their own branch.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderApproverRole("HEAD_OFFICE")}
                    disabled={saving}
                    className={cn(
                      "rounded-md border bg-background p-3 text-left transition-colors",
                      orderApproverRole === "HEAD_OFFICE" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50",
                    )}
                  >
                    <span className="text-sm font-semibold">Head Office</span>
                    <span className="mt-1 block text-xs text-muted-foreground">Head Office decides orders across all company branches.</span>
                  </button>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                <div>
                  <Label htmlFor="org-status">Status</Label>
                  <p className="text-xs text-muted-foreground">Inactive companies remain hidden from assignments.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Checkbox
                    id="org-status"
                    checked={status}
                    onCheckedChange={(v: boolean | "indeterminate") => setStatus(Boolean(v))}
                    disabled={saving}
                  />
                  <Badge variant={status ? "default" : "outline"}>{status ? "Active" : "Inactive"}</Badge>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <Label htmlFor="create-hide-branch-admin-price-visibility">Hide Branch Admin prices</Label>
                    <p className="text-xs text-muted-foreground">
                      Hide product and order prices from branch admin users.
                    </p>
                  </div>
                  <Switch
                    id="create-hide-branch-admin-price-visibility"
                    checked={hideBranchAdminPrices}
                    onCheckedChange={setHideBranchAdminPrices}
                    disabled={saving}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <Label htmlFor="create-hide-order-portal-price-visibility">Hide Order Portal prices</Label>
                    <p className="text-xs text-muted-foreground">
                      Hide product and order prices from order portal users.
                    </p>
                  </div>
                  <Switch
                    id="create-hide-order-portal-price-visibility"
                    checked={hideOrderPortalPrices}
                    onCheckedChange={setHideOrderPortalPrices}
                    disabled={saving}
                  />
                </div>
              </div>
              <PrivateNetworkLoginFields
                idPrefix="create"
                enabled={privateNetworkEnabled}
                entries={networkEntries}
                disabled={saving}
                onEnabledChange={setPrivateNetworkEnabled}
                onEntriesChange={setNetworkEntries}
              />
            </div>
          </div>
          <DialogFooter>
            <Button
              onClick={submit}
              className="gap-2 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100 disabled:shadow-none"
              disabled={!name || !code || saving || Boolean(networkError)}
            >
              <Save className="h-4 w-4" />
              Save Company
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <PremiumConfirmDialog
        open={confirmModeOpen}
        onOpenChange={setConfirmModeOpen}
        onConfirm={createCompany}
        title="Confirm Budget Model"
        description={`This company will use ${budgetAllocationMode === "quantity" ? "quantity-based" : "money-value"} budget allocation. ${ORDER_APPROVER_ROLE_LABELS[orderApproverRole]} will be the only role allowed to approve or reject orders. Super Admins can change this later from Edit Company.`}
        confirmText="Create Company"
        cancelText="Review"
        type="warning"
        isLoading={saving}
      />
    </>
  )
}

function CreateBranchDialog({
  organizations,
  open,
  onOpenChange,
  onCreated,
  showFeedback,
  variant,
  className,
}: Readonly<{
  organizations: Organization[]
  open: boolean
  onOpenChange: (v: boolean) => void
  onCreated: (item: Branch) => void
  showFeedback: (msg: string, type: AlertType) => void
  variant?: NonNullable<React.ComponentProps<typeof Button>["variant"]>
  className?: string
}>) {
  const [orgId, setOrgId] = useState<string | undefined>(undefined)
  const [name, setName] = useState("")
  const [province, setProvince] = useState("")
  const [city, setCity] = useState("")
  const [address, setAddress] = useState("")
  const [costCenterId, setCostCenterId] = useState("")
  const [status, setStatus] = useState<boolean>(true)
  const [saving, setSaving] = useState(false)
  const canSubmit = Boolean(
    orgId &&
    name.trim() &&
    province.trim() &&
    city.trim() &&
    address.trim()
  )
  async function submit() {
    if (!canSubmit || !orgId) return
    const payload = {
      organizationId: orgId,
      name: name.trim(),
      province: province.trim(),
      city: city.trim(),
      address: address.trim(),
      costCenterId: costCenterId.trim() || null,
      status: status ? "active" : "inactive",
    }
    console.log("[CreateBranchDialog] Submitting new branch:", payload)

    try {
      setSaving(true)
      const res = await fetch("/api/v1/branches", {
        method: "POST",
        body: JSON.stringify(payload),
        headers: { "Content-Type": "application/json" }
      })
      const data = await res.json()

      console.log("[CreateBranchDialog] API Response:", { ok: res.ok, status: res.status, data })

      if (!res.ok) throw new Error(data.error || "Failed to create branch")

      showFeedback("Branch created successfully.", "success")
      setName("")
      setProvince("")
      setCity("")
      setAddress("")
      setCostCenterId("")
      setStatus(true)
      setOrgId(undefined)

      console.log("[CreateBranchDialog] Calling onCreated to trigger refresh...")
      onCreated(data.item)
      console.log("[CreateBranchDialog] onCreated called")
    } catch (e: any) {
      console.error("[CreateBranchDialog] Error:", e.message)
      showFeedback(e.message, "error")
    } finally {
      setSaving(false)
    }
  }
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!saving) onOpenChange(nextOpen)
    }}>
      <DialogTrigger asChild>
        <Button className="gap-2 bg-emerald-600 text-white hover:bg-emerald-700 dark:bg-emerald-500 dark:text-slate-950 dark:hover:bg-emerald-400 border-none">
          <GitBranch className="h-4 w-4" />
          Create Branch
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Branch</DialogTitle>
          <p className="text-sm text-muted-foreground">
            Branches inherit organization settings and determine branch-admin visibility.
          </p>
        </DialogHeader>
        <div className="space-y-5">
          <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
            <div className="grid gap-3">
              <div className="space-y-2">
                <Label>Company</Label>
                <Select value={orgId} onValueChange={(v: string) => setOrgId(v)}>
                  <SelectTrigger disabled={saving}>
                    <SelectValue placeholder="Select company" />
                  </SelectTrigger>
                  <SelectContent>
                    {organizations
                      .map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>
                          {o.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-3">
                <div className="space-y-2">
                  <Label htmlFor="bname">Branch name</Label>
                  <Input
                    id="bname"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Downtown Branch"
                    disabled={saving}
                  />
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="branch-province">Province</Label>
                    <Input
                      id="branch-province"
                      value={province}
                      onChange={(e) => setProvince(e.target.value)}
                      placeholder="Punjab"
                      disabled={saving}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="branch-city">City</Label>
                    <Input
                      id="branch-city"
                      value={city}
                      onChange={(e) => setCity(e.target.value)}
                      placeholder="Lahore"
                      disabled={saving}
                    />
                  </div>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="branch-address">Address</Label>
                  <Textarea
                    id="branch-address"
                    value={address}
                    onChange={(e) => setAddress(e.target.value)}
                    placeholder="Street address, area, building, or landmark"
                    className="min-h-20 resize-none"
                    disabled={saving}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="branch-cost-center-id">Cost center ID</Label>
                  <Input
                    id="branch-cost-center-id"
                    value={costCenterId}
                    onChange={(e) => setCostCenterId(e.target.value)}
                    placeholder="Optional"
                    disabled={saving}
                    maxLength={128}
                  />
                </div>
                <p className="text-xs text-muted-foreground">Branch code will be automatically generated.</p>
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
              <div>
                <Label htmlFor="branch-status">Status</Label>
                <p className="text-xs text-muted-foreground">Deactivate to temporarily hide the branch.</p>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="branch-status"
                  checked={status}
                  onCheckedChange={(v: boolean | "indeterminate") => setStatus(Boolean(v))}
                  disabled={saving}
                />
                <Badge variant={status ? "default" : "outline"}>{status ? "Active" : "Inactive"}</Badge>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={!canSubmit || saving} className="gap-2">
            {saving ? <Loader className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Saving..." : "Save Branch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditOrgDialog({
  org,
  isSuperAdmin,
  onSave,
}: Readonly<{
  org: Organization
  isSuperAdmin: boolean
  onSave: (
    payload: Partial<Organization>,
    priceVisibility?: PriceVisibilitySettings,
    privateNetworkLogin?: ReturnType<typeof toPrivateNetworkLoginPayload>,
  ) => Promise<boolean>
}>) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(org.name)
  const [code, setCode] = useState(org.code)
  const [status, setStatus] = useState<boolean>(isActiveStatus(org.status))
  const [budgetAllocationMode, setBudgetAllocationMode] = useState<BudgetAllocationMode>(
    parseBudgetAllocationMode(org.budgetAllocationMode)
  )
  const [orderApproverRole, setOrderApproverRole] = useState<OrderApproverRole>(
    parseOrderApproverRole(org.orderApproverRole)
  )
  const [hideBranchAdminPrices, setHideBranchAdminPrices] = useState(false)
  const [hideOrderPortalPrices, setHideOrderPortalPrices] = useState(false)
  const [privateNetworkEnabled, setPrivateNetworkEnabled] = useState(false)
  const [networkEntries, setNetworkEntries] = useState<PrivateNetworkEntryDraft[]>([])
  const [loadingNetwork, setLoadingNetwork] = useState(false)
  const [networkLoadFailed, setNetworkLoadFailed] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [saving, setSaving] = useState(false)

  const networkError = networkLoadFailed
    ? null
    : privateNetworkDraftError(privateNetworkEnabled, networkEntries)

  useEffect(() => {
    setName(org.name)
    setCode(org.code)
    setStatus(isActiveStatus(org.status))
    setBudgetAllocationMode(parseBudgetAllocationMode(org.budgetAllocationMode))
    setOrderApproverRole(parseOrderApproverRole(org.orderApproverRole))
  }, [org.name, org.code, org.status, org.budgetAllocationMode, org.orderApproverRole])

  useEffect(() => {
    if (!open || !isSuperAdmin) return

    let cancelled = false
    setLoadingSettings(true)
    fetch(`/api/v1/settings?organizationId=${org.id}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return
        const settings = Array.isArray(data?.data) ? data.data : []
        const legacySetting = settings.find((item: any) => item.key === LEGACY_HIDE_PRICES_SETTING_KEY)
        const branchAdminSetting = settings.find((item: any) => item.key === HIDE_BRANCH_ADMIN_PRICES_SETTING_KEY)
        const orderPortalSetting = settings.find((item: any) => item.key === HIDE_ORDER_PORTAL_PRICES_SETTING_KEY)
        const budgetModeSetting = settings.find((item: any) => item.key === BUDGET_ALLOCATION_MODE_SETTING_KEY)
        const legacyValue = legacySetting?.value === true
        setHideBranchAdminPrices(branchAdminSetting ? branchAdminSetting.value === true : legacyValue)
        setHideOrderPortalPrices(orderPortalSetting ? orderPortalSetting.value === true : legacyValue)
        setBudgetAllocationMode(parseBudgetAllocationMode(budgetModeSetting?.value ?? org.budgetAllocationMode))
      })
      .catch(() => {
        if (!cancelled) {
          setHideBranchAdminPrices(false)
          setHideOrderPortalPrices(false)
          setBudgetAllocationMode(parseBudgetAllocationMode(org.budgetAllocationMode))
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSettings(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, isSuperAdmin, org.id])

  useEffect(() => {
    if (!open || !isSuperAdmin) return

    let cancelled = false
    setLoadingNetwork(true)
    setNetworkLoadFailed(false)
    fetch(`/api/v1/organizations/${org.id}/network-policy`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load private network login settings")
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        const loaded = Array.isArray(data?.entries) ? data.entries : []
        setPrivateNetworkEnabled(data?.enabled === true)
        setNetworkEntries(
          loaded.map((item: any) =>
            createNetworkEntryDraft(String(item?.value ?? ""), String(item?.label ?? "")),
          ),
        )
      })
      .catch(() => {
        // Never let a failed read become an empty draft that a later save would
        // write back — that would silently switch a tenant's restriction off.
        if (!cancelled) {
          setNetworkLoadFailed(true)
          setPrivateNetworkEnabled(false)
          setNetworkEntries([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingNetwork(false)
      })

    return () => {
      cancelled = true
    }
  }, [open, isSuperAdmin, org.id])

  return (
    <Dialog open={open} onOpenChange={(nextOpen) => {
      if (!saving) setOpen(nextOpen)
    }}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Edit"
          className="h-8 w-8 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 dark:hover:bg-slate-800"
        >
          <Pencil size={16} />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Company</DialogTitle>
          <p className="text-sm text-muted-foreground">Update company metadata. Changes sync immediately.</p>
        </DialogHeader>
        <div className="space-y-5">
          <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="ename">Company name</Label>
                <Input id="ename" value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="ecode">Code</Label>
                <Input id="ecode" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} disabled={saving} />
              </div>
            </div>
            <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
              <div>
                <Label htmlFor="org-status-edit">Status</Label>
                <p className="text-xs text-muted-foreground">Inactive orgs keep their data but hide from selectors.</p>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="org-status-edit"
                  checked={status}
                  onCheckedChange={(v: boolean | "indeterminate") => setStatus(Boolean(v))}
                  disabled={saving}
                />
                <Badge variant={status ? "default" : "outline"}>{status ? "Active" : "Inactive"}</Badge>
              </div>
            </div>
            {isSuperAdmin && (
              <div className="space-y-3">
                <div className="space-y-2 rounded-md border bg-background px-3 py-2">
                  <Label>Order approver</Label>
                  <p className="text-xs text-muted-foreground">
                    This role alone can approve or reject pending orders.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setOrderApproverRole("BRANCH_ADMIN")}
                      disabled={loadingSettings || saving}
                      className={cn(
                        "rounded-md border bg-background p-3 text-left transition-colors",
                        orderApproverRole === "BRANCH_ADMIN" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50",
                      )}
                    >
                      <span className="text-sm font-semibold">Branch Admin</span>
                      <span className="mt-1 block text-xs text-muted-foreground">Limited to the admin's own branch.</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setOrderApproverRole("HEAD_OFFICE")}
                      disabled={loadingSettings || saving}
                      className={cn(
                        "rounded-md border bg-background p-3 text-left transition-colors",
                        orderApproverRole === "HEAD_OFFICE" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50",
                      )}
                    >
                      <span className="text-sm font-semibold">Head Office</span>
                      <span className="mt-1 block text-xs text-muted-foreground">Covers every branch in this company.</span>
                    </button>
                  </div>
                </div>
                <div className="space-y-2 rounded-md border bg-background px-3 py-2">
                  <Label>Budget allocation model</Label>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setBudgetAllocationMode("money")}
                      disabled={loadingSettings || saving}
                      className={cn(
                        "rounded-md border bg-background p-3 text-left transition-colors",
                        budgetAllocationMode === "money" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50"
                      )}
                    >
                      <span className="text-sm font-semibold">Money value</span>
                      <span className="mt-1 block text-xs text-muted-foreground">Allocate budgets directly in PKR.</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setBudgetAllocationMode("quantity")}
                      disabled={loadingSettings || saving}
                      className={cn(
                        "rounded-md border bg-background p-3 text-left transition-colors",
                        budgetAllocationMode === "quantity" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50"
                      )}
                    >
                      <span className="text-sm font-semibold">Quantity</span>
                      <span className="mt-1 block text-xs text-muted-foreground">Allocate product quantities that calculate budget value.</span>
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    New orders follow the selected model immediately. Existing orders and reports remain unchanged.
                  </p>
                </div>
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <Label htmlFor="hide-branch-admin-price-visibility">Hide Branch Admin prices</Label>
                    <p className="text-xs text-muted-foreground">
                      Hide product and order prices from branch admin users.
                    </p>
                  </div>
                  <Switch
                    id="hide-branch-admin-price-visibility"
                    checked={hideBranchAdminPrices}
                    onCheckedChange={setHideBranchAdminPrices}
                    disabled={loadingSettings || saving}
                  />
                </div>
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <Label htmlFor="hide-order-portal-price-visibility">Hide Order Portal prices</Label>
                    <p className="text-xs text-muted-foreground">
                      Hide product and order prices from order portal users.
                    </p>
                  </div>
                  <Switch
                    id="hide-order-portal-price-visibility"
                    checked={hideOrderPortalPrices}
                    onCheckedChange={setHideOrderPortalPrices}
                    disabled={loadingSettings || saving}
                  />
                </div>
                {networkLoadFailed ? (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700 dark:bg-amber-950/40">
                    <p className="text-xs font-medium text-amber-900 dark:text-amber-100">
                      Private network login settings could not be loaded. They are left
                      unchanged when you save. Close and reopen this dialog to retry.
                    </p>
                  </div>
                ) : (
                  <PrivateNetworkLoginFields
                    idPrefix={`edit-${org.id}`}
                    enabled={privateNetworkEnabled}
                    entries={networkEntries}
                    disabled={loadingNetwork || saving}
                    onEnabledChange={setPrivateNetworkEnabled}
                    onEntriesChange={setNetworkEntries}
                  />
                )}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button
            className="gap-2"
            disabled={
              saving ||
              loadingSettings ||
              loadingNetwork ||
              !name.trim() ||
              !code.trim() ||
              Boolean(networkError)
            }
            onClick={async () => {
              setSaving(true)
              try {
                const saved = await onSave(
                  {
                    name,
                    code,
                    status: status ? "active" : "inactive",
                    ...(isSuperAdmin ? { budgetAllocationMode, orderApproverRole } : {}),
                  },
                  isSuperAdmin
                    ? {
                      hideBranchAdminPrices,
                      hideOrderPortalPrices,
                    }
                    : undefined,
                  isSuperAdmin && !networkLoadFailed
                    ? toPrivateNetworkLoginPayload(privateNetworkEnabled, networkEntries)
                    : undefined
                )
                if (saved) setOpen(false)
              } finally {
                setSaving(false)
              }
            }}
          >
            {saving ? <Loader className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function EditBranchDialog({ branch, onSave }: Readonly<{ branch: Branch; onSave: (payload: Partial<Branch>) => void }>) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(branch.name)
  const [code, setCode] = useState(branch.code)
  const [province, setProvince] = useState(branch.province ?? "")
  const [city, setCity] = useState(branch.city ?? "")
  const [address, setAddress] = useState(branch.address ?? "")
  const [costCenterId, setCostCenterId] = useState(branch.costCenterId ?? "")
  const [status, setStatus] = useState<boolean>(isActiveStatus(branch.status))

  useEffect(() => {
    setName(branch.name)
    setCode(branch.code)
    setProvince(branch.province ?? "")
    setCity(branch.city ?? "")
    setAddress(branch.address ?? "")
    setCostCenterId(branch.costCenterId ?? "")
    setStatus(isActiveStatus(branch.status))
  }, [branch.name, branch.code, branch.province, branch.city, branch.address, branch.costCenterId, branch.status])
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="Edit branch">
          <Pencil size={16} />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit Branch</DialogTitle>
          <p className="text-sm text-muted-foreground">Keep branch naming clean for orders and budgets.</p>
        </DialogHeader>
        <div className="space-y-5">
          <div className="rounded-lg border bg-muted/20 p-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="bname-edit">Branch name</Label>
                <Input id="bname-edit" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="bcode-edit">Code</Label>
                <Input id="bcode-edit" value={code} disabled className="bg-muted cursor-not-allowed" />
                <p className="text-xs text-muted-foreground italic">Branch codes are non-editable.</p>
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="branch-province-edit">Province</Label>
                <Input
                  id="branch-province-edit"
                  value={province}
                  onChange={(e) => setProvince(e.target.value)}
                  placeholder="Punjab"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="branch-city-edit">City</Label>
                <Input
                  id="branch-city-edit"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Lahore"
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="branch-address-edit">Address</Label>
              <Textarea
                id="branch-address-edit"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="Street address, area, building, or landmark"
                className="min-h-20 resize-none"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="branch-cost-center-id-edit">Cost center ID</Label>
              <Input
                id="branch-cost-center-id-edit"
                value={costCenterId}
                onChange={(e) => setCostCenterId(e.target.value)}
                placeholder="Optional"
                maxLength={128}
              />
            </div>
            <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
              <div>
                <Label htmlFor="branch-status-edit">Status</Label>
                <p className="text-xs text-muted-foreground">Inactive branches stay archived for reference.</p>
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="branch-status-edit"
                  checked={status}
                  onCheckedChange={(v: boolean | "indeterminate") => setStatus(Boolean(v))}
                />
                <Badge variant={status ? "default" : "outline"}>{status ? "Active" : "Inactive"}</Badge>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            className="gap-2"
            onClick={() => {
              onSave({
                name: name.trim(),
                province: province.trim() || null,
                city: city.trim() || null,
                address: address.trim() || null,
                costCenterId: costCenterId.trim() || null,
                status: status ? "active" : "inactive",
              })
              setOpen(false)
            }}
            disabled={!name.trim()}
          >
            <Save className="h-4 w-4" />
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
