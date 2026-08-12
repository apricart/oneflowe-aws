import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { FieldSourceBadge } from "./field-source-badge"
import { StockStatusBadge } from "./stock-status-badge"
import { Eye, EyeOff, Settings, Package } from "lucide-react"
import { cn, formatPKR } from "@/lib/utils"

interface ProductDetailCardProps {
  product: {
    id: number
    productName: string
    productCode: string
    basePrice: number
    unit: string
    stockQuantity: number
    reorderThreshold: number
    isVisible: boolean
    isActive: boolean
    description?: string
    customName?: string
    customPrice?: number
    customDescription?: string
    customImageUrl?: string
    productImageUrl?: string
    categoryName?: string
  }
  isEditable?: boolean
  showSource?: boolean
  showParentStatus?: boolean
  onEdit?: () => void
  onToggleVisibility?: () => void
  className?: string
}

export function ProductDetailCard({
  product,
  isEditable = false,
  showSource = true,
  showParentStatus = true,
  onEdit,
  onToggleVisibility,
  className
}: Readonly<ProductDetailCardProps>) {
  const effectiveName = product.customName || product.productName
  const effectivePrice = product.customPrice || product.basePrice
  const effectiveDescription = product.customDescription || product.description


  const getSource = (field: "name" | "price" | "description" | "image") => {
    switch (field) {
      case "name":
        return product.customName ? "organization" : "global"
      case "price":
        return product.customPrice ? "organization" : "global"
      case "description":
        return product.customDescription ? "organization" : "global"
      case "image":
        return product.customImageUrl ? "organization" : "global"
      default:
        return "global"
    }
  }

  return (
    <Card className={cn("w-full", className)}>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between">
          <div className="space-y-1">
            <CardTitle className="text-lg flex items-center gap-2">
              <Package className="h-5 w-5" />
              {effectiveName}
            </CardTitle>
            <div className="flex items-center gap-2">
              <Badge variant="outline" className="text-xs">
                {product.productCode}
              </Badge>
              {product.categoryName && (
                <Badge variant="secondary" className="text-xs">
                  {product.categoryName}
                </Badge>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <StockStatusBadge
              quantity={product.stockQuantity}
              threshold={product.reorderThreshold}
            />
            {onToggleVisibility && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onToggleVisibility}
                className="h-8 w-8 p-0"
              >
                {product.isVisible ? (
                  <Eye className="h-4 w-4" />
                ) : (
                  <EyeOff className="h-4 w-4" />
                )}
              </Button>
            )}
            {onEdit && isEditable && (
              <Button
                variant="ghost"
                size="sm"
                onClick={onEdit}
                className="h-8 w-8 p-0"
              >
                <Settings className="h-4 w-4" />
              </Button>
            )}
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Product Details */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">Price</span>
            <div className="flex items-center gap-2">
              <span className="font-semibold">
                {formatPKR(effectivePrice / 100)} {product.unit}
              </span>
              {showSource && (
                <FieldSourceBadge
                  source={getSource("price")}
                  field="price"
                />
              )}
            </div>
          </div>

          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">Name</span>
            <div className="flex items-center gap-2">
              <span className="font-medium">{effectiveName}</span>
              {showSource && (
                <FieldSourceBadge
                  source={getSource("name")}
                  field="name"
                />
              )}
            </div>
          </div>


          {effectiveDescription && (
            <div className="flex items-start justify-between">
              <span className="text-sm font-medium text-muted-foreground">Description</span>
              <div className="flex items-start gap-2 max-w-xs">
                <span className="text-sm text-right">{effectiveDescription}</span>
                {showSource && (
                  <FieldSourceBadge
                    source={getSource("description")}
                    field="description"
                  />
                )}
              </div>
            </div>
          )}
        </div>

        {/* Stock Information */}
        <div className="pt-3 border-t space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">Stock Status</span>
            <StockStatusBadge
              quantity={product.stockQuantity || 0}
              threshold={product.reorderThreshold || 10}
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">Current Stock</span>
            <span className="font-semibold">{product.stockQuantity || 0}</span>
          </div>
          {product.reorderThreshold > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-muted-foreground">Reorder Threshold</span>
              <span className="font-semibold">{product.reorderThreshold}</span>
            </div>
          )}
        </div>

        {/* Status Information */}
        <div className="pt-3 border-t">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium text-muted-foreground">Status</span>
            <div className="flex items-center gap-2">
              <Badge
                variant={product.isActive ? "default" : "secondary"}
                className={product.isActive ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"}
              >
                {product.isActive ? "Active" : "Inactive"}
              </Badge>
              <Badge
                variant={product.isVisible ? "default" : "secondary"}
                className={product.isVisible ? "bg-blue-100 text-blue-800" : "bg-gray-100 text-gray-600"}
              >
                {product.isVisible ? "Visible" : "Hidden"}
              </Badge>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
