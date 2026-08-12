"use client"

import { useAppContext } from "@/components/context/app-context"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Dialog,DialogContent,DialogFooter,DialogHeader,DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Tabs,TabsContent,TabsList,TabsTrigger } from "@/components/ui/tabs"
import { useToast } from "@/hooks/use-toast"
import { cn,formatPKR } from "@/lib/utils"
import { Building2,Check,Edit,Package,Plus,RefreshCw,Search } from "lucide-react"
import { useMemo,useState } from "react"
import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type Organization = {
    id: number
    name: string
}

type GlobalProduct = {
    id: number
    productCode: string
    name: string
    basePrice: number
    unit: string
    status: string
    categoryName?: string
    parentCategoryName?: string
    imageUrl?: string
}

type AssignedProduct = {
    id: number
    organizationId: number
    globalProductId: number
    customPrice: number | null
    customName: string | null
    isActive: boolean
    assignedAt: string
    productName: string
    productCode: string
    productImageUrl: string | null
    organizationName: string
    categoryName?: string
    parentCategoryName?: string
}

export default function AssignProductPage() {
    const { toast } = useToast()
    const { organizationId: contextOrgId } = useAppContext()
    const [localOrgId, setLocalOrgId] = useState<string>("")
    const [searchQuery, setSearchQuery] = useState("")
    const [priceDialogOpen, setPriceDialogOpen] = useState(false)
    const [editDialogOpen, setEditDialogOpen] = useState(false)
    const [selectedProduct, setSelectedProduct] = useState<GlobalProduct | null>(null)
    const [selectedAssignment, setSelectedAssignment] = useState<AssignedProduct | null>(null)
    const [categoryFilter, setCategoryFilter] = useState("all")
    const [subCategoryFilter, setSubCategoryFilter] = useState("all")
    const [price, setPrice] = useState("")
    const [isActive, setIsActive] = useState(true)
    const [saving, setSaving] = useState(false)

    // Use context org if available, otherwise use local selection
    const selectedOrgId = contextOrgId || localOrgId
    const showOrgSelector = !contextOrgId

    // Fetch organizations (only needed when no context org)
    const { data: orgsData } = useSWR<{ items: Organization[] }>(
        showOrgSelector ? "/api/v1/organizations" : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch all global products with filters
    const productParams = new URLSearchParams()
    productParams.set("limit", "500")
    if (categoryFilter !== "all") productParams.set("category", categoryFilter)
    if (subCategoryFilter !== "all") productParams.set("subCategory", subCategoryFilter)
    if (searchQuery) productParams.set("search", searchQuery)

    const { data: productsData, isLoading: productsLoading } = useSWR<{
        items: GlobalProduct[]
    }>(
        `/api/v1/admin/global-inventory?${productParams.toString()}`,
        fetcher,
        { fallbackData: { items: [] } }
    )

    // Fetch assigned products for selected organization
    const assignmentParams = new URLSearchParams()
    assignmentParams.set("organizationId", selectedOrgId || "")
    if (categoryFilter !== "all") assignmentParams.set("category", categoryFilter)
    if (subCategoryFilter !== "all") assignmentParams.set("subCategory", subCategoryFilter)
    if (searchQuery) assignmentParams.set("search", searchQuery)

    const { data: assignmentsData, isLoading: assignmentsLoading, mutate: mutateAssignments } = useSWR<{
        items: AssignedProduct[]
    }>(
        selectedOrgId ? `/api/v1/admin/organization-assignments?${assignmentParams.toString()}` : null,
        fetcher,
        { fallbackData: { items: [] } }
    )

    const allProducts = productsData?.items ?? []
    const assignedProducts = assignmentsData?.items ?? []
    const assignedProductIds = new Set(assignedProducts.map(a => a.globalProductId))
    const hasActiveSearchOrFilters = Boolean(searchQuery.trim()) || categoryFilter !== "all" || subCategoryFilter !== "all"

    // Filter products: Not assigned = products not in assignedProductIds
    const notAssignedProducts = useMemo(() => {
        return allProducts.filter(p => !assignedProductIds.has(p.id))
    }, [allProducts, assignedProductIds])

    const filteredNotAssigned = notAssignedProducts
    const filteredAssigned = assignedProducts

    const handleAssignClick = (product: GlobalProduct) => {
        setSelectedProduct(product)
        setPrice("")
        setIsActive(true)
        setPriceDialogOpen(true)
    }

    const handleEditClick = (assignment: AssignedProduct) => {
        setSelectedAssignment(assignment)
        setPrice(assignment.customPrice ? (assignment.customPrice / 100).toString() : "")
        setIsActive(assignment.isActive)
        setEditDialogOpen(true)
    }

    const handleAssignProduct = async () => {
        if (!selectedProduct || !selectedOrgId || !price) {
            toast({ title: "Error", description: "Please enter a price", variant: "destructive" })
            return
        }

        setSaving(true)
        try {
            const res = await fetch("/api/v1/admin/organization-assignments", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    productIds: [selectedProduct.id],
                    organizationId: Number.parseInt(selectedOrgId),
                    customPrice: Number.parseFloat(price),
                    isActive: isActive,
                }),
            })

            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || "Failed to assign product")
            }

            toast({ title: "Success", description: "Product assigned successfully" })
            setPriceDialogOpen(false)
            setSelectedProduct(null)
            mutateAssignments()
        } catch (error: any) {
            toast({ title: "Error", description: error.message, variant: "destructive" })
        } finally {
            setSaving(false)
        }
    }

    const handleUpdatePrice = async () => {
        if (!selectedAssignment || !price) {
            toast({ title: "Error", description: "Please enter a price", variant: "destructive" })
            return
        }

        setSaving(true)
        try {
            const res = await fetch("/api/v1/admin/organization-assignments", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: selectedAssignment.id,
                    customPrice: Number.parseFloat(price),
                    isActive: isActive,
                }),
            })

            if (!res.ok) {
                const data = await res.json()
                throw new Error(data.error || "Failed to update price")
            }

            toast({ title: "Success", description: "Price updated successfully" })
            setEditDialogOpen(false)
            setSelectedAssignment(null)
            mutateAssignments()
        } catch (error: any) {
            toast({ title: "Error", description: error.message, variant: "destructive" })
        } finally {
            setSaving(false)
        }
    }

    return (
        <div className="space-y-6 p-4 md:p-6">
            {/* Compact Page Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
                <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-blue-100 to-indigo-100 dark:from-blue-900/50 dark:to-indigo-900/50 flex items-center justify-center border border-blue-50/50 dark:border-blue-800/50 shadow-inner">
                        <Building2 className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Group Inventory</h1>
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Manage organization product assignments</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-9 gap-2 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 shadow-sm" onClick={() => mutateAssignments()}>
                        <RefreshCw className="h-4 w-4" />
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                </div>
            </div>

            {/* Stat Cards */}
            {selectedOrgId && (
                <div className="grid gap-4 md:grid-cols-2">
                    <StatCard
                        label="Total Products"
                        value={allProducts.length}
                        icon={<Package className="h-5 w-5" />}
                        variant="blue"
                    />
                    <StatCard
                        label="Assigned Products"
                        value={assignedProducts.length}
                        icon={<Check className="h-5 w-5" />}
                        variant="green"
                    />
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
                                <SelectValue placeholder="Select an organization" />
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

            {/* Products Table with Tabs */}
            {selectedOrgId && (
                <Card className="border border-slate-200 dark:border-slate-800 shadow-sm">
                    <CardHeader className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                        <div>
                            <CardTitle className="text-xl text-slate-900 dark:text-white">Product Assignments</CardTitle>
                            <p className="text-sm text-muted-foreground">
                                Manage product assignments for the selected organization.
                            </p>
                        </div>
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-end w-full">
                            <div className="relative w-full lg:w-64">
                                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                                <Input
                                    placeholder="Search products..."
                                    className="pl-9"
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                            </div>
                            <CategoryFilter value={categoryFilter} onChange={(val) => { setCategoryFilter(val); setSubCategoryFilter('all'); }} />
                            <SubcategoryFilter categoryId={categoryFilter} value={subCategoryFilter} onChange={setSubCategoryFilter} />
                        </div>
                    </CardHeader>
                    <CardContent>
                        <Tabs defaultValue="not-assigned" className="w-full">
                            <TabsList className="grid w-full max-w-md grid-cols-2">
                                <TabsTrigger value="not-assigned">
                                    Not Assigned ({filteredNotAssigned.length})
                                </TabsTrigger>
                                <TabsTrigger value="assigned">
                                    Assigned ({filteredAssigned.length})
                                </TabsTrigger>
                            </TabsList>

                            {/* Not Assigned Tab */}
                            <TabsContent value="not-assigned" className="mt-4">
                                <div className="overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Product</TableHead>
                                                <TableHead>Category</TableHead>
                                                <TableHead>Subcategory</TableHead>
                                                <TableHead>Base Price</TableHead>
                                                <TableHead>Unit</TableHead>
                                                <TableHead className="text-right">Action</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {(() => {
                                              if (productsLoading) {
                                                return (
                                                <TableRow>
                                                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                        Loading products...
                                                    </TableCell>
                                                </TableRow>
                                            )
                                              }
                                              if (filteredNotAssigned.length === 0) {
                                                return (
                                                <TableRow>
                                                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                        {allProducts.length === 0 && hasActiveSearchOrFilters
                                                            ? "No products match your search."
                                                            : "Product is already assigned. Please check assigned product tab."}
                                                    </TableCell>
                                                </TableRow>
                                            )
                                              }
                                              return (
                                                filteredNotAssigned.map((product) => (
                                                    <TableRow key={product.id} className="hover:bg-muted/40">
                                                        <TableCell>
                                                            <div className="flex items-center gap-3">
                                                                {product.imageUrl ? (
                                                                    <img
                                                                        src={product.imageUrl}
                                                                        alt={product.name}
                                                                        className="h-10 w-10 rounded-lg border object-cover"
                                                                    />
                                                                ) : (
                                                                    <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-muted/40">
                                                                        <Package className="h-4 w-4 text-muted-foreground" />
                                                                    </div>
                                                                )}
                                                                <span className="font-medium">{product.name}</span>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">
                                                                {product.parentCategoryName || "Uncategorized"}
                                                            </Badge>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Badge variant="outline">{product.categoryName || "Uncategorized"}</Badge>
                                                        </TableCell>
                                                        <TableCell>{formatPKR(product.basePrice / 100)}</TableCell>
                                                        <TableCell>{product.unit}</TableCell>
                                                        <TableCell className="text-right">
                                                            <Button
                                                                size="sm"
                                                                onClick={() => handleAssignClick(product)}
                                                                className="gap-1"
                                                            >
                                                                <Plus className="h-3 w-3" />
                                                                Assign
                                                            </Button>
                                                        </TableCell>
                                                    </TableRow>
                                                ))
                                            )
                                            })()}
                                        </TableBody>
                                    </Table>
                                </div>
                            </TabsContent>

                            {/* Assigned Tab */}
                            <TabsContent value="assigned" className="mt-4">
                                <div className="overflow-x-auto">
                                    <Table>
                                        <TableHeader>
                                            <TableRow>
                                                <TableHead>Product</TableHead>
                                                <TableHead>Category</TableHead>
                                                <TableHead>Subcategory</TableHead>
                                                <TableHead>Custom Price</TableHead>
                                                <TableHead>Status</TableHead>
                                                <TableHead className="text-right">Action</TableHead>
                                            </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                            {(() => {
                                              if (assignmentsLoading) {
                                                return (
                                                <TableRow>
                                                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                        Loading assignments...
                                                    </TableCell>
                                                </TableRow>
                                            )
                                              }
                                              if (filteredAssigned.length === 0) {
                                                return (
                                                <TableRow>
                                                    <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                                        No products assigned yet.
                                                    </TableCell>
                                                </TableRow>
                                            )
                                              }
                                              return (
                                                filteredAssigned.map((assignment) => (
                                                    <TableRow key={assignment.id} className="hover:bg-muted/40">
                                                        <TableCell>
                                                            <div className="flex items-center gap-3">
                                                                {assignment.productImageUrl ? (
                                                                    <img
                                                                        src={assignment.productImageUrl}
                                                                        alt={assignment.productName}
                                                                        className="h-10 w-10 rounded-lg border object-cover"
                                                                    />
                                                                ) : (
                                                                    <div className="flex h-10 w-10 items-center justify-center rounded-lg border bg-muted/40">
                                                                        <Package className="h-4 w-4 text-muted-foreground" />
                                                                    </div>
                                                                )}
                                                                <span className="font-medium">{assignment.customName || assignment.productName}</span>
                                                            </div>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Badge variant="outline" className="bg-indigo-50 text-indigo-700 border-indigo-200">
                                                                {assignment.parentCategoryName || "Uncategorized"}
                                                            </Badge>
                                                        </TableCell>
                                                        <TableCell>
                                                            <Badge variant="outline">{assignment.categoryName || "Uncategorized"}</Badge>
                                                        </TableCell>
                                                        <TableCell>
                                                            {assignment.customPrice
                                                                ? formatPKR(assignment.customPrice / 100)
                                                                : <span className="text-muted-foreground">Not set</span>}
                                                        </TableCell>
                                                        <TableCell>
                                                            <Badge variant={(assignment as any).globalStatus === "active" ? "default" : "secondary"}>
                                                                {(assignment as any).globalStatus === "active" ? "Active" : "Inactive"}
                                                            </Badge>
                                                        </TableCell>
                                                        <TableCell className="text-right">
                                                            <Button
                                                                variant="outline"
                                                                size="sm"
                                                                onClick={() => handleEditClick(assignment)}
                                                                className="gap-1"
                                                            >
                                                                <Edit className="h-3 w-3" />
                                                                Edit Price
                                                            </Button>
                                                        </TableCell>
                                                    </TableRow>
                                                ))
                                            )
                                            })()}
                                        </TableBody>
                                    </Table>
                                </div>
                            </TabsContent>
                        </Tabs>
                    </CardContent>
                </Card>
            )}

            {/* Assign Price Dialog */}
            <Dialog open={priceDialogOpen} onOpenChange={setPriceDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Set Product Price</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        {selectedProduct && (
                            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                                <Package className="h-8 w-8 text-muted-foreground" />
                                <div>
                                    <p className="font-medium">{selectedProduct.name}</p>
                                    <p className="text-xs text-muted-foreground">
                                        Base price: {formatPKR(selectedProduct.basePrice / 100)}
                                    </p>
                                </div>
                            </div>
                        )}
                        <div>
                            <label htmlFor="assign-custom-price" className="block text-sm font-medium mb-2">Custom Price (PKR)</label>
                            <Input
                                id="assign-custom-price"
                                type="number"
                                step="0.01"
                                placeholder="Enter custom price"
                                value={price}
                                onChange={(e) => setPrice(e.target.value)}
                            />
                            <p className="text-xs text-muted-foreground mt-1">
                                This price will be used for orders from this organization.
                            </p>
                        </div>
                        <div className="flex items-center justify-between p-3 border rounded-lg">
                            <div className="space-y-0.5">
                                <label htmlFor="assign-active-status" className="text-sm font-medium">Active Status</label>
                                <p className="text-xs text-muted-foreground">Make product visible to organization</p>
                            </div>
                            <input
                                id="assign-active-status"
                                type="checkbox"
                                checked={isActive}
                                onChange={(e) => setIsActive(e.target.checked)}
                                className="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setPriceDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleAssignProduct} disabled={saving || !price}>
                            {saving ? "Assigning..." : "Assign Product"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Edit Price Dialog */}
            <Dialog open={editDialogOpen} onOpenChange={setEditDialogOpen}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>Edit Product Price</DialogTitle>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        {selectedAssignment && (
                            <div className="flex items-center gap-3 p-3 rounded-lg bg-muted/50">
                                <Package className="h-8 w-8 text-muted-foreground" />
                                <div>
                                    <p className="font-medium">{selectedAssignment.productName}</p>
                                    <p className="text-xs text-muted-foreground">Code: {selectedAssignment.productCode}</p>
                                </div>
                            </div>
                        )}
                        <div>
                            <label htmlFor="edit-custom-price" className="block text-sm font-medium mb-2">Custom Price (PKR)</label>
                            <Input
                                id="edit-custom-price"
                                type="number"
                                step="0.01"
                                placeholder="Enter custom price"
                                value={price}
                                onChange={(e) => setPrice(e.target.value)}
                            />
                        </div>
                        <div className="flex items-center justify-between p-3 border rounded-lg">
                            <div className="space-y-0.5">
                                <label htmlFor="edit-active-status" className="text-sm font-medium">Active Status</label>
                                <p className="text-xs text-muted-foreground">Toggle organization-level visibility</p>
                            </div>
                            <input
                                id="edit-active-status"
                                type="checkbox"
                                checked={isActive}
                                onChange={(e) => setIsActive(e.target.checked)}
                                className="h-5 w-5 rounded border-gray-300 text-indigo-600 focus:ring-indigo-600"
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={() => setEditDialogOpen(false)}>
                            Cancel
                        </Button>
                        <Button onClick={handleUpdatePrice} disabled={saving || !price}>
                            {saving ? "Updating..." : "Update Price"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
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
const CategoryFilter = ({ value, onChange }: { value: string, onChange: (val: string) => void }) => {
    const { data } = useSWR<{ items: { id: number, name: string }[] }>('/api/v1/categories?limit=100', fetcher)
    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm w-full lg:w-[180px]"
        >
            <option value="all">All Categories</option>
            {data?.items?.map((cat) => (
                <option key={cat.id} value={cat.id.toString()}>
                    {cat.name}
                </option>
            ))}
        </select>
    )
}

const SubcategoryFilter = ({ categoryId, value, onChange }: { categoryId: string, value: string, onChange: (val: string) => void }) => {
    const query = categoryId !== 'all'
        ? `/api/v1/subcategories?categoryId=${categoryId}&limit=100`
        : '/api/v1/subcategories?limit=100'
    const { data } = useSWR<{ items: { id: number, name: string }[] }>(query, fetcher)

    return (
        <select
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="rounded-md border border-input bg-background px-3 py-2 text-sm w-full lg:w-[180px]"
        >
            <option value="all">All Subcategories</option>
            {data?.items?.map((cat) => (
                <option key={cat.id} value={cat.id.toString()}>
                    {cat.name}
                </option>
            ))}
        </select>
    )
}
