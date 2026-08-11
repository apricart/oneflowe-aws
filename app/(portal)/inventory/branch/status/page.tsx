"use client"

import { useState,useMemo } from "react"
import useSWR from "swr"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { formatPKR } from "@/lib/utils"
import { Search,Package,Loader2,ToggleLeft } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useAppContext } from "@/components/context/app-context"

import { fetcher,apiFetch } from "@/lib/fetcher"

type OrgProduct = {
    id: number
    globalProductId: number
    productName: string
    productCode: string
    productImageUrl: string | null
    customPrice: number | null
    customName: string | null
    isActive: boolean
}

export default function ProductStatusPage() {
    const { organizationId: contextOrgId } = useAppContext()
    const { toast } = useToast()
    const [localOrgId, setLocalOrgId] = useState<string>("")
    const [searchQuery, setSearchQuery] = useState("")
    const [statusFilter, setStatusFilter] = useState<string>("all")
    const [togglingId, setTogglingId] = useState<number | null>(null)

    const selectedOrgId = contextOrgId || localOrgId
    const showOrgSelector = !contextOrgId
    const hasSearchQuery = Boolean(searchQuery.trim())

    // Fetch organizations
    const { data: orgsData } = useSWR<{ items: { id: number; name: string }[] }>(
        showOrgSelector ? "/api/v1/organizations" : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch organization products
    const { data: productsData, isLoading, mutate } = useSWR<{ items: OrgProduct[] }>(
        selectedOrgId
            ? `/api/v1/head-office/organization-inventory?organizationId=${selectedOrgId}&status=${statusFilter}&limit=1000`
            : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    const orgProducts = productsData?.items ?? []

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

    const handleToggleStatus = async (product: OrgProduct) => {
        if (!selectedOrgId) return

        setTogglingId(product.id)
        const newActive = !product.isActive

        // Optimistic update — flip immediately in the UI
        const optimisticData = {
            items: orgProducts.map(p =>
                p.id === product.id ? { ...p, isActive: newActive } : p
            ),
        }
        mutate(optimisticData, false) // update local data, don't revalidate yet

        try {
            await apiFetch("/api/v1/head-office/organization-inventory", {
                method: "PUT",
                body: JSON.stringify({
                    id: product.id,
                    isActive: newActive,
                    organizationId: selectedOrgId,
                }),
            })

            toast({
                title: newActive ? "Product Activated" : "Product Deactivated",
                description: `${product.customName || product.productName} is now ${newActive ? "active" : "inactive"} across all groups and branches`,
                variant: "success",
            })
            // Revalidate to get fresh server data
            mutate()
        } catch (error: any) {
            toast({
                title: "Error",
                description: error.message,
                variant: "destructive",
            })
        } finally {
            setTogglingId(null)
        }
    }

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

            {/* Stats */}
            {selectedOrgId && (
                <div className="grid gap-4 md:grid-cols-3">
                    <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                        <CardContent className="p-5 space-y-2">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Total Products</p>
                            <p className="text-2xl font-semibold">{orgProducts.length}</p>
                            <div className="h-1 rounded-full bg-gradient-to-r from-blue-500 to-cyan-500" />
                        </CardContent>
                    </Card>
                    <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                        <CardContent className="p-5 space-y-2">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Active</p>
                            <p className="text-2xl font-semibold text-emerald-600">{activeCount}</p>
                            <div className="h-1 rounded-full bg-gradient-to-r from-emerald-500 to-green-500" />
                        </CardContent>
                    </Card>
                    <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                        <CardContent className="p-5 space-y-2">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Inactive</p>
                            <p className="text-2xl font-semibold text-amber-600">{inactiveCount}</p>
                            <div className="h-1 rounded-full bg-gradient-to-r from-amber-500 to-orange-500" />
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* Products Table */}
            {selectedOrgId && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <CardTitle className="text-xl">Organization Products</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                Toggle the switch to activate or deactivate a product. Changes apply to all groups and branches instantly.
                            </p>
                        </div>
                        <div className="flex flex-col gap-3 w-full lg:flex-row lg:items-center lg:justify-end lg:w-auto">
                            <div className="relative w-full lg:w-64">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    placeholder="Search products..."
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
                                        <TableHead>Price</TableHead>
                                        <TableHead className="w-40">Status</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {(() => {
                                      if (isLoading) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                                                <div className="flex items-center justify-center gap-2">
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    Loading products...
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      if (filteredProducts.length === 0) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={4} className="py-10 text-center text-sm text-muted-foreground">
                                                {(() => {
                                                  if (hasSearchQuery) {
                                                    return "No products match your search."
                                                  }
                                                  if (statusFilter === "active") {
                                                    return "No active products."
                                                  }
                                                  if (statusFilter === "inactive") {
                                                    return "No inactive products."
                                                  }
                                                  return "No products found."
                                                })()}
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      return (
                                        filteredProducts.map((product) => (
                                            <TableRow
                                                key={product.id}
                                                className={`hover:bg-muted/40 ${!product.isActive ? "opacity-60" : ""}`}
                                            >
                                                <TableCell>
                                                    <div className="flex items-center gap-3">
                                                        {product.productImageUrl ? (
                                                            <img
                                                                src={product.productImageUrl}
                                                                alt={product.productName}
                                                                className="h-10 w-10 rounded-lg border object-cover"
                                                            />
                                                        ) : (
                                                            <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-muted/40">
                                                                <Package className="h-4 w-4 text-muted-foreground" />
                                                            </div>
                                                        )}
                                                        <div>
                                                            <p className="font-medium">
                                                                {product.customName || product.productName}
                                                            </p>
                                                            {product.customName && (
                                                                <p className="text-xs text-muted-foreground">{product.productName}</p>
                                                            )}
                                                        </div>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline">{product.productCode}</Badge>
                                                </TableCell>
                                                <TableCell className="font-medium">
                                                    {product.customPrice
                                                        ? formatPKR(product.customPrice / 100)
                                                        : <span className="text-muted-foreground">-</span>}
                                                </TableCell>
                                                <TableCell>
                                                    <div className="flex items-center gap-3">
                                                        <Switch
                                                            disabled={togglingId === product.id}
                                                            checked={product.isActive}
                                                            onCheckedChange={() => handleToggleStatus(product)}
                                                        />
                                                        {(() => {
                                                          if (togglingId === product.id) {
                                                            return (
                                                            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
                                                        )
                                                          }
                                                          return (
                                                            <span className={`text-xs font-semibold ${product.isActive ? "text-emerald-600 dark:text-emerald-400" : "text-amber-600 dark:text-amber-400"}`}>
                                                                {product.isActive ? "Active" : "Inactive"}
                                                            </span>
                                                        )
                                                        })()}
                                                    </div>
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
                        <ToggleLeft className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-40" />
                        <p className="text-lg font-medium text-muted-foreground">Select an organization</p>
                        <p className="text-sm text-muted-foreground mt-1">
                            Choose an organization to manage product status.
                        </p>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
