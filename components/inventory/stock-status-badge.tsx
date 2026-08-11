import { Badge } from "@/components/ui/badge"
import { CheckCircle, AlertTriangle, XCircle } from "lucide-react"
import { cn } from "@/lib/utils"

interface StockStatusBadgeProps {
  quantity: number
  threshold: number
  variant?: "in-stock" | "low-stock" | "out-of-stock"
  showIcon?: boolean
  className?: string
}

export function StockStatusBadge({ 
  quantity, 
  threshold, 
  variant, 
  showIcon = true,
  className 
}: Readonly<StockStatusBadgeProps>) {
  // Determine variant based on quantity and threshold
  const getVariant = (): "in-stock" | "low-stock" | "out-of-stock" => {
    if (variant) return variant
    if (quantity === 0) return "out-of-stock"
    if (quantity <= threshold) return "low-stock"
    return "in-stock"
  }

  const currentVariant = getVariant()

  const variants = {
    "in-stock": {
      className: "bg-green-100 text-green-800 border-green-200",
      icon: CheckCircle,
      label: "In Stock"
    },
    "low-stock": {
      className: "bg-yellow-100 text-yellow-800 border-yellow-200",
      icon: AlertTriangle,
      label: "Low Stock"
    },
    "out-of-stock": {
      className: "bg-red-100 text-red-800 border-red-200",
      icon: XCircle,
      label: "Out of Stock"
    }
  }

  const config = variants[currentVariant]
  const Icon = config.icon

  return (
    <Badge 
      variant="outline" 
      className={cn(
        "flex items-center gap-1.5 font-medium",
        config.className,
        className
      )}
    >
      {showIcon && <Icon className="h-3 w-3" />}
      <span>{config.label}</span>
      <span className="text-xs opacity-75">({quantity})</span>
    </Badge>
  )
}
