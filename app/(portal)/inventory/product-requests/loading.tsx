import { Skeleton } from "@/components/ui/skeleton"

export default function ProductRequestsLoading() {
  return (
    <div className="space-y-5 p-4 md:p-6">
      <Skeleton className="h-24 rounded-2xl" />
      <Skeleton className="h-10 w-96 max-w-full rounded-lg" />
      <Skeleton className="h-[420px] rounded-xl" />
    </div>
  )
}
