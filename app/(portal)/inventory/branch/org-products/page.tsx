"use client"

import { useState,useMemo } from "react"
import useSWR from "swr"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { formatPKR } from "@/lib/utils"
import { Search,Package,Building2 } from "lucide-react"
import { useAppContext } from "@/components/context/app-context"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type OrgProduct = {
    id: number
    globalProductId: number
    productName: string
    productCode: string
    productImageUrl: string | null
    basePrice: number
    customPrice: number | null
    customName: string | null
    customDescription: string | null
    customImageUrl: string | null
    isActive: boolean
    assignedAt: string
    categoryName: string | null
    parentCategoryName: string | null
}

export default function ViewOrgProductsPage() {
    const { organizationId: contextOrgId } = useAppContext()
    const [localOrgId, setLocalOrgId] = useState<string>("")
    const [searchQuery, setSearchQuery] = useState("")
    const [statusFilter, setStatusFilter] = useState<string>("all")

    const selectedOrgId = contextOrgId || localOrgId
    const showOrgSelector = !contextOrgId

    // Fetch organizations (only if no org in context)
    const { data: orgsData } = useSWR<{ items: { id: number; name: string }[] }>(
        showOrgSelector ? "/api/v1/organizations" : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch org name for display
    const { data: allOrgsData } = useSWR<{ items: { id: number; name: string }[] }>(
        selectedOrgId ? "/api/v1/organizations" : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch organization products
    // No fallbackData: zero-filled fallback made the stat cards flash "0"
    // before the real numbers arrived.
    const { data: productsData, isLoading } = useSWR<{ items: OrgProduct[]; total: number }>(
        selectedOrgId
            ? `/api/v1/head-office/organization-inventory?organizationId=${selectedOrgId}&status=${statusFilter}&limit=1000`
            : null,
        fetcher,
        { keepPreviousData: true }
    )

    const orgProducts = productsData?.items ?? []
    const orgName = allOrgsData?.items?.find((o) => o.id.toString() === selectedOrgId?.toString())?.name || "Organization"

    // Search filtering
    const filteredProducts = useMemo(() => {
        if (!searchQuery) return orgProducts
        const q = searchQuery.toLowerCase()
        return orgProducts.filter(
            (p) =>
                p.productName.toLowerCase().includes(q) ||
                p.productCode.toLowerCase().includes(q) ||
                (p.customName?.toLowerCase().includes(q))
        )
    }, [orgProducts, searchQuery])

    const activeCount = orgProducts.filter((p) => p.isActive).length
    const inactiveCount = orgProducts.filter((p) => !p.isActive).length

    return (
        <div className="space-y-8 p-6">
            {/* Organization Selector */}
            {showOrgSelector && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader>
                        <CardTitle className="text-lg">Select Organization</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Select value={localOrgId} onValueChange={setLocalOrgId}>
                            <SelectTrigger className="w-full max-w-md">
                                <SelectValue placeholder="Select organization" />
                            </SelectTrigger>
                            <SelectContent>
                                {orgsData?.items.map((org) => (
                                    <SelectItem key={org.id} value={org.id.toString()}>
                                        {org.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </CardContent>
                </Card>
            )}

            {/* Stats cards */}
            {selectedOrgId && (
                <div className="grid gap-4 md:grid-cols-3">
                    <StatsCard label="Total Products" value={orgProducts.length} accent="from-blue-500 to-cyan-500" isLoading={!productsData} />
                    <StatsCard label="Active" value={activeCount} accent="from-emerald-500 to-green-500" isLoading={!productsData} />
                    <StatsCard label="Inactive" value={inactiveCount} accent="from-amber-500 to-orange-500" isLoading={!productsData} />
                </div>
            )}

            {/* Products Table */}
            {selectedOrgId && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <CardTitle className="text-xl text-slate-900 dark:text-white">
                                Products assigned to {orgName}
                            </CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {filteredProducts.length} product{filteredProducts.length !== 1 ? "s" : ""} found
                            </p>
                        </div>
                        <div className="flex flex-col gap-3 w-full lg:flex-row lg:items-center lg:justify-end lg:w-auto">
                            <div className="relative w-full lg:w-64">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    placeholder="Search by name or code..."
                                    className="pl-9"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                            </div>
                            <div className="w-full lg:w-48">
                                <Select value={statusFilter} onValueChange={setStatusFilter}>
                                    <SelectTrigger>
                                        <SelectValue placeholder="Status" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        <SelectItem value="all">All Statuses</SelectItem>
                                        <SelectItem value="active">Active Only</SelectItem>
                                        <SelectItem value="inactive">Inactive Only</SelectItem>
                                    </SelectContent>
                                </Select>
                            </div>
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Product</TableHead>
                                        <TableHead>Code</TableHead>
                                        <TableHead>Category</TableHead>
                                        <TableHead>Price</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Assigned</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {(() => {
                                      if (isLoading) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                                                Loading products...
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      if (filteredProducts.length === 0) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={6} className="py-10 text-center text-sm text-muted-foreground">
                                                {orgProducts.length === 0
                                                    ? "No products assigned to this organization yet."
                                                    : "No products match your search."}
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      return (
                                        filteredProducts.map((product) => (
                                            <TableRow
                                                key={product.id}
                                                className={!product.isActive ? "opacity-60" : ""}
                                            >
                                                <TableCell>
                                                    <div className="flex items-center gap-3">
                                                        {product.customImageUrl || product.productImageUrl ? (
                                                            <img
                                                                src={product.customImageUrl || product.productImageUrl || ""}
                                                                alt={product.productName}
                                                                className="h-10 w-10 rounded-lg border object-cover"
                                                            />
                                                        ) : (
                                                            <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-muted/40">
                                                                <Package className="h-4 w-4 text-muted-foreground" />
                                                            </div>
                                                        )}
                                                        <div>
                                                            <p className="font-medium text-slate-900 dark:text-white">
                                                                {product.customName || product.productName}
                                                            </p>
                                                            {product.customName && (
                                                                <p className="text-xs text-muted-foreground">
                                                                    {product.productName}
                                                                </p>
                                                            )}
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline">{product.productCode}</Badge>
                                                </TableCell>
                                                <TableCell>
                                                    <div className="space-y-1">
                                                        {product.parentCategoryName && (
                                                            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-950/30 dark:text-indigo-300 dark:border-indigo-800 text-[10px]">
                                                                {product.parentCategoryName}
                                                            </Badge>
                                                        )}
                                                        {product.categoryName && (
                                                            <Badge variant="outline" className="text-[10px] ml-1">
                                                                {product.categoryName}
                                                            </Badge>
                                                        )}
                                                        {!product.parentCategoryName && !product.categoryName && (
                                                            <span className="text-xs text-muted-foreground">—</span>
                                                        )}
                                                    </div>
                                                </TableCell>
                                                <TableCell className="font-medium">
                                                    {formatPKR((product.customPrice ?? product.basePrice) / 100)}
                                                </TableCell>
                                                <TableCell>
                                                    {product.isActive ? (
                                                        <Badge className="bg-emerald-100 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800">
                                                            Active
                                                        </Badge>
                                                    ) : (
                                                        <Badge variant="secondary" className="text-amber-700 dark:text-amber-400">
                                                            Inactive
                                                        </Badge>
                                                    )}
                                                </TableCell>
                                                <TableCell className="text-xs text-muted-foreground">
                                                    {product.assignedAt
                                                        ? new Date(product.assignedAt).toLocaleDateString()
                                                        : "—"}
                                                </TableCell>
                                            </TableRow>
                                        ))
                                    )
                                    })()}
                                </TableBody>
                            </Table>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Empty state */}
            {!selectedOrgId && (
                <Card className="border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50">
                    <CardContent className="py-16 text-center">
                        <Building2 className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-40" />
                        <p className="text-lg font-medium text-muted-foreground">Select an organization</p>
                        <p className="text-sm text-muted-foreground mt-1">
                            Choose an organization to view its assigned products.
                        </p>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}

function StatsCard({ label, value, accent, isLoading = false }: Readonly<{ label: string; value: number; accent: string; isLoading?: boolean }>) {
    return (
        <Card className="border border-slate-200 dark:border-slate-800 shadow-sm bg-white dark:bg-slate-900">
            <CardContent className="p-5 space-y-2">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
                {isLoading ? (
                    <div className="h-8 w-16 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
                ) : (
                    <p className="text-2xl font-semibold text-slate-900 dark:text-white">{value}</p>
                )}
                <div className={`h-1 rounded-full bg-gradient-to-r ${accent}`} />
            </CardContent>
        </Card>
    )
}
