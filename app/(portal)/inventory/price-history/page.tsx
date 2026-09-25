import { getServerSession } from "next-auth"
import { ShieldAlert } from "lucide-react"

import ProductPriceHistoryView from "@/components/inventory/product-price-history-view"
import { authOptions } from "@/lib/auth-options"

export default async function ProductPriceHistoryPage() {
  const session = await getServerSession(authOptions)
  const role = (session?.user as { role?: string } | undefined)?.role
  if (role !== "SUPER_ADMIN" && role !== "HEAD_OFFICE") {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <ShieldAlert className="mx-auto h-9 w-9 text-slate-400" />
          <h1 className="mt-4 text-lg font-bold">Access restricted</h1>
          <p className="mt-2 text-sm text-slate-500">Product price history is available to Super Administrators and Head Office users.</p>
        </div>
      </div>
    )
  }
  return <ProductPriceHistoryView role={role} />
}
