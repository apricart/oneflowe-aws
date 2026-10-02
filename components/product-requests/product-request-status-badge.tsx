import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { PRODUCT_REQUEST_STATUS_LABELS, type ProductRequestStatus } from "@/lib/product-request"

const STATUS_CLASSES: Record<ProductRequestStatus, string> = {
  PENDING: "border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300",
  APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-800 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300",
}

export function ProductRequestStatusBadge({ status }: Readonly<{ status: ProductRequestStatus }>) {
  return (
    <Badge variant="outline" className={cn(STATUS_CLASSES[status])}>
      {PRODUCT_REQUEST_STATUS_LABELS[status]}
    </Badge>
  )
}
