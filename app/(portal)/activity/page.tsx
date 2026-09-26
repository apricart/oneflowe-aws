import { getServerSession } from "next-auth"
import { redirect } from "next/navigation"

import { ActivityLogScreen } from "@/components/activity/activity-log-screen"
import { authOptions } from "@/lib/auth-options"
import { canViewActivityLog } from "@/lib/activity-log-access"

/**
 * `/activity` — the admin activity log.
 *
 * The redirect here and the entry in the sidebar are both presentation. The
 * authorization that matters is in `GET /api/v1/activity-logs`, which re-checks
 * `canViewActivityLog` server-side: this page renders no trail data itself, so
 * a reader who reached it some other way still sees nothing.
 */
export default async function ActivityPage() {
  const session = await getServerSession(authOptions)
  if (!session?.user) {
    redirect("/login")
  }

  if (!canViewActivityLog((session.user as { role?: string }).role)) {
    redirect("/dashboard")
  }

  return (
    <div className="container mx-auto max-w-[1600px] px-4 py-8">
      <ActivityLogScreen />
    </div>
  )
}
