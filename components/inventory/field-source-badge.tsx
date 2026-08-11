import { Badge } from "@/components/ui/badge"
import { Building2, Globe, Lock } from "lucide-react"
import { cn } from "@/lib/utils"

interface FieldSourceBadgeProps {
  source: "organization" | "global" | "restricted"
  field: "name" | "price" | "description" | "image"
  className?: string
}

export function FieldSourceBadge({ source, field, className }: Readonly<FieldSourceBadgeProps>) {
  const variants = {
    organization: {
      className: "bg-blue-100 text-blue-800 border-blue-200",
      icon: Building2,
      label: "Org Custom"
    },
    global: {
      className: "bg-gray-100 text-gray-600 border-gray-200",
      icon: Globe,
      label: "Global Default"
    },
    restricted: {
      className: "bg-orange-100 text-orange-800 border-orange-200",
      icon: Lock,
      label: "Restricted"
    }
  }

  const config = variants[source]
  const Icon = config.icon

  return (
    <Badge 
      variant="outline" 
      className={cn(
        "flex items-center gap-1.5 text-xs",
        config.className,
        className
      )}
    >
      <Icon className="h-3 w-3" />
      <span>{config.label}</span>
    </Badge>
  )
}
