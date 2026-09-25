import { Skeleton } from "@/components/ui/skeleton"

export default function ProductPriceHistoryLoading() {
  return (
    <div className="space-y-5 p-4 md:p-6">
      <Skeleton className="h-24 rounded-2xl" />
      <Skeleton className="h-20 rounded-xl" />
      <div className="grid gap-5 xl:grid-cols-[300px_minmax(0,1fr)]">
        <Skeleton className="h-[680px] rounded-xl" />
        <div className="space-y-5">
          <Skeleton className="h-20 rounded-xl" />
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {Array.from({ length: 4 }, (_, index) => <Skeleton className="h-32 rounded-xl" key={index} />)}
          </div>
          <Skeleton className="h-[440px] rounded-xl" />
        </div>
      </div>
    </div>
  )
}
