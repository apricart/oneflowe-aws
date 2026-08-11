"use client"
import { useState } from "react"
import useSWR from "swr"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Dialog,DialogContent,DialogHeader,DialogTitle,DialogFooter,DialogDescription } from "@/components/ui/dialog"
import { useToast } from "@/hooks/use-toast"
import { Search,Plus,Edit,Trash2,FolderTree,Package,Loader2,FolderOpen,RefreshCw,Folder } from "lucide-react"
import { cn } from "@/lib/utils"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

type Category = {
    id: number
    name: string
    subcategoriesCount: number
    productsCount: number
    createdAt: string
    updatedAt: string
}

export default function CategoriesPage() {
    const { toast } = useToast()
    const [searchQuery, setSearchQuery] = useState("")

    // Dialog state
    const [dialogMode, setDialogMode] = useState<"create" | "edit" | "delete" | null>(null)
    const [selectedCategory, setSelectedCategory] = useState<Category | null>(null)
    const [categoryName, setCategoryName] = useState("")
    const [isSubmitting, setIsSubmitting] = useState(false)

    const params = new URLSearchParams()
    if (searchQuery) params.set("search", searchQuery)

    const { data, isLoading, mutate } = useSWR<{
        items: Category[]
        pagination: { page: number; limit: number; total: number; pages: number }
    }>(`/api/v1/categories?${params.toString()}`, fetcher, {
        // No fallbackData: zero-filled fallback made the stat cards flash "0"
        // before the real numbers arrived. keepPreviousData shows the previous
        // results while a search change loads.
        revalidateOnFocus: false,
        keepPreviousData: true,
    })

    const categories = data?.items ?? []
    const totalCategories = data?.pagination?.total ?? 0

    const openCreateDialog = () => {
        setCategoryName("")
        setSelectedCategory(null)
        setDialogMode("create")
    }

    const openEditDialog = (category: Category) => {
        setCategoryName(category.name)
        setSelectedCategory(category)
        setDialogMode("edit")
    }

    const openDeleteDialog = (category: Category) => {
        setSelectedCategory(category)
        setDialogMode("delete")
    }

    const closeDialog = () => {
        setDialogMode(null)
        setSelectedCategory(null)
        setCategoryName("")
        setIsSubmitting(false)
    }

    const handleCreateCategory = async () => {
        if (!categoryName.trim()) {
            toast({ title: "Error", description: "Category name is required", variant: "destructive" })
            return
        }

        setIsSubmitting(true)
        try {
            const res = await fetch("/api/v1/categories", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ name: categoryName.trim() }),
            })
            const data = await res.json()

            if (res.ok) {
                toast({ title: "Success", description: "Category created successfully" })
                mutate()
                closeDialog()
            } else {
                toast({ title: "Error", description: data.error || "Failed to create category", variant: "destructive" })
            }
        } catch (error) {
            console.error("Failed to create category:", error)
            toast({ title: "Error", description: "Failed to create category", variant: "destructive" })
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleEditCategory = async () => {
        if (!selectedCategory || !categoryName.trim()) {
            toast({ title: "Error", description: "Category name is required", variant: "destructive" })
            return
        }

        setIsSubmitting(true)
        try {
            const res = await fetch("/api/v1/categories", {
                method: "PUT",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ id: selectedCategory.id, name: categoryName.trim() }),
            })
            const data = await res.json()

            if (res.ok) {
                toast({ title: "Success", description: "Category updated successfully" })
                mutate()
                closeDialog()
            } else {
                toast({ title: "Error", description: data.error || "Failed to update category", variant: "destructive" })
            }
        } catch (error) {
            console.error("Failed to update category:", error)
            toast({ title: "Error", description: "Failed to update category", variant: "destructive" })
        } finally {
            setIsSubmitting(false)
        }
    }

    const handleDeleteCategory = async () => {
        if (!selectedCategory) return

        setIsSubmitting(true)
        try {
            const res = await fetch(`/api/v1/categories?id=${selectedCategory.id}`, {
                method: "DELETE",
            })
            const data = await res.json()

            if (res.ok) {
                toast({ title: "Success", description: "Category deleted successfully" })
                mutate()
                closeDialog()
            } else {
                toast({ title: "Cannot Delete", description: data.error, variant: "destructive" })
            }
        } catch (error) {
            console.error("Failed to delete category:", error)
            toast({ title: "Error", description: "Failed to delete category", variant: "destructive" })
        } finally {
            setIsSubmitting(false)
        }
    }

    return (
        <div className="space-y-6 p-4 md:p-6" suppressHydrationWarning>
            {/* Compact Page Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
                <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-purple-100 to-indigo-100 dark:from-purple-900/50 dark:to-indigo-900/50 flex items-center justify-center border border-purple-50/50 dark:border-purple-800/50 shadow-inner">
                        <Folder className="h-6 w-6 text-purple-600 dark:text-purple-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Category Management</h1>
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Create and manage product categories</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-9 gap-2 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 shadow-sm" onClick={() => mutate()}>
                        <RefreshCw className="h-4 w-4" />
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                    <Button size="sm" className="h-9 gap-2 bg-purple-600 hover:bg-purple-700 text-white shadow-sm" onClick={openCreateDialog}>
                        <Plus className="h-4 w-4" />
                        <span>Create Category</span>
                    </Button>
                </div>
            </div>

            {/* Stat Cards */}
            <div className="grid gap-4 md:grid-cols-2">
                <StatCard
                    label="Total Categories"
                    value={totalCategories}
                    icon={<FolderTree className="h-5 w-5" />}
                    variant="purple"
                    isLoading={!data}
                />
                <StatCard
                    label="Total Products"
                    value={categories.reduce((acc, cat) => acc + cat.productsCount, 0)}
                    icon={<Package className="h-5 w-5" />}
                    variant="blue"
                    isLoading={!data}
                />
            </div>

            <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
                <CardHeader>
                    <CardTitle className="text-xl text-slate-900 dark:text-white">Categories</CardTitle>
                    <p className="text-sm text-muted-foreground">
                        {(() => {
                          if (data) {
                            return `${totalCategories} ${totalCategories === 1 ? "category" : "categories"} in total`
                          }
                          return "Loading…"
                        })()}
                    </p>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-center">
                        <div className="relative w-full lg:w-64">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search categories"
                                className="pl-9"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                    </div>
                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Name</TableHead>
                                    <TableHead>Subcategories</TableHead>
                                    <TableHead>Products</TableHead>
                                    <TableHead>Created</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {(() => {
                                  if (isLoading) {
                                    return (
                                    <TableRow>
                                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                            <Loader2 className="h-5 w-5 animate-spin mx-auto mb-2" />
                                            Loading categories…
                                        </TableCell>
                                    </TableRow>
                                )
                                  }
                                  if (categories.length === 0) {
                                    return (
                                    <TableRow>
                                        <TableCell colSpan={5} className="py-10 text-center text-sm text-muted-foreground">
                                            {searchQuery
                                                ? "No categories found matching your search."
                                                : "No categories yet. Create your first category to organize products."}
                                        </TableCell>
                                    </TableRow>
                                )
                                  }
                                  return (
                                    categories.map((category) => (
                                        <TableRow key={category.id} className="hover:bg-muted/40">
                                            <TableCell>
                                                <div className="flex items-center gap-3">
                                                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-indigo-600">
                                                        <FolderTree className="h-5 w-5 text-white" />
                                                    </div>
                                                    <div>
                                                        <p className="font-medium text-slate-900 dark:text-white">{category.name}</p>
                                                        <p className="text-xs text-muted-foreground">ID: {category.id}</p>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="secondary" className="gap-1">
                                                    <FolderOpen className="h-3 w-3" />
                                                    {category.subcategoriesCount}
                                                </Badge>
                                            </TableCell>
                                            <TableCell>
                                                <div className="flex items-center gap-2">
                                                    <Package className="h-3 w-3 text-muted-foreground" />
                                                    <span className="text-sm">{category.productsCount}</span>
                                                </div>
                                            </TableCell>
                                            <TableCell className="text-sm text-muted-foreground">
                                                {new Date(category.createdAt).toLocaleDateString()}
                                            </TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 w-8 p-0"
                                                        onClick={() => openEditDialog(category)}
                                                    >
                                                        <Edit className="h-3 w-3" />
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                                                        onClick={() => openDeleteDialog(category)}
                                                    >
                                                        <Trash2 className="h-3 w-3" />
                                                    </Button>
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

            {/* Create/Edit Dialog */}
            <Dialog open={dialogMode === "create" || dialogMode === "edit"} onOpenChange={(open) => !open && closeDialog()}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle>{dialogMode === "create" ? "Create Category" : "Edit Category"}</DialogTitle>
                        <DialogDescription>
                            {dialogMode === "create"
                                ? "Add a new category to organize your products."
                                : "Update the category name."}
                        </DialogDescription>
                    </DialogHeader>
                    <div className="space-y-4 py-4">
                        <div>
                            <label htmlFor="category-name" className="block text-sm font-medium mb-2">Category Name</label>
                            <Input
                                id="category-name"
                                value={categoryName}
                                onChange={(e) => setCategoryName(e.target.value)}
                                placeholder="Enter category name"
                                onKeyDown={(e) => {
                                    if (e.key === "Enter" && !isSubmitting) {
                                        dialogMode === "create" ? handleCreateCategory() : handleEditCategory()
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
                            onClick={dialogMode === "create" ? handleCreateCategory : handleEditCategory}
                            disabled={isSubmitting || !categoryName.trim()}
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
                        <DialogTitle className="text-destructive">Delete Category</DialogTitle>
                        <DialogDescription>
                            Are you sure you want to delete "{selectedCategory?.name}"?
                            {selectedCategory && (selectedCategory.subcategoriesCount > 0 || selectedCategory.productsCount > 0) && (
                                <span className="block mt-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-sm">
                                    ⚠️ This category has{" "}
                                    {selectedCategory.subcategoriesCount > 0 && (
                                        <strong>{selectedCategory.subcategoriesCount} subcategor{selectedCategory.subcategoriesCount > 1 ? "ies" : "y"}</strong>
                                    )}
                                    {selectedCategory.subcategoriesCount > 0 && selectedCategory.productsCount > 0 && " and "}
                                    {selectedCategory.productsCount > 0 && (
                                        <strong>{selectedCategory.productsCount} product{selectedCategory.productsCount > 1 ? "s" : ""}</strong>
                                    )}
                                    . You must remove them first.
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
                            onClick={handleDeleteCategory}
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

function StatCard({ label, value, icon, variant, isLoading = false }: Readonly<{
    label: string;
    value: string | number;
    icon: React.ReactNode;
    variant: 'blue' | 'green' | 'red' | 'amber' | 'purple'
    isLoading?: boolean
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
