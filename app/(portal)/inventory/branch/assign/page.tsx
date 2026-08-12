"use client"

import { useState,useMemo,useEffect } from "react"
import useSWR from "swr"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { formatPKR } from "@/lib/utils"
import { Search,Package,Building2,GitBranch,Users,Loader2,CheckCircle2 } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useAppContext } from "@/components/context/app-context"


const fetcher = (url: string) => fetch(url).then((res) => res.json())

type Organization = { id: number; name: string }
type Branch = { id: number; name: string; organizationId: number }
type Group = { id: number; name: string; organizationId: number }

type AssignmentState = {
    organizationInventoryIds: number[]
    partialOrganizationInventoryIds: number[]
    branchCount: number
}

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

export default function AssignToBranchPage() {
    const { toast } = useToast()
    const { organizationId: contextOrgId } = useAppContext()
    const [localOrgId, setLocalOrgId] = useState<string>("")
    const [searchQuery, setSearchQuery] = useState("")
    const [statusFilter, setStatusFilter] = useState<string>("all")
    const [selectedProducts, setSelectedProducts] = useState<number[]>([])
    const [selectedGroup, setSelectedGroup] = useState<string>("")
    const [saving, setSaving] = useState(false)

    const [alreadyAssignedIds, setAlreadyAssignedIds] = useState<Set<number>>(new Set())
    const [loadingAssignments, setLoadingAssignments] = useState(false)



    const selectedOrgId = contextOrgId || localOrgId
    const showOrgSelector = !contextOrgId

    // Fetch organizations
    const { data: orgsData } = useSWR<{ items: Organization[] }>(
        showOrgSelector ? "/api/v1/organizations" : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch organization's assigned products
    const { data: productsData, isLoading, mutate } = useSWR<{ items: OrgProduct[] }>(
        selectedOrgId ? `/api/v1/head-office/organization-inventory?organizationId=${selectedOrgId}&status=${statusFilter}&limit=1000` : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch groups for selected organization
    const { data: groupsData } = useSWR<{ groups: Group[] }>(
        selectedOrgId ? `/api/v1/groups?organizationId=${selectedOrgId}` : null,
        fetcher,
        { fallbackData: { groups: [] } }
    )

    // Fetch group branches when a group is selected
    const { data: groupBranchesData } = useSWR<{ branches: Branch[] }>(
        selectedGroup ? `/api/v1/groups/${selectedGroup}/branches` : null,
        fetcher,
        { fallbackData: { branches: [] } }
    )

    const orgProducts = productsData?.items ?? []
    const groups = groupsData?.groups ?? []
    const branchesToShow = groupBranchesData?.branches ?? []

    // When group changes, fetch existing assignments to know which products are already assigned
    useEffect(() => {
        if (!selectedGroup || !selectedOrgId) {
            setAlreadyAssignedIds(new Set())
            setSelectedProducts([])
            return
        }

        const controller = new AbortController()
        setAlreadyAssignedIds(new Set())
        setSelectedProducts([])

        const fetchAssignments = async () => {
            setLoadingAssignments(true)
            try {
                const params = new URLSearchParams({
                    organizationId: String(selectedOrgId),
                    groupId: selectedGroup,
                    view: "assignment-state",
                })
                const res = await fetch(
                    `/api/v1/head-office/branch-assignments?${params.toString()}`,
                    { signal: controller.signal },
                )
                const data = await res.json().catch(() => null) as AssignmentState | { error?: string } | null

                if (!res.ok) {
                    const message = data && "error" in data && data.error
                        ? data.error
                        : "Failed to load existing group assignments"
                    throw new Error(message)
                }

                if (!data || !("organizationInventoryIds" in data) || !Array.isArray(data.organizationInventoryIds)) {
                    throw new Error("Invalid assignment-state response")
                }

                setAlreadyAssignedIds(new Set(data.organizationInventoryIds.map(Number)))
            } catch (error) {
                if (controller.signal.aborted) return
                console.error("Failed to load group assignments:", error)
                setAlreadyAssignedIds(new Set())
                toast({
                    title: "Unable to load assignments",
                    description: error instanceof Error
                        ? error.message
                        : "Please refresh and try again.",
                    variant: "destructive",
                })
            } finally {
                if (!controller.signal.aborted) {
                    setLoadingAssignments(false)
                }
            }
        }

        fetchAssignments()

        return () => controller.abort()
    }, [selectedGroup, selectedOrgId])

    // Search filtering
    const filteredProducts = useMemo(() => {
        if (!searchQuery) return orgProducts
        const q = searchQuery.toLowerCase()
        return orgProducts.filter(p =>
            p.productName.toLowerCase().includes(q) ||
            p.productCode.toLowerCase().includes(q)
        )
    }, [orgProducts, searchQuery])

    const handleProductToggle = (productId: number) => {
        // Don't allow toggling already-assigned products
        if (alreadyAssignedIds.has(productId)) return
        setSelectedProducts(prev =>
            prev.includes(productId)
                ? prev.filter(id => id !== productId)
                : [...prev, productId]
        )
    }

    const handleSelectAllNew = () => {
        const newProducts = filteredProducts.filter(p => !alreadyAssignedIds.has(p.id))
        if (selectedProducts.length === newProducts.length) {
            setSelectedProducts([])
        } else {
            setSelectedProducts(newProducts.map(p => p.id))
        }
    }

    const handleAssign = async () => {
        if (selectedProducts.length === 0) {
            toast({ title: "Error", description: "Please select at least one new product to assign", variant: "destructive" })
            return
        }
        if (!selectedGroup) {
            toast({ title: "Error", description: "Please select a group first", variant: "destructive" })
            return
        }

        setSaving(true)
        try {
            const res = await fetch("/api/v1/head-office/branch-assignments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    organizationInventoryIds: selectedProducts,
                    groupId: Number.parseInt(selectedGroup),
                    organizationId: Number.parseInt(selectedOrgId as string),
                }),
            })

            const data = await res.json()
            if (!res.ok) throw new Error(data.error || "Failed to assign products")

            const groupName = groups.find(g => g.id.toString() === selectedGroup)?.name || "group"
            toast({
                title: "Products Assigned",
                description: `${selectedProducts.length} product${selectedProducts.length !== 1 ? "s" : ""} assigned to ${groupName}`,
                variant: "success",
            })

            // Move newly assigned into the already-assigned set
            setAlreadyAssignedIds(prev => {
                const updated = new Set(prev)
                for (const id of selectedProducts) updated.add(id)
                return updated
            })
            setSelectedProducts([])
            mutate()
        } catch (error: any) {
            console.error("Assignment error:", error)
            toast({ title: "Error", description: error.message || "Failed to assign products", variant: "destructive" })
        } finally {
            setSaving(false)
        }
    }



    const newProductsCount = selectedProducts.length
    const alreadyAssignedCount = filteredProducts.filter(p => alreadyAssignedIds.has(p.id)).length

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

            {/* STEP 1: Group Selection */}
            {selectedOrgId && (
                <Card className="border-2 border-blue-200 dark:border-blue-900 shadow-sm bg-blue-50/30 dark:bg-blue-950/20">
                    <CardHeader>
                        <CardTitle className="text-lg flex items-center gap-2">
                            <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-bold">1</div>
                            Select Group
                        </CardTitle>
                        <p className="text-sm text-muted-foreground">Choose which group's branches should receive the products.</p>
                    </CardHeader>
                    <CardContent>
                        <div className="flex flex-col md:flex-row gap-4 items-start">
                            <div className="w-full md:w-80">
                                <Select value={selectedGroup} onValueChange={setSelectedGroup}>
                                    <SelectTrigger className="bg-white dark:bg-slate-900">
                                        <SelectValue placeholder="Select a group" />
                                    </SelectTrigger>
                                    <SelectContent>
                                        {groups.length === 0 ? (
                                            <div className="py-2 px-3 text-sm text-muted-foreground">No groups available</div>
                                        ) : (
                                            groups.map((group) => (
                                                <SelectItem key={group.id} value={group.id.toString()}>
                                                    <div className="flex items-center gap-2">
                                                        <Users className="h-4 w-4" />
                                                        {group.name}
                                                    </div>
                                                </SelectItem>
                                            ))
                                        )}
                                    </SelectContent>
                                </Select>
                            </div>

                            {/* Branches in this group (info display) */}
                            {selectedGroup && (
                                <div className="flex-1">
                                    <p className="text-xs font-medium text-muted-foreground mb-2 flex items-center gap-1">
                                        <GitBranch className="h-3.5 w-3.5" />
                                        Branches in this group:
                                    </p>
                                    <div className="flex flex-wrap gap-2">
                                        {branchesToShow.length === 0 ? (
                                            <Badge variant="outline" className="text-amber-600 border-amber-200 bg-amber-50 dark:bg-amber-950/30">
                                                No branches in this group
                                            </Badge>
                                        ) : (
                                            branchesToShow.map((branch) => (
                                                <Badge key={branch.id} variant="outline" className="text-blue-700 border-blue-200 bg-blue-50 dark:bg-blue-950/30 dark:text-blue-300 dark:border-blue-800">
                                                    <Building2 className="h-3 w-3 mr-1" />
                                                    {branch.name}
                                                </Badge>
                                            ))
                                        )}
                                    </div>
                                    {loadingAssignments && (
                                        <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
                                            <Loader2 className="h-3 w-3 animate-spin" />
                                            Loading existing assignments...
                                        </p>
                                    )}
                                </div>
                            )}
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* STEP 2: Products Table (only show after group is selected) */}
            {selectedOrgId && selectedGroup && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <CardTitle className="text-lg flex items-center gap-2">
                                <div className="flex h-7 w-7 items-center justify-center rounded-full bg-blue-600 text-white text-xs font-bold">2</div>
                                Select Products to Assign
                            </CardTitle>
                            <p className="text-sm text-muted-foreground mt-1">
                                Products already assigned to this group are highlighted. Select new products to add.
                            </p>
                            {alreadyAssignedCount > 0 && (
                                <p className="text-xs text-emerald-600 dark:text-emerald-400 mt-1 flex items-center gap-1">
                                    <CheckCircle2 className="h-3.5 w-3.5" />
                                    {alreadyAssignedCount} product{alreadyAssignedCount !== 1 ? "s" : ""} already assigned to this group
                                </p>
                            )}
                        </div>
                        <div className="flex flex-col gap-4 w-full lg:flex-row lg:items-center lg:justify-end lg:w-auto">
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
                                        <TableHead className="w-12">
                                            <Checkbox
                                                checked={
                                                    filteredProducts.some(p => !alreadyAssignedIds.has(p.id)) &&
                                                    selectedProducts.length === filteredProducts.filter(p => !alreadyAssignedIds.has(p.id)).length
                                                }
                                                onCheckedChange={handleSelectAllNew}
                                                title="Select all new products"
                                            />
                                        </TableHead>
                                        <TableHead>Product</TableHead>
                                        <TableHead>Code</TableHead>
                                        <TableHead>Price</TableHead>

                                        <TableHead className="w-20">Assigned</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {(() => {
                                      if (isLoading || loadingAssignments) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                <div className="flex items-center justify-center gap-2">
                                                    <Loader2 className="h-4 w-4 animate-spin" />
                                                    {loadingAssignments ? "Loading assignments..." : "Loading products..."}
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      if (filteredProducts.length === 0) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                {orgProducts.length === 0
                                                    ? "No products assigned to this organization yet."
                                                    : "No products match your search."}
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      return (
                                        filteredProducts.map((product) => {
                                            const isAssigned = alreadyAssignedIds.has(product.id)
                                            const isSelected = selectedProducts.includes(product.id)

                                            return (
                                                <TableRow
                                                    key={product.id}
                                                    className={`cursor-pointer transition-colors ${(() => {
                                                      if (isAssigned) {
                                                        return "bg-emerald-50/60 dark:bg-emerald-950/20 hover:bg-emerald-50 dark:hover:bg-emerald-950/30"
                                                      }
                                                      if (isSelected) {
                                                        return "bg-blue-50/50 dark:bg-blue-950/20"
                                                      }
                                                      return "hover:bg-muted/40"
                                                    })()
                                                        }`}
                                                    onClick={() => handleProductToggle(product.id)}
                                                >
                                                    <TableCell onClick={(e) => e.stopPropagation()}>
                                                        {isAssigned ? (
                                                            <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                                                        ) : (
                                                            <Checkbox
                                                                checked={isSelected}
                                                                onCheckedChange={() => handleProductToggle(product.id)}
                                                            />
                                                        )}
                                                    </TableCell>
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
                                                            <span className={`font-medium ${isAssigned ? "text-emerald-700 dark:text-emerald-400" : ""}`}>
                                                                {product.customName || product.productName}
                                                            </span>
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
                                                        {isAssigned ? (
                                                            <Badge variant="outline" className="text-emerald-600 border-emerald-200 bg-emerald-50 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800 text-[10px]">
                                                                Assigned
                                                            </Badge>
                                                        ) : (
                                                            <span className="text-xs text-muted-foreground">New</span>
                                                        )}
                                                    </TableCell>
                                                </TableRow>
                                            )
                                        })
                                    )
                                    })()}
                                </TableBody>
                            </Table>
                        </div>

                        {/* Assign button bar */}
                        <div className="mt-6 flex items-center justify-between border-t pt-4">
                            <p className="text-sm text-muted-foreground">
                                {(() => {
                                  if (newProductsCount > 0) {
                                    return `${newProductsCount} new product${newProductsCount !== 1 ? "s" : ""} selected to assign`
                                  }
                                  return "Select products to assign to this group's branches"
                                })()}
                            </p>
                            <Button
                                onClick={handleAssign}
                                loading={saving}
                                disabled={saving || newProductsCount === 0 || branchesToShow.length === 0}
                                className="gap-2"
                            >
                                {saving ? (
                                    "Assigning..."
                                ) : (
                                    <>
                                        <GitBranch className="h-4 w-4" />
                                        Assign to Group ({newProductsCount})
                                    </>
                                )}
                            </Button>
                        </div>
                    </CardContent>
                </Card>
            )}

            {/* Prompt to select group if none selected */}
            {selectedOrgId && !selectedGroup && (
                <Card className="border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/50 dark:bg-slate-900/50">
                    <CardContent className="py-16 text-center">
                        <Users className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-40" />
                        <p className="text-lg font-medium text-muted-foreground">Select a group above</p>
                        <p className="text-sm text-muted-foreground mt-1">Choose a group to see its products and assign new ones.</p>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
