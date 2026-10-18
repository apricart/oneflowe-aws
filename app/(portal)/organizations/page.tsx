"use client"
import { BranchHeadCountField, headCountFieldValue } from "@/components/branches/branch-head-count-field"
import { BranchRegionSelect } from "@/components/branches/branch-region-select"
import { parseHeadCountInput } from "@/lib/branch-head-count"
import type { BranchRegion } from "@/lib/branch-region"
import { useAppContext } from "@/components/context/app-context"
import { BranchExcelExportButton } from "@/components/organizations/branch-excel-export-button"
import { BranchListExcelExportButton } from "@/components/organizations/branch-list-excel-export-button"
import {
EmailDomainField,
emailDomainDraftError,
toEmailDomainPayload,
} from "@/components/organizations/email-domain-field"
import { OrderApprovalLevelsFields } from "@/components/organizations/order-approval-levels-fields"
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
import { DEFAULT_ORGANIZATION_BUDGETS_ENABLED } from "@/lib/organization-budget-policy"
import { formatCountLabel } from "@/lib/count-label"
import {
  DEFAULT_ORDERING_BLOCK_THRESHOLD,
  ORDERING_BLOCK_THRESHOLD_MAX,
  ORDERING_BLOCK_THRESHOLD_MIN,
  orderingBlockThresholdOrDefault,
  parseOrderingBlockThresholdDraft,
  type OrderingBlockThresholdDraft,
} from "@/lib/ordering-block-threshold"
import { useBranches,useOrganizations } from "@/lib/hooks/use-api"
import {
  approvalLevelAmountText,
  approvalLevelDraftsError,
  toApprovalLevelsPayload,
  type ApprovalLevelsPayload,
} from "@/lib/order-approval-levels"
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
  ntnNumber?: string | null
  strnNumber?: string | null
  emailDomain?: string | null
  status?: "active" | "inactive"
  budgetAllocationMode?: BudgetAllocationMode
  orderApproverRole?: OrderApproverRole
  orderApprovalRequired?: boolean
  blockOrderingOnUnpaidInvoices?: boolean
  blockOrderingOnUnacknowledgedDeliveries?: boolean
  unpaidInvoiceBlockThreshold?: number
  unacknowledgedDeliveryBlockThreshold?: number
  budgetsEnabled?: boolean
  managedOrdering?: boolean
}

/** The Create confirmation's sentence about approval levels, or nothing while they are off. */
function approvalLevelsSummary(enabled: boolean, count: number): string {
  if (!enabled) return ""
  return ` It will have ${formatCountLabel(count, "order approval level")}.`
}

// Each hint prints the limit being typed, so it always says what will be saved.
// `null` is a limit that does not parse yet.
function unpaidInvoiceBlockHint(threshold: number | null): string {
  return threshold === null
    ? "A branch that reaches the limit below in unpaid invoices (delivered and not marked paid) cannot place new orders until they are paid."
    : `A branch with ${threshold} or more unpaid invoices (delivered and not marked paid) cannot place new orders until they are paid.`
}

const MANAGED_ORDERING_HINT =
  "Apricart's Order Desk may enter this company's orders (received by email or WhatsApp) for the desk users granted it in Order Desk Team. Desk orders are Active immediately."

function unacknowledgedDeliveryBlockHint(threshold: number | null): string {
  return threshold === null
    ? "A branch that reaches the limit below in orders that are delivered but not yet acknowledged (still approved) cannot place new orders until they are acknowledged."
    : `A branch with ${threshold} or more orders that are delivered but not yet acknowledged (still approved) cannot place new orders until they are acknowledged.`
}

const UNPAID_INVOICE_THRESHOLD_LABEL = "Unpaid invoices that stop ordering"
const UNACKNOWLEDGED_DELIVERY_THRESHOLD_LABEL = "Unacknowledged deliveries that stop ordering"

/** A stored limit as the field's starting text; anything unusable reads as the default. */
function thresholdDraftText(value: number | undefined): string {
  return String(orderingBlockThresholdOrDefault(value))
}

const thresholdValue = (draft: OrderingBlockThresholdDraft): number | null => (draft.ok ? draft.value : null)

/**
 * The two limits as the request sends them: a limit that does not parse is left
 * out (the server keeps what it has, or the default on create). Save is only
 * refused for one while its block is on — see `orderingBlockThresholdsInvalid`.
 */
function orderingBlockThresholdPayload(
  unpaid: OrderingBlockThresholdDraft,
  unacknowledged: OrderingBlockThresholdDraft,
): { unpaidInvoiceBlockThreshold?: number; unacknowledgedDeliveryBlockThreshold?: number } {
  return {
    ...(unpaid.ok ? { unpaidInvoiceBlockThreshold: unpaid.value } : {}),
    ...(unacknowledged.ok ? { unacknowledgedDeliveryBlockThreshold: unacknowledged.value } : {}),
  }
}

function orderingBlockThresholdsInvalid(
  blocks: ReadonlyArray<{ enabled: boolean; draft: OrderingBlockThresholdDraft }>,
): boolean {
  return blocks.some((block) => block.enabled && !block.draft.ok)
}

type OrderingBlockThresholdField = {
  label: string
  text: string
  draft: OrderingBlockThresholdDraft
  onTextChange: (text: string) => void
}

/**
 * Super Admin only. Switching one on can stop a branch ordering at once, so
 * each hint says exactly what is counted. A block with a limit shows the limit
 * while it is on; the server re-validates it (whole numbers, 1 to 100).
 */
function OrderingBlockSwitch({
  id,
  label,
  hint,
  checked,
  onCheckedChange,
  disabled,
  threshold,
}: Readonly<{
  id: string
  label: string
  hint: string
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  disabled: boolean
  threshold?: OrderingBlockThresholdField
}>) {
  const thresholdId = `${id}-threshold`
  const thresholdErrorId = `${thresholdId}-error`
  const thresholdError = threshold && !threshold.draft.ok ? threshold.draft.message : null
  return (
    <div className="rounded-md border bg-background px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="pr-4">
          <Label htmlFor={id}>{label}</Label>
          <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
        <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} disabled={disabled} />
      </div>
      {threshold && checked ? (
        <div className="mt-2 border-t pt-2">
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor={thresholdId} className="text-xs font-normal">{threshold.label}</Label>
            <Input
              id={thresholdId}
              type="number"
              inputMode="numeric"
              min={ORDERING_BLOCK_THRESHOLD_MIN}
              max={ORDERING_BLOCK_THRESHOLD_MAX}
              step={1}
              value={threshold.text}
              onChange={(event) => threshold.onTextChange(event.target.value)}
              disabled={disabled}
              aria-invalid={thresholdError ? true : undefined}
              aria-describedby={thresholdError ? thresholdErrorId : undefined}
              className="h-8 w-24"
            />
          </div>
          {thresholdError ? (
            <p id={thresholdErrorId} role="alert" className="mt-1 text-xs text-destructive">{thresholdError}</p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

const BUDGET_ALLOCATION_HINT =
  "When off, orders are placed without a budget: nothing is checked, held or reported against one. When on, a branch needs an allocated budget before it can order."

const EDIT_BUDGET_ALLOCATION_ON_NOTE =
  "New orders follow the selected model immediately. Existing orders and reports remain unchanged."
const EDIT_BUDGET_ALLOCATION_OFF_NOTE =
  "New orders take no budget. Orders already holding budget keep it until they are decided, and allocations are kept for if budgets are switched back on."

/**
 * The budget allocation switch and, while it is on, the model it runs on.
 * Super Admin only; the server refuses the field from anyone else. The model
 * is hidden rather than disabled while off, because it has no effect then.
 */
function BudgetAllocationFields({
  idPrefix,
  enabled,
  onEnabledChange,
  mode,
  onModeChange,
  disabled,
  note,
}: Readonly<{
  idPrefix: string
  enabled: boolean
  onEnabledChange: (enabled: boolean) => void
  mode: BudgetAllocationMode
  onModeChange: (mode: BudgetAllocationMode) => void
  disabled: boolean
  note?: string
}>) {
  const modeOption = (value: BudgetAllocationMode, label: string, description: string) => (
    <button
      type="button"
      onClick={() => onModeChange(value)}
      disabled={disabled}
      aria-pressed={mode === value}
      className={cn(
        "rounded-md border bg-background p-3 text-left transition-colors",
        mode === value ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50"
      )}
    >
      <span className="text-sm font-semibold">{label}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{description}</span>
    </button>
  )

  return (
    <div className="space-y-3 rounded-md border bg-background px-3 py-2">
      <div className="flex items-center justify-between">
        <div className="pr-4">
          <Label htmlFor={`${idPrefix}-budgets-enabled`}>Budget allocation</Label>
          <p className="text-xs text-muted-foreground">{BUDGET_ALLOCATION_HINT}</p>
        </div>
        <Switch
          id={`${idPrefix}-budgets-enabled`}
          checked={enabled}
          onCheckedChange={onEnabledChange}
          disabled={disabled}
        />
      </div>
      {enabled && (
        <div className="space-y-2">
          <Label>Budget allocation model</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {modeOption("money", "Money value", "Allocate budgets directly in PKR.")}
            {modeOption("quantity", "Quantity", "Allocate product quantities that calculate budget value.")}
          </div>
        </div>
      )}
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  )
}

const CREATE_EMAIL_DOMAIN_HINT =
  "People joining through the join page must use an address at this domain. Leave blank and nobody can join this way."
const EDIT_EMAIL_DOMAIN_HINT =
  "People joining through the join page must use an address at this domain. Clear it to stop anyone joining this way."
type Branch = {
  id: number
  name: string
  code: string | null
  organizationId: number
  province?: string | null
  city?: string | null
  region?: BranchRegion | null
  address?: string | null
  costCenterId?: string | null
  headCount?: number | null
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
    orderApprovalLevels?: ApprovalLevelsPayload,
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

      if (orderApprovalLevels) {
        const levelsRes = await fetch(`/api/v1/organizations/${id}/approval-levels`, {
          method: "PUT",
          body: JSON.stringify(orderApprovalLevels),
          headers: { "Content-Type": "application/json" },
        })
        const levelsData = await levelsRes.json()
        if (!levelsRes.ok) {
          throw new Error(levelsData.error || "Failed to update approval levels")
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
        (b.code || "").toLowerCase().includes(q) ||
        (b.costCenterId || "").toLowerCase().includes(q)
      )
    }
    return result
  }, [visibleBranches, branchStatusFilter, branchSearch])

  const orgCount = orgs?.items?.length ?? 0
  const branchCount = branches?.items?.length ?? 0

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
                        budgetsEnabled={org.budgetsEnabled !== false}
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
  budgetsEnabled = true,
}: Readonly<{
  title: string
  subtitle: string
  onClick: () => void
  isActive: boolean
  children?: ReactNode
  status?: boolean
  badgeLabel?: string
  budgetAllocationMode?: BudgetAllocationMode
  budgetsEnabled?: boolean
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
                  !budgetsEnabled && "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-800/50 dark:text-slate-400",
                  budgetsEnabled && normalizedBudgetAllocationMode === "quantity"
                    ? "border-indigo-200/70 bg-indigo-50/70 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300"
                    : "border-sky-200/70 bg-sky-50/70 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300"
                )}
              >
                {budgetsEnabled ? BUDGET_ALLOCATION_MODE_LABELS[normalizedBudgetAllocationMode] : "Budget off"}
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
  const [ntnNumber, setNtnNumber] = useState("")
  const [strnNumber, setStrnNumber] = useState("")
  const [emailDomain, setEmailDomain] = useState("")
  const [status, setStatus] = useState<boolean>(true)
  const [budgetAllocationMode, setBudgetAllocationMode] = useState<BudgetAllocationMode>("money")
  // Off by default: a new company orders without budgets until a Super Admin
  // switches allocation on (DEFAULT_ORGANIZATION_BUDGETS_ENABLED).
  const [budgetsEnabled, setBudgetsEnabled] = useState(DEFAULT_ORGANIZATION_BUDGETS_ENABLED)
  const [orderApproverRole, setOrderApproverRole] = useState<OrderApproverRole>(DEFAULT_ORDER_APPROVER_ROLE)
  const [orderApprovalRequired, setOrderApprovalRequired] = useState(true)
  const [blockOrderingOnUnpaidInvoices, setBlockOrderingOnUnpaidInvoices] = useState(false)
  const [blockOrderingOnUnacknowledgedDeliveries, setBlockOrderingOnUnacknowledgedDeliveries] = useState(false)
  const [unpaidInvoiceBlockThresholdText, setUnpaidInvoiceBlockThresholdText] = useState(String(DEFAULT_ORDERING_BLOCK_THRESHOLD))
  const [unacknowledgedDeliveryBlockThresholdText, setUnacknowledgedDeliveryBlockThresholdText] = useState(String(DEFAULT_ORDERING_BLOCK_THRESHOLD))
  // Off by default: no company is reachable by the Order Desk until asked.
  const [managedOrdering, setManagedOrdering] = useState(false)
  const [hideBranchAdminPrices, setHideBranchAdminPrices] = useState(false)
  const [hideOrderPortalPrices, setHideOrderPortalPrices] = useState(false)
  const [privateNetworkEnabled, setPrivateNetworkEnabled] = useState(false)
  const [networkEntries, setNetworkEntries] = useState<PrivateNetworkEntryDraft[]>([])
  // Off by default: a new company's orders carry no approval levels until a
  // Super Admin switches them on (plans/OF-APPROVAL-LEVELS-organization-approval-levels.md).
  const [approvalLevelsEnabled, setApprovalLevelsEnabled] = useState(false)
  const [approvalLevelDrafts, setApprovalLevelDrafts] = useState<string[]>([])
  const [confirmModeOpen, setConfirmModeOpen] = useState(false)
  const [saving, setSaving] = useState(false)

  const approvalLevelsError = approvalLevelDraftsError(approvalLevelsEnabled, approvalLevelDrafts)
  const networkError = privateNetworkDraftError(privateNetworkEnabled, networkEntries)
  const emailDomainError = emailDomainDraftError(emailDomain)
  const unpaidInvoiceBlockThreshold = parseOrderingBlockThresholdDraft(unpaidInvoiceBlockThresholdText)
  const unacknowledgedDeliveryBlockThreshold = parseOrderingBlockThresholdDraft(unacknowledgedDeliveryBlockThresholdText)
  const thresholdsInvalid = orderingBlockThresholdsInvalid([
    { enabled: blockOrderingOnUnpaidInvoices, draft: unpaidInvoiceBlockThreshold },
    { enabled: blockOrderingOnUnacknowledgedDeliveries, draft: unacknowledgedDeliveryBlockThreshold },
  ])

  async function createCompany() {
    setSaving(true)
    const emailDomainPayload = toEmailDomainPayload(emailDomain)
    try {
      const res = await fetch("/api/v1/organizations", {
        method: "POST",
        body: JSON.stringify({
          name,
          code,
          // Optional: only sent when filled in, so a blank field stays absent.
          ...(ntnNumber.trim() ? { ntnNumber: ntnNumber.trim() } : {}),
          ...(strnNumber.trim() ? { strnNumber: strnNumber.trim() } : {}),
          ...(emailDomainPayload ? { emailDomain: emailDomainPayload } : {}),
          status: status ? "active" : "inactive",
          budgetsEnabled,
          budgetAllocationMode,
          orderApproverRole,
          orderApprovalRequired,
          blockOrderingOnUnpaidInvoices,
          blockOrderingOnUnacknowledgedDeliveries,
          ...orderingBlockThresholdPayload(unpaidInvoiceBlockThreshold, unacknowledgedDeliveryBlockThreshold),
          managedOrdering,
          priceVisibility: {
            hideBranchAdminPrices,
            hideOrderPortalPrices,
          },
          privateNetworkLogin: toPrivateNetworkLoginPayload(
            privateNetworkEnabled,
            networkEntries,
          ),
          orderApprovalLevels: toApprovalLevelsPayload(approvalLevelsEnabled, approvalLevelDrafts),
        }),
        headers: { "Content-Type": "application/json" }
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Failed to create company")

      showFeedback("Company created successfully.", "success")
      setName("")
      setCode("")
      setNtnNumber("")
      setStrnNumber("")
      setEmailDomain("")
      setStatus(true)
      setBudgetAllocationMode("money")
      setBudgetsEnabled(DEFAULT_ORGANIZATION_BUDGETS_ENABLED)
      setOrderApproverRole(DEFAULT_ORDER_APPROVER_ROLE)
      setOrderApprovalRequired(true)
      setBlockOrderingOnUnpaidInvoices(false)
      setBlockOrderingOnUnacknowledgedDeliveries(false)
      setUnpaidInvoiceBlockThresholdText(String(DEFAULT_ORDERING_BLOCK_THRESHOLD))
      setUnacknowledgedDeliveryBlockThresholdText(String(DEFAULT_ORDERING_BLOCK_THRESHOLD))
      setHideBranchAdminPrices(false)
      setHideOrderPortalPrices(false)
      setPrivateNetworkEnabled(false)
      setNetworkEntries([])
      setApprovalLevelsEnabled(false)
      setApprovalLevelDrafts([])
      setConfirmModeOpen(false)
      onCreated(data.item)
    } catch (e: any) {
      showFeedback(e.message, "error")
    } finally {
      setSaving(false)
    }
  }

  function submit() {
    if (!name || !code || saving || networkError || emailDomainError || thresholdsInvalid || approvalLevelsError) return
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
                <Label htmlFor="ntn-number">NTN number (optional)</Label>
                <Input
                  id="ntn-number"
                  value={ntnNumber}
                  onChange={(e) => setNtnNumber(e.target.value)}
                  placeholder="1234567-8"
                  disabled={saving}
                />
                <p className="text-xs text-muted-foreground">Tax registration number. Leave blank if not applicable.</p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="strn-number">STRN number (optional)</Label>
                <Input
                  id="strn-number"
                  value={strnNumber}
                  onChange={(e) => setStrnNumber(e.target.value)}
                  placeholder="3277876123456"
                  disabled={saving}
                />
                <p className="text-xs text-muted-foreground">Sales tax registration number, printed on invoices beside the NTN.</p>
              </div>
              <EmailDomainField
                id="email-domain"
                value={emailDomain}
                onChange={setEmailDomain}
                disabled={saving}
                hint={CREATE_EMAIL_DOMAIN_HINT}
              />
              <BudgetAllocationFields
                idPrefix="create"
                enabled={budgetsEnabled}
                onEnabledChange={setBudgetsEnabled}
                mode={budgetAllocationMode}
                onModeChange={setBudgetAllocationMode}
                disabled={saving}
              />
              <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                <div className="pr-4">
                  <Label htmlFor="create-order-approval-required">Require order approval</Label>
                  <p className="text-xs text-muted-foreground">
                    Turn this off to approve new Order Initiator and Group Order Initiator orders immediately.
                  </p>
                </div>
                <Switch
                  id="create-order-approval-required"
                  checked={orderApprovalRequired}
                  onCheckedChange={setOrderApprovalRequired}
                  disabled={saving}
                />
              </div>
              <div className={cn("space-y-2", !orderApprovalRequired && "opacity-60")}>
                <Label>Order approver</Label>
                <p className="text-xs text-muted-foreground">
                  {orderApprovalRequired
                    ? "Exactly one role can approve or reject pending orders for this company."
                    : "Saved for use if approval is required again later."}
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  <button
                    type="button"
                    onClick={() => setOrderApproverRole("BRANCH_ADMIN")}
                    disabled={saving || !orderApprovalRequired}
                    className={cn(
                      "rounded-md border bg-background p-3 text-left transition-colors",
                      orderApproverRole === "BRANCH_ADMIN" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50",
                    )}
                  >
                    <span className="text-sm font-semibold">Financial Approver</span>
                    <span className="mt-1 block text-xs text-muted-foreground">Each Financial Approver decides orders for their own branch.</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderApproverRole("HEAD_OFFICE")}
                    disabled={saving || !orderApprovalRequired}
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
              <OrderApprovalLevelsFields
                idPrefix="create"
                enabled={approvalLevelsEnabled}
                levels={approvalLevelDrafts}
                disabled={saving}
                onEnabledChange={setApprovalLevelsEnabled}
                onLevelsChange={setApprovalLevelDrafts}
              />
              <OrderingBlockSwitch
                id="create-block-ordering-on-unpaid-invoices"
                label="Block ordering on unpaid invoices"
                hint={unpaidInvoiceBlockHint(thresholdValue(unpaidInvoiceBlockThreshold))}
                checked={blockOrderingOnUnpaidInvoices}
                onCheckedChange={setBlockOrderingOnUnpaidInvoices}
                disabled={saving}
                threshold={{
                  label: UNPAID_INVOICE_THRESHOLD_LABEL,
                  text: unpaidInvoiceBlockThresholdText,
                  draft: unpaidInvoiceBlockThreshold,
                  onTextChange: setUnpaidInvoiceBlockThresholdText,
                }}
              />
              <OrderingBlockSwitch
                id="create-block-ordering-on-unacknowledged-deliveries"
                label="Block ordering on unacknowledged deliveries"
                hint={unacknowledgedDeliveryBlockHint(thresholdValue(unacknowledgedDeliveryBlockThreshold))}
                checked={blockOrderingOnUnacknowledgedDeliveries}
                onCheckedChange={setBlockOrderingOnUnacknowledgedDeliveries}
                disabled={saving}
                threshold={{
                  label: UNACKNOWLEDGED_DELIVERY_THRESHOLD_LABEL,
                  text: unacknowledgedDeliveryBlockThresholdText,
                  draft: unacknowledgedDeliveryBlockThreshold,
                  onTextChange: setUnacknowledgedDeliveryBlockThresholdText,
                }}
              />
              <OrderingBlockSwitch
                id="create-managed-ordering"
                label="Managed by Apricart Order Desk"
                hint={MANAGED_ORDERING_HINT}
                checked={managedOrdering}
                onCheckedChange={setManagedOrdering}
                disabled={saving}
              />
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
                    <Label htmlFor="create-hide-branch-admin-price-visibility">Hide Financial Approver prices</Label>
                    <p className="text-xs text-muted-foreground">
                      Hide product and order prices from financial approver users.
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
                    <Label htmlFor="create-hide-order-portal-price-visibility">Hide Order Initiator prices</Label>
                    <p className="text-xs text-muted-foreground">
                      Hide product and order prices from order initiator users.
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
              disabled={!name || !code || saving || Boolean(networkError) || Boolean(emailDomainError) || thresholdsInvalid || Boolean(approvalLevelsError)}
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
        description={`${budgetsEnabled ? `This company will use ${budgetAllocationMode === "quantity" ? "quantity-based" : "money-value"} budget allocation.` : "This company will order without budget allocation."} ${orderApprovalRequired ? `${ORDER_APPROVER_ROLE_LABELS[orderApproverRole]} will approve or reject new orders.` : "New orders will be approved immediately when they are created."}${approvalLevelsSummary(approvalLevelsEnabled, approvalLevelDrafts.length)} Super Admins can change this later from Edit Company.`}
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
  const [region, setRegion] = useState<BranchRegion | null>(null)
  const [address, setAddress] = useState("")
  const [costCenterId, setCostCenterId] = useState("")
  const [headCountText, setHeadCountText] = useState("")
  const [status, setStatus] = useState<boolean>(true)
  const [saving, setSaving] = useState(false)
  const headCount = parseHeadCountInput(headCountText)
  const canSubmit = Boolean(
    headCount !== undefined &&
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
      region,
      address: address.trim(),
      costCenterId: costCenterId.trim() || null,
      headCount: headCount ?? null,
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
      setHeadCountText("")
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
                <BranchRegionSelect id="branch-region" value={region} onChange={setRegion} disabled={saving} />
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
                <BranchHeadCountField
                  id="branch-head-count"
                  value={headCountText}
                  onChange={setHeadCountText}
                  disabled={saving}
                />
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
    orderApprovalLevels?: ApprovalLevelsPayload,
  ) => Promise<boolean>
}>) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(org.name)
  const [code, setCode] = useState(org.code)
  const [ntnNumber, setNtnNumber] = useState(org.ntnNumber ?? "")
  const [strnNumber, setStrnNumber] = useState(org.strnNumber ?? "")
  const [emailDomain, setEmailDomain] = useState(org.emailDomain ?? "")
  const [status, setStatus] = useState<boolean>(isActiveStatus(org.status))
  const [budgetAllocationMode, setBudgetAllocationMode] = useState<BudgetAllocationMode>(
    parseBudgetAllocationMode(org.budgetAllocationMode)
  )
  const [orderApproverRole, setOrderApproverRole] = useState<OrderApproverRole>(
    parseOrderApproverRole(org.orderApproverRole)
  )
  const [orderApprovalRequired, setOrderApprovalRequired] = useState(
    org.orderApprovalRequired !== false,
  )
  const [blockOrderingOnUnpaidInvoices, setBlockOrderingOnUnpaidInvoices] = useState(
    org.blockOrderingOnUnpaidInvoices === true,
  )
  const [blockOrderingOnUnacknowledgedDeliveries, setBlockOrderingOnUnacknowledgedDeliveries] = useState(
    org.blockOrderingOnUnacknowledgedDeliveries === true,
  )
  const [unpaidInvoiceBlockThresholdText, setUnpaidInvoiceBlockThresholdText] = useState(
    thresholdDraftText(org.unpaidInvoiceBlockThreshold),
  )
  const [unacknowledgedDeliveryBlockThresholdText, setUnacknowledgedDeliveryBlockThresholdText] = useState(
    thresholdDraftText(org.unacknowledgedDeliveryBlockThreshold),
  )
  const [managedOrdering, setManagedOrdering] = useState(org.managedOrdering === true)
  // Anything but an explicit false reads as on, matching the server's
  // fail-safe: a tenant is never shown as unbudgeted when it is not.
  const [budgetsEnabled, setBudgetsEnabled] = useState(org.budgetsEnabled !== false)
  const [hideBranchAdminPrices, setHideBranchAdminPrices] = useState(false)
  const [hideOrderPortalPrices, setHideOrderPortalPrices] = useState(false)
  const [privateNetworkEnabled, setPrivateNetworkEnabled] = useState(false)
  const [networkEntries, setNetworkEntries] = useState<PrivateNetworkEntryDraft[]>([])
  const [loadingNetwork, setLoadingNetwork] = useState(false)
  const [networkLoadFailed, setNetworkLoadFailed] = useState(false)
  const [approvalLevelsEnabled, setApprovalLevelsEnabled] = useState(false)
  const [approvalLevelDrafts, setApprovalLevelDrafts] = useState<string[]>([])
  const [loadingApprovalLevels, setLoadingApprovalLevels] = useState(false)
  const [approvalLevelsLoadFailed, setApprovalLevelsLoadFailed] = useState(false)
  const [loadingSettings, setLoadingSettings] = useState(false)
  const [saving, setSaving] = useState(false)

  const networkError = networkLoadFailed
    ? null
    : privateNetworkDraftError(privateNetworkEnabled, networkEntries)
  const approvalLevelsError = approvalLevelsLoadFailed
    ? null
    : approvalLevelDraftsError(approvalLevelsEnabled, approvalLevelDrafts)
  const emailDomainError = emailDomainDraftError(emailDomain)
  const unpaidInvoiceBlockThreshold = parseOrderingBlockThresholdDraft(unpaidInvoiceBlockThresholdText)
  const unacknowledgedDeliveryBlockThreshold = parseOrderingBlockThresholdDraft(unacknowledgedDeliveryBlockThresholdText)
  const thresholdsInvalid = isSuperAdmin && orderingBlockThresholdsInvalid([
    { enabled: blockOrderingOnUnpaidInvoices, draft: unpaidInvoiceBlockThreshold },
    { enabled: blockOrderingOnUnacknowledgedDeliveries, draft: unacknowledgedDeliveryBlockThreshold },
  ])

  useEffect(() => {
    setName(org.name)
    setCode(org.code)
    setNtnNumber(org.ntnNumber ?? "")
    setStrnNumber(org.strnNumber ?? "")
    setEmailDomain(org.emailDomain ?? "")
    setStatus(isActiveStatus(org.status))
    setBudgetAllocationMode(parseBudgetAllocationMode(org.budgetAllocationMode))
    setOrderApproverRole(parseOrderApproverRole(org.orderApproverRole))
    setOrderApprovalRequired(org.orderApprovalRequired !== false)
    setBlockOrderingOnUnpaidInvoices(org.blockOrderingOnUnpaidInvoices === true)
    setBlockOrderingOnUnacknowledgedDeliveries(org.blockOrderingOnUnacknowledgedDeliveries === true)
    setUnpaidInvoiceBlockThresholdText(thresholdDraftText(org.unpaidInvoiceBlockThreshold))
    setUnacknowledgedDeliveryBlockThresholdText(thresholdDraftText(org.unacknowledgedDeliveryBlockThreshold))
    setManagedOrdering(org.managedOrdering === true)
    setBudgetsEnabled(org.budgetsEnabled !== false)
  }, [
    org.name,
    org.code,
    org.ntnNumber,
    org.strnNumber,
    org.emailDomain,
    org.status,
    org.budgetAllocationMode,
    org.orderApproverRole,
    org.orderApprovalRequired,
    org.blockOrderingOnUnpaidInvoices,
    org.blockOrderingOnUnacknowledgedDeliveries,
    org.unpaidInvoiceBlockThreshold,
    org.unacknowledgedDeliveryBlockThreshold,
    org.budgetsEnabled,
    org.managedOrdering,
  ])

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
  }, [open, isSuperAdmin, org.id, org.budgetAllocationMode])

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

  useEffect(() => {
    if (!open || !isSuperAdmin) return

    let cancelled = false
    setLoadingApprovalLevels(true)
    setApprovalLevelsLoadFailed(false)
    fetch(`/api/v1/organizations/${org.id}/approval-levels`)
      .then(async (res) => {
        if (!res.ok) throw new Error("Failed to load approval levels")
        return res.json()
      })
      .then((data) => {
        if (cancelled) return
        const loaded: unknown[] = Array.isArray(data?.levels) ? data.levels : []
        setApprovalLevelsEnabled(data?.enabled === true)
        setApprovalLevelDrafts(
          loaded.map((item) => approvalLevelAmountText(Number((item as { maxAmountCents?: unknown })?.maxAmountCents))),
        )
      })
      .catch(() => {
        // As for private network login: a failed read must never become an
        // empty draft that a later save writes back, switching the levels off.
        if (!cancelled) {
          setApprovalLevelsLoadFailed(true)
          setApprovalLevelsEnabled(false)
          setApprovalLevelDrafts([])
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingApprovalLevels(false)
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
            <div className="space-y-2">
              <Label htmlFor="entn">NTN number (optional)</Label>
              <Input
                id="entn"
                value={ntnNumber}
                onChange={(e) => setNtnNumber(e.target.value)}
                placeholder="1234567-8"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">Tax registration number. Clear the field to remove it.</p>
            </div>
            <div className="space-y-2">
              <Label htmlFor="estrn">STRN number (optional)</Label>
              <Input
                id="estrn"
                value={strnNumber}
                onChange={(e) => setStrnNumber(e.target.value)}
                placeholder="3277876123456"
                disabled={saving}
              />
              <p className="text-xs text-muted-foreground">Sales tax registration number. Clear the field to remove it.</p>
            </div>
            <EmailDomainField
              id="eemail-domain"
              value={emailDomain}
              onChange={setEmailDomain}
              disabled={saving}
              hint={EDIT_EMAIL_DOMAIN_HINT}
            />
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
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div className="pr-4">
                    <Label htmlFor={`edit-order-approval-required-${org.id}`}>Require order approval</Label>
                    <p className="text-xs text-muted-foreground">
                      When off, newly created orders are approved immediately. Existing orders are unchanged.
                    </p>
                  </div>
                  <Switch
                    id={`edit-order-approval-required-${org.id}`}
                    checked={orderApprovalRequired}
                    onCheckedChange={setOrderApprovalRequired}
                    disabled={loadingSettings || saving}
                  />
                </div>
                <div className={cn(
                  "space-y-2 rounded-md border bg-background px-3 py-2",
                  !orderApprovalRequired && "opacity-60",
                )}>
                  <Label>Order approver</Label>
                  <p className="text-xs text-muted-foreground">
                    {orderApprovalRequired
                      ? "This role alone can approve or reject pending orders."
                      : "Saved for use if approval is required again later."}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <button
                      type="button"
                      onClick={() => setOrderApproverRole("BRANCH_ADMIN")}
                      disabled={loadingSettings || saving || !orderApprovalRequired}
                      className={cn(
                        "rounded-md border bg-background p-3 text-left transition-colors",
                        orderApproverRole === "BRANCH_ADMIN" ? "border-indigo-500 ring-2 ring-indigo-100 dark:ring-indigo-900/40" : "hover:bg-muted/50",
                      )}
                    >
                      <span className="text-sm font-semibold">Financial Approver</span>
                      <span className="mt-1 block text-xs text-muted-foreground">Limited to the approver's own branch.</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setOrderApproverRole("HEAD_OFFICE")}
                      disabled={loadingSettings || saving || !orderApprovalRequired}
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
                {approvalLevelsLoadFailed ? (
                  <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 dark:border-amber-700 dark:bg-amber-950/40">
                    <p className="text-xs font-medium text-amber-900 dark:text-amber-100">
                      Order approval levels could not be loaded. They are left unchanged when
                      you save. Close and reopen this dialog to retry.
                    </p>
                  </div>
                ) : (
                  <OrderApprovalLevelsFields
                    idPrefix={`edit-${org.id}`}
                    enabled={approvalLevelsEnabled}
                    levels={approvalLevelDrafts}
                    disabled={loadingApprovalLevels || saving}
                    onEnabledChange={setApprovalLevelsEnabled}
                    onLevelsChange={setApprovalLevelDrafts}
                  />
                )}
                <OrderingBlockSwitch
                  id={`edit-block-ordering-on-unpaid-invoices-${org.id}`}
                  label="Block ordering on unpaid invoices"
                  hint={unpaidInvoiceBlockHint(thresholdValue(unpaidInvoiceBlockThreshold))}
                  checked={blockOrderingOnUnpaidInvoices}
                  onCheckedChange={setBlockOrderingOnUnpaidInvoices}
                  disabled={loadingSettings || saving}
                  threshold={{
                    label: UNPAID_INVOICE_THRESHOLD_LABEL,
                    text: unpaidInvoiceBlockThresholdText,
                    draft: unpaidInvoiceBlockThreshold,
                    onTextChange: setUnpaidInvoiceBlockThresholdText,
                  }}
                />
                <OrderingBlockSwitch
                  id={`edit-block-ordering-on-unacknowledged-deliveries-${org.id}`}
                  label="Block ordering on unacknowledged deliveries"
                  hint={unacknowledgedDeliveryBlockHint(thresholdValue(unacknowledgedDeliveryBlockThreshold))}
                  checked={blockOrderingOnUnacknowledgedDeliveries}
                  onCheckedChange={setBlockOrderingOnUnacknowledgedDeliveries}
                  disabled={loadingSettings || saving}
                  threshold={{
                    label: UNACKNOWLEDGED_DELIVERY_THRESHOLD_LABEL,
                    text: unacknowledgedDeliveryBlockThresholdText,
                    draft: unacknowledgedDeliveryBlockThreshold,
                    onTextChange: setUnacknowledgedDeliveryBlockThresholdText,
                  }}
                />
                <OrderingBlockSwitch
                  id={`edit-managed-ordering-${org.id}`}
                  label="Managed by Apricart Order Desk"
                  hint={MANAGED_ORDERING_HINT}
                  checked={managedOrdering}
                  onCheckedChange={setManagedOrdering}
                  disabled={loadingSettings || saving}
                />
                <BudgetAllocationFields
                  idPrefix={`edit-${org.id}`}
                  enabled={budgetsEnabled}
                  onEnabledChange={setBudgetsEnabled}
                  mode={budgetAllocationMode}
                  onModeChange={setBudgetAllocationMode}
                  disabled={loadingSettings || saving}
                  note={budgetsEnabled ? EDIT_BUDGET_ALLOCATION_ON_NOTE : EDIT_BUDGET_ALLOCATION_OFF_NOTE}
                />
                <div className="flex items-center justify-between rounded-md border bg-background px-3 py-2">
                  <div>
                    <Label htmlFor="hide-branch-admin-price-visibility">Hide Financial Approver prices</Label>
                    <p className="text-xs text-muted-foreground">
                      Hide product and order prices from financial approver users.
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
                    <Label htmlFor="hide-order-portal-price-visibility">Hide Order Initiator prices</Label>
                    <p className="text-xs text-muted-foreground">
                      Hide product and order prices from order initiator users.
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
              loadingApprovalLevels ||
              !name.trim() ||
              !code.trim() ||
              Boolean(networkError) ||
              Boolean(emailDomainError) ||
              thresholdsInvalid ||
              Boolean(approvalLevelsError)
            }
            onClick={async () => {
              setSaving(true)
              try {
                const saved = await onSave(
                  {
                    name,
                    code,
                    // Optional: an emptied field clears the stored value.
                    ntnNumber: ntnNumber.trim() || null,
                    strnNumber: strnNumber.trim() || null,
                    emailDomain: toEmailDomainPayload(emailDomain),
                    status: status ? "active" : "inactive",
                    ...(isSuperAdmin
                      ? {
                        budgetsEnabled,
                        budgetAllocationMode,
                        orderApproverRole,
                        orderApprovalRequired,
                        blockOrderingOnUnpaidInvoices,
                        blockOrderingOnUnacknowledgedDeliveries,
                        ...orderingBlockThresholdPayload(unpaidInvoiceBlockThreshold, unacknowledgedDeliveryBlockThreshold),
                        managedOrdering,
                      }
                      : {}),
                  },
                  isSuperAdmin
                    ? {
                      hideBranchAdminPrices,
                      hideOrderPortalPrices,
                    }
                    : undefined,
                  isSuperAdmin && !networkLoadFailed
                    ? toPrivateNetworkLoginPayload(privateNetworkEnabled, networkEntries)
                    : undefined,
                  // Switched off, this omits the levels so the stored ones are
                  // kept; never sent at all if they could not be loaded.
                  isSuperAdmin && !approvalLevelsLoadFailed
                    ? toApprovalLevelsPayload(approvalLevelsEnabled, approvalLevelDrafts)
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
  const [code, setCode] = useState(branch.code ?? "")
  const [province, setProvince] = useState(branch.province ?? "")
  const [city, setCity] = useState(branch.city ?? "")
  const [region, setRegion] = useState<BranchRegion | null>(branch.region ?? null)
  const [address, setAddress] = useState(branch.address ?? "")
  const [costCenterId, setCostCenterId] = useState(branch.costCenterId ?? "")
  const [headCountText, setHeadCountText] = useState(headCountFieldValue(branch.headCount))
  const [status, setStatus] = useState<boolean>(isActiveStatus(branch.status))
  const headCount = parseHeadCountInput(headCountText)

  useEffect(() => {
    setName(branch.name)
    setCode(branch.code ?? "")
    setProvince(branch.province ?? "")
    setCity(branch.city ?? "")
    setRegion(branch.region ?? null)
    setAddress(branch.address ?? "")
    setCostCenterId(branch.costCenterId ?? "")
    setHeadCountText(headCountFieldValue(branch.headCount))
    setStatus(isActiveStatus(branch.status))
  }, [branch.name, branch.code, branch.province, branch.city, branch.region, branch.address, branch.costCenterId, branch.headCount, branch.status])
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
            <BranchRegionSelect id="branch-region-edit" value={region} onChange={setRegion} />
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
            <BranchHeadCountField
              id="branch-head-count-edit"
              value={headCountText}
              onChange={setHeadCountText}
            />
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
                region,
                address: address.trim() || null,
                costCenterId: costCenterId.trim() || null,
                headCount: headCount ?? null,
                status: status ? "active" : "inactive",
              })
              setOpen(false)
            }}
            disabled={!name.trim() || headCount === undefined}
          >
            <Save className="h-4 w-4" />
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
