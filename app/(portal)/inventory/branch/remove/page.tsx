"use client"

import { useState, useMemo } from "react"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Search, Package, Trash2, Building2, Users, AlertTriangle, Info } from "lucide-react"
import { useToast } from "@/hooks/use-toast"
import { useAppContext } from "@/components/context/app-context"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type Organization = { id: number; name: string }
type Branch = { id: number; name: string; organizationId: number }
type Group = { id: number; name: string; organizationId: number }

type BranchAssignment = {
    id: number
    branchId: number
    organizationInventoryId: number
    globalProductId: number
    productName: string
    productCode: string
    productImageUrl: string | null
    branchName: string
    isActive: boolean
    isVisible: boolean
}

export default function RemoveFromBranchPage() {
    const { toast } = useToast()
    const { organizationId: contextOrgId } = useAppContext()
    const [localOrgId, setLocalOrgId] = useState<string>("")
    const [searchQuery, setSearchQuery] = useState("")
    const [statusFilter, setStatusFilter] = useState<string>("all")
    const [removeDialogOpen, setRemoveDialogOpen] = useState(false)
    const [selectedGroup, setSelectedGroup] = useState<string>("")
    const [saving, setSaving] = useState(false)

    const selectedOrgId = contextOrgId || localOrgId
    const showOrgSelector = !contextOrgId

    // Check if user has made a valid selection
    const hasSelection = selectedGroup !== ""

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

    // Fetch group branches when a group is selected
    const { data: groupBranchesData } = useSWR<{ branches: Branch[] }>(
        selectedGroup ? `/api/v1/groups/${selectedGroup}/branches` : null,
        fetcher,
        { fallbackData: { branches: [] } }
    )

    // Only fetch assignments when a group selection has been made - use groupId parameter
    const { data: assignmentsData, isLoading, mutate } = useSWR<{ items: BranchAssignment[] }>(
        selectedOrgId && hasSelection ? `/api/v1/head-office/branch-assignments?organizationId=${selectedOrgId}&groupId=${selectedGroup}&limit=500` : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    const assignments = assignmentsData?.items ?? []
    const groups = groupsData?.groups ?? []
    const groupBranches = groupBranchesData?.branches ?? []

    // Filter assignments by search only (group filter is handled by API now)
    // Group assignments by organizationInventoryId to get unique products
    type UniqueProduct = {
        organizationInventoryId: number
        productName: string
        productCode: string
        productImageUrl: string | null
        isActive: boolean
        isVisible: boolean
        assignmentIds: number[] // All assignment IDs for this product across branches
        branchNames: string[] // List of branches this product is assigned to
    }

    const uniqueProducts = useMemo(() => {
        if (!hasSelection) return []

        const productMap = new Map<number, UniqueProduct>()

        for (const a of assignments) {
            const existing = productMap.get(a.organizationInventoryId)
            if (existing) {
                existing.assignmentIds.push(a.id)
                if (!existing.branchNames.includes(a.branchName)) {
                    existing.branchNames.push(a.branchName)
                }
            } else {
                productMap.set(a.organizationInventoryId, {
                    organizationInventoryId: a.organizationInventoryId,
                    productName: a.productName,
                    productCode: a.productCode,
                    productImageUrl: a.productImageUrl,
                    isActive: a.isActive,
                    isVisible: a.isVisible,
                    assignmentIds: [a.id],
                    branchNames: [a.branchName]
                })
            }
        }

        return Array.from(productMap.values())
    }, [assignments, hasSelection])

    // Filter unique products by status and search
    const filteredProducts = useMemo(() => {
        let result = uniqueProducts

        // Apply status filter
        if (statusFilter !== "all") {
            const isActiveMatch = statusFilter === "active"
            result = result.filter(p => p.isActive === isActiveMatch)
        }

        if (!searchQuery) return result
        const q = searchQuery.toLowerCase()
        return result.filter(p =>
            p.productName?.toLowerCase().includes(q) ||
            p.productCode?.toLowerCase().includes(q)
        )
    }, [uniqueProducts, searchQuery, statusFilter])

    // Track selected products by organizationInventoryId
    const [selectedProducts, setSelectedProducts] = useState<number[]>([])

    const handleProductToggle = (orgInvId: number) => {
        setSelectedProducts(prev =>
            prev.includes(orgInvId)
                ? prev.filter(id => id !== orgInvId)
                : [...prev, orgInvId]
        )
    }

    const handleSelectAll = () => {
        if (selectedProducts.length === filteredProducts.length) {
            setSelectedProducts([])
        } else {
            setSelectedProducts(filteredProducts.map(p => p.organizationInventoryId))
        }
    }

    const handleGroupSelect = (groupId: string) => {
        setSelectedGroup(groupId)
        setSelectedProducts([]) // Clear selections
    }

    const clearSelection = () => {
        setSelectedGroup("")
        setSelectedProducts([])
    }

    const handleRemove = async () => {
        if (selectedProducts.length === 0) {
            toast({ title: "Error", description: "Please select at least one product to remove", variant: "destructive" })
            return
        }

        // Get all assignment IDs for selected products
        const assignmentIdsToRemove: number[] = []
        for (const orgInvId of selectedProducts) {
            const product = uniqueProducts.find(p => p.organizationInventoryId === orgInvId)
            if (product) {
                assignmentIdsToRemove.push(...product.assignmentIds)
            }
        }

        setSaving(true)
        try {
            // Remove each assignment
            const removePromises = assignmentIdsToRemove.map(id =>
                fetch(`/api/v1/head-office/branch-assignments?id=${id}`, {
                    method: "DELETE",
                })
            )

            const results = await Promise.all(removePromises)
            const failedCount = results.filter(r => !r.ok).length

            if (failedCount > 0) {
                toast({
                    title: "Partial Success",
                    description: `Removed ${assignmentIdsToRemove.length - failedCount} of ${assignmentIdsToRemove.length} assignments. ${failedCount} failed.`,
                    variant: "destructive"
                })
            } else {
                toast({
                    title: "Success",
                    description: `Successfully removed ${selectedProducts.length} product(s) from all branches in the group`,
                })
            }

            setRemoveDialogOpen(false)
            setSelectedProducts([])
            mutate()
        } catch (error: any) {
            toast({ title: "Error", description: error.message, variant: "destructive" })
        } finally {
            setSaving(false)
        }
    }

    // Get display name for current selection
    const getSelectionLabel = () => {
        if (selectedGroup) {
            const group = groups.find(g => g.id.toString() === selectedGroup)
            return `Group: ${group?.name || selectedGroup}`
        }
        return null
    }

    return (
        <div className="space-y-8 p-6">
            {/* Organization Selector */}
            {showOrgSelector && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader>
                        <CardTitle className="text-lg">Step 1: Select Organization</CardTitle>
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

            {/* Selection - Group Only */}
            {selectedOrgId && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader>
                        <CardTitle className="text-lg">
                            {showOrgSelector ? "Step 2: " : "Step 1: "}Select Group
                        </CardTitle>
                        <p className="text-sm text-muted-foreground">
                            Select a group to view and remove product assignments from all branches in that group.
                        </p>
                    </CardHeader>
                    <CardContent className="space-y-4">
                        {/* Group Selection */}
                        <div className="max-w-md">
                            <label htmlFor="remove-inventory-group" className="text-sm font-medium mb-3 block flex items-center gap-2">
                                <Users className="h-4 w-4" />
                                Select Group
                            </label>
                            <Select value={selectedGroup} onValueChange={handleGroupSelect}>
                                <SelectTrigger id="remove-inventory-group" className={selectedGroup ? "border-red-400" : ""}>
                                    <SelectValue placeholder="Choose a group..." />
                                </SelectTrigger>
                                <SelectContent>
                                    {groups.length === 0 ? (
                                        <div className="py-2 px-3 text-sm text-muted-foreground">No groups available</div>
                                    ) : (
                                        groups.map((group) => (
                                            <SelectItem key={group.id} value={group.id.toString()}>
                                                {group.name}
                                            </SelectItem>
                                        ))
                                    )}
                                </SelectContent>
                            </Select>
                        </div>

                        {/* Branches in Selected Group */}
                        {hasSelection && groupBranches.length > 0 && (
                            <div className="p-4 bg-slate-50 dark:bg-slate-900/50 rounded-lg border">
                                <p className="text-sm font-medium mb-3 flex items-center gap-2">
                                    <Building2 className="h-4 w-4" />
                                    Branches in this Group ({groupBranches.length})
                                </p>
                                <div className="flex flex-wrap gap-2">
                                    {groupBranches.map((branch) => (
                                        <Badge key={branch.id} variant="outline" className="bg-white dark:bg-slate-800">
                                            {branch.name}
                                        </Badge>
                                    ))}
                                </div>
                                <p className="text-xs text-muted-foreground mt-2">
                                    Removing products will remove them from all branches listed above.
                                </p>
                            </div>
                        )}

                        {/* Current Selection Display */}
                        {hasSelection && (
                            <div className="flex items-center justify-between p-3 bg-slate-100 dark:bg-slate-800 rounded-lg">
                                <div className="flex items-center gap-2">
                                    <Badge variant="secondary" className="text-sm">
                                        {getSelectionLabel()}
                                    </Badge>
                                </div>
                                <Button variant="ghost" size="sm" onClick={clearSelection}>
                                    Clear Selection
                                </Button>
                            </div>
                        )}

                        {/* Info message when no selection */}
                        {!hasSelection && (
                            <div className="flex items-center gap-3 p-4 bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg">
                                <Info className="h-5 w-5 text-amber-600" />
                                <p className="text-sm text-amber-800 dark:text-amber-200">
                                    Please select a <strong>Group</strong> above to view assigned products.
                                </p>
                            </div>
                        )}

                        {/* Search & Filter - Only show if selection made */}
                        {hasSelection && (
                            <div className="flex flex-col md:flex-row gap-4">
                                <div className="flex-1 max-w-md">
                                    <label htmlFor="remove-inventory-search" className="text-sm font-medium mb-2 block">Search Products</label>
                                    <div className="relative">
                                        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                        <Input
                                            id="remove-inventory-search"
                                            placeholder="Search by name or code..."
                                            className="pl-9"
                                            value={searchQuery}
                                            onChange={(e) => setSearchQuery(e.target.value)}
                                        />
                                    </div>
                                </div>

                                <div className="w-full md:w-48">
                                    <label htmlFor="remove-inventory-status" className="text-sm font-medium mb-2 block">Status</label>
                                    <Select value={statusFilter} onValueChange={setStatusFilter}>
                                        <SelectTrigger id="remove-inventory-status">
                                            <SelectValue placeholder="Filter Status" />
                                        </SelectTrigger>
                                        <SelectContent>
                                            <SelectItem value="all">All Statuses</SelectItem>
                                            <SelectItem value="active">Active Only</SelectItem>
                                            <SelectItem value="inactive">Inactive Only</SelectItem>
                                        </SelectContent>
                                    </Select>
                                </div>
                            </div>
                        )}
                    </CardContent>
                </Card>
            )}

            {/* Assignments Table - Only show when selection is made */}
            {selectedOrgId && hasSelection && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <CardTitle className="text-xl">Products in Group</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                {isLoading
                                    ? "Loading products..."
                                    : `${filteredProducts.length} product(s) found. Select products to remove from all branches.`
                                }
                            </p>
                        </div>
                        <Button
                            onClick={() => setRemoveDialogOpen(true)}
                            disabled={selectedProducts.length === 0}
                            variant="destructive"
                            className="gap-2"
                        >
                            <Trash2 className="h-4 w-4" />
                            Remove Selected ({selectedProducts.length})
                        </Button>
                    </CardHeader>
                    <CardContent>
                        <div className="overflow-x-auto">
                            <Table>
                                <TableHeader>
                                    <TableRow>
                                        <TableHead className="w-12">
                                            <Checkbox
                                                checked={selectedProducts.length === filteredProducts.length && filteredProducts.length > 0}
                                                onCheckedChange={handleSelectAll}
                                                disabled={filteredProducts.length === 0}
                                            />
                                        </TableHead>
                                        <TableHead>Product</TableHead>
                                        <TableHead>Code</TableHead>
                                    </TableRow>
                                </TableHeader>
                                <TableBody>
                                    {(() => {
                                      if (isLoading) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={3} className="py-10 text-center text-sm text-muted-foreground">
                                                Loading products...
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      if (filteredProducts.length === 0) {
                                        return (
                                        <TableRow>
                                            <TableCell colSpan={3} className="py-10 text-center text-sm text-muted-foreground">
                                                No products assigned to branches in this group.
                                            </TableCell>
                                        </TableRow>
                                    )
                                      }
                                      return (
                                        filteredProducts.map((product) => (
                                            <TableRow
                                                key={product.organizationInventoryId}
                                                className={`hover:bg-muted/40 cursor-pointer ${selectedProducts.includes(product.organizationInventoryId) ? "bg-red-50/50 dark:bg-red-950/20" : ""}`}
                                                onClick={() => handleProductToggle(product.organizationInventoryId)}
                                            >
                                                <TableCell onClick={(e) => e.stopPropagation()}>
                                                    <Checkbox
                                                        checked={selectedProducts.includes(product.organizationInventoryId)}
                                                        onCheckedChange={() => handleProductToggle(product.organizationInventoryId)}
                                                    />
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
                                                        <span className="font-medium">{product.productName}</span>
                                                    </div>
                                                </TableCell>
                                                <TableCell>
                                                    <Badge variant="outline">{product.productCode}</Badge>
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

            {/* Remove Confirmation Dialog */}
            <Dialog open={removeDialogOpen} onOpenChange={setRemoveDialogOpen}>
                <DialogContent className="max-w-lg">
                    <DialogHeader>
                        <DialogTitle className="flex items-center gap-2 text-red-600">
                            <AlertTriangle className="h-5 w-5" />
                            Confirm Removal
                        </DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <p className="text-sm text-muted-foreground">
                            You are about to remove <strong>{selectedProducts.length}</strong> product(s) from <strong>all branches</strong> in this group.
                        </p>
                        <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
                            <p className="text-sm text-amber-800 dark:text-amber-200">
                                <strong>Warning:</strong> This will remove the selected products from ALL branches in the group.
                                The products can be re-assigned later if needed.
                            </p>
                        </div>
                        <div className="max-h-40 overflow-y-auto border rounded-lg p-3 space-y-2">
                            {selectedProducts.slice(0, 10).map(orgInvId => {
                                const product = uniqueProducts.find(p => p.organizationInventoryId === orgInvId)
                                if (!product) return null
                                return (
                                    <div key={orgInvId} className="flex items-center justify-between text-sm">
                                        <span>{product.productName}</span>
                                        <div className="flex gap-1">
                                            {product.branchNames.slice(0, 3).map((name) => (
                                                <Badge key={name} variant="outline" className="text-xs">{name}</Badge>
                                            ))}
                                            {product.branchNames.length > 3 && (
                                                <Badge variant="secondary" className="text-xs">+{product.branchNames.length - 3}</Badge>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                            {selectedProducts.length > 10 && (
                                <p className="text-sm text-muted-foreground text-center">
                                    ...and {selectedProducts.length - 10} more
                                </p>
                            )}
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setRemoveDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleRemove}
                            disabled={saving}
                        >
                            {saving ? "Removing..." : `Remove ${selectedProducts.length} Product(s)`}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </div>
    )
}
