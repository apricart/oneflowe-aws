"use client"
import { useState } from "react"
import useSWR from "swr"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { useToast } from "@/hooks/use-toast"
import { Search, Sparkles, Plus, Edit, Trash2, FolderOpen, Package, Loader2, FolderTree, RefreshCw } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatCountLabel } from "@/lib/count-label"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type Category = {
    id: number
    name: string
}

type Subcategory = {
    id: number
    name: string
    parentId: number
    categoryName: string
    productsCount: number
    createdAt: string
    updatedAt: string
}

export default function SubcategoriesPage() {
    const { toast } = useToast()
    const [searchQuery, setSearchQuery] = useState("")
    const [categoryFilter, setCategoryFilter] = useState<string>("")

    // Dialog state
    const [dialogMode, setDialogMode] = useState<"create" | "edit" | "delete" | null>(null)
    const [selectedSubcategory, setSelectedSubcategory] = useState<Subcategory | null>(null)
    const [subcategoryName, setSubcategoryName] = useState("")
    const [selectedCategoryId, setSelectedCategoryId] = useState<string>("")
    const [isSubmitting, setIsSubmitting] = useState(false)

    // Fetch categories for dropdown
    const { data: categoriesData } = useSWR<{ items: Category[] }>(
        `/api/v1/categories`,
        fetcher,
        { fallbackData: { items: [] } }
    )
    const categories = categoriesData?.items ?? []

    // Fetch subcategories
    const params = new URLSearchParams()
    if (searchQuery) params.set("search", searchQuery)
    if (categoryFilter) params.set("categoryId", categoryFilter)

    const { data, isLoading, mutate } = useSWR<{
        items: Subcategory[]
        pagination: { page: number; limit: number; total: number; pages: number }
    }>(`/api/v1/subcategories?${params.toString()}`, fetcher, {
        // No fallbackData: zero-filled fallback made the stat cards flash "0"
        // before the real numbers arrived. keepPreviousData shows the previous
        // results while a search/filter change loads.
        revalidateOnFocus: false,
        keepPreviousData: true,
    })

    const subcategories = data?.items ?? []
    const totalSubcategories = data?.pagination?.total ?? 0

    const openCreateDialog = () => {
        setSubcategoryName("")
        setSelectedCategoryId("")
        setSelectedSubcategory(null)
        setDialogMode("create")
    }

    const openEditDialog = (subcategory: Subcategory) => {
        setSubcategoryName(subcategory.name)
        setSelectedCategoryId(subcategory.parentId.toString())
        setSelectedSubcategory(subcategory)
        setDialogMode("edit")
    }

    const openDeleteDialog = (subcategory: Subcategory) => {
        setSelectedSubcategory(subcategory)
        setDialogMode("delete")
    }

    const closeDialog = () => {
        setDialogMode(null)
        setSelectedSubcategory(null)
        setSubcategoryName("")
        setSelectedCategoryId("")
        setIsSubmitting(false)
    }

    const handleCreate = async () => {
        if (!subcategoryName.trim() || !selectedCategoryId) {
            toast({ title: "Error", description: "Name and category are required", variant: "destructive" })
            return
        }

        setIsSubmitting(true)
        try {
            const res = await fetch("/api/v1/subcategories", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    name: subcategoryName.trim(),
                    categoryId: parseInt(selectedCategoryId)
                }),
            })
            const data = await res.json()

            if (res.ok) {
                toast({ title: "Success", description: "Subcategory created successfully" })
                mutate()
                closeDialog()
            } else {
                toast({ title: "Error", description: data.error || "Failed to create subcategory", variant: "destructive" })
            }
        } catch (error) {
            toast({ title: "Error", description: "Failed to create subcategory", variant: "destructive" })
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleEdit = async () => {
        if (!selectedSubcategory || !subcategoryName.trim() || !selectedCategoryId) {
            toast({ title: "Error", description: "Name and category are required", variant: "destructive" })
            return
        }

        setIsSubmitting(true)
        try {
            const res = await fetch("/api/v1/subcategories", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    id: selectedSubcategory.id,
                    name: subcategoryName.trim(),
                    categoryId: parseInt(selectedCategoryId)
                }),
            })
            const data = await res.json()

            if (res.ok) {
                toast({ title: "Success", description: "Subcategory updated successfully" })
                mutate()
                closeDialog()
            } else {
                toast({ title: "Error", description: data.error || "Failed to update subcategory", variant: "destructive" })
            }
        } catch (error) {
            toast({ title: "Error", description: "Failed to update subcategory", variant: "destructive" })
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleDelete = async () => {
        if (!selectedSubcategory) return

        setIsSubmitting(true)
        try {
            const res = await fetch(`/api/v1/subcategories?id=${selectedSubcategory.id}`, {
                method: "DELETE",
            })
            const data = await res.json()

            if (res.ok) {
                toast({ title: "Success", description: "Subcategory deleted successfully" })
                mutate()
                closeDialog()
            } else {
                toast({ title: "Cannot Delete", description: data.error, variant: "destructive" })
            }
        } catch (error) {
            toast({ title: "Error", description: "Failed to delete subcategory", variant: "destructive" })
        } finally {
            setIsSubmitting(false)
        }
    }

    return (
        <div className="space-y-6 p-4 md:p-6" suppressHydrationWarning>
            {/* Compact Page Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
                <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-amber-100 to-orange-100 dark:from-amber-900/50 dark:to-orange-900/50 flex items-center justify-center border border-amber-50/50 dark:border-amber-800/50 shadow-inner">
                        <FolderOpen className="h-6 w-6 text-amber-600 dark:text-amber-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Subcategory Management</h1>
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Manage products within categories</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-9 gap-2 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 shadow-sm" onClick={() => mutate()}>
                        <RefreshCw className="h-4 w-4" />
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                    <Button size="sm" className="h-9 gap-2 bg-amber-600 hover:bg-amber-700 text-white shadow-sm" onClick={openCreateDialog}>
                        <Plus className="h-4 w-4" />
                        <span>Create Subcategory</span>
                    </Button>
                </div>
            </div>

            {/* Stat Cards */}
            <div className="grid gap-4 md:grid-cols-2">
                <StatCard
                    label="Total Subcategories"
                    value={totalSubcategories}
                    icon={<FolderOpen className="h-5 w-5" />}
                    variant="amber"
                    isLoading={!data}
                />
                <StatCard
                    label="Total Products"
                    value={subcategories.reduce((acc, sub) => acc + sub.productsCount, 0)}
                    icon={<Package className="h-5 w-5" />}
                    variant="blue"
                    isLoading={!data}
                />
            </div>

            {/* Main Content */}
            <Card className="border border-slate-200 dark:border-slate-800 shadow-sm bg-white dark:bg-slate-900">
                <CardHeader>
                    <CardTitle className="text-xl text-slate-900 dark:text-white">Subcategories</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        {data ? `${formatCountLabel(totalSubcategories, "subcategory", "subcategories")} in total` : "Loading…"}
                    </p>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-center">
                        <div className="relative w-full lg:w-64">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search subcategories"
                                className="pl-9"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <Select value={categoryFilter || "all"} onValueChange={(v) => setCategoryFilter(v === "all" ? "" : v)}>
                            <SelectTrigger className="w-full lg:w-64">
                                <SelectValue placeholder="All categories" />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All categories</SelectItem>
                                {categories.map((cat) => (
                                    <SelectItem key={cat.id} value={cat.id.toString()}>
                                        {cat.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                    </div>
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Category</TableHead>
                                    <TableHead>Products</TableHead>
                                    <TableHead>Created</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {isLoading ? (
                                    <TableRow>
                                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                                            Loading subcategories…
                                        </TableCell>
                                    </TableRow>
                                ) : subcategories.length === 0 ? (
                                    <TableRow>
                                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                            {searchQuery || categoryFilter
                                                ? "No subcategories found matching your filters."
                                                : "No subcategories yet. Create your first subcategory to organize products."}
                                        </TableCell>
                                    </TableRow>
                                ) : (
                                    subcategories.map((subcategory) => (
                                        <TableRow key={subcategory.id} className="hover:bg-muted/40">
                                            <TableCell>
                                                <div className="flex items-center gap-3">
                                                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-purple-500 to-pink-600">
                                                        <FolderOpen className="h-5 w-5 text-white" />
                                                    </div>
                                                    <div>
                                                        <p className="font-medium text-slate-900 dark:text-white">{subcategory.name}</p>
                                                        <p className="text-xs text-muted-foreground">ID: {subcategory.id}</p>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="outline" className="gap-1">
                                                    <FolderTree className="h-3 w-3" />
                                                    {subcategory.categoryName}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-2">
                                                    <Package className="h-3 w-3 text-muted-foreground" />
                                                    <span className="text-sm">{formatCountLabel(subcategory.productsCount, "product")}</span>
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-sm text-muted-foreground">
                                                {new Date(subcategory.createdAt).toLocaleDateString()}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 w-8 p-0"
                                                        onClick={() => openEditDialog(subcategory)}
                                                    >
                                                        <Edit className="h-3 w-3" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                                                        onClick={() => openDeleteDialog(subcategory)}
                                                    >
                                                        <Trash2 className="h-3 w-3" />
                                                    </Button>
                                                </div>
                                            </TableCell>
                                        </TableRow>
                                    ))
                                )}
                            </TableBody>
                        </Table>
                    </div>
                </CardContent>
            </Card>

            {/* Create/Edit Dialog */}
            <Dialog open={dialogMode === "create" || dialogMode === "edit"} onOpenChange={(open) => !open && closeDialog()}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{dialogMode === "create" ? "Create Subcategory" : "Edit Subcategory"}</DialogTitle>
                        <DialogDescription>
                            {dialogMode === "create"
                                ? "Add a new subcategory under a parent category."
                                : "Update the subcategory details."}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div>
                            <label className="block text-sm font-medium mb-2">Parent Category *</label>
                            <Select value={selectedCategoryId} onValueChange={setSelectedCategoryId}>
                                <SelectTrigger>
                                    <SelectValue placeholder="Select a category" />
                                </SelectTrigger>
                                <SelectContent>
                                    {categories.map((cat) => (
                                        <SelectItem key={cat.id} value={cat.id.toString()}>
                                            {cat.name}
                                        </SelectItem>
                                    ))}
                                </SelectContent>
                            </Select>
                        </div>
                        <div>
                            <label className="block text-sm font-medium mb-2">Subcategory Name *</label>
                            <Input
                                value={subcategoryName}
                                onChange={(e) => setSubcategoryName(e.target.value)}
                                placeholder="Enter subcategory name"
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && !isSubmitting) {
                                        dialogMode === "create" ? handleCreate() : handleEdit()
                                    }
                                }}
                            />
                        </div>
                    </div>
                    <DialogFooter>
                        <Button variant="outline" onClick={closeDialog} disabled={isSubmitting}>
                            Cancel
                        </Button>
                        <Button
                            onClick={dialogMode === "create" ? handleCreate : handleEdit}
                            disabled={isSubmitting || !subcategoryName.trim() || !selectedCategoryId}
                        >
                            {dialogMode === "create" ? "Create" : "Save Changes"}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>

            {/* Delete Confirmation Dialog */}
            <Dialog open={dialogMode === "delete"} onOpenChange={(open) => !open && closeDialog()}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-destructive">Delete Subcategory</DialogTitle>
                        <DialogDescription>
                            Are you sure you want to delete "{selectedSubcategory?.name}"?
                            {selectedSubcategory && selectedSubcategory.productsCount > 0 && (
                                <span className="block mt-2 text-amber-600 dark:text-amber-400">
                                    ⚠️ This subcategory has {formatCountLabel(selectedSubcategory.productsCount, "product")}.
                                </span>
                            )}
                        </DialogDescription>
                    </DialogHeader>
                    <DialogFooter>
                        <Button variant="outline" onClick={closeDialog} disabled={isSubmitting}>
                            Cancel
                        </Button>
                        <Button
                            variant="destructive"
                            onClick={handleDelete}
                            disabled={isSubmitting}
                        >
                            Delete
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
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
        red: "bg-white/80 text-rose-600 shadow-sm border border-rose-100 dark:bg-slate-800 dark:border-rose-800",
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
