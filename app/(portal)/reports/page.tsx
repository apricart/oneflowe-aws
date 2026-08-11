"use client"

import { Card,CardContent,CardHeader,CardTitle } from "@/components/ui/card"
import Link from "next/link"
import {
  BarChart3,
  Package,
  FileText,RotateCcw,
  ClipboardList,
  Warehouse,
  Sparkles,
  ArrowRight,
  Building2,
  FolderTree,ShoppingBag,
  Loader2
} from "lucide-react"

import { useState,useEffect } from "react"

import { useSession } from "next-auth/react"

const reportCards = [
  {
    title: "Order Report",
    href: "/reports/order-report",
    description: "Unified view of all orders (Fulfilled, Refunded, Rejected) with advanced filtering.",
    icon: ShoppingBag,
    gradient: "from-rose-500 to-pink-500",
  },
  {
    title: "Refund Report",
    href: "/reports/refund-report",
    description: "Track refund requests, statuses, amounts, item details, and processing history.",
    icon: RotateCcw,
    gradient: "from-orange-500 to-rose-500",
  },
  {
    title: "Product Report",
    description: "Analyze product performance and category-wise breakdown",
    href: "/reports/product-performance",
    icon: Package,
    gradient: "from-blue-500 to-cyan-500",
  },
  {
    title: "Branch Reports",
    description: "Branch-level performance rankings, threshold alerts, and comparisons",
    href: "/reports/branch-reports",
    icon: Building2,
    gradient: "from-emerald-500 to-teal-500",
  },

  {
    title: "Stock Reports",
    description: "Current stock levels and inventory status",
    href: "/reports/stock-reports",
    icon: ClipboardList,
    gradient: "from-emerald-500 to-teal-500",
  },
  {
    title: "Stock Logs",
    description: "Track all stock movements and adjustments",
    href: "/reports/stock-logs",
    icon: FileText,
    gradient: "from-amber-500 to-orange-500",
  },
  {
    title: "Stock Store Report",
    description: "Store-wise inventory overview and distribution",
    href: "/reports/stock-store-Report",
    icon: Warehouse,
    gradient: "from-violet-500 to-purple-500",
  },
  {
    title: "Organization Report",
    description: "Multi-organization data comparison and global performance metrics",
    href: "/reports/organization-report",
    icon: Building2,
    gradient: "from-blue-600 to-indigo-600",
  },
  {
    title: "Groups Report",
    description: "Group performance, member branches, and purchase breakdowns",
    href: "/reports/groups",
    icon: FolderTree,
    gradient: "from-fuchsia-500 to-pink-500",
  },
]

export default function ReportsPage() {
  const { data: session } = useSession()
  const role = (session?.user as any)?.role
  const isBuyer = role === "HEAD_OFFICE" || role === "BRANCH_ADMIN"
  const [hasMounted, setHasMounted] = useState(false)

  useEffect(() => {
    setHasMounted(true)
  }, [])

  const displayReportCards = reportCards
    .filter(card => {
      if (role === "BRANCH_ADMIN") {
        if (card.title === "Groups Report" || card.title === "Organization Report") {
          return false
        }
      }
      return true
    })
    .map(card => {
      if (!isBuyer) return card
      
      let description = card.description
      if (card.title === "Order Report") {
        description = "Branch-level purchase rankings, threshold alerts, and comparisons"
      } else if (card.title === "Groups Report") {
        description = "Group performance, member branches, and purchase breakdowns"
      }
      
      return { ...card, description }
    })

  if (!hasMounted) {
    return (
      <div className="flex h-screen items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-slate-400" />
      </div>
    )
  }

  return (
    <main className="min-h-screen bg-slate-50 dark:bg-slate-950 p-4 md:p-6 space-y-6">
      {/* Hero Header */}
      <Card className="relative overflow-hidden border-none bg-gradient-to-r from-slate-900 via-indigo-900 to-indigo-700 text-white shadow-xl">
        <div className="pointer-events-none absolute inset-0 opacity-30">
          <div className="absolute -top-16 right-0 h-48 w-48 rounded-full bg-white/30 blur-3xl" />
          <div className="absolute bottom-0 left-0 h-32 w-32 rounded-full bg-indigo-400/40 blur-3xl" />
        </div>
        <CardHeader className="relative flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="space-y-3">
            <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-white/70">
              <Sparkles className="h-4 w-4" />
              Analytics Hub
            </p>
            <CardTitle className="text-3xl font-semibold text-white">Reports & Insights</CardTitle>
            <p className="text-sm text-white/80">
              Explore comprehensive analytics, track performance, and make data-driven decisions across your organization.
            </p>
          </div>
          <div className="rounded-full bg-white/15 px-4 py-2 text-xs uppercase tracking-wide text-white">
            {reportCards.length} report types
          </div>
        </CardHeader>
      </Card>

      {/* Report Cards Grid */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {displayReportCards.map((report) => {
          const Icon = report.icon
          return (
            <Link key={report.title} href={report.href} className="group">
              <Card className="h-full border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900 hover:shadow-lg hover:border-indigo-300 dark:hover:border-indigo-700 transition-all duration-300">
                <CardContent className="p-5 flex flex-col h-full">
                  <div className={`mb-4 inline-flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-r ${report.gradient} text-white shadow-md`}>
                    <Icon className="h-6 w-6" />
                  </div>
                  <h3 className="text-lg font-semibold text-slate-900 dark:text-white mb-2 group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors">
                    {report.title}
                  </h3>
                  <p className="text-sm text-muted-foreground flex-1">
                    {report.description}
                  </p>
                  <div className="mt-4 flex items-center gap-2 text-sm font-medium text-indigo-600 dark:text-indigo-400 group-hover:gap-3 transition-all">
                    <span>View Report</span>
                    <ArrowRight className="h-4 w-4" />
                  </div>
                </CardContent>
              </Card>
            </Link>
          )
        })}
      </div>

      {/* Quick Stats Overview */}
      <Card className="border border-slate-200 dark:border-slate-800 shadow-sm dark:shadow-slate-900/50 bg-white dark:bg-slate-900">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg text-slate-900 dark:text-white">
            <BarChart3 className="h-5 w-5 text-indigo-600" />
            Quick Overview
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Stock Reports</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-white">3</p>
              <p className="text-xs text-muted-foreground">Inventory insights</p>
            </div>
            <div className="p-4 rounded-xl bg-slate-50 dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-1">Order Reports</p>
              <p className="text-2xl font-bold text-slate-900 dark:text-white">2</p>
              <p className="text-xs text-muted-foreground">Refund tracking</p>
            </div>
            <div className="p-4 rounded-xl bg-indigo-50 dark:bg-indigo-900/30 border border-indigo-200 dark:border-indigo-800">
              <p className="text-xs font-semibold text-indigo-600 dark:text-indigo-400 uppercase tracking-wide mb-1">Total Reports</p>
              <p className="text-2xl font-bold text-indigo-600 dark:text-indigo-400">{displayReportCards.length}</p>
              <p className="text-xs text-muted-foreground">Available types</p>
            </div>
          </div>
        </CardContent>
      </Card>
    </main>
  )
}
