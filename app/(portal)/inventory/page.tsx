"use client"
import { viewerAccessFor } from "@/lib/viewer-access"
import { useSession } from "next-auth/react"
import dynamic from "next/dynamic"

const GlobalInventoryView = dynamic(() => import("@/components/admin/global-inventory-view"))
const HeadOfficeInventoryView = dynamic(() => import("@/components/head-office/organization-inventory-view"))

export default function InventoryPage() {
  const { data: session } = useSession()
  // An organization-wide Viewer reads Head Office's catalogue view, which
  // changes nothing.
  const { viewRole: userRole } = viewerAccessFor(session?.user)

  if (!session) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    )
  }

  if (userRole === "SUPER_ADMIN") {
    return <GlobalInventoryView />
  }

  if (userRole === "HEAD_OFFICE") {
    return <HeadOfficeInventoryView />
  }

  return (
    <div className="flex items-center justify-center min-h-screen">
      <p className="text-muted-foreground">Access denied</p>
    </div>
  )
}
