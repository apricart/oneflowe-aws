"use client"

import React,{ useCallback,useEffect,useMemo,useState } from "react"
import useSWR,{ useSWRConfig } from "swr"
import { useSession } from "next-auth/react"
import {
  AlertCircle,ChevronDown,
  ChevronRight,
  Edit2,
  PackageCheck,
  PackagePlus,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X
} from "lucide-react"

import { useToast } from "@/hooks/use-toast"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog,DialogContent,DialogDescription,DialogFooter,DialogHeader,DialogTitle } from "@/components/ui/dialog"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { BranchFilter } from "@/components/reports/branch-filter"
import { GroupFilter } from "@/components/reports/group-filter"
import { useAppContext } from "@/components/context/app-context"
import { GlobalDateFilter,type FilterPreset,type GlobalDateFilterChange } from "@/components/dashboard/global-date-filter"
import { cn } from "@/lib/utils"
import { formatQuantity,parseQuantity,validateProductQuantity } from "@/lib/quantity"
import { BUDGET_ALLOCATION_MODE_SETTING_KEY,parseBudgetAllocationMode } from "@/lib/budget-allocation-mode"
import { type DateRange } from "@/lib/hooks/use-sales-performance"

const fetcher = (url: string) => fetch(url).then((r) => r.json())

interface BudgetAllocation {
  branchId: number
  branchName: string
  organizationId: number
  groupId?: number
  groupName?: string
}

interface ProductOption {
  id: number
  productCode?: string | null
  name?: string | null
  productName?: string | null
  customName?: string | null
  unit?: string | null
  basePrice?: number | string | null
  customPrice?: number | string | null
  isEnabled?: boolean | null
  isAvailable?: boolean | null
  allowDecimalQuantity?: boolean | null
  quantityStep?: number | null
}

interface QuantityAllocationLine {
  id: string
  productId: string
  quantity: string
}

interface QuantityBranchSummary {
  branchId: number
  baseQuantity: number
  addonQuantity: number
  totalQuantity: number
  spentQuantity: number
  remainingQuantity: number
  productCount: number
}

interface QuantityProductSummary {
  quantityBudgetId: number
  branchId: number
  organizationInventoryId: number
  globalProductId: number
  productCode?: string | null
  productName: string
  unit?: string | null
  baseQuantity: number
  addonQuantity: number
  totalQuantity: number
  spentQuantity: number
  remainingQuantity: number
}

const createAllocationLine = (): QuantityAllocationLine => ({
  id: crypto.randomUUID(),
  productId: "",
  quantity: "",
})

const toCents = (value: number | string | null | undefined) => {
  if (value === null || value === undefined) return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const getProductName = (product?: ProductOption) => product?.customName || product?.productName || product?.name || "Select product"

const getProductPriceCents = (product?: ProductOption) => {
  if (!product) return null
  return toCents(product.customPrice) ?? toCents(product.basePrice)
}

const emptyQuantitySummary = (branchId: number): QuantityBranchSummary => ({
  branchId,
  baseQuantity: 0,
  addonQuantity: 0,
  totalQuantity: 0,
  spentQuantity: 0,
  remainingQuantity: 0,
  productCount: 0,
})

const getQuantityAllocationError = (error: unknown) => {
  const message = typeof error === "string" ? error : ""
  if (!message) return "Quantity allocation failed."

  if (/(amount|budget value|current total spent|pkr|pric|spent)/i.test(message)) {
    return "Quantity allocation could not be applied with the selected products and quantities."
  }

  return message
}

export default function BudgetByQuantityPage() {
  const { data: session, status } = useSession()
  const { toast } = useToast()
  const { mutate: globalMutate } = useSWRConfig()
  const role = (session?.user as any)?.role
  const isHeadOffice = role === "HEAD_OFFICE" || role === "SUPER_ADMIN"
  const {
    organizationId,
    branchIds: contextBranchIds,
    setBranchIds: setContextBranchIds,
    isInitialized,
  } = useAppContext()

  const [searchQuery, setSearchQuery] = useState("")
  const [editingBudget, setEditingBudget] = useState<BudgetAllocation | null>(null)
  const [showDialog, setShowDialog] = useState(false)
  const [allocationType, setAllocationType] = useState<"monthly" | "addon">("addon")
  const [allocationLines, setAllocationLines] = useState<QuantityAllocationLine[]>(() => [createAllocationLine()])
  const [isSavingAllocation, setIsSavingAllocation] = useState(false)
  const [showEmptyAllDialog, setShowEmptyAllDialog] = useState(false)
  const [isResettingBudgets, setIsResettingBudgets] = useState(false)
  const [expandedBranchIds, setExpandedBranchIds] = useState<number[]>([])

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

  const applyDateFilterParams = useCallback((params: URLSearchParams) => {
    if (dateRange) {
      params.set("startDate", dateRange.startDate.toISOString())
      params.set("endDate", dateRange.endDate.toISOString())
    }
    params.set("preset", activePreset)
    if (selectedMonths.length > 0) params.set("months", selectedMonths.join(","))
    const effectiveSelectedYears = selectedMonths.length > 0 && selectedYears.length === 0 && !dateRange
      ? [new Date().getFullYear()]
      : selectedYears
    if (effectiveSelectedYears.length > 0) params.set("years", effectiveSelectedYears.join(","))
  }, [activePreset, dateRange, selectedMonths, selectedYears])

  const settingsEndpoint = useMemo(() => {
    if (!isHeadOffice || !isInitialized || !organizationId) return null
    return `/api/v1/settings?organizationId=${organizationId}`
  }, [isHeadOffice, isInitialized, organizationId])
  const { data: settingsData, isLoading: settingsLoading } = useSWR<any>(settingsEndpoint, fetcher)
  const budgetAllocationMode = parseBudgetAllocationMode(
    settingsData?.data?.find((setting: any) => setting.key === BUDGET_ALLOCATION_MODE_SETTING_KEY)?.value
  )
  const isQuantityBudgetMode = budgetAllocationMode === "quantity"

  const budgetsEndpoint = useMemo(() => {
    if (!isHeadOffice || !isInitialized || !organizationId || !isQuantityBudgetMode) return null

    const params = new URLSearchParams()
    params.set("all", "true")
    if (organizationId) params.set("organizationId", String(organizationId))
    applyDateFilterParams(params)
    if (selectedGroupIds.length > 0) params.set("groupIds", selectedGroupIds.join(","))
    if (contextBranchIds.length > 0) params.set("branchIds", contextBranchIds.join(","))

    return `/api/v1/budgets?${params.toString()}`
  }, [applyDateFilterParams, contextBranchIds, isHeadOffice, isInitialized, isQuantityBudgetMode, organizationId, selectedGroupIds])

  const quantityBudgetsEndpoint = useMemo(() => {
    if (!isHeadOffice || !isInitialized || !organizationId || !isQuantityBudgetMode) return null

    const params = new URLSearchParams()
    if (organizationId) params.set("organizationId", String(organizationId))
    applyDateFilterParams(params)
    if (selectedGroupIds.length > 0) params.set("groupIds", selectedGroupIds.join(","))
    if (contextBranchIds.length > 0) params.set("branchIds", contextBranchIds.join(","))

    return `/api/v1/budget-quantity?${params.toString()}`
  }, [applyDateFilterParams, contextBranchIds, isHeadOffice, isInitialized, isQuantityBudgetMode, organizationId, selectedGroupIds])

  const dialogProductsEndpoint = useMemo(() => {
    if (!showDialog || !editingBudget) return null

    const params = new URLSearchParams()
    params.set("branchId", String(editingBudget.branchId))
    params.set("organizationId", String(editingBudget.organizationId))

    params.set("limit", "500")

    return `/api/v1/branch/inventory?${params.toString()}`
  }, [editingBudget, showDialog])

  const { data: budgetsData, mutate } = useSWR<any>(budgetsEndpoint, fetcher)
  const { data: quantityBudgetsData, mutate: mutateQuantityBudgets } = useSWR<any>(quantityBudgetsEndpoint, fetcher)
  const { data: dialogProductsData, isLoading: productsLoading } = useSWR<any>(dialogProductsEndpoint, fetcher)

  const budgets: BudgetAllocation[] = budgetsData?.budgets || []
  const quantityBranchSummaries: QuantityBranchSummary[] = quantityBudgetsData?.branches || []
  const quantityProductSummaries: QuantityProductSummary[] = quantityBudgetsData?.products || []
  const dialogProducts: ProductOption[] = dialogProductsData?.items || []
  const productsById = useMemo(() => {
    return new Map(dialogProducts.map((product) => [String(product.id), product]))
  }, [dialogProducts])

  const scopedBudgets = useMemo(() => {
    return budgets.filter((budget) => {
      if (organizationId && String(budget.organizationId) !== String(organizationId)) return false
      if (selectedGroupIds.length > 0 && budget.groupId && !selectedGroupIds.includes(String(budget.groupId))) return false
      if (contextBranchIds.length > 0 && !contextBranchIds.includes(String(budget.branchId))) return false
      return true
    })
  }, [budgets, contextBranchIds, organizationId, selectedGroupIds])

  const filteredBudgets = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return scopedBudgets

    return scopedBudgets.filter((budget) =>
      budget.branchName.toLowerCase().includes(query) ||
      budget.branchId.toString().includes(query) ||
      budget.groupName?.toLowerCase().includes(query)
    )
  }, [scopedBudgets, searchQuery])

  const quantitySummaryByBranchId = useMemo(() => {
    return new Map(quantityBranchSummaries.map((summary) => [summary.branchId, summary]))
  }, [quantityBranchSummaries])

  const quantityProductsByBranchId = useMemo(() => {
    return quantityProductSummaries.reduce((productsByBranch, product) => {
      const products = productsByBranch.get(product.branchId) || []
      products.push(product)
      productsByBranch.set(product.branchId, products)
      return productsByBranch
    }, new Map<number, QuantityProductSummary[]>())
  }, [quantityProductSummaries])

  const allocationSummary = useMemo(() => {
    return allocationLines.reduce(
      (summary, line) => {
        const product = productsById.get(line.productId)
        const quantity = parseQuantity(line.quantity)
        const validation = validateProductQuantity(quantity, {
          allowDecimalQuantity: product?.allowDecimalQuantity,
          quantityStep: product?.quantityStep,
        })

        if (!product || !validation.ok) return summary

        summary.totalQuantity += validation.quantity
        summary.items += 1
        return summary
      },
      { items: 0, totalQuantity: 0 }
    )
  }, [allocationLines, productsById])

  const scopedQuantitySummary = useMemo(() => {
    return scopedBudgets.reduce(
      (summary, budget) => {
        const branchSummary = quantitySummaryByBranchId.get(budget.branchId) || emptyQuantitySummary(budget.branchId)
        summary.baseQuantity += branchSummary.baseQuantity
        summary.addonQuantity += branchSummary.addonQuantity
        summary.spentQuantity += branchSummary.spentQuantity
        summary.remainingQuantity += branchSummary.remainingQuantity
        summary.totalQuantity += branchSummary.totalQuantity
        return summary
      },
      {
        baseQuantity: 0,
        addonQuantity: 0,
        spentQuantity: 0,
        remainingQuantity: 0,
        totalQuantity: 0,
      }
    )
  }, [scopedBudgets, quantitySummaryByBranchId])

  const resetBudgetFilters = useCallback(() => {
    handleDateChange({ range: null, preset: "all" })
    setSelectedGroupIds([])
    setContextBranchIds([])
    setSearchQuery("")
    mutate()
    mutateQuantityBudgets()
  }, [handleDateChange, mutate, mutateQuantityBudgets, setContextBranchIds])

  const handleEditBudget = (budget: BudgetAllocation) => {
    setEditingBudget(budget)
    setAllocationType("addon")
    setAllocationLines([createAllocationLine()])
    setShowDialog(true)
  }

  const toggleBranchProducts = (branchId: number) => {
    setExpandedBranchIds((current) =>
      current.includes(branchId)
        ? current.filter((id) => id !== branchId)
        : [...current, branchId]
    )
  }

  const updateAllocationLine = (lineId: string, patch: Partial<QuantityAllocationLine>) => {
    setAllocationLines((current) =>
      current.map((line) => (line.id === lineId ? { ...line, ...patch } : line))
    )
  }

  const addAllocationLine = () => {
    setAllocationLines((current) => [...current, createAllocationLine()])
  }

  const removeAllocationLine = (lineId: string) => {
    setAllocationLines((current) =>
      current.length === 1 ? [createAllocationLine()] : current.filter((line) => line.id !== lineId)
    )
  }

  const validateAllocation = () => {
    if (!editingBudget) return "Select a branch before allocating quantity."
    if (allocationSummary.items === 0) return "Select at least one product and enter a positive quantity."

    const selectedProductIds = allocationLines
      .map((line) => line.productId)
      .filter(Boolean)
    if (new Set(selectedProductIds).size !== selectedProductIds.length) {
      return "Each product can only appear once in a quantity allocation."
    }

    for (const line of allocationLines) {
      if (!line.productId && !line.quantity) continue

      const product = productsById.get(line.productId)
      const quantity = parseQuantity(line.quantity)
      const priceCents = getProductPriceCents(product)

      if (!product) return "Select a product for every allocation row."
      const quantityValidation = validateProductQuantity(quantity, {
        allowDecimalQuantity: product.allowDecimalQuantity,
        quantityStep: product.quantityStep,
        label: `Quantity for ${getProductName(product)}`,
      })
      if (!quantityValidation.ok) return quantityValidation.error
      if (priceCents === null || priceCents <= 0) {
        return `${getProductName(product)} is not available for quantity allocation right now.`
      }
    }

    return null
  }

  const handleEmptyAllBudgets = async () => {
    if (!organizationId) {
      return toast({
        title: "Organization required",
        description: "Select an organization before resetting quantity budgets.",
        variant: "destructive",
      })
    }

    setIsResettingBudgets(true)
    try {
      const res = await fetch("/api/v1/budget-quantity", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationId,
          branchIds: contextBranchIds,
          groupIds: selectedGroupIds,
        }),
      })

      const json = await res.json()
      if (!res.ok) {
        return toast({
          title: "Reset failed",
          description: json.error || "Quantity budgets could not be reset.",
          variant: "destructive",
        })
      }

      toast({
        title: "Quantity budgets emptied",
        description: `Reset ${json.reset?.branchCount ?? scopedBudgets.length} branch budget${(json.reset?.branchCount ?? scopedBudgets.length) === 1 ? "" : "s"} to zero.`,
      })
      setShowEmptyAllDialog(false)
      setExpandedBranchIds([])
      mutate()
      mutateQuantityBudgets()
      globalMutate((key) =>
        typeof key === "string" &&
        (key.includes("/api/v1/analytics/budgets/summary") ||
          key.includes("/api/v1/budgets") ||
          key.includes("/api/v1/budget-quantity"))
      )
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" })
    } finally {
      setIsResettingBudgets(false)
    }
  }

  const handleSaveQuantityAllocation = async () => {
    const validationError = validateAllocation()
    if (validationError || !editingBudget) {
      return toast({ title: "Allocation blocked", description: validationError || "Invalid quantity allocation.", variant: "destructive" })
    }

    setIsSavingAllocation(true)
    try {
      const res = await fetch("/api/v1/budget-quantity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          branchId: editingBudget.branchId,
          items: allocationLines
            .filter((line) => line.productId && line.quantity)
            .map((line) => ({
              branchInventoryId: Number(line.productId),
              quantity: parseQuantity(line.quantity),
            })),
          type: allocationType,
        }),
      })

      if (!res.ok) {
        const json = await res.json()
        return toast({ title: "Failed", description: getQuantityAllocationError(json.error), variant: "destructive" })
      }

      toast({
        title: "Quantity budget allocated",
        description: `${allocationSummary.totalQuantity} units across ${allocationSummary.items} product${allocationSummary.items === 1 ? "" : "s"} allocated to ${editingBudget.branchName}.`,
      })
      setShowDialog(false)
      setEditingBudget(null)
      setAllocationLines([createAllocationLine()])
      mutate()
      mutateQuantityBudgets()
      globalMutate((key) => typeof key === "string" && key.includes("/api/v1/analytics/budgets/summary"))
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" })
    } finally {
      setIsSavingAllocation(false)
    }
  }

  if (status === "loading" || settingsLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <RefreshCw className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  if (!isHeadOffice) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
          <p className="text-muted-foreground">You do not have permission to access this page</p>
        </Card>
      </div>
    )
  }

  if (!organizationId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-muted-foreground" />
          <p className="text-muted-foreground">Select an organization to manage quantity budgets.</p>
        </Card>
      </div>
    )
  }

  if (!isQuantityBudgetMode) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Card className="p-8 text-center">
          <AlertCircle className="mx-auto mb-4 h-12 w-12 text-destructive" />
          <p className="text-muted-foreground">This organization uses money-value budgeting. Quantity budgeting is not available.</p>
        </Card>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#f8fafc] pb-20 dark:bg-[#020617]">
      <div className="sticky top-0 z-30 w-full border-b border-slate-200 bg-white/80 shadow-sm backdrop-blur-xl transition-all duration-300 dark:border-slate-800 dark:bg-slate-950/80">
        <div className="mx-auto flex max-w-[1600px] flex-wrap items-center justify-between gap-4 px-6 py-4">
          <div className="flex items-center gap-4">
            <div className="group flex h-12 w-12 rotate-3 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-600 to-purple-700 shadow-lg shadow-indigo-500/20 transition-all duration-500 hover:rotate-0">
              <PackagePlus className="h-6 w-6 text-white" />
            </div>
            <div>
              <h1 className="text-xl font-black uppercase tracking-tight text-slate-900 dark:text-white">Budget by Quantity</h1>
              <p className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-400">
                <PackageCheck className="h-3.5 w-3.5" />
                Product Quantity Allocation
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
              <div className="flex h-6 items-center gap-2 border-l border-slate-200 pl-3 dark:border-slate-800">
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
            <Button
              variant="ghost"
              size="icon"
              className="ml-2 rounded-xl border border-slate-200 bg-white text-slate-400 transition-colors hover:text-indigo-500 dark:border-slate-800 dark:bg-slate-900"
              onClick={resetBudgetFilters}
            >
              <RefreshCw className={cn("h-4 w-4", (!budgetsData || !quantityBudgetsData) && "animate-spin")} />
            </Button>
          </div>
        </div>
      </div>

      <div className="mx-auto max-w-[1600px] space-y-6 p-4 md:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full sm:w-96">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <input
              type="text"
              placeholder="Search branches or groups..."
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="w-full rounded-xl border border-slate-200 bg-white py-2 pl-10 pr-4 text-sm font-bold uppercase tracking-tight outline-none transition-all focus:ring-2 focus:ring-blue-500 dark:border-slate-800 dark:bg-slate-900"
            />
          </div>
          <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:items-center">
            <Badge className="w-fit rounded-full bg-slate-900 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-white dark:bg-white dark:text-slate-950">
              {filteredBudgets.length} branch{filteredBudgets.length === 1 ? "" : "es"} ready for quantity allocation
            </Badge>
            <Button
              variant="outline"
              onClick={() => setShowEmptyAllDialog(true)}
              disabled={scopedBudgets.length === 0 || isResettingBudgets}
              className="w-fit rounded-xl border-slate-200 px-4 text-[10px] font-bold uppercase tracking-widest text-rose-600 transition-colors hover:bg-rose-50 dark:border-slate-800 dark:hover:bg-rose-950/20"
            >
              {isResettingBudgets ? <RefreshCw className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-2 h-3.5 w-3.5" />}
              Empty All
            </Button>
          </div>
        </div>

        <Card className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900 dark:shadow-slate-900/50">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-slate-200 bg-gradient-to-r from-slate-50 to-slate-100 dark:border-slate-700 dark:from-slate-900 dark:to-slate-800">
                <TableHead className="pl-5 text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Branch</TableHead>
                <TableHead className="text-left text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Group</TableHead>
                <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Base Quantity</TableHead>
                <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Add-on Quantity</TableHead>
                <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-indigo-500">Total Quantity</TableHead>
                <TableHead className="pr-5 text-right text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Quantity Allocation</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(() => {
                if (budgets.length === 0) {
                  return (
                <TableRow>
                  <TableCell colSpan={6} className="py-16 text-center">
                    <PackageCheck className="mx-auto mb-3 h-8 w-8 text-indigo-500 opacity-40" />
                    <p className="text-sm text-muted-foreground">No branches found</p>
                  </TableCell>
                </TableRow>
              )
                }
                if (filteredBudgets.length === 0) {
                  return (
                <TableRow>
                  <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                    No branches match your search
                  </TableCell>
                </TableRow>
              )
                }
                return (
                filteredBudgets.map((budget) => {
                  const summary = quantitySummaryByBranchId.get(budget.branchId) || emptyQuantitySummary(budget.branchId)
                  const productRows = quantityProductsByBranchId.get(budget.branchId) || []
                  const isExpanded = expandedBranchIds.includes(budget.branchId)

                  return (
                    <React.Fragment key={budget.branchId}>
                      <TableRow
                        role="button"
                        tabIndex={0}
                        aria-expanded={isExpanded}
                        onClick={() => toggleBranchProducts(budget.branchId)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            toggleBranchProducts(budget.branchId)
                          }
                        }}
                        className="cursor-pointer border-b border-slate-100 transition-colors hover:bg-slate-50 focus-visible:bg-indigo-50 focus-visible:outline-none dark:border-slate-800/50 dark:hover:bg-slate-800/50 dark:focus-visible:bg-indigo-950/20"
                      >
                        <TableCell className="py-2.5 pl-5">
                          <div className="flex min-w-0 items-center gap-2">
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              aria-label={`${isExpanded ? "Hide" : "Show"} product quantity details for ${budget.branchName}`}
                              aria-expanded={isExpanded}
                              onClick={(event) => {
                                event.stopPropagation()
                                toggleBranchProducts(budget.branchId)
                              }}
                              className="h-7 w-7 shrink-0 rounded-md text-slate-500"
                            >
                              {isExpanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
                            </Button>
                            <div className="h-2 w-2 shrink-0 rounded-full bg-indigo-500" />
                            <span className="truncate text-[13px] font-semibold text-slate-800 dark:text-slate-200" title={budget.branchName}>
                              {budget.branchName}
                            </span>
                          </div>
                        </TableCell>
                        <TableCell className="py-2.5">
                          <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">
                            {budget.groupName || "Ungrouped"}
                          </span>
                        </TableCell>
                        <TableCell className="py-2.5 text-right text-[13px] font-bold tabular-nums text-slate-700 dark:text-slate-200">
                          {formatQuantity(summary.baseQuantity)}
                        </TableCell>
                        <TableCell className="py-2.5 text-right text-[13px] font-bold tabular-nums text-slate-700 dark:text-slate-200">
                          {formatQuantity(summary.addonQuantity)}
                        </TableCell>
                        <TableCell className="py-2.5 text-right text-[13px] font-black tabular-nums text-indigo-600 dark:text-indigo-300">
                          {formatQuantity(summary.totalQuantity)}
                        </TableCell>
                        <TableCell className="py-2.5 pr-5 text-right">
                          <Button
                            size="sm"
                            onClick={(event) => {
                              event.stopPropagation()
                              handleEditBudget(budget)
                            }}
                            className="h-7 rounded-lg bg-indigo-600 px-2.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm hover:bg-indigo-700"
                          >
                            <Edit2 className="mr-1 h-3 w-3" />
                            Allocate
                          </Button>
                        </TableCell>
                      </TableRow>

                      {isExpanded && (
                        <TableRow className="border-b border-slate-100 bg-indigo-50/40 hover:bg-indigo-50/40 dark:border-slate-800/50 dark:bg-indigo-950/10 dark:hover:bg-indigo-950/10">
                          <TableCell colSpan={6} className="px-5 py-4">
                            {(() => {
                              if (productRows.length === 0) {
                                return (
                              <div className="rounded-lg border border-dashed border-slate-200 bg-white px-4 py-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
                                No product quantity allocations for this branch yet.
                              </div>
                            )
                              }
                              return (
                              <div className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-slate-700 dark:bg-slate-900">
                                <Table>
                                  <TableHeader>
                                    <TableRow className="bg-slate-50 dark:bg-slate-800/70">
                                      <TableHead className="pl-4 text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Product Name</TableHead>
                                      <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Base Quantity</TableHead>
                                      <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Add-on Quantity</TableHead>
                                      <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Total Budget Quantity</TableHead>
                                      <TableHead className="text-right text-[10px] font-black uppercase tracking-widest text-slate-500 dark:text-slate-400">Spent</TableHead>
                                      <TableHead className="pr-4 text-right text-[10px] font-black uppercase tracking-widest text-emerald-600 dark:text-emerald-400">Remaining</TableHead>
                                    </TableRow>
                                  </TableHeader>
                                  <TableBody>
                                    {productRows.map((product) => (
                                      <TableRow key={product.quantityBudgetId} className="border-b border-slate-100 last:border-b-0 dark:border-slate-800">
                                        <TableCell className="py-2.5 pl-4">
                                          <div className="min-w-0">
                                            <p className="truncate text-[13px] font-semibold text-slate-900 dark:text-white" title={product.productName}>
                                              {product.productName}
                                            </p>
                                            {(product.productCode || product.unit) && (
                                              <p className="truncate text-[11px] font-medium text-slate-400">
                                                {[product.productCode, product.unit].filter(Boolean).join(" / ")}
                                              </p>
                                            )}
                                          </div>
                                        </TableCell>
                                        <TableCell className="py-2.5 text-right text-[13px] font-bold tabular-nums text-slate-700 dark:text-slate-200">
                                          {formatQuantity(product.baseQuantity)}
                                        </TableCell>
                                        <TableCell className="py-2.5 text-right text-[13px] font-bold tabular-nums text-slate-700 dark:text-slate-200">
                                          {formatQuantity(product.addonQuantity)}
                                        </TableCell>
                                        <TableCell className="py-2.5 text-right text-[13px] font-black tabular-nums text-indigo-600 dark:text-indigo-300">
                                          {formatQuantity(product.totalQuantity)}
                                        </TableCell>
                                        <TableCell className="py-2.5 text-right text-[13px] font-bold tabular-nums text-rose-600 dark:text-rose-300">
                                          {formatQuantity(product.spentQuantity)}
                                        </TableCell>
                                        <TableCell className={cn(
                                          "py-2.5 pr-4 text-right text-[13px] font-black tabular-nums",
                                          product.remainingQuantity < 0 ? "text-rose-600 dark:text-rose-300" : "text-emerald-600 dark:text-emerald-300"
                                        )}>
                                          {formatQuantity(product.remainingQuantity)}
                                        </TableCell>
                                      </TableRow>
                                    ))}
                                  </TableBody>
                                </Table>
                              </div>
                            )
                            })()}
                          </TableCell>
                        </TableRow>
                      )}
                    </React.Fragment>
                  )
                })
              )
              })()}
            </TableBody>
          </Table>
        </Card>

        <Dialog open={showDialog} onOpenChange={setShowDialog}>
          <DialogContent className="max-w-3xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <DialogHeader>
              <DialogTitle className="text-slate-900 dark:text-white">Allocate Budget by Quantity</DialogTitle>
              <DialogDescription className="text-slate-600 dark:text-slate-400">
                Select products and quantities for {editingBudget?.branchName}.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-950 md:grid-cols-3">
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Branch</p>
                  <p className="truncate text-sm font-bold text-slate-900 dark:text-white">{editingBudget?.branchName}</p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Selected Products</p>
                  <p className="text-sm font-bold text-indigo-600">{allocationSummary.items}</p>
                </div>
                <div>
                  <p className="text-[10px] font-black uppercase tracking-widest text-slate-400">Quantity To Allocate</p>
                  <p className="text-sm font-bold text-emerald-600">{allocationSummary.totalQuantity} units</p>
                </div>
              </div>

              <div className="flex rounded-xl border border-slate-200 bg-slate-100 p-1 dark:border-slate-700 dark:bg-slate-800">
                <button type="button"
                  onClick={() => setAllocationType("addon")}
                  className={cn(
                    "flex-1 rounded-lg py-2 text-xs font-bold transition-all",
                    allocationType === "addon"
                      ? "bg-white text-indigo-600 shadow-sm dark:bg-slate-700 dark:text-indigo-400"
                      : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                  )}
                >
                  One-time Quantity Add-on
                </button>
                <button type="button"
                  onClick={() => setAllocationType("monthly")}
                  className={cn(
                    "flex-1 rounded-lg py-2 text-xs font-bold transition-all",
                    allocationType === "monthly"
                      ? "bg-white text-indigo-600 shadow-sm dark:bg-slate-700 dark:text-indigo-400"
                      : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"
                  )}
                >
                  Monthly Quantity Baseline
                </button>
              </div>

              <div className="space-y-3">
                {allocationLines.map((line, index) => {
                  const selectedProduct = productsById.get(line.productId)
                  const quantityStep = selectedProduct?.allowDecimalQuantity
                    ? selectedProduct.quantityStep || 0.1
                    : 1

                  return (
                    <div key={line.id} className="grid grid-cols-1 gap-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-slate-800 dark:bg-slate-950 md:grid-cols-[minmax(0,1fr)_160px_36px]">
                      <div className="min-w-0">
                        <label htmlFor={`budget-product-${line.id}`} className="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400">
                          Product {index + 1}
                        </label>
                        <Select
                          value={line.productId}
                          onValueChange={(value) => updateAllocationLine(line.id, { productId: value })}
                          disabled={productsLoading}
                        >
                          <SelectTrigger id={`budget-product-${line.id}`} className="h-10 w-full">
                            <SelectValue placeholder={productsLoading ? "Loading products..." : "Select product"} />
                          </SelectTrigger>
                          <SelectContent>
                            {dialogProducts.map((productOption) => {
                              const productLabel = getProductName(productOption)

                              return (
                                <SelectItem key={productOption.id} value={String(productOption.id)}>
                                  {productOption.productCode ? `${productOption.productCode} - ` : ""}
                                  {productLabel}
                                  {productOption.unit ? ` (${productOption.unit})` : ""}
                                </SelectItem>
                              )
                            })}
                          </SelectContent>
                        </Select>
                      </div>

                      <div>
                        <label htmlFor={`budget-quantity-${line.id}`} className="mb-1 block text-[10px] font-black uppercase tracking-widest text-slate-400">Quantity</label>
                        <Input
                          id={`budget-quantity-${line.id}`}
                          type="number"
                          inputMode="decimal"
                          min={quantityStep}
                          step={quantityStep}
                          value={line.quantity}
                          onChange={(event) => updateAllocationLine(line.id, { quantity: event.target.value })}
                          placeholder="0"
                          className="h-10 font-bold"
                        />
                      </div>

                      <div className="flex items-end">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-10 w-10 rounded-lg text-slate-400 hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-950/20"
                          onClick={() => removeAllocationLine(line.id)}
                        >
                          {allocationLines.length === 1 ? <X className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="flex flex-col gap-3 rounded-xl border border-indigo-100 bg-indigo-50 p-4 dark:border-indigo-800/30 dark:bg-indigo-900/20 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="text-sm font-bold text-indigo-900 dark:text-indigo-100">
                    {allocationSummary.totalQuantity} total units across {allocationSummary.items} product{allocationSummary.items === 1 ? "" : "s"}
                  </p>
                </div>
                <Button type="button" variant="outline" onClick={addAllocationLine} className="gap-2 rounded-xl bg-white font-bold dark:bg-slate-950">
                  <Plus className="h-4 w-4" />
                  Add Product
                </Button>
              </div>

              {dialogProductsData?.pricesHidden && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-medium text-amber-800 dark:border-amber-800 dark:bg-amber-950/20 dark:text-amber-300">
                  Quantity allocation is not available for this role or context.
                </div>
              )}
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => setShowDialog(false)} disabled={isSavingAllocation}>
                Cancel
              </Button>
              <Button
                onClick={handleSaveQuantityAllocation}
                disabled={isSavingAllocation || productsLoading || allocationSummary.totalQuantity <= 0 || dialogProductsData?.pricesHidden}
                className="gap-2 bg-indigo-600 text-white hover:bg-indigo-700"
              >
                {/* {isSavingAllocation ? <RefreshCw className="h-4 w-4 animate-spin" /> : <CheckCircle className="h-4 w-4" />} */}
                Apply Quantity Allocation
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={showEmptyAllDialog} onOpenChange={setShowEmptyAllDialog}>
          <DialogContent className="max-w-md border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900">
            <DialogHeader>
              <DialogTitle className="text-slate-900 dark:text-white">Empty All Quantity Budgets</DialogTitle>
              <DialogDescription className="text-slate-600 dark:text-slate-400">
                Are you sure you want to reset all quantity budgets in the current view to zero?
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
              <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-5 w-5 text-red-600 dark:text-red-400" />
                <div className="space-y-2">
                  <p className="text-sm font-medium text-red-900 dark:text-red-100">
                    This will reset quantity and money-budget values for the current budget period.
                  </p>
                  <p className="text-xs text-red-700 dark:text-red-300">Branches affected: {scopedBudgets.length}</p>
                  <p className="text-xs text-red-700 dark:text-red-300">Total quantity: {formatQuantity(scopedQuantitySummary.totalQuantity)}</p>
                  <p className="text-xs text-red-700 dark:text-red-300">Spent quantity: {formatQuantity(scopedQuantitySummary.spentQuantity)}</p>
                  <p className="text-xs text-red-700 dark:text-red-300">This action can be reversed by allocating new quantity budgets.</p>
                </div>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowEmptyAllDialog(false)} disabled={isResettingBudgets}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleEmptyAllBudgets} disabled={isResettingBudgets} className="gap-2">
                {isResettingBudgets ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                Empty All Budgets
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}
