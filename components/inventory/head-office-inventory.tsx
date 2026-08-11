"use client"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
Select,
SelectContent,
SelectItem,
SelectTrigger,
SelectValue,
} from "@/components/ui/select"
import { Table } from "@/components/ui/table"
import { fetcher } from "@/lib/fetcher"
import { cn,formatPKR } from "@/lib/utils"
import {
AlertCircle,
CheckCircle,
Filter,
MapPin,
Package,
RefreshCw,
Search
} from "lucide-react"
import React,{ useMemo,useState } from "react"
import useSWR from "swr"

interface AssignedProduct {
  id: number
  productId: number
  organizationId: number
  isEnabled: boolean
  customName: string | null
  customPrice: number | null
  customDescription: string | null
  overrideLevel: string | null
  createdAt: string
  productName: string
  productCode: string
  productImageUrl: string | null
  categoryName: string | null
  basePrice: number
  unit: string
}

interface Branch {
  id: number
  name: string
  address: string | null
  isActive: boolean
}

export default function HeadOfficeInventory({ organizationId }: Readonly<{ organizationId: number }>) {
  const [searchQuery, setSearchQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<string>("all")
  const [selectedProducts, setSelectedProducts] = useState<number[]>([])

  // Fetch categories
  const { data: categoriesData } = useSWR<{ items: { id: number; name: string }[] }>("/api/v1/categories", fetcher)
  const categories = categoriesData?.items || []

  // Fetch assigned products
  const { data: assignedProducts, error: assignedError, isLoading: assignedLoading } = useSWR<{
    items: AssignedProduct[]
    total: number
  }>(`/api/v1/inventory/assignments?organizationId=${organizationId}`, fetcher)

  // Fetch branches for this organization
  const { data: branches } = useSWR<Branch[]>(`/api/v1/branches?organizationId=${organizationId}`, fetcher)

  // Filter assigned products
  const filteredProducts = useMemo(() => {
    if (!assignedProducts?.items) return []

    let filtered = assignedProducts.items

    // Strictly show only active products as per user requirement
    filtered = filtered.filter(p => p.isEnabled)

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
  }, [assignedProducts?.items, searchQuery, categoryFilter, categories])

  // Calculate summary stats
  const totalAssigned = assignedProducts?.total || 0
  const activeAssigned = useMemo(() => {
    if (!assignedProducts?.items) return 0
    return assignedProducts.items.filter(p => p.isEnabled).length
  }, [assignedProducts?.items])

  const totalBranches = branches?.length || 0

  const toggleProductSelection = (productId: number) => {
    setSelectedProducts(prev =>
      prev.includes(productId)
        ? prev.filter(id => id !== productId)
        : [...prev, productId]
    )
  }

  const selectAllProducts = () => {
    setSelectedProducts(
      selectedProducts.length === filteredProducts.length
        ? []
        : filteredProducts.map(p => p.id)
    )
  }

  if (assignedLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <RefreshCw className="h-8 w-8 animate-spin mx-auto mb-2" />
          <p className="text-sm text-muted-foreground">Loading assigned products...</p>
        </div>
      </div>
    )
  }

  if (assignedError) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <AlertCircle className="h-8 w-8 text-red-500 mx-auto mb-2" />
          <p className="text-sm text-red-600">Failed to load assigned products</p>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6 p-4 md:p-6">
      {/* Compact Page Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
        <div className="flex items-center gap-4">
          <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-blue-100 to-indigo-100 dark:from-blue-900/50 dark:to-indigo-900/50 flex items-center justify-center border border-blue-50/50 dark:border-blue-800/50 shadow-inner">
            <Package className="h-6 w-6 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Organization Inventory</h1>
            <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Manage products assigned to your organization</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-9 gap-2 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 shadow-sm" onClick={() => {}}>
            <RefreshCw className="h-4 w-4" />
            <span className="hidden sm:inline">Refresh</span>
          </Button>
        </div>
      </div>

      {/* Stat Cards */}
      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Total Assigned"
          value={totalAssigned}
          icon={<Package className="h-5 w-5" />}
          variant="blue"
        />
        <StatCard
          label="Active Products"
          value={activeAssigned}
          icon={<CheckCircle className="h-5 w-5" />}
          variant="green"
        />
        <StatCard
          label="Total Branches"
          value={totalBranches}
          icon={<MapPin className="h-5 w-5" />}
          variant="amber"
        />
      </div>

      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-semibold">Assigned Products</h3>
          <div className="flex gap-2">
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[180px]">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-muted-foreground" />
                  <SelectValue placeholder="All Categories" />
                </div>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {categories.map((cat) => (
                  <SelectItem key={cat.id} value={String(cat.id)}>
                    {cat.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" size={16} />
              <Input
                placeholder="Search products..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-10 w-64"
              />
            </div>
          </div>
        </div>

        <Card>
          <Table>
            <thead>
              <tr>
                <th className="text-left p-4 font-medium w-12">
                  <input
                    type="checkbox"
                    checked={selectedProducts.length === filteredProducts.length && filteredProducts.length > 0}
                    onChange={selectAllProducts}
                    className="rounded"
                  />
                </th>
                <th className="text-left p-4 font-medium">Product</th>
                <th className="text-left p-4 font-medium">Status</th>
                <th className="text-left p-4 font-medium">Custom Name</th>
                <th className="text-left p-4 font-medium">Custom Price</th>
                <th className="text-right p-4 font-medium">Override Level</th>
              </tr>
            </thead>
            <tbody>
              {(() => {
                if (filteredProducts.length === 0) {
                  return (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-gray-500">
                    No active assigned products found
                  </td>
                </tr>
              )
                }
                return (
                filteredProducts.map(product => (
                  <tr key={product.id} className="hover:bg-gray-50">
                    <td className="p-4">
                      <input
                        type="checkbox"
                        checked={selectedProducts.includes(product.id)}
                        onChange={() => toggleProductSelection(product.id)}
                        className="rounded"
                      />
                    </td>
                    <td className="p-4">
                      <div className="flex items-center gap-3">
                        {product.productImageUrl ? (
                          <img
                            src={product.productImageUrl}
                            alt={product.productName}
                            className="w-12 h-12 object-cover rounded-lg border"
                          />
                        ) : (
                          <div className="w-12 h-12 bg-gray-100 rounded-lg border flex items-center justify-center">
                            <Package className="w-6 h-6 text-gray-400" />
                          </div>
                        )}
                        <div>
                          <div className="font-medium">{product.productName}</div>
                          <div className="text-xs text-gray-500">{product.productCode}</div>
                          <div className="text-xs text-gray-500">{product.categoryName || "No Category"}</div>
                        </div>
                      </div>
                    </td>
                    <td className="p-4">
                      <Badge
                        variant={product.isEnabled ? "default" : "secondary"}
                        className={product.isEnabled ? "bg-green-100 text-green-800" : ""}
                      >
                        {product.isEnabled ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                    <td className="p-4">
                      <div className="text-sm">{product.customName || "-"}</div>
                    </td>
                    <td className="p-4">
                      <div className="text-sm">
                        {product.customPrice
                          ? formatPKR(product.customPrice / 100)
                          : formatPKR(product.basePrice / 100)}
                      </div>
                    </td>
                    <td className="p-4 text-right">
                      <Badge
                        variant={(() => {
                          if (product.overrideLevel === "super_admin") {
                            return "default"
                          }
                          if (product.overrideLevel === "head_office") {
                            return "secondary"
                          }
                          return "outline"
                        })()}
                        className={(() => {
                          if (product.overrideLevel === "super_admin") {
                            return "bg-blue-100 text-blue-800"
                          }
                          if (product.overrideLevel === "head_office") {
                            return "bg-green-100 text-green-800"
                          }
                          return ""
                        })()}
                      >
                        {product.overrideLevel?.replace("_", " ").toUpperCase() || "SUPER ADMIN"}
                      </Badge>
                    </td>
                  </tr>
                ))
              )
              })()}
            </tbody>
          </Table>
        </Card>
      </div>
    </div>
  )
}

function StatCard({ label, value, icon, variant }: Readonly<{
  label: string; 
  value: string | number; 
  icon: React.ReactNode;
  variant: 'blue' | 'green' | 'red' | 'amber' | 'purple'
}>) {
  const variants = {
    blue: "bg-gradient-to-br from-blue-50/80 to-indigo-50/80 border-blue-100/50 text-blue-700 dark:from-blue-900/20 dark:to-indigo-900/20 dark:border-blue-800/30 dark:text-blue-400",
    green: "bg-gradient-to-br from-emerald-50/80 to-teal-50/80 border-emerald-100/50 text-emerald-700 dark:from-emerald-900/20 dark:to-teal-900/20 dark:border-emerald-800/30 dark:text-emerald-400",
    red: "bg-gradient-to-br from-rose-50/80 to-red-50/80 border-rose-100/50 text-rose-700 dark:from-rose-900/20 dark:to-red-900/20 dark:border-rose-800/30 dark:text-rose-400",
    amber: "bg-gradient-to-br from-amber-50/80 to-orange-50/80 border-amber-100/50 text-amber-700 dark:from-amber-900/20 dark:to-orange-900/20 dark:border-amber-800/30 dark:text-amber-400",
    purple: "bg-gradient-to-br from-purple-50/80 to-fuchsia-50/80 border-purple-100/50 text-purple-700 dark:from-purple-900/20 dark:to-fuchsia-900/20 dark:border-purple-800/30 dark:text-purple-400",
  }

  const iconBadge = {
    blue: "bg-white/80 text-blue-600 shadow-sm border border-blue-100 dark:bg-slate-800 dark:border-blue-800",
    green: "bg-white/80 text-emerald-600 shadow-sm border border-emerald-100 dark:bg-slate-800 dark:border-emerald-800",
    red: "bg-white/80 text-rose-600 shadow-sm border border-rose-100 dark:bg-slate-800 dark:border-rose-800",
    amber: "bg-white/80 text-amber-600 shadow-sm border border-amber-100 dark:bg-slate-800 dark:border-amber-800",
    purple: "bg-white/80 text-purple-600 shadow-sm border border-purple-100 dark:bg-slate-800 dark:border-purple-800",
  }

  return (
    <div className={cn("flex items-center justify-between p-4 rounded-2xl border shadow-sm transition-all hover:shadow-md", variants[variant])}>
      <div className="space-y-1">
        <p className="text-[10px] font-bold uppercase tracking-[0.15em] opacity-80">{label}</p>
        <p className="text-2xl font-black tracking-tight">{value}</p>
      </div>
      <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center", iconBadge[variant])}>
        {icon}
      </div>
    </div>
  )
}
