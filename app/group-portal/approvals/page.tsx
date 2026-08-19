"use client"

import { useState } from "react"
import Link from "next/link"
import { ArrowLeft, ClipboardCheck, Layers, LogOut, Package } from "lucide-react"

import { ApprovalAllOrders } from "@/components/group-portal/approval-all-orders"
import { ApprovalQueue } from "@/components/group-portal/approval-queue"
import { Button } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { securelySignOut } from "@/lib/session-coordination"

/**
 * The Group User's approval workspace.
 *
 * Reachable only by GROUP_USER: the proxy confines the role to `/group-portal`
 * and keeps this area exclusive to it, the server layout above refuses any
 * other role before this page renders, and every endpoint it calls allowlists
 * the role independently.
 */
export default function GroupApprovalsPage() {
  const [tab, setTab] = useState("groups")

  return (
    <main className="min-h-screen bg-slate-50/50 p-4 dark:bg-slate-950 md:p-8">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-slate-100 bg-white p-5 shadow-[0_2px_10px_-3px_rgba(6,81,237,0.1)] dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-emerald-50/50 bg-gradient-to-tr from-emerald-100 to-teal-100 shadow-inner dark:border-emerald-800/50 dark:from-emerald-900/50 dark:to-teal-900/50">
              <ClipboardCheck className="h-6 w-6 text-emerald-600 dark:text-emerald-400" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-900 dark:text-slate-100">Order Approvals</h1>
              <p className="text-xs font-medium text-slate-500 dark:text-slate-400">
                Decide orders across every branch assigned to you
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
            <TabsTrigger value="groups" className="gap-2">
              <Layers className="h-4 w-4" />
              By group order
            </TabsTrigger>
            <TabsTrigger value="orders" className="gap-2">
              <Package className="h-4 w-4" />
              All branch orders
            </TabsTrigger>
          </TabsList>

          <TabsContent value="groups" className="mt-5">
            <ApprovalQueue />
          </TabsContent>

          <TabsContent value="orders" className="mt-5">
            <ApprovalAllOrders />
          </TabsContent>
        </Tabs>
      </div>
    </main>
  )
}
