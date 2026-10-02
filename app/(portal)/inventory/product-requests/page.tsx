import { redirect } from "next/navigation"
import { ShieldAlert } from "lucide-react"

import ProductRequestsView from "@/components/product-requests/product-requests-view"
import { getSharedServerSession } from "@/lib/auth"
import { canOpenProductRequests } from "@/lib/product-request-access"

/**
 * Product Catalog → Product Requests.
 *
 * Checked on the server so a signed-in caller who may not be here gets an
 * explicit refusal rather than a page that mounts and then fails every
 * request. Neither this nor the sidebar is the authorization boundary — every
 * handler behind the page re-checks through `lib/product-request-access.ts`.
 */
export default async function ProductRequestsPage() {
  const session = await getSharedServerSession()
  if (!session?.user) redirect("/login")

  const role = (session.user as { role?: string }).role
  if (!canOpenProductRequests(role)) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <div className="max-w-md rounded-2xl border border-slate-200 bg-white p-8 text-center shadow-sm dark:border-slate-800 dark:bg-slate-900">
          <ShieldAlert className="mx-auto h-9 w-9 text-slate-400" />
          <h1 className="mt-4 text-lg font-bold">Access restricted</h1>
          <p className="mt-2 text-sm text-slate-500">Product requests are available to Super Administrators and Head Office users.</p>
        </div>
      </div>
    )
  }

  return <ProductRequestsView role={role as string} />
}
