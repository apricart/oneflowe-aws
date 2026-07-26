"use client"
import { useMemo, useState, useEffect, type ReactNode } from "react"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { useAppContext } from "@/components/context/app-context"
import { formatPKR } from "@/lib/utils"
import { Search, Package, Building2, ShieldCheck, Sparkles, RefreshCw, CheckCircle, XCircle, AlertCircle, Filter, ChevronLeft, ChevronRight } from "lucide-react"
import { useDebounce } from "@/hooks/use-debounce"
import { cn } from "@/lib/utils"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type OrganizationInventoryItem = {
    id: number
    isActive: boolean
    productName: string
    productCode: string
    productImageUrl?: string
    customName?: string
    customPrice?: number
    customDescription?: string
    customImageUrl?: string

    categoryName?: string
    parentCategoryName?: string
    basePrice?: number
    unit: string
    assignedAt: string
}
export default function HeadOfficeInventoryView() {
    const { organizationId, isInitialized } = useAppContext()
    const [searchQuery, setSearchQuery] = useState("")
    const debouncedSearch = useDebounce(searchQuery, 300)
    const [categoryFilter, setCategoryFilter] = useState("all")
    const [subCategoryFilter, setSubCategoryFilter] = useState("all")
    const [statusFilter, setStatusFilter] = useState("all")
    const [page, setPage] = useState(1)
    const PAGE_SIZE = 20

    // Fetch ALL org inventory data once — no filter params in URL.
    // Deferred until the org context has hydrated so we don't fire an
    // unscoped request first and re-fetch when organizationId arrives.
    const query = `/api/v1/head-office/organization-inventory?limit=1000${organizationId ? `&organizationId=${organizationId}` : ""}`

    const { data, isLoading } = useSWR<{ items: OrganizationInventoryItem[]; total: number }>(isInitialized ? query : null, fetcher, {
        // No fallbackData: zero-filled fallback made the stat cards flash "0"
        // before the real numbers arrived.
        revalidateOnFocus: false,
        dedupingInterval: 30000,
        keepPreviousData: true,
    })

    const allProducts = data?.items ?? []
    const totalAssigned = allProducts.length

    // Fetch categories and subcategories for filter dropdowns
    const { data: catData } = useSWR<{ items: { id: number, name: string }[] }>('/api/v1/categories?limit=100', fetcher, {
        fallbackData: { items: [] }, revalidateOnFocus: false, dedupingInterval: 60000
    })
    const { data: subCatData } = useSWR<{ items: { id: number, name: string }[] }>(
        categoryFilter !== 'all'
            ? `/api/v1/subcategories?categoryId=${categoryFilter}&limit=100`
            : '/api/v1/subcategories?limit=100',
        fetcher,
        { fallbackData: { items: [] }, revalidateOnFocus: false, dedupingInterval: 60000 }
    )

    // Client-side filtering — instant, no API calls
    const filteredProducts = useMemo(() => {
        let filtered = allProducts

        // Status filter
        if (statusFilter === "active") {
            filtered = filtered.filter((item) => item.isActive)
        } else if (statusFilter === "inactive") {
            filtered = filtered.filter((item) => !item.isActive)
        }

        // Category filter (parent category)
        if (categoryFilter !== 'all') {
            const subCatIds = (subCatData?.items ?? []).map(sc => sc.id)
            if (subCatIds.length > 0) {
                filtered = filtered.filter((item) => {
                    const catName = item.parentCategoryName
                    const matchingCat = catData?.items?.find(c => c.id.toString() === categoryFilter)
                    return catName === matchingCat?.name
                })
            }
        }

        // Subcategory filter
        if (subCategoryFilter !== 'all') {
            const matchingSub = subCatData?.items?.find(sc => sc.id.toString() === subCategoryFilter)
            if (matchingSub) {
                filtered = filtered.filter((item) => item.categoryName === matchingSub.name)
            }
        }

        // Debounced search filter
        if (debouncedSearch) {
            const q = debouncedSearch.toLowerCase()
            filtered = filtered.filter(
                (item) =>
                    item.productName.toLowerCase().includes(q) ||
                    item.productCode.toLowerCase().includes(q) ||
                    (item.customName?.toLowerCase().includes(q))
            )
        }

        return filtered
    }, [allProducts, statusFilter, categoryFilter, subCategoryFilter, debouncedSearch, catData?.items, subCatData?.items])

    const activeCount = useMemo(() => allProducts.filter((item) => item.isActive).length, [allProducts])
    const customPriceCount = useMemo(
        () => allProducts.filter((item) => item.customPrice !== undefined && item.customPrice !== null).length,
        [allProducts]
    )

    const totalPages = Math.max(1, Math.ceil(filteredProducts.length / PAGE_SIZE))

    // Reset page when filters change
    useEffect(() => {
        setPage(1)
    }, [debouncedSearch, categoryFilter, subCategoryFilter, statusFilter])

    useEffect(() => {
        if (page > totalPages) {
            setPage(totalPages)
        }
    }, [totalPages, page])

    const paginatedProducts = useMemo(() => {
        const start = (page - 1) * PAGE_SIZE
        return filteredProducts.slice(start, start + PAGE_SIZE)
    }, [filteredProducts, page])

    return (
        <div className="space-y-6 p-4 md:p-6">
            {/* Compact Page Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
                <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-blue-100 to-indigo-100 dark:from-blue-900/50 dark:to-indigo-900/50 flex items-center justify-center border border-blue-50/50 dark:border-blue-800/50 shadow-inner">
                        <Building2 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Organization Inventory</h1>
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Centrally managed catalog for your organization</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Badge variant="outline" className="h-8 px-3 rounded-full border-blue-200 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:border-blue-800/60 dark:text-blue-400 font-semibold uppercase tracking-wider text-[10px]">
                        Read-Only
                    </Badge>
                </div>
            </div>

            {/* Stat Cards */}
            <div className="grid gap-4 md:grid-cols-3">
                <StatCard
                    label="Assigned Products"
                    value={totalAssigned}
                    icon={<Package className="h-5 w-5" />}
                    variant="blue"
                    isLoading={!data}
                />
                <StatCard
                    label="Active SKUs"
                    value={activeCount}
                    icon={<CheckCircle className="h-5 w-5" />}
                    variant="green"
                    isLoading={!data}
                />
                <StatCard
                    label="Inactive SKUs"
                    value={totalAssigned - activeCount}
                    icon={<XCircle className="h-5 w-5" />}
                    variant="red"
                    isLoading={!data}
                />
            </div>

            <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
                <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between border-b bg-slate-50/50 dark:bg-slate-800/50 p-6">
                    <div>
                        <CardTitle className="text-xl text-slate-900 dark:text-white">Assigned products</CardTitle>
                        <p className="text-sm text-muted-foreground">Filtered list of SKUs currently available to your organization.</p>
                    </div>
                    <div className="flex flex-col gap-3 w-full lg:flex-row lg:items-center lg:justify-end">
                        <div className="relative w-full lg:w-64">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search products..."
                                className="pl-9 h-10"
                                value={searchQuery}
                                onChange={(event) => setSearchQuery(event.target.value)}
                            />
                        </div>
                        <div className="flex gap-2">
                            <select
                                value={categoryFilter}
                                onChange={(e) => { setCategoryFilter(e.target.value); setSubCategoryFilter('all'); }}
                                className="h-10 rounded-xl border border-slate-200 bg-white dark:bg-slate-900 px-3 py-2 text-sm w-full lg:w-[180px] focus:ring-2 focus:ring-blue-500/20"
                            >
                                <option value="all">All Categories</option>
                                {catData?.items?.map((cat) => (
                                    <option key={cat.id} value={cat.id.toString()}>
                                        {cat.name}
                                    </option>
                                ))}
                            </select>
                            <select
                                value={subCategoryFilter}
                                onChange={(e) => setSubCategoryFilter(e.target.value)}
                                className="h-10 rounded-xl border border-slate-200 bg-white dark:bg-slate-900 px-3 py-2 text-sm w-full lg:w-[180px] focus:ring-2 focus:ring-blue-500/20"
                            >
                                <option value="all">All Subcategories</option>
                                {subCatData?.items?.map((sub) => (
                                    <option key={sub.id} value={sub.id.toString()}>
                                        {sub.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </CardHeader>
                <CardContent className="p-0">
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader className="bg-slate-50/50 dark:bg-slate-800/50">
                                <TableRow>
                                    <TableHead className="pl-6 py-4">Product</TableHead>
                                    <TableHead>Category</TableHead>
                                    <TableHead>Subcategory</TableHead>
                                    <TableHead>Unit Price</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead className="pr-6">Assigned on</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {isLoading ? (
                                    <TableRow>
                                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                            Loading assigned catalog…
                                        </TableCell>
                                    </TableRow>
                                ) : allProducts.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                            No products have been assigned yet. Once Super Admin approves products for your organization, they
                                            will appear here automatically.
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    paginatedProducts.map((item) => (
                                        <TableRow key={item.id} className="hover:bg-slate-50 dark:hover:bg-slate-800/50 transition-colors border-b border-slate-100 dark:border-slate-800/50 group">
                                            <TableCell className="pl-6 py-4">
                                                <div className="flex items-center gap-3">
                                                    {item.customImageUrl || item.productImageUrl ? (
                                                        <img
                                                            src={item.customImageUrl || item.productImageUrl}
                                                            alt={item.productName}
                                                            className="h-12 w-12 rounded-xl border border-slate-200 dark:border-slate-700 object-cover shadow-sm group-hover:scale-105 transition-transform"
                                                        />
                                                    ) : (
                                                        <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800">
                                                            <Package className="h-5 w-5 text-slate-400" />
                                                        </div>
                                                    )}
                                                    <div>
                                                        <p className="font-bold text-slate-900 dark:text-slate-100">{item.customName || item.productName}</p>
                                                        <p className="text-xs font-mono text-slate-500 dark:text-slate-400">{item.productCode}</p>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="outline" className="bg-blue-50/50 text-blue-700 border-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:border-blue-800 font-semibold">
                                                    {item.parentCategoryName || "Uncategorized"}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="outline" className="bg-slate-100/50 text-slate-600 border-slate-200 dark:bg-slate-800/50 dark:text-slate-400 dark:border-slate-700 font-medium">
                                                    {item.categoryName || "Uncategorized"}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="font-bold text-slate-900 dark:text-slate-100">
                                                {formatPKR((item.customPrice ?? item.basePrice ?? 0) / 100)}
                                            </TableCell>
                                            <TableCell>
                                                <Badge className={cn(
                                                    "rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider border shadow-sm",
                                                    item.isActive 
                                                        ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-900/30 dark:text-emerald-400 dark:border-emerald-800"
                                                        : "bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800 dark:text-slate-400 dark:border-slate-700"
                                                )}>
                                                    {item.isActive ? "Active" : "Inactive"}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-xs font-bold text-slate-500 dark:text-slate-400 pr-6 uppercase tracking-tight">
                                                {new Date(item.assignedAt).toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' })}
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </div>
                    <div className="px-6 py-4 flex flex-col gap-4 text-sm text-slate-500 md:flex-row md:items-center md:justify-between bg-slate-50/30 dark:bg-slate-800/30">
                        <span className="font-medium">
                            Showing{" "}
                            <span className="text-slate-900 dark:text-white">
                                {filteredProducts.length === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
                                –
                                {Math.min(filteredProducts.length, page * PAGE_SIZE)}
                            </span>{" "}
                            of <span className="text-slate-900 dark:text-white">{filteredProducts.length}</span> products
                        </span>
                        <div className="inline-flex items-center gap-2">
                            <Button variant="outline" size="sm" className="h-8 w-8 p-0 rounded-lg border-slate-200" disabled={page === 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                                <ChevronLeft className="h-4 w-4" />
                            </Button>
                            <span className="text-xs font-bold text-slate-700 dark:text-slate-300">
                                {page} / {totalPages}
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                className="h-8 w-8 p-0 rounded-lg border-slate-200"
                                disabled={page === totalPages || filteredProducts.length === 0}
                                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                            >
                                <ChevronRight className="h-4 w-4" />
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>
        </div>
    )
}

function StatCard({ label, value, icon, variant, isLoading = false }: {
    label: string;
    value: string | number;
    icon: React.ReactNode;
    variant: 'blue' | 'green' | 'red' | 'amber' | 'purple'
    isLoading?: boolean
}) {
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
        red: "bg-white/80 text-rose-600 shadow-sm border border-rose-100 dark:bg-slate-800 dark:border-blue-800",
        amber: "bg-white/80 text-amber-600 shadow-sm border border-amber-100 dark:bg-slate-800 dark:border-amber-800",
        purple: "bg-white/80 text-purple-600 shadow-sm border border-purple-100 dark:bg-slate-800 dark:border-purple-800",
    }

    return (
        <div className={cn("flex items-center justify-between p-4 rounded-2xl border shadow-sm transition-all hover:shadow-md", variants[variant])}>
            <div className="space-y-1">
                <p className="text-[10px] font-bold uppercase tracking-[0.15em] opacity-80">{label}</p>
                {isLoading ? (
                    <div className="h-8 w-16 rounded-md bg-slate-300/40 dark:bg-slate-600/40 animate-pulse" />
                ) : (
                    <p className="text-2xl font-black tracking-tight">{value}</p>
                )}
            </div>
            <div className={cn("h-10 w-10 rounded-xl flex items-center justify-center", iconBadge[variant])}>
                {icon}
            </div>
        </div>
    )
}
