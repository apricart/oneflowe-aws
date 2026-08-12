"use client"
import { useState,useMemo } from "react"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Switch } from "@/components/ui/switch"
import {
  Package,
  Search,
  RefreshCw,AlertCircle,
  Check,
  X,
  Filter,LayoutGrid,
  Box,
  ChevronRight,
  Info
} from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import useSWR from "swr"
import { useToast } from "@/hooks/use-toast"
import { cn,formatPKR } from "@/lib/utils"
import { BankingKPICard } from "@/components/dashboard/banking-kpi-card"
import { motion,AnimatePresence } from "framer-motion"

const fetcher = (url: string) => fetch(url).then(res => res.json())

interface BranchProduct {
  id: number
  branchId: number
  organizationId: number
  globalProductId: number
  organizationProductId: number
  isVisible: boolean
  isAvailable: boolean
  customNotes: string | null
  createdAt: string
  updatedAt: string
  productName: string
  productCode: string
  productImageUrl: string | null
  categoryName: string | null
  basePrice: number | null
  unit: string
  customName: string | null
  customPrice: number | null
  customDescription: string | null
}

export default function BranchAdminInventory({
  organizationId,
  branchId
}: Readonly<{
  organizationId: number
  branchId: number
}>) {
  const { toast } = useToast()
  const [searchQuery, setSearchQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  const [visibilityFilter] = useState("all")

  // Fetch categories
  const { data: categoriesData } = useSWR<{ items: { id: number; name: string }[] }>("/api/v1/categories", fetcher)
  const categories = categoriesData?.items || []

  // Fetch branch products with visibility data
  const { data, error, isLoading, mutate } = useSWR<{
    items: BranchProduct[]
    pricesHidden?: boolean
  }>(
    `/api/v1/inventory/branch-visibility?branchId=${branchId}&organizationId=${organizationId}`,
    fetcher,
    { revalidateOnFocus: false }
  )

  const products = data?.items || []
  const pricesHidden = Boolean(data?.pricesHidden)

  // Filter products
  const filteredProducts = useMemo(() => {
    let filtered = products

    if (visibilityFilter === "visible") {
      filtered = filtered.filter(p => p.isVisible)
    } else if (visibilityFilter === "hidden") {
      filtered = filtered.filter(p => !p.isVisible)
    }

    if (categoryFilter !== "all") {
      filtered = filtered.filter(p => p.categoryName === categories.find(c => String(c.id) === categoryFilter)?.name)
    }

    if (searchQuery) {
      filtered = filtered.filter(p =>
        p.productName.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.productCode.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.customName?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    }

    return filtered
  }, [products, visibilityFilter, searchQuery, categoryFilter, categories])

  // Calculate summary stats
  const totalProducts = products.length
  const visibleProducts = products.filter(p => p.isVisible).length
  const hiddenProducts = products.filter(p => !p.isVisible).length

  const handleToggleVisibility = async (branchProductId: number, isVisible: boolean) => {
    try {
      const response = await fetch("/api/v1/inventory/branch-visibility", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          organizationProductId: branchProductId,
          branchId: branchId,
          isVisible
        }),
      })

      if (response.ok) {
        toast({
          title: "Success",
          description: `Product ${isVisible ? 'shown' : 'hidden'} successfully`,
        })
        mutate()
      } else {
        const result = await response.json()
        toast({
          title: "Error",
          description: result.error || "Failed to update visibility",
          variant: "destructive",
        })
      }
    } catch (error) {
      console.error("Error updating visibility:", error)
      toast({
        title: "Error",
        description: "Failed to update visibility",
        variant: "destructive",
      })
    }
  }

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-[60vh] gap-4">
        <div className="relative">
          <div className="h-12 w-12 rounded-full border-4 border-slate-200 dark:border-slate-800 border-t-indigo-500 animate-spin" />
        </div>
        <p className="text-sm font-medium text-slate-500 animate-pulse tracking-wide uppercase">Synchronizing Inventory...</p>
      </div>
    )
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="glass-card p-8 rounded-[2rem] border border-red-100 dark:border-red-900/30 text-center max-w-md">
          <div className="w-16 h-16 bg-red-50 dark:bg-red-900/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="h-8 w-8 text-red-500" />
          </div>
          <h3 className="text-lg font-bold text-slate-900 dark:text-white mb-2">Sync Failed</h3>
          <p className="text-sm text-slate-500 dark:text-slate-400 mb-6">We couldn't load your branch inventory. Please check your connection and try again.</p>
          <Button onClick={() => mutate()} className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-6">
            Retry Connection
          </Button>
        </div>
      </div>
    )
  }

  return (
    <motion.main 
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="min-h-screen bg-slate-50 dark:bg-slate-950 p-4 lg:p-6 space-y-6 max-w-[2000px] mx-auto overflow-x-hidden"
    >
      {/* ━━━ Premium Header ━━━ */}
      <div className="relative z-30 flex flex-col md:flex-row md:items-center justify-between gap-6 mb-2">
        <div className="space-y-1 px-2">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-500/10 rounded-lg">
              <Box className="w-5 h-5 text-indigo-500" />
            </div>
            <h1 className="text-2xl font-black text-slate-900 dark:text-white tracking-tight">Branch Inventory</h1>
          </div>
          <p className="text-sm font-medium text-slate-500 dark:text-slate-400">Manage and monitor product availability for your branch</p>
        </div>
        
        <div className="flex items-center gap-3">
          <Button 
            variant="outline" 
            onClick={() => mutate()} 
            className="h-10 px-4 rounded-xl border-slate-200 dark:border-slate-800 bg-white/50 dark:bg-slate-900/50 backdrop-blur-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-all shadow-sm gap-2 text-xs font-bold uppercase tracking-wider"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            Refresh Data
          </Button>
        </div>
      </div>

      {/* ━━━ KPI Stats ━━━ */}
      <div className="relative z-10 grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6 mb-8">
        <BankingKPICard
          icon={Package}
          title="Total Catalog"
          value={totalProducts}
          subtitle="Total SKUs assigned"
          gradient="from-blue-500 to-indigo-600"
          iconBg="text-blue-600 bg-blue-600"
          delay={0}
        />
        <BankingKPICard
          icon={Check}
          title="Visible in Shop"
          value={visibleProducts}
          subtitle="Currently active"
          gradient="from-emerald-500 to-teal-600"
          iconBg="text-emerald-600 bg-emerald-600"
          delay={50}
        />
        <BankingKPICard
          icon={X}
          title="Hidden Products"
          value={hiddenProducts}
          subtitle="Restricted from view"
          gradient="from-rose-500 to-red-600"
          iconBg="text-rose-600 bg-rose-600"
          delay={100}
        />
      </div>

      {/* ━━━ Inventory Management Table ━━━ */}
      <Card className="border border-slate-200/80 dark:border-slate-800/60 shadow-sm bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl overflow-hidden glass-card rounded-[2rem]">
        <div className="p-6 border-b border-slate-100 dark:border-slate-800/50 bg-slate-50/50 dark:bg-slate-800/20">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
            <div className="flex items-center gap-3">
              <LayoutGrid className="w-5 h-5 text-indigo-500" />
              <h3 className="text-lg font-black text-slate-800 dark:text-slate-200 uppercase tracking-widest">Catalog Visibility</h3>
            </div>
            
            <div className="flex flex-wrap items-center gap-3">
              <div className="relative group">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 group-focus-within:text-indigo-500 transition-colors" />
                <Input
                  placeholder="Search products or SKU..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="pl-10 w-full md:w-72 h-11 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 focus:ring-2 focus:ring-indigo-500/20 transition-all text-sm font-medium"
                />
              </div>

              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-full md:w-52 h-11 rounded-xl border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 shadow-sm font-bold text-xs uppercase tracking-wider">
                  <div className="flex items-center gap-2">
                    <Filter className="h-3.5 w-3.5 text-indigo-500" />
                    <SelectValue placeholder="All Categories" />
                  </div>
                </SelectTrigger>
                <SelectContent className="rounded-2xl border-slate-200 dark:border-slate-800 shadow-2xl">
                  <SelectItem value="all" className="font-bold text-xs uppercase tracking-wider">All Categories</SelectItem>
                  {categories.map((cat) => (
                    <SelectItem key={cat.id} value={String(cat.id)} className="font-bold text-xs uppercase tracking-wider">
                      {cat.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow className="border-b border-slate-100 dark:border-slate-800/50 hover:bg-transparent">
                <TableHead className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Product Details</TableHead>
                <TableHead className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Category & Code</TableHead>
                {!pricesHidden && <TableHead className="px-6 py-4 text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Price Info</TableHead>}
                <TableHead className="px-6 py-4 text-center text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Shop Availability</TableHead>
                <TableHead className="px-6 py-4 text-right text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <AnimatePresence mode="popLayout">
                {filteredProducts.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={pricesHidden ? 4 : 5} className="h-64 text-center">
                      <div className="flex flex-col items-center justify-center gap-3">
                        <div className="p-4 bg-slate-50 dark:bg-slate-800/50 rounded-2xl border border-dashed border-slate-200 dark:border-slate-700">
                          <Package className="h-10 w-10 text-slate-300 dark:text-slate-600" />
                        </div>
                        <p className="text-sm font-bold text-slate-400 uppercase tracking-widest">No matching products found</p>
                      </div>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredProducts.map((product, idx) => (
                    <motion.tr
                      key={product.id}
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.02 }}
                      className="group border-b border-slate-50 dark:border-slate-800/30 hover:bg-slate-50/50 dark:hover:bg-slate-800/30 transition-colors"
                    >
                      <TableCell className="px-6 py-4">
                        <div className="flex items-center gap-4">
                          <div className="relative group-hover:scale-110 transition-transform duration-300">
                            {product.productImageUrl ? (
                              <img
                                src={product.productImageUrl}
                                alt={product.productName}
                                className="w-14 h-14 object-cover rounded-2xl border border-slate-200 dark:border-slate-800 shadow-sm"
                              />
                            ) : (
                              <div className="w-14 h-14 bg-slate-100 dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 flex items-center justify-center">
                                <Package className="w-6 h-6 text-slate-300 dark:text-slate-500" />
                              </div>
                            )}
                            <div className={cn(
                              "absolute -top-1 -right-1 w-4 h-4 rounded-full border-2 border-white dark:border-slate-900",
                              product.isVisible ? "bg-emerald-500 shadow-[0_0_10px_rgba(16,185,129,0.5)]" : "bg-slate-300 dark:bg-slate-600"
                            )} />
                          </div>
                          <div>
                            <div className="font-black text-slate-900 dark:text-white text-sm tracking-tight leading-tight mb-0.5">
                              {product.customName || product.productName}
                            </div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className="text-[9px] font-black uppercase px-1.5 py-0 border-slate-200 dark:border-slate-700 text-slate-500">
                                {product.unit}
                              </Badge>
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      
                      <TableCell className="px-6 py-4">
                        <div className="space-y-1">
                          <div className="text-xs font-bold text-slate-700 dark:text-slate-300 uppercase tracking-wider">{product.categoryName || "Uncategorized"}</div>
                          <div className="text-[10px] font-black text-slate-400 uppercase tracking-[0.1em]">{product.productCode}</div>
                        </div>
                      </TableCell>

                      {!pricesHidden && <TableCell className="px-6 py-4">
                        <div className="space-y-0.5">
                          <div className="text-sm font-black text-indigo-600 dark:text-indigo-400 tracking-tight">
                            {product.customPrice !== null || product.basePrice !== null
                              ? formatPKR(product.customPrice || product.basePrice || 0, { maximumFractionDigits: 0 })
                              : "-"}
                          </div>
                        </div>
                      </TableCell>}

                      <TableCell className="px-6 py-4">
                        <div className="flex justify-center">
                          <div className={cn(
                            "flex items-center gap-2 px-3 py-1.5 rounded-full border shadow-sm transition-all duration-300",
                            product.isAvailable 
                              ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400 ring-4 ring-emerald-500/5" 
                              : "bg-slate-100 border-slate-200 text-slate-500 dark:bg-slate-800 dark:border-slate-700"
                          )}>
                            <div className={cn("w-1.5 h-1.5 rounded-full", product.isAvailable ? "bg-emerald-500 animate-pulse" : "bg-slate-400")} />
                            <span className="text-[10px] font-black uppercase tracking-widest">
                              {product.isAvailable ? "Available" : "Stock-Out"}
                            </span>
                          </div>
                        </div>
                      </TableCell>

                      <TableCell className="px-6 py-4 text-right">
                        <div className="flex items-center justify-end gap-3">
                          <div className="flex flex-col items-end gap-1 mr-2">
                            <span className="text-[9px] font-black text-slate-400 uppercase tracking-wider">
                              {product.isVisible ? "Visible" : "Hidden"}
                            </span>
                            <Switch
                              checked={product.isVisible}
                              onCheckedChange={(checked) => handleToggleVisibility(product.id, checked)}
                              className="data-[state=checked]:bg-indigo-500"
                            />
                          </div>
                          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-indigo-500 transition-all">
                            <ChevronRight className="h-5 w-5" />
                          </Button>
                        </div>
                      </TableCell>
                    </motion.tr>
                  ))
                )}
              </AnimatePresence>
            </TableBody>
          </Table>
        </div>
        
        <div className="p-6 border-t border-slate-100 dark:border-slate-800/50 bg-slate-50/50 dark:bg-slate-800/10">
          <div className="flex items-center gap-2 text-[10px] font-bold text-slate-400 uppercase tracking-widest">
            <Info className="w-3.5 h-3.5 text-indigo-500" />
            Showing {filteredProducts.length} of {totalProducts} total products assigned by head office
          </div>
        </div>
      </Card>
    </motion.main>
  )
}
