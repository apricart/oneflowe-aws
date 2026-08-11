"use client"

import { useAppContext } from "@/components/context/app-context"
import { Badge } from "@/components/ui/badge"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { formatPKR } from "@/lib/utils"
import { Building2,GitBranch,Loader2,Package,Search } from "lucide-react"
import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { useEffect,useMemo,useState } from "react"
import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type Organization = { id: number; name: string }
type Group = { id: number; name: string; organizationId: number }

type BranchProduct = {
    id: number
    branchId: number
    branchName: string
    productName: string
    productCode: string
    productImageUrl: string | null
    customName: string | null
    customPrice: number | null
    basePrice: number
    isVisible: boolean
    isActive: boolean
    assignedAt: string
    organizationInventoryId: number
    globalProductId: number
    globalStatus: string
    orgIsActive: boolean
}

function mergeBranchProduct(
    productMap: Map<number, BranchProduct & { branches: string[] }>,
    globalProductId: number,
    product: BranchProduct,
): void {
    const existing = productMap.get(globalProductId)
    if (!existing) {
        productMap.set(globalProductId, {
            ...product,
            isActive: product.orgIsActive ?? product.isActive,
            branches: product.branchName ? [product.branchName] : [],
        })
        return
    }
    if (product.branchName && !existing.branches.includes(product.branchName)) {
        existing.branches.push(product.branchName)
    }
    if (new Date(product.assignedAt) < new Date(existing.assignedAt)) {
        existing.assignedAt = product.assignedAt
    }
}

export default function ViewBranchProductsPage() {
    const { data: session } = useSession()
    const router = useRouter()
    const role = (session?.user as any)?.role

    useEffect(() => {
        if (role === "BRANCH_ADMIN") {
            router.push("/dashboard")
        }
    }, [role, router])

    const { organizationId: contextOrgId } = useAppContext()
    const [localOrgId, setLocalOrgId] = useState<string>("")
    const [selectedGroupId, setSelectedGroupId] = useState<string>("")
    const [searchQuery, setSearchQuery] = useState("")

    const selectedOrgId = contextOrgId || localOrgId
    const showOrgSelector = !contextOrgId

    // Fetch organizations
    const { data: orgsData } = useSWR<{ items: Organization[] }>(
        showOrgSelector ? "/api/v1/organizations" : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch groups for selected organization
    const { data: groupsData } = useSWR<{ groups: Group[] }>(
        selectedOrgId ? `/api/v1/groups?organizationId=${selectedOrgId}` : null,
        fetcher,
        { fallbackData: { groups: [] } }
    )

    // Fetch products for selected group
    const { data: productsData, isLoading } = useSWR<{ items: BranchProduct[] }>(
        selectedOrgId && selectedGroupId
            ? `/api/v1/head-office/branch-assignments?organizationId=${selectedOrgId}&groupId=${selectedGroupId}&limit=1000`
            : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch actual branches in the selected group
    const { data: groupBranchesData } = useSWR<{ branches: { id: number; name: string }[] }>(
        selectedGroupId ? `/api/v1/groups/${selectedGroupId}/branches` : null,
        fetcher,
        { fallbackData: { branches: [] } }
    )

    const branchProducts = productsData?.items ?? []

    // Deduplicate: group by globalProductId so each product appears once
    const deduplicatedProducts = useMemo(() => {
        const productMap = new Map<number, BranchProduct & { branches: string[] }>()

        for (const p of branchProducts) {
            const gpId = p.globalProductId as number
            if (!gpId) continue

            mergeBranchProduct(productMap, gpId, p)
        }

        return Array.from(productMap.values())
    }, [branchProducts])

    // Search filtering
    const filteredProducts = useMemo(() => {
        if (!searchQuery) return deduplicatedProducts
        const q = searchQuery.toLowerCase()
        return deduplicatedProducts.filter(p =>
            p.productName.toLowerCase().includes(q) ||
            p.productCode.toLowerCase().includes(q) ||
            p.branches.some(b => b.toLowerCase().includes(q))
        )
    }, [deduplicatedProducts, searchQuery])

    const allBranches = useMemo(() => {
        return (groupBranchesData?.branches || []).map(b => b.name)
    }, [groupBranchesData])

    return (
        <div className="space-y-8 p-6">
            {/* Selectors */}
            <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                <CardHeader>
                    <CardTitle className="text-lg">Select Group</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {showOrgSelector && (
                        <div>
                            <label htmlFor="branch-organization" className="text-sm font-medium mb-2 block">Organization</label>
                            <Select value={localOrgId} onValueChange={setLocalOrgId}>
                                <SelectTrigger id="branch-organization" className="w-full max-w-md">
                                    <SelectValue placeholder="Select organization" />
                                </SelectTrigger>
                                <SelectContent>
                                    {orgsData?.items.map((org) => (
                                        <SelectItem key={org.id} value={org.id.toString()}>{org.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}

                    {selectedOrgId && (
                        <div>
                            <label htmlFor="branch-group" className="text-sm font-medium mb-2 block flex items-center gap-2">
                                <GitBranch className="h-4 w-4" /> Select Group
                            </label>
                            <Select value={selectedGroupId} onValueChange={setSelectedGroupId}>
                                <SelectTrigger id="branch-group" className="max-w-md">
                                    <SelectValue placeholder="Select a group" />
                                </SelectTrigger>
                                <SelectContent>
                                    {(groupsData?.groups || []).map((group) => (
                                        <SelectItem key={group.id} value={group.id.toString()}>{group.name}</SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Branches in this group */}
            {selectedGroupId && allBranches.length > 0 && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardContent className="pt-5">
                        <div className="flex items-center gap-2 mb-2">
                            <Building2 className="h-4 w-4 text-muted-foreground" />
                            <span className="text-sm font-medium">Branches in this group ({allBranches.length})</span>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {allBranches.map((branch) => (
                                <Badge key={branch} variant="secondary" className="text-xs px-3 py-1">
                                    <Building2 className="mr-1.5 h-3 w-3" />
                                    {branch}
                                </Badge>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Products Table — Read Only */}
            {selectedGroupId && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <CardTitle className="text-xl">Group Products</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                Products assigned to branches in the selected group.
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
                                            <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
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
                                            <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                {branchProducts.length === 0
                                                    ? "No products assigned to branches in this group yet."
                                                    : "No products match your search."}
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      return (
                                        filteredProducts.map((product) => (
                                            <TableRow
                                                key={product.globalProductId || product.id}
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
                                                        <span className="font-medium">{product.customName || product.productName}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline">{product.productCode}</Badge>
                                                </TableCell>
                                                <TableCell className="font-medium">
                                                    {(() => {
                                                      if (product.customPrice) {
                                                        return formatPKR(product.customPrice / 100)
                                                      }
                                                      if (product.basePrice) {
                                                        return formatPKR(product.basePrice / 100)
                                                      }
                                                      return <span className="text-muted-foreground">-</span>
                                                    })()}
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
