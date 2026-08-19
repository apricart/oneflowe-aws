"use client"

import Link from "next/link"
import useSWR from "swr"
import { ArrowRight, Building2, Layers, LogOut, ShieldCheck, ShoppingCart } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ListSkeleton } from "@/components/ui/skeleton"
import { securelySignOut } from "@/lib/session-coordination"
import { fetcher } from "@/lib/fetcher"

type GroupPortalScope = {
  item?: {
    organization: { id: number; name: string } | null
    role: string
    canApproveOrders: boolean
    groups: { id: number; name: string }[]
    assignedBranches: { id: number; name: string; groupId: number | null }[]
    branches: { id: number; name: string; city: string | null; groupId: number | null }[]
  }
}

/**
 * Landing page shared by the two group-based roles.
 *
 * The dedicated multi-branch views are not built yet; until they are, this page
 * confirms who the user is and exactly which branches an administrator gave
 * them, so both roles are verifiable end to end without borrowing the
 * single-branch /shop screens.
 */
export default function GroupPortalPage() {
  const { data, error, isLoading } = useSWR<GroupPortalScope>("/api/v1/group-portal/scope", fetcher)

  const scope = data?.item
  const groups = scope?.groups ?? []
  const assignedBranches = scope?.assignedBranches ?? []
  const branches = scope?.branches ?? []

  return (
    <main className="min-h-screen bg-slate-50/50 p-4 dark:bg-slate-950 md:p-8">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-indigo-50/50 bg-gradient-to-tr from-indigo-100 to-purple-100 shadow-inner dark:border-indigo-800/50 dark:from-indigo-900/50 dark:to-purple-900/50">
              <ShoppingCart className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">
                {scope?.canApproveOrders ? "Group Workspace" : "Group Order Portal"}
              </h1>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                {scope?.organization?.name ?? "Ordering on behalf of assigned branches"}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" className="gap-2" onClick={() => securelySignOut({ callbackUrl: "/login" })}>
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>

        {/* Each workspace belongs to exactly one role: GROUP_ORDER_PORTAL raises
            group orders, GROUP_USER decides them. This landing page is shared,
            so it offers whichever workspace the signed-in role owns. */}
        {scope?.canApproveOrders ? (
          <Card className="rounded-2xl border-emerald-100 bg-gradient-to-tr from-emerald-50 to-teal-50 dark:border-emerald-900/60 dark:from-emerald-950/40 dark:to-teal-950/30">
            <CardContent className="flex flex-col items-start justify-between gap-4 p-5 sm:flex-row sm:items-center">
              <div>
                <h2 className="flex items-center gap-2 text-base font-semibold text-slate-900 dark:text-slate-100">
                  <ShieldCheck className="h-4 w-4" />
                  Review orders awaiting you
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  Approve or reject orders across every branch in your scope — one at a time, or a
                  whole group order at once.
                </p>
              </div>
              <Button asChild className="shrink-0 gap-2">
                <Link href="/group-portal/approvals">
                  Open approvals
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        ) : (
          <Card className="rounded-2xl border-indigo-100 bg-gradient-to-tr from-indigo-50 to-purple-50 dark:border-indigo-900/60 dark:from-indigo-950/40 dark:to-purple-950/30">
            <CardContent className="flex flex-col items-start justify-between gap-4 p-5 sm:flex-row sm:items-center">
              <div>
                <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                  Place a group order
                </h2>
                <p className="mt-1 text-sm text-slate-600 dark:text-slate-300">
                  Select locations, choose items, and submit for many branches at once — tracked
                  under a single group order ID.
                </p>
              </div>
              <Button asChild className="shrink-0 gap-2">
                <Link href="/group-portal/bulk-order">
                  Start ordering
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </CardContent>
          </Card>
        )}

        {(() => {
          if (isLoading) {
            return (
              <Card className="rounded-2xl">
                <CardContent className="p-6">
                  <ListSkeleton rows={4} />
                </CardContent>
              </Card>
            )
          }
          if (error || !scope) {
            return (
              <Card role="alert" className="rounded-2xl border-rose-200 bg-rose-50/60 dark:border-rose-900/60 dark:bg-rose-950/20">
                <CardContent className="p-5 text-sm text-slate-700 dark:text-slate-300">
                  Your branch access could not be loaded. Please try again, or contact your
                  administrator if this continues.
                </CardContent>
              </Card>
            )
          }
          return (
            <div className="grid gap-6 md:grid-cols-2">
              <ScopeCard
                title="Assigned groups"
                icon={<Layers className="h-4 w-4" />}
                emptyLabel="No groups assigned"
                items={groups.map((group) => group.name)}
              />
              <ScopeCard
                title="Individually assigned branches"
                icon={<Building2 className="h-4 w-4" />}
                emptyLabel="No individual branches assigned"
                items={assignedBranches.map((branch) => branch.name)}
              />
              <Card className="rounded-2xl md:col-span-2">
                <CardHeader className="pb-3">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Building2 className="h-4 w-4" />
                    {scope?.canApproveOrders ? "Branches you can approve for" : "Branches you can order for"}
                    <Badge variant="secondary">{branches.length}</Badge>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {branches.length === 0 ? (
                    <p className="text-sm text-slate-500 dark:text-slate-400">
                      No branches are currently in scope. Ask your administrator to assign a group
                      or a branch to your account.
                    </p>
                  ) : (
                    <ul className="grid gap-2 sm:grid-cols-2">
                      {branches.map((branch) => (
                        <li
                          key={branch.id}
                          className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm dark:border-slate-800 dark:bg-slate-900"
                        >
                          <span className="font-medium text-slate-900 dark:text-slate-100">{branch.name}</span>
                          {branch.city && (
                            <span className="ml-2 text-xs text-slate-500 dark:text-slate-400">{branch.city}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </CardContent>
              </Card>
            </div>
          )
        })()}
      </div>
    </main>
  )
}

function ScopeCard({
  title,
  icon,
  items,
  emptyLabel,
}: Readonly<{
  title: string
  icon: React.ReactNode
  items: string[]
  emptyLabel: string
}>) {
  return (
    <Card className="rounded-2xl">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-base">
          {icon}
          {title}
          <Badge variant="secondary">{items.length}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-slate-500 dark:text-slate-400">{emptyLabel}</p>
        ) : (
          <ul className="space-y-1.5">
            {items.map((item) => (
              <li key={item} className="text-sm text-slate-700 dark:text-slate-300">
                {item}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
