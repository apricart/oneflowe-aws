"use client"
import { useState,useMemo,ReactNode,useEffect,useCallback } from "react"
import useSWR,{ useSWRConfig } from "swr"
import { useSession } from "next-auth/react"
import { useToast } from "@/hooks/use-toast"
import { Card,CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogFooter,DialogDescription } from "@/components/ui/dialog"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Wallet,AlertCircle,Edit2,Zap,PieChart,CheckCircle2,AlertTriangle,RefreshCw,Trash2,Search,ArrowUp,ArrowDown,ArrowUpDown } from "lucide-react"
import { formatPKR,cn } from "@/lib/utils"
import { useAppContext } from "@/components/context/app-context"
import { GlobalDateFilter,type FilterPreset,type GlobalDateFilterChange } from "@/components/dashboard/global-date-filter"

import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { type DateRange } from "@/lib/hooks/use-sales-performance"
import { BUDGET_ALLOCATION_MODE_SETTING_KEY,parseBudgetAllocationMode,type BudgetAllocationMode } from "@/lib/budget-allocation-mode"

const fetcher = (url: string) => fetch(url).then(r => r.json())

interface BudgetAllocation {
  branchId: number
  branchName: string
  organizationId: number
  groupId?: number
  groupName?: string
  amountAllocatedCents: number
  amountSpentCents: number
  amountHeldCents: number
  amountCreditedCents: number
  remainingCents: number
  baselineBudgetCents: number
  budgetAllocationMode?: BudgetAllocationMode
}

const BUDGET_ALLOCATION_MODE_LABELS: Record<BudgetAllocationMode, string> = {
  money: "Money-based",
  quantity: "Quantity-based",
}
const QUANTITY_ALLOCATION_DISABLED_TITLE = "This branch belongs to a quantity-based organization. Allocate budgets from Budget by Quantity."

const getRowBudgetAllocationMode = (budget: BudgetAllocation, fallbackMode: BudgetAllocationMode) =>
  parseBudgetAllocationMode(budget.budgetAllocationMode ?? fallbackMode)

const getBudgetUsagePercentage = (budget: BudgetAllocation) => {
  const total = (budget.amountAllocatedCents || 0) + (budget.amountCreditedCents || 0)
  if (total <= 0) return 0
  return ((budget.amountSpentCents || 0) + (budget.amountHeldCents || 0)) / total * 100
}

const formatPercentageNoRound = (value: number) => {
  const scaled = Math.trunc(value * 100)
  const sign = scaled < 0 ? "-" : ""
  const absoluteScaled = Math.abs(scaled)
  const whole = Math.trunc(absoluteScaled / 100)
  const decimal = String(absoluteScaled % 100).padStart(2, "0")
  return `${sign}${whole}.${decimal}%`
}

const buildBudgetsEndpoint = (options: {
  enabled: boolean
  organizationId: string | number | null
  dateRange: DateRange | null
  activePreset: FilterPreset
  selectedMonths: number[]
  selectedYears: number[]
  selectedGroupIds: string[]
  branchIds: string[]
}) => {
  if (!options.enabled) return null
  const params = new URLSearchParams({ all: "true", preset: options.activePreset })
  if (options.organizationId) params.set("organizationId", String(options.organizationId))
  if (options.dateRange) {
    params.set("startDate", options.dateRange.startDate.toISOString())
    params.set("endDate", options.dateRange.endDate.toISOString())
  }
  if (options.selectedMonths.length > 0) params.set("months", options.selectedMonths.join(","))
  const years = options.selectedMonths.length > 0 && options.selectedYears.length === 0 && !options.dateRange
    ? [new Date().getFullYear()]
    : options.selectedYears
  if (years.length > 0) params.set("years", years.join(","))
  if (options.selectedGroupIds.length > 0) params.set("groupIds", options.selectedGroupIds.join(","))
  if (options.branchIds.length > 0) params.set("branchIds", options.branchIds.join(","))
  return `/api/v1/budgets?${params.toString()}`
}

const isBudgetManagerRole = (role: string | undefined) => (
  role === "HEAD_OFFICE" || role === "SUPER_ADMIN"
)

const getMoneyAllocationDisabledTitle = (mode: BudgetAllocationMode) => (
  mode === "quantity"
    ? "This organization uses quantity-based budgeting. Allocate budgets from Budget by Quantity."
    : undefined
)

const getAverageUtilization = (allocated: number, spent: number, held: number) => (
  allocated > 0 ? ((spent + held) / allocated) * 100 : 0
)

const getPercentageOfTotal = (value: number, total: number) => (
  total > 0 ? ((value / total) * 100).toFixed(1) : "0"
)

export default function BudgetsPage() {
  const { data: session, status } = useSession()
  const { toast } = useToast()
  const { mutate: globalMutate } = useSWRConfig()
  const role = (session?.user as any)?.role
  const isHeadOffice = isBudgetManagerRole(role)
  const { organizationId, branchIds: contextBranchIds, setBranchIds: setContextBranchIds, isInitialized } = useAppContext()

  const [searchQuery, setSearchQuery] = useState("")
  const [sortColumn, setSortColumn] = useState<"branch" | "base" | "addon" | "total" | "spent" | "remaining">("total")
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc")
  const [editingBudget, setEditingBudget] = useState<BudgetAllocation | null>(null)
  const [showDialog, setShowDialog] = useState(false)
  const [newAmount, setNewAmount] = useState("")
  const [bulkAmount, setBulkAmount] = useState("")
  const [showBulkDialog, setShowBulkDialog] = useState(false)
  const [showEmptyDialog, setShowEmptyDialog] = useState(false)
  const [showEmptyAllDialog, setShowEmptyAllDialog] = useState(false)
  const [emptyingBudget, setEmptyingBudget] = useState<BudgetAllocation | null>(null)
  const [allocationType, setAllocationType] = useState<"monthly" | "addon">("addon")

  // ━━━ GLOBAL FILTERS ━━━
  const [dateRange, setDateRange] = useState<DateRange | null>(null)
  const [activePreset, setActivePreset] = useState<FilterPreset>("all")
  const [selectedMonths, setSelectedMonths] = useState<number[]>([])
  const [selectedYears, setSelectedYears] = useState<number[]>([])
  const [selectedGroupIds, setSelectedGroupIds] = useState<string[]>([])

  const handleDateChange = useCallback(({ range, preset, months = [], years = [] }: GlobalDateFilterChange) => {
    setDateRange(range)
    setActivePreset(preset)
    setSelectedMonths(months || [])
    setSelectedYears(years || [])
  }, [])

  useEffect(() => {
    if (isInitialized) {
      handleDateChange({ range: null, preset: "all" })
    }
  }, [isInitialized, handleDateChange])

  // Build endpoint respecting context (organization scope)
  const budgetsEndpoint = useMemo(() => buildBudgetsEndpoint({
    enabled: isHeadOffice && isInitialized,
    organizationId,
    dateRange,
    activePreset,
    selectedMonths,
    selectedYears,
    selectedGroupIds,
    branchIds: contextBranchIds,
  }), [isHeadOffice, isInitialized, organizationId, dateRange, activePreset, selectedMonths, selectedYears, contextBranchIds, selectedGroupIds])

  const settingsEndpoint = useMemo(() => {
    if (!isHeadOffice || !isInitialized || !organizationId) return null
    return `/api/v1/settings?organizationId=${organizationId}`
  }, [isHeadOffice, isInitialized, organizationId])

  // keepPreviousData keeps the current numbers on screen during filter changes
  const { data: budgetsData, mutate } = useSWR<any>(budgetsEndpoint, fetcher, { keepPreviousData: true })
  const { data: settingsData } = useSWR<any>(settingsEndpoint, fetcher)

  const resetBudgetFilters = useCallback(() => {
    handleDateChange({ range: null, preset: "all" })
    setSelectedGroupIds([])
    setContextBranchIds([])
    setSearchQuery("")
    mutate()
  }, [handleDateChange, mutate, setContextBranchIds])

  const budgets: BudgetAllocation[] = budgetsData?.budgets || []
  const budgetAllocationMode = parseBudgetAllocationMode(
    settingsData?.data?.find((setting: any) => setting.key === BUDGET_ALLOCATION_MODE_SETTING_KEY)?.value
  )
  const isQuantityBudgetMode = budgetAllocationMode === "quantity"
  const moneyAllocationDisabledTitle = getMoneyAllocationDisabledTitle(budgetAllocationMode)

  const formatAmount = (cents: number) => formatPKR(cents / 100)

  // Filter scoped budgets natively
  const scopedBudgets = useMemo(() => {
    return budgets.filter((b) => {
      if (organizationId && String(b.organizationId) !== String(organizationId)) return false
      if (selectedGroupIds.length > 0 && b.groupId && !selectedGroupIds.includes(String(b.groupId))) return false
      if (contextBranchIds.length > 0 && !contextBranchIds.includes(String(b.branchId))) return false
      return true
    })
  }, [budgets, organizationId, contextBranchIds, selectedGroupIds])

  const moneyBasedScopedBudgets = useMemo(
    () => scopedBudgets.filter((budget) => getRowBudgetAllocationMode(budget, budgetAllocationMode) === "money"),
    [scopedBudgets, budgetAllocationMode]
  )
  const quantityBasedScopedBudgetCount = scopedBudgets.length - moneyBasedScopedBudgets.length

  const filteredBudgets = useMemo(() => {
    return scopedBudgets.filter((b) =>
      b.branchName.toLowerCase().includes(searchQuery.toLowerCase()) ||
      b.branchId.toString().includes(searchQuery)
    )
  }, [scopedBudgets, searchQuery])

  const handleSort = (col: typeof sortColumn) => {
    if (sortColumn === col) {
      setSortDirection(d => d === "asc" ? "desc" : "asc")
    } else {
      setSortColumn(col)
      setSortDirection("desc")
    }
  }

  const sortedFilteredBudgets = useMemo(() => {
    return [...filteredBudgets].sort((a, b) => {
      let aVal: number | string
      let bVal: number | string
      switch (sortColumn) {
        case "branch":
          aVal = a.branchName.toLowerCase()
          bVal = b.branchName.toLowerCase()
          break
        case "base":
          aVal = a.baselineBudgetCents
          bVal = b.baselineBudgetCents
          break
        case "addon":
          aVal = a.amountCreditedCents || 0
          bVal = b.amountCreditedCents || 0
          break
        case "total":
          aVal = a.amountAllocatedCents + (a.amountCreditedCents || 0)
          bVal = b.amountAllocatedCents + (b.amountCreditedCents || 0)
          break
        case "spent":
          aVal = a.amountSpentCents + a.amountHeldCents
          bVal = b.amountSpentCents + b.amountHeldCents
          break
        case "remaining":
          aVal = a.remainingCents
          bVal = b.remainingCents
          break
        default:
          return 0
      }
      if (typeof aVal === "string" && typeof bVal === "string") {
        return sortDirection === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal)
      }
      return sortDirection === "asc" ? (aVal as number) - (bVal as number) : (bVal as number) - (aVal as number)
    })
  }, [filteredBudgets, sortColumn, sortDirection])

  const totalAllocated = scopedBudgets.reduce((sum, b) => sum + b.amountAllocatedCents + (b.amountCreditedCents || 0), 0)
  const totalSpent = scopedBudgets.reduce((sum, b) => sum + b.amountSpentCents, 0)
  const totalHeld = scopedBudgets.reduce((sum, b) => sum + b.amountHeldCents, 0)
  const totalRemaining = scopedBudgets.reduce((sum, b) => sum + b.remainingCents, 0)
  const avgUtilization = getAverageUtilization(totalAllocated, totalSpent, totalHeld)

  const handleEditBudget = (budget: BudgetAllocation) => {
    if (getRowBudgetAllocationMode(budget, budgetAllocationMode) === "quantity") {
      return toast({
        title: "Allocation unavailable",
        description: QUANTITY_ALLOCATION_DISABLED_TITLE,
        variant: "destructive",
      })
    }

    setEditingBudget(budget)
    setNewAmount("") // Start with empty field since we're adding, not replacing
    setAllocationType("addon")
    setShowDialog(true)
  }

  const handleSaveBudget = async () => {
    if (!editingBudget || !newAmount) return
    if (getRowBudgetAllocationMode(editingBudget, budgetAllocationMode) === "quantity") {
      return toast({
        title: "Allocation unavailable",
        description: QUANTITY_ALLOCATION_DISABLED_TITLE,
        variant: "destructive",
      })
    }

    const amountCents = Math.round(Number.parseFloat(newAmount) * 100)
    if (!Number.isFinite(amountCents) || amountCents < 0) {
      return toast({ title: "Invalid amount", variant: "destructive" })
    }

    // Client-side validation: Total Proposed Budget >= Current Total Spent
    const currentSpentCents = (editingBudget.amountSpentCents || 0) + (editingBudget.amountHeldCents || 0)
    let proposedTotalCents = 0
    if (allocationType === "monthly") {
      proposedTotalCents = amountCents + (editingBudget.amountCreditedCents || 0)
    } else {
      // Add-on type: adding to the current credits
      proposedTotalCents = (editingBudget.amountAllocatedCents || 0) + (editingBudget.amountCreditedCents || 0) + amountCents
    }

    if (proposedTotalCents < currentSpentCents) {
      return toast({
        title: "Allocation Blocked",
        description: `Total budget (₨${(proposedTotalCents / 100).toFixed(2)}) cannot be lower than current spending (₨${(currentSpentCents / 100).toFixed(2)}).`,
        variant: "destructive"
      })
    }

    try {
      const res = await fetch("/api/v1/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: editingBudget.branchId,
          amountAllocatedCents: amountCents,
          type: allocationType,
        })
      })

      if (!res.ok) {
        const json = await res.json()
        return toast({ title: "Failed", description: json.error, variant: "destructive" })
      }

      const newRemaining = (editingBudget.remainingCents / 100) + Number.parseFloat(newAmount)
      toast({
        title: "Budget Updated",
        description: `Added ${formatPKR(Number.parseFloat(newAmount))} to ${editingBudget.branchName}. New remaining: ${formatPKR(newRemaining)}`,
      })
      setShowDialog(false)
      setEditingBudget(null)
      mutate()
      
      // Global revalidation for analytics
      globalMutate(key => typeof key === 'string' && key.includes('/api/v1/analytics/budgets/summary'))
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" })
    }
  }

  const handleEmptyBudget = (budget: BudgetAllocation) => {
    if (getRowBudgetAllocationMode(budget, budgetAllocationMode) === "quantity") {
      return toast({
        title: "Reset unavailable",
        description: QUANTITY_ALLOCATION_DISABLED_TITLE,
        variant: "destructive",
      })
    }

    setEmptyingBudget(budget)
    setShowEmptyDialog(true)
  }

  const handleConfirmEmptyBudget = async () => {
    if (!emptyingBudget) return
    if (getRowBudgetAllocationMode(emptyingBudget, budgetAllocationMode) === "quantity") {
      return toast({
        title: "Reset unavailable",
        description: QUANTITY_ALLOCATION_DISABLED_TITLE,
        variant: "destructive",
      })
    }

    // Client-side validation: Cannot empty budget if there is spending
    const currentSpentCents = (emptyingBudget.amountSpentCents || 0) + (emptyingBudget.amountHeldCents || 0)
    if (currentSpentCents > 0) {
      return toast({
        title: "Cannot Reset Budget",
        description: `This branch has already spent ₨${(currentSpentCents / 100).toFixed(2)}. You must maintain at least enough budget to cover existing spending.`,
        variant: "destructive"
      })
    }

    try {
      const res = await fetch("/api/v1/budgets", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: emptyingBudget.branchId,
          amountAllocatedCents: 0,
          setAbsolute: true,
          resetAddons: true,
        })
      })

      if (!res.ok) {
        const json = await res.json()
        return toast({ title: "Failed", description: json.error, variant: "destructive" })
      }

      toast({
        title: "Budget Emptied",
        description: `Successfully reset budget for ${emptyingBudget.branchName} to ₨0.00`,
      })
      setShowEmptyDialog(false)
      setEmptyingBudget(null)
      mutate()
      
      // Global revalidation for analytics
      globalMutate(key => typeof key === 'string' && key.includes('/api/v1/analytics/budgets/summary'))
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" })
    }
  }

  const handleEmptyAllBudgets = async () => {
    try {
      let successCount = 0
      for (const budget of scopedBudgets) {
        const res = await fetch("/api/v1/budgets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branchId: budget.branchId,
            amountAllocatedCents: 0,
            setAbsolute: true,
            resetAddons: true,
          })
        })
        if (res.ok) successCount++
      }

      toast({
        title: "Bulk Empty Complete",
        description: `Reset ${successCount}/${scopedBudgets.length} branch budgets to ₨0.00`
      })
      setShowEmptyAllDialog(false)
      mutate()
      
      // Global revalidation for analytics
      globalMutate(key => typeof key === 'string' && key.includes('/api/v1/analytics/budgets/summary'))
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" })
    }
  }

  const handleBulkAllocate = async () => {
    if (!bulkAmount) return
    if (moneyBasedScopedBudgets.length === 0) {
      return toast({
        title: "No money-based branches",
        description: "Quantity-based organizations are skipped for money budget allocation.",
        variant: "destructive",
      })
    }

    const amountCents = Math.round(Number.parseFloat(bulkAmount) * 100)
    if (!Number.isFinite(amountCents) || amountCents < 0) {
      return toast({ title: "Invalid amount", variant: "destructive" })
    }

    try {
      let successCount = 0
      // Apply only to money-based branches in the current context scope.
      for (const budget of moneyBasedScopedBudgets) {
        const res = await fetch("/api/v1/budgets", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            branchId: budget.branchId,
            amountAllocatedCents: amountCents,
          })
        })
        if (res.ok) successCount++
      }

      toast({
        title: "Bulk Allocation Complete",
        description: `Allocated ${formatPKR(Number.parseFloat(bulkAmount))} to ${successCount}/${moneyBasedScopedBudgets.length} money-based branches.${quantityBasedScopedBudgetCount > 0 ? (" Skipped " + String(quantityBasedScopedBudgetCount) + " quantity-based branches.") : ""}`
      })
      setShowBulkDialog(false)
      setBulkAmount("")
      mutate()

      // Global revalidation for analytics
      globalMutate(key => typeof key === 'string' && key.includes('/api/v1/analytics/budgets/summary'))
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" })
    }
  }

  const getSpendingPercentage = (budget: BudgetAllocation) => {
    return getBudgetUsagePercentage(budget)
  }

  const getStatusColor = (percentage: number) => {
    if (percentage >= 90) return "bg-red-500"
    if (percentage >= 70) return "bg-yellow-500"
    return "bg-green-500"
  }

  if (status === "loading") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <RefreshCw className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  if (!isHeadOffice) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Card className="p-8 text-center">
          <AlertCircle className="h-12 w-12 text-destructive mx-auto mb-4" />
          <p className="text-muted-foreground">You do not have permission to access this page</p>
        </Card>
      </div>
    )
  }


  return (
    <div className="min-h-screen bg-[#f8fafc] dark:bg-[#020617] pb-20">
      {/* ━━━ STICKY PREMIUM HEADER ━━━ */}
      <div className="sticky top-0 z-30 w-full backdrop-blur-xl bg-white/80 dark:bg-slate-950/80 border-b border-slate-200 dark:border-slate-800 shadow-sm transition-all duration-300">
        <div className="max-w-[1600px] mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="h-12 w-12 rounded-2xl bg-gradient-to-br from-indigo-600 to-purple-700 flex items-center justify-center shadow-lg shadow-indigo-500/20 rotate-3 group hover:rotate-0 transition-all duration-500">
              <Wallet className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black tracking-tight text-slate-900 dark:text-white uppercase">Budget Intelligence</h1>
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-[0.2em] flex items-center gap-1.5">
                <PieChart className="h-3.5 w-3.5" />
                Financial Allocation Hub
              </p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <GlobalDateFilter 
              value={dateRange} 
              activePreset={activePreset} 
              onChange={handleDateChange} 
              months={selectedMonths}
              years={selectedYears}
            />
            {(role === "SUPER_ADMIN" || role === "HEAD_OFFICE") && (
              <div className="flex items-center gap-2 h-6 pl-3 border-l border-slate-200 dark:border-slate-800">
                <GroupFilter 
                  selectedIds={selectedGroupIds} 
                  onChange={setSelectedGroupIds} 
                  organizationId={organizationId || undefined}
                  disabled={contextBranchIds.length > 0}
                />
                <BranchFilter 
                  selectedIds={contextBranchIds} 
                  onChange={setContextBranchIds} 
                  organizationId={organizationId || undefined} 
                  groupIds={selectedGroupIds}
                />
              </div>
            )}
            <Button variant="ghost" size="icon" className="rounded-xl text-slate-400 hover:text-indigo-500 transition-colors bg-white dark:bg-slate-900 ml-2 border border-slate-200 dark:border-slate-800" onClick={resetBudgetFilters}>
              <RefreshCw className={cn("h-4 w-4", !budgetsData && "animate-spin")} />
            </Button>
          </div>
        </div>
      </div>

      <div className="space-y-6 p-4 md:p-6 max-w-[1600px] mx-auto">

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <CompactStatCard
          label="Total Budget"
          value={formatAmount(totalAllocated)}
          icon={<Wallet className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-indigo-50/80 to-blue-50/80 border-indigo-100/50 text-indigo-700 dark:from-indigo-900/20 dark:to-blue-900/20 dark:border-indigo-800/30 dark:text-indigo-400"
          iconBadge="bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-400"
          isLoading={isHeadOffice && !budgetsData}
        />
        <CompactStatCard
          label="Spent This Period"
          value={formatAmount(totalSpent + totalHeld)}
          icon={<PieChart className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-rose-50/80 to-pink-50/80 border-rose-100/50 text-rose-700 dark:from-rose-900/20 dark:to-pink-900/20 dark:border-rose-800/30 dark:text-rose-400"
          iconBadge="bg-rose-100 dark:bg-rose-900/40 text-rose-600 dark:text-rose-400"
          isLoading={isHeadOffice && !budgetsData}
        />
        <CompactStatCard
          label="Remaining"
          value={formatAmount(totalRemaining)}
          icon={<CheckCircle2 className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-teal-50/80 to-emerald-50/80 border-teal-100/50 text-teal-700 dark:from-teal-900/20 dark:to-emerald-900/20 dark:border-teal-800/30 dark:text-teal-400"
          iconBadge="bg-emerald-100 dark:bg-emerald-900/40 text-emerald-600 dark:text-emerald-400"
          isLoading={isHeadOffice && !budgetsData}
        />
        <CompactStatCard
          label="Avg Utilization"
          value={formatPercentageNoRound(avgUtilization)}
          icon={<Zap className="h-5 w-5" />}
          gradient="bg-gradient-to-br from-fuchsia-50/80 to-purple-50/80 border-fuchsia-100/50 text-fuchsia-700 dark:from-fuchsia-900/20 dark:to-purple-900/20 dark:border-fuchsia-800/30 dark:text-fuchsia-400"
          iconBadge="bg-fuchsia-100 dark:bg-fuchsia-900/40 text-fuchsia-600 dark:text-fuchsia-400"
          isLoading={isHeadOffice && !budgetsData}
        />
      </div>

      <div className="flex flex-col sm:flex-row gap-4 items-center justify-between">
        <div className="relative w-full sm:w-96">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search branches..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl text-sm font-bold uppercase tracking-tight focus:ring-2 focus:ring-blue-500 outline-none transition-all"
          />
        </div>
        <div className="flex gap-2 w-full sm:w-auto">
          <Button
            onClick={() => setShowBulkDialog(true)}
            disabled={scopedBudgets.length > 0 && moneyBasedScopedBudgets.length === 0}
            title={(() => {
              if (moneyBasedScopedBudgets.length === 0) {
                return moneyAllocationDisabledTitle || "No money-based branches available for bulk allocation."
              }
              if (quantityBasedScopedBudgetCount > 0) {
                return "Quantity-based branches will be skipped."
              }
              return undefined
            })()}
            variant="outline"
            className="flex-1 font-bold uppercase text-[10px] tracking-widest border-slate-200 dark:border-slate-800 rounded-xl px-6"
          >
            <Zap className="h-3.5 w-3.5 mr-2 text-amber-500" /> Bulk Allocate
          </Button>
          <Button onClick={() => setShowEmptyAllDialog(true)} disabled={isQuantityBudgetMode} title={moneyAllocationDisabledTitle} variant="outline" className="flex-1 font-bold uppercase text-[10px] tracking-widest border-slate-200 dark:border-slate-800 rounded-xl px-6 hover:bg-rose-50 dark:hover:bg-rose-950/20 text-rose-600 transition-colors">
            <Trash2 className="h-3.5 w-3.5 mr-2" /> Empty All
          </Button>
        </div>
      </div>

      <Card className="overflow-hidden border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900 rounded-2xl">
        <Table>
          <TableHeader>
            <TableRow className="bg-gradient-to-r from-slate-50 to-slate-100 dark:from-slate-900 dark:to-slate-800 border-b border-slate-200 dark:border-slate-700">
              <TableHead className="font-black text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400 pl-5 cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200 transition-colors" onClick={() => handleSort("branch")}>
                <span className="flex items-center gap-1">Branch {(() => {
                  if (sortColumn === "branch") {
                    return (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                  }
                  return <ArrowUpDown className="h-3 w-3 opacity-40" />
                })()}</span>
              </TableHead>
              <TableHead className="text-right font-black text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400 cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200 transition-colors" onClick={() => handleSort("base")}>
                <span className="flex items-center justify-end gap-1">Base {(() => {
                  if (sortColumn === "base") {
                    return (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                  }
                  return <ArrowUpDown className="h-3 w-3 opacity-40" />
                })()}</span>
              </TableHead>
              <TableHead className="text-right font-black text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400 cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200 transition-colors" onClick={() => handleSort("addon")}>
                <span className="flex items-center justify-end gap-1">Add-on {(() => {
                  if (sortColumn === "addon") {
                    return (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                  }
                  return <ArrowUpDown className="h-3 w-3 opacity-40" />
                })()}</span>
              </TableHead>
              <TableHead className="text-right font-black text-[10px] uppercase tracking-widest text-indigo-500 cursor-pointer select-none hover:text-indigo-700 transition-colors" onClick={() => handleSort("total")}>
                <span className="flex items-center justify-end gap-1">Total Budget {(() => {
                  if (sortColumn === "total") {
                    return (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                  }
                  return <ArrowUpDown className="h-3 w-3 opacity-40" />
                })()}</span>
              </TableHead>
              <TableHead className="text-right font-black text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400 cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200 transition-colors" onClick={() => handleSort("spent")}>
                <span className="flex items-center justify-end gap-1">Spent {(() => {
                  if (sortColumn === "spent") {
                    return (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                  }
                  return <ArrowUpDown className="h-3 w-3 opacity-40" />
                })()}</span>
              </TableHead>
              <TableHead className="text-right font-black text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400 cursor-pointer select-none hover:text-slate-700 dark:hover:text-slate-200 transition-colors" onClick={() => handleSort("remaining")}>
                <span className="flex items-center justify-end gap-1">Remaining {(() => {
                  if (sortColumn === "remaining") {
                    return (sortDirection === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />)
                  }
                  return <ArrowUpDown className="h-3 w-3 opacity-40" />
                })()}</span>
              </TableHead>
              <TableHead className="text-right font-black text-[10px] uppercase tracking-widest text-slate-500 dark:text-slate-400 pr-5">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(() => {
              if (budgets.length === 0) {
                return (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-16">
                  <AlertTriangle className="h-8 w-8 text-yellow-500 mx-auto mb-3 opacity-40" />
                  <p className="text-sm text-muted-foreground">No branches found</p>
                </TableCell>
              </TableRow>
            )
              }
              if (filteredBudgets.length === 0) {
                return (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-10 text-muted-foreground text-sm">
                  No branches match your search
                </TableCell>
              </TableRow>
            )
              }
              return (
              sortedFilteredBudgets.map(budget => {
                const spendingPercent = getSpendingPercentage(budget)
                const isNearLimit = spendingPercent >= 90
                const isMedium = spendingPercent >= 70
                const totalBudget = budget.amountAllocatedCents + (budget.amountCreditedCents || 0)
                const hasNoBudget = totalBudget === 0 && budget.baselineBudgetCents === 0
                const rowBudgetAllocationMode = parseBudgetAllocationMode(budget.budgetAllocationMode ?? budgetAllocationMode)
                const rowIsQuantityBudgetMode = rowBudgetAllocationMode === "quantity"
                const rowMoneyAllocationDisabledTitle = rowIsQuantityBudgetMode ? QUANTITY_ALLOCATION_DISABLED_TITLE : undefined

                return (
                  <TableRow
                    key={budget.branchId}
                    className={cn(
                      "transition-colors border-b border-slate-100 dark:border-slate-800/50",
                      hasNoBudget ? "bg-slate-50/50 dark:bg-slate-900/50" : "",
                      isNearLimit ? "bg-red-50/60 dark:bg-red-950/10" : "",
                      isMedium && !isNearLimit ? "bg-amber-50/40 dark:bg-amber-950/10" : "",
                      "hover:bg-slate-50 dark:hover:bg-slate-800/50"
                    )}
                  >
                    <TableCell className="pl-5 py-2.5">
                      <div className="flex items-center gap-2.5 min-w-0">
                        <div className={cn(
                          "w-2 h-2 rounded-full shrink-0",
                          (() => {
                            if (hasNoBudget) {
                              return "bg-slate-300"
                            }
                            if (isNearLimit) {
                              return "bg-red-500"
                            }
                            if (isMedium) {
                              return "bg-amber-500"
                            }
                            return "bg-emerald-500"
                          })()
                        )} />
                        <span className="font-semibold text-[13px] text-slate-800 dark:text-slate-200 truncate" title={budget.branchName}>
                          {budget.branchName}
                        </span>
                        <Badge
                          variant="outline"
                          className={cn(
                            "shrink-0 whitespace-nowrap rounded-md px-2 py-0.5 text-[9px] font-semibold uppercase tracking-widest",
                            rowBudgetAllocationMode === "quantity"
                              ? "border-indigo-200/70 bg-indigo-50/70 text-indigo-700 dark:border-indigo-500/20 dark:bg-indigo-500/10 dark:text-indigo-300"
                              : "border-sky-200/70 bg-sky-50/70 text-sky-700 dark:border-sky-500/20 dark:bg-sky-500/10 dark:text-sky-300"
                          )}
                        >
                          {BUDGET_ALLOCATION_MODE_LABELS[rowBudgetAllocationMode]}
                        </Badge>
                      </div>
                    </TableCell>

                    <TableCell className="text-right py-2.5">
                      <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400 tabular-nums">
                        {formatAmount(budget.baselineBudgetCents)}
                      </span>
                    </TableCell>

                    <TableCell className="text-right py-2.5">
                      {(budget.amountCreditedCents || 0) > 0 ? (
                        <span className="text-[13px] font-bold text-amber-600 dark:text-amber-400 tabular-nums">
                          +{formatAmount(budget.amountCreditedCents)}
                        </span>
                      ) : (
                        <span className="text-[13px] text-slate-300 dark:text-slate-700">—</span>
                      )}
                    </TableCell>

                    <TableCell className="text-right py-2.5">
                      <div className="flex flex-col items-end gap-1">
                        <span className="text-[13px] font-black text-slate-900 dark:text-white tabular-nums">
                          {formatAmount(totalBudget)}
                        </span>
                        {totalBudget > 0 && (
                          <div className="w-12 h-1 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                            <div
                              className={cn("h-full rounded-full transition-all duration-500", getStatusColor(spendingPercent))}
                              style={{ width: `${Math.min(100, spendingPercent)}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </TableCell>

                    <TableCell className="text-right py-2.5">
                      <span className="text-[13px] font-semibold text-rose-600 dark:text-rose-400 tabular-nums" title={`Spent: ${formatAmount(budget.amountSpentCents)} + Pending: ${formatAmount(budget.amountHeldCents)}`}>
                        {formatAmount(budget.amountSpentCents + budget.amountHeldCents)}
                      </span>
                    </TableCell>

                    <TableCell className="text-right py-2.5">
                      <span className={cn("text-[13px] font-black tabular-nums", budget.remainingCents < 0 ? "text-red-600" : "text-emerald-600 dark:text-emerald-400")}>
                        {formatAmount(budget.remainingCents)}
                      </span>
                    </TableCell>

                    <TableCell className="text-right pr-5 py-2.5">
                      <div className="flex gap-1.5 justify-end">
                        <Button
                          size="sm"
                          onClick={() => handleEditBudget(budget)}
                          disabled={rowIsQuantityBudgetMode}
                          title={rowMoneyAllocationDisabledTitle}
                          className="h-7 px-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white text-[10px] font-bold uppercase tracking-wide shadow-sm"
                        >
                          <Edit2 className="h-3 w-3 mr-1" />
                          Allocate
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => handleEmptyBudget(budget)}
                          disabled={rowIsQuantityBudgetMode}
                          className="h-7 w-7 p-0 rounded-lg text-slate-400 hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/20"
                          title={rowMoneyAllocationDisabledTitle || "Reset budget to zero"}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })
            )
            })()}
          </TableBody>
        </Table>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card className="p-6 border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
          <div className="flex items-center gap-3 mb-4">
            <PieChart className="h-5 w-5 text-blue-600" />
            <h3 className="font-bold text-lg text-slate-900 dark:text-white">Budget Overview</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">Spent (Inc. Pending)</span>
              <span className="font-bold text-slate-900 dark:text-white">{getPercentageOfTotal(totalSpent + totalHeld, totalAllocated)}%</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-slate-700 dark:text-slate-300">Available Remaining</span>
              <span className="font-bold text-green-600">{getPercentageOfTotal(totalRemaining, totalAllocated)}%</span>
            </div>
          </div>
        </Card>

        <Card className="p-6 border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-slate-900 dark:to-slate-900">
          <div className="flex items-center gap-3 mb-4">
            <Wallet className="h-5 w-5 text-blue-600" />
            <h3 className="font-bold text-lg text-slate-900 dark:text-white">At-Risk Branches</h3>
          </div>
          <div className="space-y-2">
            {scopedBudgets.some(b => getSpendingPercentage(b) >= 70) ? (
              <>
                <p className="text-2xl font-bold text-red-600">{scopedBudgets.filter(b => getSpendingPercentage(b) >= 90).length}</p>
                <p className="text-xs text-muted-foreground">Branches at/near budget limit ({scopedBudgets.filter(b => getSpendingPercentage(b) >= 90).length} at 90%+)</p>
              </>
            ) : (
              <p className="text-sm text-green-600 font-medium">All branches within safe limits</p>
            )}
          </div>
        </Card>
      </div>

      <Dialog open={showDialog} onOpenChange={setShowDialog}>
        <DialogContent className="max-w-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <DialogHeader>
            <DialogTitle className="text-slate-900 dark:text-white">Allocate Budget</DialogTitle>
            <DialogDescription className="text-slate-600 dark:text-slate-400">Configure budget allocation for {editingBudget?.branchName}.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="flex p-1 bg-slate-100 dark:bg-slate-800 rounded-xl border border-slate-200 dark:border-slate-700">
              <button type="button"
                onClick={() => setAllocationType("monthly")}
                className={cn(
                  "flex-1 py-2 text-xs font-bold rounded-lg transition-all",
                  allocationType === "monthly"
                    ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm"
                    : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                )}
              >
                Monthly Base
              </button>
              <button type="button"
                onClick={() => setAllocationType("addon")}
                className={cn(
                  "flex-1 py-2 text-xs font-bold rounded-lg transition-all",
                  allocationType === "addon"
                    ? "bg-white dark:bg-slate-700 text-indigo-600 dark:text-indigo-400 shadow-sm"
                    : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                )}
              >
                One-time Add-on
              </button>
            </div>

            {allocationType === "monthly" ? (
              <div className="p-3 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-100 dark:border-indigo-800/30 rounded-lg">
                <p className="text-[11px] text-indigo-700 dark:text-indigo-300 font-medium">
                  <strong>Monthly Base:</strong> This sets the recurring baseline budget for this branch. It will persist every month.
                </p>
              </div>
            ) : (
              <div className="p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-100 dark:border-amber-800/30 rounded-lg">
                <p className="text-[11px] text-amber-700 dark:text-amber-300 font-medium">
                  <strong>One-time Add-on:</strong> This adds extra budget for the current month ONLY. It will reset at the end of the month.
                </p>
              </div>
            )}
            <div className="p-4 bg-slate-100 dark:bg-slate-800 rounded-lg space-y-2 text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Monthly Budget</span>
                <span className="font-semibold">{formatAmount(editingBudget?.amountAllocatedCents || 0)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Spent (Incl. Pending)</span>
                <span className="font-semibold text-orange-600">{formatAmount((editingBudget?.amountSpentCents || 0) + (editingBudget?.amountHeldCents || 0))}</span>
              </div>
              <div className="h-px bg-border" />
              <div className="flex justify-between font-bold">
                <span>Remaining</span>
                <span className="text-green-600">{formatAmount(editingBudget?.remainingCents || 0)}</span>
              </div>
            </div>
            <div>
              <label htmlFor="budget-adjustment-amount" className="block text-sm font-semibold mb-2 text-slate-900 dark:text-white">
                {allocationType === "monthly" ? "New Baseline Amount (PKR)" : "Amount to Add (PKR)"}
              </label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">PKR</span>
                <Input id="budget-adjustment-amount" type="number" value={newAmount} onChange={(e) => setNewAmount(e.target.value)} placeholder="0.00" step="0.01" min="0" className="pl-12 text-lg font-bold h-11" />
              </div>
              <p className="text-xs text-blue-600 dark:text-blue-400 mt-2 font-medium">
                {allocationType === "monthly"
                  ? `Branch baseline will be updated to ${formatPKR(Number.parseFloat(newAmount || "0"))}`
                  : `New total budget will be: ${formatPKR((editingBudget?.amountAllocatedCents || 0) / 100 + (editingBudget?.amountCreditedCents || 0) / 100 + Number.parseFloat(newAmount || "0"))}`
                }
              </p>
              {(() => {
                const amt = Number.parseFloat(newAmount || "0")
                const amtCents = Math.round(amt * 100)
                const currentSpentCents = (editingBudget?.amountSpentCents || 0) + (editingBudget?.amountHeldCents || 0)
                let proposedTotalCents = 0
                if (allocationType === "monthly") {
                  proposedTotalCents = amtCents + (editingBudget?.amountCreditedCents || 0)
                } else {
                  proposedTotalCents = (editingBudget?.amountAllocatedCents || 0) + (editingBudget?.amountCreditedCents || 0) + amtCents
                }
                
                if (proposedTotalCents < currentSpentCents && newAmount) {
                  return (
                    <div className="mt-2 p-2 bg-rose-50 dark:bg-rose-950/20 border border-rose-200 dark:border-rose-800 rounded-lg flex items-center gap-2 animate-in fade-in slide-in-from-top-1">
                      <AlertCircle className="h-3.5 w-3.5 text-rose-600" />
                      <p className="text-[10px] font-black uppercase text-rose-600">Insufficient to cover ₨{(currentSpentCents/100).toFixed(2)} spent</p>
                    </div>
                  )
                }
                return null
              })()}
              <p className="text-xs text-muted-foreground mt-1">
                {allocationType === "monthly"
                  ? "Changes will affect future months automatically."
                  : "This amount will be added to the current month's allocation."}
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleSaveBudget} className="gap-2 bg-indigo-600 hover:bg-indigo-700 text-white">
              <CheckCircle2 className="h-4 w-4" />
              {allocationType === "monthly" ? "Update Baseline" : "Apply Add-on"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showBulkDialog} onOpenChange={setShowBulkDialog}>
        <DialogContent className="max-w-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <DialogHeader>
            <DialogTitle className="text-slate-900 dark:text-white">Allocate Budget to All Branches</DialogTitle>
            <DialogDescription>
              Quickly allocate the same monthly budget to {moneyBasedScopedBudgets.length} money-based branches in the current context.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-4 bg-blue-50 dark:bg-blue-950 rounded-lg">
              <p className="text-sm font-medium text-blue-900 dark:text-blue-100">
                This will update eligible money-based branches to the same amount.
              </p>
            </div>
            {quantityBasedScopedBudgetCount > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-800/50 dark:bg-amber-950/20">
                <p className="text-xs font-semibold text-amber-800 dark:text-amber-300">
                  {quantityBasedScopedBudgetCount} quantity-based branch{quantityBasedScopedBudgetCount === 1 ? "" : "es"} will not be included in this bulk allocation.
                </p>
              </div>
            )}
            <div>
              <label htmlFor="bulk-budget-amount" className="block text-sm font-semibold mb-2 text-slate-900 dark:text-white">Monthly Budget Amount (PKR)</label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-xs font-semibold text-muted-foreground">PKR</span>
                <Input id="bulk-budget-amount" type="number" value={bulkAmount} onChange={(e) => setBulkAmount(e.target.value)} placeholder="0.00" step="0.01" min="0" className="pl-12 text-lg font-bold h-11" />
              </div>
              <p className="text-xs text-muted-foreground mt-2">
                This amount will be assigned to {moneyBasedScopedBudgets.length} money-based branch{moneyBasedScopedBudgets.length === 1 ? "" : "es"} currently in view.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBulkDialog(false)}>Cancel</Button>
            <Button onClick={handleBulkAllocate} disabled={moneyBasedScopedBudgets.length === 0} className="gap-2">
              <Zap className="h-4 w-4" />
              Allocate All Branches
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEmptyDialog} onOpenChange={setShowEmptyDialog}>
        <DialogContent className="max-w-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <DialogHeader>
            <DialogTitle className="text-slate-900 dark:text-white">Empty Budget Confirmation</DialogTitle>
            <DialogDescription className="text-slate-600 dark:text-slate-400">
              Are you sure you want to reset the budget for {emptyingBudget?.branchName} to ₨0.00?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-4 bg-red-50 dark:bg-red-950 rounded-lg border border-red-200 dark:border-red-800">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
                <div className="space-y-1">
                  <p className="text-sm font-medium text-red-900 dark:text-red-100">This will reset the allocated budget to zero</p>
                  <p className="text-xs text-red-700 dark:text-red-300">Current budget: {formatAmount(emptyingBudget?.amountAllocatedCents || 0)}</p>
                  <p className="text-xs text-red-700 dark:text-red-300">This action can be reversed by allocating a new budget.</p>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEmptyDialog(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleConfirmEmptyBudget} className="gap-2">
              <Trash2 className="h-4 w-4" />
              Empty Budget
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showEmptyAllDialog} onOpenChange={setShowEmptyAllDialog}>
        <DialogContent className="max-w-md border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900">
          <DialogHeader>
            <DialogTitle className="text-slate-900 dark:text-white">Empty All Budgets Confirmation</DialogTitle>
            <DialogDescription>
              Are you sure you want to reset ALL {scopedBudgets.length} branch budgets to ₨0.00?
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="p-4 bg-red-50 dark:bg-red-950 rounded-lg border border-red-200 dark:border-red-800">
              <div className="flex items-start gap-3">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400 mt-0.5" />
                <div className="space-y-2">
                  <p className="text-sm font-medium text-red-900 dark:text-red-100">This will reset ALL branch budgets in the current view to zero</p>
                  <p className="text-xs text-red-700 dark:text-red-300">Total allocated: {formatAmount(totalAllocated)}</p>
                  <p className="text-xs text-red-700 dark:text-red-300">Branches affected: {scopedBudgets.length}</p>
                  <p className="text-xs text-red-700 dark:text-red-300">This action can be reversed by allocating new budgets.</p>
                </div>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEmptyAllDialog(false)}>Cancel</Button>
            <Button variant="destructive" onClick={handleEmptyAllBudgets} className="gap-2">
              <Trash2 className="h-4 w-4" />
              Empty All Budgets
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
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
  isLoading = false,
}: Readonly<{
  label: string
  value: string | number
  icon: ReactNode
  gradient: string
  iconBadge: string
  isLoading?: boolean
}>) {
  return (
    <Card className={cn("border rounded-2xl shadow-sm transition-all duration-300 hover:shadow-md hover:-translate-y-0.5 [container-type:inline-size]", gradient)}>
      <CardContent className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-1.5 p-3">
        <div className="min-w-0 space-y-1.5">
          <p className="text-[10px] font-bold opacity-80 uppercase tracking-widest">
            {label}
          </p>
          {isLoading ? (
            <div className="h-8 w-20 rounded-md bg-slate-300/40 dark:bg-slate-600/40 animate-pulse" />
          ) : (
            <p className="whitespace-nowrap text-[clamp(1.05rem,8.5cqw,2.1rem)] font-black leading-tight tracking-tight tabular-nums">
              {value}
            </p>
          )}
        </div>
        <div className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-xl 2xl:h-12 2xl:w-12", iconBadge)}>
           {icon}
        </div>
      </CardContent>
    </Card>
  )
}
