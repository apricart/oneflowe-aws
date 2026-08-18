"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowLeft, History, LogOut, ShoppingCart } from "lucide-react"

import { GroupOrderHistory } from "@/components/group-portal/group-order-history"
import { GroupOrderWorkspace } from "@/components/group-portal/group-order-workspace"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { securelySignOut } from "@/lib/session-coordination"

/**
 * The Group Order Portal's ordering workspace.
 *
 * Reachable only by GROUP_ORDER_PORTAL: the proxy confines the role to
 * `/group-portal`, the server layout above refuses any other role before this
 * page renders, and every endpoint it calls allowlists the role independently.
 */
export default function GroupBulkOrderPage() {
  const [tab, setTab] = useState("create")

  return (
    <main className="min-h-screen bg-slate-50/50 p-4 dark:bg-slate-950 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-indigo-50/50 bg-gradient-to-tr from-indigo-100 to-purple-100 shadow-inner dark:border-indigo-800/50 dark:from-indigo-900/50 dark:to-purple-900/50">
              <ShoppingCart className="h-6 w-6 text-indigo-600 dark:text-indigo-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Group Ordering</h1>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Order for many branches at once, tracked under one group order ID
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant="outline" size="sm" className="gap-2">
              <Link href="/group-portal">
                <ArrowLeft className="h-4 w-4" />
                My access
              </Link>
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="gap-2"
              onClick={() => securelySignOut({ callbackUrl: "/login" })}
            >
              <LogOut className="h-4 w-4" />
              Sign out
            </Button>
          </div>
        </header>

        <Tabs value={tab} onValueChange={setTab}>
          <TabsList>
            <TabsTrigger value="create" className="gap-2">
              <ShoppingCart className="h-4 w-4" />
              New group order
            </TabsTrigger>
            <TabsTrigger value="history" className="gap-2">
              <History className="h-4 w-4" />
              My group orders
            </TabsTrigger>
          </TabsList>

          <TabsContent value="create" className="mt-5">
            <GroupOrderWorkspace />
          </TabsContent>

          <TabsContent value="history" className="mt-5">
            <GroupOrderHistory />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}
