"use client"
import { GlobalInventoryExport } from "@/components/admin/global-inventory-export"
import { ProductForm } from "@/components/global-inventory/product-form"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Dialog,DialogContent,DialogHeader,DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Table,TableBody,TableCell,TableHead,TableHeader,TableRow } from "@/components/ui/table"
import { useDebounce } from "@/hooks/use-debounce"
import { useToast } from "@/hooks/use-toast"
import { cn,formatPKR } from "@/lib/utils"
import { AlertTriangle,CheckCircle,Edit,Loader,Package,Plus,RefreshCw,Search,Trash2,XCircle } from "lucide-react"
import { useRouter } from "next/navigation"
import { useEffect,useMemo,useState } from "react"
import useSWR from "swr"

const fetcher = (url: string) => fetch(url).then((res) => res.json())
const PAGE_SIZE = 50

type GlobalInventoryItem = {
    id: number
    productCode: string
    name: string
    description?: string
    categoryId?: number
    categoryName?: string
    parentCategoryName?: string
    imageUrl?: string
    basePrice: number
    unit: string
    status: string
    stockQuantity: number
    assignedOrganizations: number
    createdAt: string
    updatedAt: string
}

type GlobalInventoryFormItem = GlobalInventoryItem & {
    metadata?: Record<string, any> | null
    discountType?: string | null
    discountValue?: number | null
    discountStartAt?: string | null
    discountEndAt?: string | null
    discountActive?: boolean | null
}

type GlobalInventoryImageItem = {
    id: number
    imageUrl?: string | null
}

export default function GlobalInventoryView() {
    const router = useRouter()
    const [searchQuery, setSearchQuery] = useState("")
    const debouncedSearch = useDebounce(searchQuery, 300)
    const [statusFilter, setStatusFilter] = useState("all")
    const [categoryFilter, setCategoryFilter] = useState("")
    const [subCategoryFilter, setSubCategoryFilter] = useState("")
    const [page, setPage] = useState(1)
    const [dialogMode, setDialogMode] = useState<"create" | "edit" | "delete" | null>(null)
    const [selectedProduct, setSelectedProduct] = useState<GlobalInventoryItem | null>(null)
    const [isDeleting, setIsDeleting] = useState(false)
    const [loadingProductId, setLoadingProductId] = useState<number | null>(null)
    const { toast } = useToast()

    // Fetch ALL products once — no filter params in URL
    const queryParams = useMemo(() => {
        const params = new URLSearchParams()
        params.set("page", page.toString())
        params.set("limit", PAGE_SIZE.toString())
        if (debouncedSearch) params.set("search", debouncedSearch)
        if (statusFilter && statusFilter !== "all") params.set("status", statusFilter)
        if (categoryFilter) params.set("category", categoryFilter)
        if (subCategoryFilter) params.set("subCategory", subCategoryFilter)
        params.set("lite", "true")
        return params.toString()
    }, [page, debouncedSearch, statusFilter, categoryFilter, subCategoryFilter])

    const { data, isLoading, mutate } = useSWR<{
        items: GlobalInventoryItem[]
        summary?: {
            totalProducts: number
            activeProducts: number
            inactiveProducts: number
        }
        pagination: { page: number; limit: number; total: number; totalPages: number }
    }>(`/api/v1/admin/global-inventory?${queryParams}`, fetcher, {
        // No fallbackData: zero-filled fallback made the stat cards flash "0"
        // before the real numbers arrived. keepPreviousData shows the previous
        // page's data while a filter/page change loads.
        revalidateOnFocus: false,
        dedupingInterval: 30000,
        keepPreviousData: true,
    })

    const { data: categoriesData } = useSWR<{ items: Array<{ id: number; name: string }> }>(
        "/api/v1/categories?limit=100",
        fetcher,
        { fallbackData: { items: [] }, revalidateOnFocus: false, dedupingInterval: 60000 }
    )

    const { data: subcategoriesData } = useSWR<{ items: Array<{ id: number; name: string }> }>(
        categoryFilter ? `/api/v1/subcategories?categoryId=${categoryFilter}&limit=100` : null,
        fetcher,
        { fallbackData: { items: [] }, revalidateOnFocus: false, dedupingInterval: 60000 }
    )

    const paginatedProducts = data?.items ?? []
    const summary = data?.summary || { totalProducts: 0, activeProducts: 0, inactiveProducts: 0 }
    const visibleProductIds = useMemo(
        () => paginatedProducts.map((product) => product.id).filter((id) => Number.isInteger(id) && id > 0),
        [paginatedProducts]
    )

    const imageQuery = useMemo(() => {
        if (visibleProductIds.length === 0) return null
        const params = new URLSearchParams()
        params.set("imagesOnly", "true")
        params.set("ids", visibleProductIds.join(","))
        return `/api/v1/admin/global-inventory?${params.toString()}`
    }, [visibleProductIds])

    const { data: imageData } = useSWR<{ items: GlobalInventoryImageItem[] }>(
        imageQuery,
        fetcher,
        {
            fallbackData: { items: [] },
            revalidateOnFocus: false,
            dedupingInterval: 30000,
        }
    )

    const imageMap = useMemo(() => {
        const map = new Map<number, string>()
        for (const item of imageData?.items || []) {
            if (item.id && item.imageUrl) {
                map.set(item.id, item.imageUrl)
            }
        }
        return map
    }, [imageData?.items])

    // Client-side filtering — instant, no API calls
    useEffect(() => {
        setPage(1)
    }, [statusFilter, categoryFilter, subCategoryFilter, debouncedSearch])

    const totalPages = Math.max(1, data?.pagination?.totalPages || 1)
    const totalProducts = summary.totalProducts
    const activeProducts = summary.activeProducts
    const inactiveProducts = summary.inactiveProducts

    const handleDelete = async () => {
        if (!selectedProduct) return

        setIsDeleting(true)
        try {
            const res = await fetch(`/api/v1/admin/global-inventory?id=${selectedProduct.id}&mode=delete`, {
                method: "DELETE",
            })

            if (res.ok) {
                mutate()
                setDialogMode(null)
                setSelectedProduct(null)
                toast({
                    title: "Success",
                    description: `Product "${selectedProduct.name}" deleted successfully.`
                })
            } else {
                const data = await res.json()
                toast({
                    title: "Error",
                    description: data.error || "Failed to process request",
                    variant: "destructive"
                })
            }
        } catch (error) {
            console.error("Failed to process the inventory request:", error)
            toast({
                title: "Error",
                description: "Failed to process request",
                variant: "destructive"
            })
        } finally {
            setIsDeleting(false)
        }
    }

    const handleEditProduct = async (productId: number) => {
        setLoadingProductId(productId)
        try {
            const res = await fetch(`/api/v1/admin/global-inventory?id=${productId}`)
            const payload = await res.json()

            if (!res.ok || !payload?.item) {
                throw new Error(payload?.error || "Failed to load product details")
            }

            setSelectedProduct(payload.item as GlobalInventoryFormItem)
            setDialogMode("edit")
        } catch (error: any) {
            toast({
                title: "Error",
                description: error.message || "Failed to load product details",
                variant: "destructive"
            })
        } finally {
            setLoadingProductId(null)
        }
    }

    return (
        <div className="space-y-6 p-4 md:p-6">
            {/* Compact Page Header */}
            <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800 p-4 md:p-5 rounded-2xl shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)]">
                <div className="flex items-center gap-4">
                    <div className="h-12 w-12 rounded-xl bg-gradient-to-tr from-blue-100 to-indigo-100 dark:from-blue-900/50 dark:to-indigo-900/50 flex items-center justify-center border border-blue-50/50 dark:border-blue-800/50 shadow-inner">
                        <Package className="h-6 w-6 text-blue-600 dark:text-blue-400" />
                    </div>
                    <div>
                        <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Global Inventory</h1>
                        <p className="text-xs font-medium text-slate-500 dark:text-slate-400">Centralized product catalog for the entire platform</p>
                    </div>
                </div>
                <div className="flex items-center gap-2">
                    <Button variant="outline" size="sm" className="h-9 gap-2 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 bg-white hover:bg-slate-50 dark:bg-slate-800 dark:hover:bg-slate-700 shadow-sm" onClick={() => mutate()}>
                        <RefreshCw className="h-4 w-4" />
                        <span className="hidden sm:inline">Refresh</span>
                    </Button>
                    <Button size="sm" className="h-9 gap-2 bg-blue-600 hover:bg-blue-700 text-white shadow-sm" onClick={() => router.push("/inventory/add")}>
                        <Plus className="h-4 w-4" />
                        <span>Create Product</span>
                    </Button>
                </div>
            </div>

            {/* Stat Cards */}
            <div className="grid gap-4 md:grid-cols-3">
                <StatCard
                    label="Total Products"
                    value={totalProducts}
                    icon={<Package className="h-5 w-5" />}
                    variant="blue"
                    isLoading={!data}
                />
                <StatCard
                    label="Active Products"
                    value={activeProducts}
                    icon={<CheckCircle className="h-5 w-5" />}
                    variant="green"
                    isLoading={!data}
                />
                <StatCard
                    label="Inactive Products"
                    value={inactiveProducts}
                    icon={<XCircle className="h-5 w-5" />}
                    variant="red"
                    isLoading={!data}
                />
            </div>

            <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
                <CardHeader>
                    <CardTitle className="text-xl text-slate-900 dark:text-white">Global product catalog</CardTitle>
                    <p className="text-sm text-muted-foreground">Manage all products in the global catalog.</p>
                </CardHeader>
                <CardContent>
                    <div className="flex flex-col gap-3 mb-4 lg:flex-row lg:items-center">
                        <div className="relative w-full lg:w-64">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                placeholder="Search by name or code"
                                className="pl-9"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <Select
                            value={categoryFilter || "__all_categories"}
                            onValueChange={(value) => {
                                setCategoryFilter(value === "__all_categories" ? "" : value)
                                setSubCategoryFilter("") // Reset subcategory when parent changes
                            }}
                        >
                            <SelectTrigger className="w-full bg-background lg:w-auto">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all_categories">All categories</SelectItem>
                                {categoriesData?.items.map((cat) => (
                                    <SelectItem key={cat.id} value={cat.id.toString()}>
                                        {cat.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            value={subCategoryFilter || "__all_subcategories"}
                            onValueChange={(value) => setSubCategoryFilter(value === "__all_subcategories" ? "" : value)}
                            disabled={!categoryFilter}
                        >
                            <SelectTrigger className="w-full bg-background lg:w-auto">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="__all_subcategories">All subcategories</SelectItem>
                                {subcategoriesData?.items.map((sub) => (
                                    <SelectItem key={sub.id} value={sub.id.toString()}>
                                        {sub.name}
                                    </SelectItem>
                                ))}
                            </SelectContent>
                        </Select>
                        <Select
                            value={statusFilter}
                            onValueChange={setStatusFilter}
                        >
                            <SelectTrigger className="w-full bg-background lg:w-auto">
                                <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                                <SelectItem value="all">All statuses</SelectItem>
                                <SelectItem value="active">Active</SelectItem>
                                <SelectItem value="inactive">Inactive</SelectItem>
                            </SelectContent>
                        </Select>
                        <GlobalInventoryExport products={paginatedProducts} />
                    </div>

                    <div className="overflow-x-auto">
                        <Table>
                            <TableHeader>
                                <TableRow>
                                    <TableHead>Product</TableHead>
                                    <TableHead>Category</TableHead>
                                    <TableHead>Subcategory</TableHead>
                                    <TableHead>Base price</TableHead>
                                    <TableHead>Status</TableHead>
                                    <TableHead>Stock</TableHead>
                                    <TableHead className="text-right">Actions</TableHead>
                                </TableRow>
                            </TableHeader>
                            <TableBody>
                                {(() => {
                                  if (isLoading) {
                                    return (
                                    <TableRow>
                                        <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                                            Loading global inventory…
                                        </TableCell>
                                    </TableRow>
                                )
                                  }
                                  if (paginatedProducts.length === 0) {
                                    return (
                                    <TableRow>
                                        <TableCell colSpan={7} className="py-10 text-center text-sm text-muted-foreground">
                                            {(debouncedSearch || categoryFilter || subCategoryFilter || (statusFilter && statusFilter !== "all"))
                                                ? "No products match your filters."
                                                : "No products found. Create your first global product to get started."}
                                        </TableCell>
                                    </TableRow>
                                )
                                  }
                                  return (
                                    paginatedProducts.map((product) => (
                                        <TableRow key={product.id} className="hover:bg-muted/40">
                                            <TableCell className="max-w-[280px]">
                                                <div className="flex min-w-0 items-center gap-3">
                                                    {imageMap.get(product.id) ? (
                                                        <img
                                                            src={imageMap.get(product.id)}
                                                            alt={product.name}
                                                            className="h-12 w-12 shrink-0 rounded-lg border object-cover"
                                                        />
                                                    ) : (
                                                        <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg border bg-muted/40">
                                                            <Package className="h-5 w-5 text-muted-foreground" />
                                                        </div>
                                                    )}
                                                    <div className="min-w-0">
                                                        <p className="truncate font-medium text-slate-900 dark:text-white" title={product.name}>{product.name}</p>
                                                        <p className="truncate text-xs text-muted-foreground" title={product.productCode}>{product.productCode}</p>
                                                    </div>
                                                </div>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="outline">{product.parentCategoryName || "Uncategorized"}</Badge>
                                            </TableCell>
                                            <TableCell>
                                                <Badge variant="secondary">{product.categoryName || "Uncategorized"}</Badge>
                                            </TableCell>
                                            <TableCell>{formatPKR(product.basePrice / 100)}</TableCell>
                                            <TableCell>
                                                <Badge
                                                    variant={
                                                        product.status === "active"
                                                            ? "default"
                                                            : "secondary"
                                                    }
                                                >
                                                    {product.status}
                                                </Badge>
                                            </TableCell>
                                            <TableCell className="text-sm">{product.stockQuantity}</TableCell>
                                            <TableCell className="text-right">
                                                <div className="flex items-center justify-end gap-2">
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 w-8 p-0"
                                                        disabled={loadingProductId === product.id}
                                                        onClick={() => {
                                                            void handleEditProduct(product.id)
                                                        }}
                                                    >
                                                        {loadingProductId === product.id ? (
                                                            <Loader className="h-3 w-3 animate-spin" />
                                                        ) : (
                                                            <Edit className="h-3 w-3" />
                                                        )}
                                                    </Button>
                                                    <Button
                                                        variant="ghost"
                                                        size="sm"
                                                        className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                                                        onClick={() => {
                                                            setSelectedProduct(product)
                                                            setDialogMode("delete")
                                                        }}
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
                    {/* Client-side pagination */}
                    <div className="mt-4 flex flex-col gap-2 text-sm text-muted-foreground md:flex-row md:items-center md:justify-between">
                        <span>
                            Showing{" "}
                            <span className="font-medium text-foreground">
                                {(data?.pagination?.total || 0) === 0 ? 0 : (page - 1) * PAGE_SIZE + 1}
                                –
                                {Math.min(data?.pagination?.total || 0, page * PAGE_SIZE)}
                            </span>{" "}
                            of <span className="font-medium text-foreground">{data?.pagination?.total || 0}</span> products
                        </span>
                        <div className="inline-flex items-center gap-2">
                            <Button variant="outline" size="sm" disabled={page === 1} onClick={() => setPage((prev) => Math.max(1, prev - 1))}>
                                Prev
                            </Button>
                            <span className="text-xs">
                                Page <span className="font-medium text-foreground">{page}</span> / {totalPages}
                            </span>
                            <Button
                                variant="outline"
                                size="sm"
                                disabled={page === totalPages || (data?.pagination?.total || 0) === 0}
                                onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                            >
                                Next
                            </Button>
                        </div>
                    </div>
                </CardContent>
            </Card>


            {/* Edit Dialog */}
            <Dialog open={dialogMode === "edit"} onOpenChange={(open) => {
                if (!open) {
                    setDialogMode(null)
                    setSelectedProduct(null)
                }
            }}>
                <DialogContent className="max-w-4xl p-0">
                    <div className="max-h-[85vh] overflow-y-auto">
                        <div className="sticky top-0 z-10 bg-background border-b px-6 py-4">
                            <DialogHeader>
                                <DialogTitle className="text-2xl font-semibold">
                                    Edit Product
                                </DialogTitle>
                            </DialogHeader>
                        </div>
                        <div className="px-6 py-6">
                            <ProductForm
                                mode="edit"
                                initialProduct={selectedProduct}
                                onCancel={() => {
                                    setDialogMode(null)
                                    setSelectedProduct(null)
                                }}
                                onSuccess={() => {
                                    setDialogMode(null)
                                    setSelectedProduct(null)
                                    mutate() // Refresh the product list
                                }}
                            />
                        </div>
                    </div>
                </DialogContent>
            </Dialog>

            {/* Delete Confirmation Dialog */}
            <Dialog open={dialogMode === "delete"} onOpenChange={(open) => {
                if (!open) {
                    setDialogMode(null)
                    setSelectedProduct(null)
                }
            }}>
                <DialogContent className="sm:max-w-md">
                    <DialogHeader>
                        <DialogTitle className="text-destructive flex items-center gap-2">
                            <AlertTriangle className="h-5 w-5" />
                            Permanently Delete Product
                        </DialogTitle>
                    </DialogHeader>
                    <div className="py-6 space-y-4">
                        <div className="p-4 bg-destructive/5 border border-destructive/20 rounded-xl space-y-3">
                            <p className="text-sm text-slate-600 dark:text-slate-400">
                                Are you sure you want to permanently delete <strong>{selectedProduct?.name}</strong>?
                            </p>
                            <p className="text-xs text-destructive font-medium bg-destructive/10 p-2 rounded border border-destructive/20">
                                ⚠️ This action cannot be undone. This will remove the product from the global catalog and all organization inventories.
                            </p>
                        </div>

                        <div className="flex justify-end gap-3">
                            <Button
                                variant="outline"
                                onClick={() => setDialogMode(null)}
                                disabled={isDeleting}
                            >
                                Cancel
                            </Button>
                            <Button
                                variant="destructive"
                                onClick={handleDelete}
                                disabled={isDeleting}
                                className="min-w-[120px]"
                            >
                                {isDeleting ? (
                                    <>
                                        {/* <Loader className="mr-2 h-4 w-4 animate-spin" /> */}
                                        Deleting...
                                    </>
                                ) : "Delete Product"}
                            </Button>
                        </div>
                    </div>
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


