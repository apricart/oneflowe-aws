import { Badge } from "@/components/ui/badge"
import { Edit3, Globe } from "lucide-react"
import { cn, formatPKR } from "@/lib/utils"

interface OverrideIndicatorProps {
  field: "name" | "price" | "description" | "image"
  globalValue: string | number
  customValue?: string | number | null
  isOverridden: boolean
  className?: string
}

export function OverrideIndicator({ 
  field, 
  globalValue, 
  customValue, 
  isOverridden, 
  className 
}: Readonly<OverrideIndicatorProps>) {
  const displayValue = isOverridden ? customValue : globalValue

  const formatValue = (value: string | number | null | undefined, field: string) => {
    if (value === null || value === undefined) return "Not set"
    
    if (field === "price") {
      return typeof value === "number" ? formatPKR(value / 100) : value
    }
    
    return value
  }

  return (
    <div className="flex items-center gap-2">
      <span className="font-medium text-sm">
        {formatValue(displayValue, field)}
      </span>
      <Badge 
        variant="outline" 
        className={cn(
          "flex items-center gap-1 text-xs",
          isOverridden 
            ? "bg-blue-100 text-blue-800 border-blue-200" 
            : "bg-gray-100 text-gray-600 border-gray-200"
        )}
      >
        {isOverridden ? (
          <>
            <Edit3 className="h-3 w-3" />
            <span>Custom</span>
          </>
        ) : (
          <>
            <Globe className="h-3 w-3" />
            <span>Global</span>
          </>
        )}
      </Badge>
    </div>
  )
}
