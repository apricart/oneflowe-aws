import { cn } from "@/lib/utils"

function Skeleton({
  className,
  ...props
}: Readonly<React.HTMLAttributes<HTMLDivElement>>) {
  return (
    <div
      className={cn("animate-pulse rounded-md bg-muted", className)}
      {...props}
    />
  )
}

export function Spinner({ size = 20 }: Readonly<{ size?: number }>) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="4" fill="none" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" fill="none" />
    </svg>
  )
}

export function LoaderOverlay() {
  return (
    <div className="fixed inset-0 z-50 grid place-items-center" style={{ background: "color-mix(in oklab, black, transparent 80%)" }}>
      <div className="rounded-xl p-6 bg-white shadow-lg grid place-items-center gap-3">
        <Spinner size={32} />
        <div className="text-sm">Loading…</div>
      </div>
    </div>
  )
}

export { Skeleton }

export function ListSkeleton({ rows = 6 }: Readonly<{ rows?: number }>) {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Skeleton className="h-8 w-48" />
        <div className="flex items-center gap-2">
          <Skeleton className="h-9 w-24" />
          <Skeleton className="h-9 w-24" />
        </div>
      </div>
      <div className="rounded-xl border">
        <div className="grid grid-cols-12 gap-2 p-4">
          <Skeleton className="col-span-3 h-4" />
          <Skeleton className="col-span-3 h-4" />
          <Skeleton className="col-span-2 h-4" />
          <Skeleton className="col-span-2 h-4" />
          <Skeleton className="col-span-2 h-4" />
        </div>
        <div className="divide-y">
          {Array.from({ length: rows }, (_, position) => `table-skeleton-row-${position + 1}`).map((skeletonKey) => (
            <div key={skeletonKey} className="grid grid-cols-12 gap-2 p-4">
              <Skeleton className="col-span-3 h-4" />
              <Skeleton className="col-span-3 h-4" />
              <Skeleton className="col-span-2 h-4" />
              <Skeleton className="col-span-2 h-4" />
              <Skeleton className="col-span-2 h-4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
