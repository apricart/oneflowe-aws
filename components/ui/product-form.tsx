"use client"

import React,{ useState,useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { CategorySelector } from "@/components/ui/category-selector"
import { ModifierTags } from "@/components/ui/modifier-tags"
import { Badge } from "@/components/ui/badge"
import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import { Tabs,TabsContent,TabsList,TabsTrigger } from "@/components/ui/tabs"
import { Package,Tag,DollarSign,Image as ImageIcon } from "lucide-react"
import useSWR from "swr"

interface Product {
  id?: number
  productCode: string
  name: string
  description?: string
  categoryId?: number
  subCategoryId?: number
  basePrice: number
  unit: string
  status: string
  imageUrl?: string
  modifiers?: Array<{
    id: number
    name: string
    type: string
  }>
}

interface Category {
  id: number
  name: string
  parentId: number | null
}

interface Modifier {
  id: number
  name: string
  type: string
  status: string
}

interface NextProductCodeResponse {
  productCode: string
}

interface ProductFormProps {
  product?: Product
  onSubmit: (product: Omit<Product, 'id'>) => void
  onCancel: () => void
  isLoading?: boolean
  className?: string
}

const fetcher = (url: string) => fetch(url).then(res => res.json())
const NEXT_PRODUCT_CODE_ENDPOINT = "/api/v1/admin/global-inventory/next-code"

const MODIFIER_TYPES = [
  { value: "unit", label: "Unit" },
  { value: "size", label: "Size" },
  { value: "packaging", label: "Packaging" },
  { value: "weight", label: "Weight" },
  { value: "volume", label: "Volume" },
  { value: "count", label: "Count" },
]

export function ProductForm({
  product,
  onSubmit,
  onCancel,
  isLoading = false,
  className
}: Readonly<ProductFormProps>) {
  const [formData, setFormData] = useState({
    productCode: "",
    name: "",
    description: "",
    categoryId: null as number | null,
    subCategoryId: null as number | null,
    basePrice: "",
    unit: "unit",
    status: "active",
    imageUrl: "",
    selectedModifiers: [] as number[],
  })

  const [errors, setErrors] = useState<Record<string, string>>({})

  const { data: nextProductCodeData } = useSWR<NextProductCodeResponse>(
    product ? null : NEXT_PRODUCT_CODE_ENDPOINT,
    fetcher,
    { revalidateOnFocus: false, revalidateOnMount: true, dedupingInterval: 0 }
  )

  // Fetch categories
  const { data: categoriesData } = useSWR<{ items: Category[] }>(
    `/api/v1/categories?type=parent`,
    fetcher
  )

  // Fetch subcategories based on selected category
  const { data: subCategoriesData } = useSWR<{ items: Category[] }>(
    formData.categoryId ? `/api/v1/subcategories?parentId=${formData.categoryId}` : null,
    fetcher
  )

  // Fetch modifiers
  const { data: modifiersData } = useSWR<{ items: Modifier[] }>(
    `/api/v1/modifiers?status=active`,
    fetcher
  )

  const modifiers = modifiersData?.items || []

  // Initialize form with product data
  useEffect(() => {
    if (product) {
      setFormData({
        productCode: product.productCode,
        name: product.name,
        description: product.description || "",
        categoryId: product.categoryId || null,
        subCategoryId: product.subCategoryId || null,
        basePrice: (product.basePrice / 100).toFixed(2),
        unit: product.unit,
        status: product.status,
        imageUrl: product.imageUrl || "",
        selectedModifiers: product.modifiers?.map(m => m.id) || [],
      })
    }
  }, [product])

  useEffect(() => {
    if (product || !nextProductCodeData?.productCode) {
      return
    }

    setFormData(prev => (
      prev.productCode
        ? prev
        : { ...prev, productCode: nextProductCodeData.productCode }
    ))
  }, [product, nextProductCodeData?.productCode])

  const validateForm = () => {
    const newErrors: Record<string, string> = {}

    if (!formData.productCode.trim()) {
      newErrors.productCode = "Product code is required"
    }

    if (!formData.name.trim()) {
      newErrors.name = "Product name is required"
    }

    if (!formData.basePrice || Number.parseFloat(formData.basePrice) < 0) {
      newErrors.basePrice = "Valid base price is required"
    }

    if (!formData.unit.trim()) {
      newErrors.unit = "Unit is required"
    }

    setErrors(newErrors)
    return Object.keys(newErrors).length === 0
  }

  const handleSubmit = (e: React.SubmitEvent<HTMLFormElement>) => {
    e.preventDefault()
    
    if (!validateForm()) {
      return
    }

    const productData: Omit<Product, 'id'> = {
      productCode: formData.productCode.trim(),
      name: formData.name.trim(),
      description: formData.description.trim() || undefined,
      categoryId: formData.categoryId || undefined,
      subCategoryId: formData.subCategoryId || undefined,
      basePrice: Math.round(Number.parseFloat(formData.basePrice) * 100), // Convert to cents
      unit: formData.unit.trim(),
      status: formData.status,
      imageUrl: formData.imageUrl.trim() || undefined,
      modifiers: modifiers
        .filter(m => formData.selectedModifiers.includes(m.id))
        .map(m => ({ id: m.id, name: m.name, type: m.type }))
    }

    onSubmit(productData)
  }

  const handleCategoryChange = (categoryId: number | null) => {
    setFormData(prev => ({
      ...prev,
      categoryId,
      subCategoryId: null // Reset subcategory when category changes
    }))
  }

  const handleSubCategoryChange = (subCategoryId: number | null) => {
    setFormData(prev => ({
      ...prev,
      subCategoryId
    }))
  }

  const handleModifiersChange = (modifierIds: number[]) => {
    setFormData(prev => ({
      ...prev,
      selectedModifiers: modifierIds
    }))
  }

  return (
    <form onSubmit={handleSubmit} className={className}>
      <Tabs defaultValue="basic" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="basic">Basic Info</TabsTrigger>
          <TabsTrigger value="pricing">Pricing</TabsTrigger>
          <TabsTrigger value="modifiers">Modifiers</TabsTrigger>
          <TabsTrigger value="media">Media</TabsTrigger>
        </TabsList>

        {/* Basic Information Tab */}
        <TabsContent value="basic" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Package size={20} />
                Basic Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="productCode">Product Code *</Label>
                  <Input
                    id="productCode"
                    value={formData.productCode}
                    onChange={(e) => setFormData(prev => ({ ...prev, productCode: e.target.value }))}
                    placeholder="e.g., PROD-001"
                    className={errors.productCode ? "border-red-500" : ""}
                  />
                  {errors.productCode && (
                    <p className="text-sm text-red-500 mt-1">{errors.productCode}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="name">Product Name *</Label>
                  <Input
                    id="name"
                    value={formData.name}
                    onChange={(e) => setFormData(prev => ({ ...prev, name: e.target.value }))}
                    placeholder="Product name"
                    className={errors.name ? "border-red-500" : ""}
                  />
                  {errors.name && (
                    <p className="text-sm text-red-500 mt-1">{errors.name}</p>
                  )}
                </div>
              </div>

              <div>
                <Label htmlFor="description">Description</Label>
                <Textarea
                  id="description"
                  value={formData.description}
                  onChange={(e) => setFormData(prev => ({ ...prev, description: e.target.value }))}
                  placeholder="Product description"
                  rows={3}
                />
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label>Category</Label>
                  <CategorySelector
                    value={formData.categoryId}
                    onChange={handleCategoryChange}
                    placeholder="Select category"
                    showSubCategories={false}
                  />
                </div>
                <div>
                  <Label>Sub Category</Label>
                  <CategorySelector
                    value={formData.subCategoryId}
                    onChange={handleSubCategoryChange}
                    placeholder="Select subcategory"
                    showSubCategories={true}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <Label htmlFor="unit">Unit *</Label>
                  <Input
                    id="unit"
                    value={formData.unit}
                    onChange={(e) => setFormData(prev => ({ ...prev, unit: e.target.value }))}
                    placeholder="e.g., piece, kg, liter"
                    className={errors.unit ? "border-red-500" : ""}
                  />
                  {errors.unit && (
                    <p className="text-sm text-red-500 mt-1">{errors.unit}</p>
                  )}
                </div>
                <div>
                  <Label htmlFor="status">Status</Label>
                  <select
                    id="status"
                    value={formData.status}
                    onChange={(e) => setFormData(prev => ({ ...prev, status: e.target.value }))}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="active">Active</option>
                    <option value="inactive">Inactive</option>
                  </select>
                </div>
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Pricing Tab */}
        <TabsContent value="pricing" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <DollarSign size={20} />
                Pricing Information
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="basePrice">Base Price (PKR) *</Label>
                <Input
                  id="basePrice"
                  type="number"
                  step="0.01"
                  min="0"
                  value={formData.basePrice}
                  onChange={(e) => setFormData(prev => ({ ...prev, basePrice: e.target.value }))}
                  placeholder="0.00"
                  className={errors.basePrice ? "border-red-500" : ""}
                />
                {errors.basePrice && (
                  <p className="text-sm text-red-500 mt-1">{errors.basePrice}</p>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Modifiers Tab */}
        <TabsContent value="modifiers" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Tag size={20} />
                Product Modifiers
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Modifiers</Label>
                <ModifierTags
                  value={formData.selectedModifiers}
                  onChange={handleModifiersChange}
                  placeholder="Select modifiers for this product"
                  maxTags={10}
                />
                <p className="text-sm text-muted-foreground mt-2">
                  Select modifiers like sizes, units, or packaging options for this product.
                </p>
              </div>

              {/* Selected Modifiers Preview */}
              {formData.selectedModifiers.length > 0 && (
                <div>
                  <Label>Selected Modifiers</Label>
                  <div className="mt-2 space-y-2">
                    {formData.selectedModifiers.map(modifierId => {
                      const modifier = modifiers.find(m => m.id === modifierId)
                      if (!modifier) return null
                      
                      return (
                        <div key={modifierId} className="flex items-center justify-between p-2 border rounded-md">
                          <div className="flex items-center gap-2">
                            <Tag size={16} />
                            <span>{modifier.name}</span>
                            <Badge variant="outline" className="text-xs">
                              {MODIFIER_TYPES.find(t => t.value === modifier.type)?.label || modifier.type}
                            </Badge>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Media Tab */}
        <TabsContent value="media" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ImageIcon size={20} />
                Media & Images
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label htmlFor="imageUrl">Image URL</Label>
                <Input
                  id="imageUrl"
                  value={formData.imageUrl}
                  onChange={(e) => setFormData(prev => ({ ...prev, imageUrl: e.target.value }))}
                  placeholder="https://example.com/image.jpg"
                />
                <p className="text-sm text-muted-foreground mt-1">
                  Enter a URL to an image for this product.
                </p>
              </div>

              {/* Image Preview */}
              {formData.imageUrl && (
                <div>
                  <Label>Image Preview</Label>
                  <div className="mt-2">
                    <img
                      src={formData.imageUrl}
                      alt="Product preview"
                      className="w-32 h-32 object-cover rounded-md border"
                      onError={(e) => {
                        e.currentTarget.style.display = 'none'
                      }}
                    />
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Form Actions */}
      <div className="flex items-center justify-end gap-2 pt-4">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={isLoading}>
          {(() => {
            if (isLoading) {
              return "Saving..."
            }
            if (product) {
              return "Update Product"
            }
            return "Create Product"
          })()}
        </Button>
      </div>
    </form>
  )
}
