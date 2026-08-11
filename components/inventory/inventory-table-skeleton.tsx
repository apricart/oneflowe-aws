import { Skeleton } from "@/components/ui/skeleton"

interface InventoryTableSkeletonProps {
  rows?: number
  columns?: number
}

export function InventoryTableSkeleton({ rows = 5, columns = 8 }: Readonly<InventoryTableSkeletonProps>) {
  return (
    <div className="space-y-4">
      {/* Table Header */}
      <div className="flex items-center space-x-4">
        {Array.from({ length: columns }, (_, position) => `inventory-header-loading-${position + 1}`).map((skeletonKey) => (
          <Skeleton key={skeletonKey} className="h-4 w-20" />
        ))}
      </div>
      
      {/* Table Rows */}
      {Array.from({ length: rows }, (_, position) => `inventory-row-loading-${position + 1}`).map((rowKey) => (
        <div key={rowKey} className="flex items-center space-x-4 py-4">
          <div className="flex items-center space-x-3">
            <Skeleton className="h-12 w-12 rounded-lg" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          {Array.from({ length: columns - 1 }, (_, position) => `${rowKey}-column-${position + 1}`).map((columnKey) => (
            <Skeleton key={columnKey} className="h-4 w-16" />
          ))}
        </div>
      ))}
    </div>
  )
}
