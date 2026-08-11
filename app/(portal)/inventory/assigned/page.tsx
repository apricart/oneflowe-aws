"use client"

import { useState,useMemo } from "react"
import useSWR from "swr"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { formatPKR } from "@/lib/utils"
import { Search,Package } from "lucide-react"
import { useAppContext } from "@/components/context/app-context"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type Organization = {
    id: number
    name: string
}

type AssignedProduct = {
    id: number
    organizationId: number
    globalProductId: number
    customPrice: number | null
    customName: string | null
    isActive: boolean
    globalStatus: string
    assignedAt: string
    productName: string
    productCode: string
    productImageUrl: string | null
    organizationName: string
}

export default function ShowAssignedProductsPage() {
    const { organizationId: contextOrgId } = useAppContext()
    const [localOrgId, setLocalOrgId] = useState<string>("")
    const [searchQuery, setSearchQuery] = useState("")

    // Use context org if available, otherwise use local selection
    const selectedOrgId = contextOrgId || localOrgId
    const showOrgSelector = !contextOrgId

    // Fetch organizations (only needed when no context org)
    const { data: orgsData } = useSWR<{ items: Organization[] }>(
        showOrgSelector ? "/api/v1/organizations" : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch assigned products for selected organization
    const { data: assignmentsData, isLoading } = useSWR<{
        items: AssignedProduct[]
    }>(
        selectedOrgId ? `/api/v1/admin/organization-assignments?organizationId=${selectedOrgId}` : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    const assignedProducts = assignmentsData?.items ?? []

    // Search filtering
    const filteredProducts = useMemo(() => {
        if (!searchQuery) return assignedProducts
        const q = searchQuery.toLowerCase()
        return assignedProducts.filter(a =>
            a.productName.toLowerCase().includes(q) ||
            a.productCode.toLowerCase().includes(q)
        )
    }, [assignedProducts, searchQuery])

    const totalValue = useMemo(() => {
        return assignedProducts.reduce((sum, p) => sum + (p.customPrice || 0), 0)
    }, [assignedProducts])

    return (
        <div className="space-y-8 p-6">
            {/* Stats */}
            {selectedOrgId && (
                <div className="grid gap-4 md:grid-cols-2">
                    <Card className="border border-slate-200 dark:border-slate-800">
                        <CardContent className="p-5 space-y-2">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Total Assigned</p>
                            <p className="text-2xl font-semibold">{assignedProducts.length}</p>
                            <p className="text-xs text-muted-foreground">Products for this organization</p>
                            <div className="h-1 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />
                        </CardContent>
                    </Card>
                    <Card className="border border-slate-200 dark:border-slate-800">
                        <CardContent className="p-5 space-y-2">
                            <p className="text-xs uppercase tracking-wide text-muted-foreground">Total Catalog Value</p>
                            <p className="text-2xl font-semibold">{formatPKR(totalValue / 100)}</p>
                            <p className="text-xs text-muted-foreground">Sum of all custom prices</p>
                            <div className="h-1 rounded-full bg-gradient-to-r from-cyan-500 to-blue-500" />
                        </CardContent>
                    </Card>
                </div>
            )}

            {/* Organization Selector - Only shown when no org selected in header */}
            {showOrgSelector && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader>
                        <CardTitle className="text-lg">Select Organization</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <Select value={localOrgId} onValueChange={setLocalOrgId}>
                            <SelectTrigger className="w-full max-w-md">
                                <SelectValue placeholder="Select an organization to view assigned products" />
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

            {/* Products Table */}
            {selectedOrgId && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <CardTitle className="text-xl">Assigned Products</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                Products with custom pricing for this organization.
                            </p>
                        </div>
                        <div className="relative w-full lg:w-64">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search products..."
                                className="pl-9"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead>Product</TableHead>
                                        <TableHead>Code</TableHead>
                                        <TableHead>Custom Price</TableHead>
                                        <TableHead>Status</TableHead>
                                        <TableHead>Assigned On</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {(() => {
                                      if (isLoading) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                Loading assigned products...
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      if (filteredProducts.length === 0) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                {assignedProducts.length === 0
                                                    ? "No products assigned to this organization yet."
                                                    : "No products match your search."}
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      return (
                                        filteredProducts.map((product) => (
                                            <TableRow key={product.id} className="hover:bg-muted/40">
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
                                                        <span className="font-medium">{product.customName || product.productName}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline">{product.productCode}</Badge>
                                                </TableCell>
                                                <TableCell className="font-medium">
                                                    {product.customPrice
                                                        ? formatPKR(product.customPrice / 100)
                                                        : <span className="text-muted-foreground">Not set</span>}
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant={product.isActive ? "default" : "secondary"}>
                                                        {product.isActive ? "Active" : "Inactive"}
                                                    </Badge>
                                                </TableCell>
                                                <TableCell className="text-muted-foreground text-sm">
                                                    {new Date(product.assignedAt).toLocaleDateString()}
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
        </div>
    )
}
