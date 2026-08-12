"use client"

import { useEffect,useState } from "react"
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Select,SelectContent,SelectGroup,SelectItem,SelectLabel,SelectTrigger,SelectValue } from "@/components/ui/select"
import { Button } from "@/components/ui/button"
import { Upload,Package } from "lucide-react"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/use-toast"
import { useRouter } from "next/navigation"
import useSWR,{ useSWRConfig } from "swr"
import { fetcher } from "@/lib/fetcher"

type GlobalProduct = {
  id: number
  productCode: string
  name: string
  description?: string
  categoryId?: number
  imageUrl?: string
  basePrice: number
  unit: string
  status: string
  stockQuantity?: number
  allowDecimalQuantity?: boolean
  quantityStep?: number
  categoryName?: string
  discountType?: string | null
  discountValue?: number | null
  discountStartAt?: string | null
  discountEndAt?: string | null
  discountActive?: boolean
  metadata?: Record<string, any> | null
}

type Category = {
  id: number
  name: string
}

type ProductFormState = {
  productCode: string
  name: string
  description: string
  categoryId: string
  subcategoryId: string
  imageUrl: string
  basePrice: string
  unit: string
  status: string
  stockQuantity: string
  allowDecimalQuantity: boolean
  quantityStep: string
  discountType: string
  discountValue: string
  discountStartAt: string
  discountEndAt: string
  discountActive: boolean
}

type ProductFormProps = {
  mode: "create" | "edit"
  initialProduct?: GlobalProduct | null
  onCancel?: () => void
  onSuccess?: () => void
}

type NextProductCodeResponse = {
  productCode: string
}

const NEXT_PRODUCT_CODE_ENDPOINT = "/api/v1/admin/global-inventory/next-code"

const getProductValidationError = (productData: ProductFormState) => {
  const requiredValues = [
    productData.productCode,
    productData.name,
    productData.basePrice,
    productData.unit,
    productData.stockQuantity,
  ]
  if (requiredValues.some((value) => !value)) {
    return "Product code, name, price, unit, and stock quantity are required"
  }
  if (!productData.subcategoryId) return "Please select a category and subcategory"

  const discountValues = [
    productData.discountType,
    productData.discountValue,
    productData.discountStartAt,
    productData.discountEndAt,
  ]
  if (productData.discountActive && discountValues.some((value) => !value)) {
    return "All discount fields (Type, Value, Start, End) are required when discount is active"
  }
  return null
}

const getProductPayload = (
  productData: ProductFormState,
  initialProduct?: GlobalProduct | null,
) => ({
  ...productData,
  id: initialProduct?.id,
  basePrice: Number.parseFloat(productData.basePrice),
  stockQuantity: Number.parseFloat(productData.stockQuantity) || 0,
  allowDecimalQuantity: productData.allowDecimalQuantity,
  quantityStep: 1,
  categoryId: productData.subcategoryId ? Number.parseInt(productData.subcategoryId) : null,
  metadata: {
    ...initialProduct?.metadata,
    parentCategoryId: Number.parseInt(productData.categoryId),
  },
  discountType: productData.discountType || null,
  discountValue: productData.discountValue ? Number.parseInt(productData.discountValue) : null,
  discountStartAt: productData.discountStartAt || null,
  discountEndAt: productData.discountEndAt || null,
  discountActive: Boolean(productData.discountActive),
})

const getSaveErrorMessage = (status: number, fallback?: string) => {
  if (status === 413) {
    return "The image is too large to save. Please use a smaller image or remove it and try again."
  }
  return fallback || "Failed to save product"
}

export function ProductForm({ mode, initialProduct, onCancel, onSuccess }: Readonly<ProductFormProps>) {
  const { toast } = useToast()
  const router = useRouter()
  const { mutate: mutateSWRCache } = useSWRConfig()

  const [productData, setProductData] = useState<ProductFormState>({
    productCode: "",
    name: "",
    description: "",
    categoryId: "",
    subcategoryId: "",
    imageUrl: "",
    basePrice: "",
    unit: "",
    status: "active",
    stockQuantity: "",
    allowDecimalQuantity: false,
    quantityStep: "1",
    discountType: "",
    discountValue: "",
    discountStartAt: "",
    discountEndAt: "",
    discountActive: false,
  })

  const { data: nextProductCodeData } = useSWR<NextProductCodeResponse>(
    mode === "create" ? NEXT_PRODUCT_CODE_ENDPOINT : null,
    fetcher,
    { revalidateOnFocus: false, revalidateOnMount: true, dedupingInterval: 0 }
  )

  useEffect(() => {
    if (initialProduct && mode === "edit") {
      // Get subcategoryId from metadata if stored there, or from categoryId if it's a subcategory
      const metadata = initialProduct.metadata as any
      setProductData({
        productCode: initialProduct.productCode,
        name: initialProduct.name,
        description: initialProduct.description || "",
        categoryId: metadata?.parentCategoryId?.toString() || "",
        subcategoryId: initialProduct.categoryId?.toString() || "",
        imageUrl: initialProduct.imageUrl || "",
        basePrice: (initialProduct.basePrice / 100).toFixed(2),
        unit: initialProduct.unit,
        status: initialProduct.status,
        stockQuantity: initialProduct.stockQuantity?.toString() || "",
        allowDecimalQuantity: !!initialProduct.allowDecimalQuantity,
        quantityStep: initialProduct.quantityStep?.toString() || "1",
        discountType: initialProduct.discountType || "",
        discountValue: initialProduct.discountValue?.toString() || "",
        discountStartAt: initialProduct.discountStartAt
          ? new Date(initialProduct.discountStartAt).toISOString().slice(0, 16)
          : "",
        discountEndAt: initialProduct.discountEndAt
          ? new Date(initialProduct.discountEndAt).toISOString().slice(0, 16)
          : "",
        discountActive: !!initialProduct.discountActive,
      })
    }
  }, [initialProduct, mode])

  useEffect(() => {
    if (mode !== "create" || !nextProductCodeData?.productCode) {
      return
    }

    setProductData((prev) => (
      prev.productCode
        ? prev
        : { ...prev, productCode: nextProductCodeData.productCode }
    ))
  }, [mode, nextProductCodeData?.productCode])

  const [imageUploadMode, setImageUploadMode] = useState<"upload" | "url">("upload")
  const [isUploadingImage, setIsUploadingImage] = useState(false)
  const [imageUploadError, setImageUploadError] = useState<string | null>(null)

  const { data: categoriesData, isLoading: categoriesLoading, error: categoriesError } = useSWR<{ items: Category[] }>(
    `/api/v1/categories`,
    fetcher,
    { fallbackData: { items: [] }, revalidateOnFocus: false }
  )
  const categories = categoriesData?.items || []

  // Fetch subcategories based on selected category
  type Subcategory = { id: number; name: string; parentId: number }
  const { data: subcategoriesData, isLoading: subcategoriesLoading } = useSWR<{ items: Subcategory[] }>(
    productData.categoryId ? `/api/v1/subcategories?categoryId=${productData.categoryId}` : null,
    fetcher,
    { fallbackData: { items: [] }, revalidateOnFocus: false }
  )
  const subcategories = subcategoriesData?.items || []



  // Compress/resize image using canvas to keep Base64 data URLs small
  const compressImage = (file: File, maxDim = 1200, quality = 0.7): Promise<File> => {
    return new Promise((resolve, reject) => {
      // GIFs can't be compressed via canvas without losing animation
      if (file.type === "image/gif") {
        resolve(file)
        return
      }

      const img = new Image()
      const url = URL.createObjectURL(file)
      img.onload = () => {
        URL.revokeObjectURL(url)
        let { width, height } = img

        // Only resize if larger than maxDim
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height)
          width = Math.round(width * ratio)
          height = Math.round(height * ratio)
        }

        const canvas = document.createElement("canvas")
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext("2d")!
        ctx.drawImage(img, 0, 0, width, height)

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              resolve(file) // fallback to original
              return
            }
            const compressed = new File([blob], file.name, {
              type: "image/jpeg",
              lastModified: Date.now(),
            })
            resolve(compressed)
          },
          "image/jpeg",
          quality
        )
      }
      img.onerror = () => {
        URL.revokeObjectURL(url)
        resolve(file) // fallback to original on error
      }
      img.src = url
    })
  }

  const handleImageFile = async (file: File | null) => {
    if (!file) return

    // Client-side validation to provide immediate feedback
    const allowedTypes = ["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp"]
    if (!allowedTypes.includes(file.type)) {
      setImageUploadError(`Invalid type: ${file.type}. Only JPG, PNG, GIF, and WEBP are allowed`)
      toast({
        title: "Validation Error",
        description: `Invalid type: ${file.type}. Only JPG, PNG, GIF, and WEBP are allowed`,
        variant: "destructive",
      })
      return
    }

    const maxSize = 4 * 1024 * 1024 // 4MB
    if (file.size > maxSize) {
      setImageUploadError("Please upload an image under 4MB")
      toast({
        title: "Validation Error",
        description: "Please upload an image under 4MB",
        variant: "destructive",
      })
      return
    }

    setIsUploadingImage(true)
    setImageUploadError(null)
    try {
      // Compress the image before uploading to keep Base64 data URL small
      const compressedFile = await compressImage(file)

      const formData = new FormData()
      formData.append("image", compressedFile)
      const res = await fetch("/api/v1/upload/image", {
        method: "POST",
        body: formData,
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data?.error || "Upload failed")
      }
      const data = await res.json()
      setProductData((prev) => ({ ...prev, imageUrl: data.url }))
      toast({
        title: "Image uploaded",
        description: "The product image has been uploaded successfully.",
      })
    } catch (error: any) {
      setImageUploadError(error.message || "Upload failed")
      toast({
        title: "Upload failed",
        description: error.message || "Could not upload image",
        variant: "destructive",
      })
    } finally {
      setIsUploadingImage(false)
    }
  }

  const handleSubmitProduct = async () => {
    const validationError = getProductValidationError(productData)
    if (validationError) {
      toast({
        title: "Validation Error",
        description: validationError,
        variant: "destructive",
      })
      return
    }

    try {
      const method = mode === "edit" ? "PUT" : "POST"
      const response = await fetch(`/api/v1/admin/global-inventory`, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(getProductPayload(productData, initialProduct)),
      })

      // Handle non-JSON responses (e.g. Vercel 413 Request Entity Too Large returns HTML)
      const result: any = await response.json().catch(() => null)
      if (!result) {
        const fallback = `Server error (${response.status}). Please try again.`
        toast({ title: "Error", description: getSaveErrorMessage(response.status, fallback), variant: "destructive" })
        return
      }

      if (response.ok) {
        toast({
          title: mode === "edit" ? "Product updated" : "Product created",
          description: result.message,
        })
        if (mode === "create") {
          await mutateSWRCache(NEXT_PRODUCT_CODE_ENDPOINT)
        }
        if (onSuccess) {
          onSuccess()
        } else {
          router.push("/global-inventory")
        }
      } else {
        toast({
          title: "Error",
          description: getSaveErrorMessage(response.status, result.error),
          variant: "destructive",
        })
      }
    } catch (error: any) {
      console.error("Error saving product:", error)
      toast({
        title: "Error",
        description: error.message || "Failed to save product",
        variant: "destructive",
      })
    }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-6">
        <Card className="border-slate-200 dark:border-slate-800 shadow-sm">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-lg font-semibold flex items-center gap-2">
              <Package className="h-5 w-5 text-primary" />
              Base details
            </CardTitle>
            <CardDescription>Core identifiers that Head Office relies on for downstream syncing.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label htmlFor="product-code" className="block text-sm font-medium mb-1">Product Code <span className="text-destructive">*</span></label>
                <Input
                  id="product-code"
                  value={productData.productCode ?? ""}
                  onChange={(e) => setProductData({ ...productData, productCode: e.target.value })}
                  placeholder="PRD-001"
                  required
                />
                <p className="mt-1 text-xs text-muted-foreground">Avoid spaces; use dashes.</p>
              </div>
              <div>
                <label htmlFor="product-name" className="block text-sm font-medium mb-1">Name <span className="text-destructive">*</span></label>
                <Input
                  id="product-name"
                  value={productData.name ?? ""}
                  onChange={(e) => setProductData({ ...productData, name: e.target.value })}
                  placeholder="Product name"
                  required
                />
                <p className="mt-1 text-xs text-muted-foreground">Visible everywhere.</p>
              </div>
              <div>
                <label htmlFor="product-status" className="block text-sm font-medium mb-1">Status</label>
                <Select value={productData.status} onValueChange={(value) => setProductData({ ...productData, status: value })}>
                  <SelectTrigger id="product-status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">Active</SelectItem>
                    <SelectItem value="inactive">Inactive</SelectItem>
                  </SelectContent>
                </Select>
                <p className="mt-1 text-xs text-muted-foreground">Inactive = hidden.</p>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="product-category" className="block text-sm font-medium mb-1">Category <span className="text-destructive">*</span></label>
                <Select
                  value={productData.categoryId}
                  onValueChange={(value) => setProductData({ ...productData, categoryId: value, subcategoryId: "" })}
                >
                  <SelectTrigger id="product-category" className="w-full">
                    <SelectValue placeholder={categoriesLoading ? "Loading..." : "Select a category"} />
                  </SelectTrigger>
                  <SelectContent>
                    {categoriesError && (
                      <SelectGroup>
                        <SelectLabel>Error loading categories</SelectLabel>
                      </SelectGroup>
                    )}
                    {!categoriesLoading && categories.length === 0 && (
                      <SelectGroup>
                        <SelectLabel>No categories found</SelectLabel>
                      </SelectGroup>
                    )}
                    {categories.map((cat) => (
                      <SelectItem key={cat.id} value={String(cat.id)}>
                        {cat.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <label htmlFor="product-subcategory" className="block text-sm font-medium mb-1">Subcategory <span className="text-destructive">*</span></label>
                <Select
                  value={productData.subcategoryId}
                  onValueChange={(value) => setProductData({ ...productData, subcategoryId: value })}
                  disabled={!productData.categoryId || subcategories.length === 0}
                >
                  <SelectTrigger id="product-subcategory" className="w-full">
                    <SelectValue
                      placeholder={
                        (() => {
                          if (!productData.categoryId) {
                            return "Select category first"
                          }
                          if (subcategoriesLoading) {
                            return "Loading..."
                          }
                          if (subcategories.length === 0) {
                            return "No subcategories"
                          }
                          return "Select subcategory"
                        })()
                      }
                    />
                  </SelectTrigger>
                  <SelectContent>
                    {subcategories.map((sub) => (
                      <SelectItem key={sub.id} value={String(sub.id)}>
                        {sub.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div>
              <label htmlFor="product-description" className="block text-sm font-medium mb-1">Description</label>
              <textarea
                id="product-description"
                value={productData.description ?? ""}
                onChange={(e) => setProductData({ ...productData, description: e.target.value })}
                className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                rows={2}
                placeholder="What makes this SKU unique?"
              />
            </div>
          </CardContent>
        </Card>

        <Card className="border-slate-200 dark:border-slate-800 shadow-sm">
          <CardHeader className="space-y-1 pb-4">
            <CardTitle className="text-lg font-semibold">Commercial setup</CardTitle>
            <CardDescription>Baseline price, measurement unit, and packaging cues.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              <div>
                <label htmlFor="product-base-price" className="block text-sm font-medium mb-1">Base Price <span className="text-destructive">*</span></label>
                <Input
                  id="product-base-price"
                  type="number"
                  step="0.01"
                  value={productData.basePrice ?? ""}
                  onChange={(e) => setProductData({ ...productData, basePrice: e.target.value })}
                  placeholder="0.00"
                  required
                />
                <p className="mt-1 text-xs text-muted-foreground">In PKR</p>
              </div>
              <div>
                <label htmlFor="product-unit" className="block text-sm font-medium mb-1">Unit <span className="text-destructive">*</span></label>
                <Input
                  id="product-unit"
                  value={productData.unit ?? ""}
                  onChange={(e) => setProductData({ ...productData, unit: e.target.value })}
                  placeholder="ltr / kg / box"
                  required
                />
                <p className="mt-1 text-xs text-muted-foreground">Measurement</p>
              </div>
              <div>
                <label htmlFor="product-stock-quantity" className="block text-sm font-medium mb-1">Stock Quantity <span className="text-destructive">*</span></label>
                <Input
                  id="product-stock-quantity"
                  type="number"
                  min="0"
                  step={productData.allowDecimalQuantity ? "any" : "1"}
                  value={productData.stockQuantity ?? ""}
                  onChange={(e) => setProductData({ ...productData, stockQuantity: e.target.value })}
                  placeholder="0"
                  required
                />
                <p className="mt-1 text-xs text-muted-foreground">Available</p>
              </div>
            </div>
            <div className="rounded-lg border bg-muted/20 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Allow manual quantities</p>
                  <p className="text-xs text-muted-foreground">When enabled, users on the order portal can freely type any quantity including decimals (e.g. 1.5 kg). Whole-unit products remain unchanged.</p>
                </div>
                <Switch
                  checked={productData.allowDecimalQuantity}
                  onCheckedChange={(checked) => setProductData((prev) => ({
                    ...prev,
                    allowDecimalQuantity: checked,
                  }))}
                />
              </div>
            </div>
            <div className="rounded-lg border bg-muted/20 p-4 space-y-3">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium">Product Image</p>
                <div className="inline-flex overflow-hidden rounded-full border text-xs">
                  {(["upload", "url"] as const).map((modeOption) => (
                    <button
                      key={modeOption}
                      type="button"
                      onClick={() => setImageUploadMode(modeOption)}
                      className={`px-3 py-1 ${imageUploadMode === modeOption ? "bg-primary text-primary-foreground" : "bg-background"}`}
                    >
                      {modeOption === "upload" ? "Upload" : "URL"}
                    </button>
                  ))}
                </div>
              </div>
              {imageUploadMode === "upload" ? (
                <div className="space-y-2">
                  <label className="flex h-32 cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed text-center text-xs text-muted-foreground hover:border-primary/60 hover:text-primary">
                    <Upload className="mb-2 h-5 w-5" />
                    <span className="font-medium">Drop image or click to browse</span>
                    <span className="text-[11px]">JPG, PNG, GIF, WEBP up to 4MB</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(event) => {
                        handleImageFile(event.target.files?.[0] || null)
                      }}
                      onClick={(event) => {
                        (event.target as HTMLInputElement).value = "" // Reset on click for same-file re-upload
                      }}
                      disabled={isUploadingImage}
                    />
                  </label>
                  {isUploadingImage && <p className="text-xs text-muted-foreground">Uploading image…</p>}
                  {imageUploadError && <p className="text-xs text-destructive">{imageUploadError}</p>}
                </div>
              ) : (
                <Input
                  value={productData.imageUrl ?? ""}
                  onChange={(e) => setProductData({ ...productData, imageUrl: e.target.value })}
                  placeholder="https://example.com/image.jpg"
                />
              )}
              {productData.imageUrl && (
                <div className="flex items-center gap-3 rounded-lg border bg-muted/20 p-2 text-xs text-muted-foreground">
                  <img src={productData.imageUrl} alt={productData.name || "Product preview"} className="h-10 w-10 rounded-md object-cover" />
                  <div className="flex-1">
                    <p className="font-medium text-foreground">{productData.name || "Preview"}</p>

                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setProductData((prev) => ({ ...prev, imageUrl: "" }))}>
                    Remove
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>

        {/* <Card className="border-slate-200 dark:border-slate-800 shadow-sm">
          <CardHeader className="space-y-1 pb-4">
            <div className="flex items-center justify-between">
              <div className="space-y-1">
                <CardTitle className="text-lg font-semibold">Discounts & promos</CardTitle>
                <CardDescription>Optional limited-time incentives that cascade to branches.</CardDescription>
              </div>
              <Switch checked={discountEnabled} onCheckedChange={handleDiscountToggle} />
            </div>
          </CardHeader>
          {discountEnabled ? (
            <CardContent className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2">
                <div>
                  <label htmlFor="product-discount-type" className="block text-sm font-medium mb-1">Discount Type {discountEnabled && "*"}</label>
                  <Select value={productData.discountType || "percent"} onValueChange={(value) => setProductData({ ...productData, discountType: value })}>
                    <SelectTrigger id="product-discount-type" className="w-full">
                      <SelectValue placeholder="Select type" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="percent">Percentage</SelectItem>
                      <SelectItem value="flat">Flat Amount</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <label htmlFor="product-discount-value" className="block text-sm font-medium mb-1">Discount Value {discountEnabled && "*"}</label>
                  <Input
                    id="product-discount-value"
                    type="number"
                    step={productData.discountType === "flat" ? "1" : "0.01"}
                    placeholder={productData.discountType === "flat" ? "Enter amount in PKR" : "Enter percentage"}
                    value={productData.discountValue ?? ""}
                    onChange={(e) => setProductData({ ...productData, discountValue: e.target.value })}
                    required={discountEnabled}
                  />
                </div>
                <div>
                  <label htmlFor="product-discount-start" className="block text-sm font-medium mb-1">Discount Start {discountEnabled && "*"}</label>
                  <Input
                    id="product-discount-start"
                    type="datetime-local"
                    value={productData.discountStartAt ?? ""}
                    onChange={(e) => setProductData({ ...productData, discountStartAt: e.target.value })}
                    required={discountEnabled}
                  />
                </div>
                <div>
                  <label htmlFor="product-discount-end" className="block text-sm font-medium mb-1">Discount End {discountEnabled && "*"}</label>
                  <Input
                    id="product-discount-end"
                    type="datetime-local"
                    value={productData.discountEndAt ?? ""}
                    onChange={(e) => setProductData({ ...productData, discountEndAt: e.target.value })}
                    required={discountEnabled}
                  />
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                <span>Discount is {productData.discountActive ? "active" : "draft"}.</span>
                <button
                  type="button"
                  className="font-semibold text-blue-600 hover:underline"
                  onClick={() => setProductData((prev) => ({ ...prev, discountActive: !prev.discountActive }))}
                >
                  Toggle state
                </button>
              </div>
            </CardContent>
          ) : (
            <></>
            // <CardContent>
            //   <div className="rounded-lg border border-dashed bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
            //     Activate discounts to configure promotional windows without leaving this form.
            //   </div>
            // </CardContent>
          )}
        </Card> */}

        {/* Action Buttons */}
        <div className="flex items-center justify-end gap-3 pt-4 border-t">
          <Button variant="outline" onClick={onCancel || (() => router.push("/global-inventory"))}>
            Cancel
          </Button>
          <Button onClick={handleSubmitProduct} size="lg" className="min-w-32">
            {mode === "edit" ? "Update Product" : "Create Product"}
          </Button>
        </div>
      </div>
    </div>
  )
}
