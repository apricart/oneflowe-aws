"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Home, Building2, Users, Package, Boxes, Wallet, BarChart3, Settings, ShieldCheck, ShoppingBag, FolderTree, FolderOpen, ChevronDown, ChevronRight } from "lucide-react"
import Image from "next/image"
import { useState } from "react"

import { useSession } from "next-auth/react"

const getNavigationByRole = (role: string) => {
  const baseNav = [
    { href: "/dashboard", label: "Dashboard", icon: Home },
  ]

  if (role === "SUPER_ADMIN") {
    return [
      ...baseNav,
      { href: "/organizations", label: "Organizations", icon: Building2 },
      { href: "/users", label: "Users", icon: Users },
      { href: "/orders", label: "Orders", icon: Package },
      { href: "/refunds", label: "Refunds", icon: Wallet },
      {
        href: "/inventory",
        label: "Inventory Management",
        icon: Boxes,
        subItems: [
          { href: "/inventory", label: "Global Products" },
          { href: "/inventory/org", label: "Organization Inventory" },
          { href: "/inventory/branch/hub", label: "Group Inventory" },
          { href: "/products/categories", label: "Categories" },
          { href: "/products/subcategories", label: "Subcategories" },
        ]
      },
      { href: "/groups", label: "Group Management", icon: FolderTree },
      { href: "/budgets", label: "Budgets", icon: Wallet },
      { href: "/budget-by-quantity", label: "Budget by Quantity", icon: Wallet },
      {
        href: "/reports",
        label: "Reports",
        icon: BarChart3,
        subItems: [
          { href: "/reports/organization-report", label: "Organization Report" },
          { href: "/reports/order-report", label: "Order Report" },
          { href: "/reports/refund-report", label: "Refund Report" },
          { href: "/reports/budget-summary", label: "Budget Report" },
          { href: "/reports/product-performance", label: "Product Report" },
          { href: "/reports/user-report", label: "User Report" },
          { href: "/reports/branch-reports", label: "Branch Report" },
          { href: "/reports/groups", label: "Group Report" },
        ]
      },
      { href: "/settings", label: "Settings", icon: Settings },
    ]
  }

  if (role === "HEAD_OFFICE") {
    return [
      ...baseNav,
      { href: "/branches", label: "My Branches", icon: Building2 },
      { href: "/users", label: "Users", icon: Users },
      { href: "/orders", label: "Orders", icon: Package },
      { href: "/inventory", label: "Inventory", icon: Boxes },
      { href: "/groups", label: "Group Management", icon: FolderTree },
      { href: "/budgets", label: "Budgets", icon: Wallet },
      { href: "/budget-by-quantity", label: "Budget by Quantity", icon: Wallet },
      {
        href: "/reports",
        label: "Reports",
        icon: BarChart3,
        subItems: [
          { href: "/reports/organization-report", label: "Organization Report" },
          { href: "/reports/order-report", label: "Order Report" },
          { href: "/reports/refund-report", label: "Refund Report" },
          { href: "/reports/budget-summary", label: "Budget Report" },
          { href: "/reports/product-performance", label: "Product Report" },
          { href: "/reports/user-report", label: "User Report" },
          { href: "/reports/branch-reports", label: "Branch Report" },
          { href: "/reports/groups", label: "Group Report" },
        ]
      },
      { href: "/settings", label: "Settings", icon: Settings },
    ]
  }

  if (role === "BRANCH_ADMIN") {
    return [
      ...baseNav,
      { href: "/orders", label: "Orders", icon: Package },
      { href: "/branch-inventory", label: "Inventory", icon: Boxes },
      {
        href: "/reports",
        label: "Reports",
        icon: BarChart3,
        subItems: [
          { href: "/reports/order-report", label: "Order Report" },
          { href: "/reports/refund-report", label: "Refund Report" },
          { href: "/reports/product-performance", label: "Product Report" },
          { href: "/reports/user-report", label: "User Report" },
          { href: "/reports/branch-reports", label: "Branch Report" },
        ]
      },
      { href: "/settings", label: "Settings", icon: Settings },
    ]
  }

  return baseNav
}

export function Sidebar() {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role
  const isLoading = status === "loading"
  const nav = getNavigationByRole(role || "")
  const [expandedItems, setExpandedItems] = useState<string[]>([])

  const toggleExpanded = (href: string) => {
    setExpandedItems(prev =>
      prev.includes(href)
        ? prev.filter(item => item !== href)
        : [...prev, href]
    )
  }

  const isItemActive = (item: any) => {
    if (item.subItems) {
      return item.subItems.some((subItem: any) => pathname.startsWith(subItem.href))
    }
    return pathname.startsWith(item.href)
  }

  const isSubItemActive = (subItem: any) => {
    return pathname === subItem.href
  }

  return (
    <aside className="w-64 shrink-0 h-svh border-r border-slate-200 dark:border-slate-800 flex flex-col bg-slate-50/50 dark:bg-slate-900/50 backdrop-blur-xl">
      <div className="px-6 py-6 flex items-center gap-3 bg-gradient-to-br from-blue-600 via-indigo-700 to-violet-800 dark:from-sky-900 dark:via-blue-900 dark:to-indigo-950 shadow-lg relative overflow-hidden group">
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(255,255,255,0.1),transparent)] group-hover:opacity-100 transition-opacity duration-700"></div>
        <div className="relative z-10 bg-white/10 backdrop-blur-md rounded-xl p-2 flex items-center justify-center ring-1 ring-white/20 shadow-inner">
          <Image src="/logo-pos.png" alt="OneFlowe" width={32} height={32} className="drop-shadow-sm" />
        </div>
        <div className="relative z-10 leading-tight">
          <div className="text-lg font-bold tracking-tight text-white drop-shadow-sm">OneFlowe</div>
          <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-blue-100/80 group-hover:text-white transition-colors duration-300 min-h-[12px]">
            {isLoading ? (
              <div className="h-2 w-16 bg-white/20 rounded animate-pulse mt-1" />
            ) : (
              role === "SUPER_ADMIN" ? "Administrator" : role === "HEAD_OFFICE" ? "Head Office" : role === "BRANCH_ADMIN" ? "Branch Admin" : ""
            )}
          </div>
        </div>
      </div>

      <nav className="p-4 flex flex-col gap-1.5 overflow-y-auto flex-1 min-h-0 bg-transparent custom-scrollbar" aria-busy={isLoading} aria-live="polite">
        {isLoading ? (
          // Loading Skeleton
          <div className="space-y-4">
            {Array(6).fill(0).map((_, i) => (
              <div key={i} className="h-10 w-full bg-slate-200/50 dark:bg-slate-800/50 rounded-xl animate-pulse" />
            ))}
          </div>
        ) : (
          nav.map((item) => {
            const active = isItemActive(item)
            const hasSubItems = 'subItems' in item && Array.isArray(item.subItems) && item.subItems.length > 0;
            const isExpanded = expandedItems.includes(item.href)

            if (hasSubItems) {
              return (
                <div key={item.href} className="space-y-1">
                  <button
                    onClick={() => toggleExpanded(item.href)}
                    className={cn(
                      "w-full rounded-xl px-4 py-2.5 text-sm flex items-center gap-3 text-left transition-all duration-300 relative group",
                      active
                        ? "font-bold bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
                        : "text-slate-600 dark:text-slate-400 hover:bg-white/80 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-100 hover:shadow-sm"
                    )}
                  >
                    {active && <div className="absolute left-0 top-2.5 bottom-2.5 w-1 bg-blue-600 dark:bg-blue-400 rounded-r-full" />}
                    {item.icon ? (
                      <item.icon size={18} className={cn("transition-transform duration-300 group-hover:scale-110", active ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500 group-hover:text-blue-500")} />
                    ) : null}
                    <span className="flex-1">{item.label}</span>
                    <div className={cn("transition-transform duration-300", isExpanded ? "rotate-180" : "rotate-0")}>
                      <ChevronDown size={14} className="opacity-50" />
                    </div>
                  </button>
                  {isExpanded && (
                    <div className="ml-4 pl-4 border-l-2 border-slate-200 dark:border-slate-800 space-y-1 mt-1 animate-in fade-in slide-in-from-left-2 duration-300">
                      {item.subItems.map((subItem: any) => {
                        const subActive = isSubItemActive(subItem)
                        const hasNestedItems = 'subItems' in subItem && Array.isArray(subItem.subItems) && subItem.subItems.length > 0
                        const isNestedExpanded = expandedItems.includes(subItem.href)

                        if (hasNestedItems) {
                          return (
                            <div key={subItem.href} className="space-y-1">
                              <button
                                onClick={() => toggleExpanded(subItem.href)}
                                className={cn(
                                  "w-full rounded-lg px-4 py-2 text-xs font-medium flex items-center gap-2 text-left transition-all duration-300",
                                  subActive
                                    ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 shadow-sm"
                                    : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
                                )}
                              >
                                <div className="w-1 h-1 rounded-full bg-current opacity-30" />
                                <span className="flex-1">{subItem.label}</span>
                                <ChevronDown size={12} className={cn("opacity-50 transition-transform duration-300", isNestedExpanded ? "rotate-180" : "rotate-0")} />
                              </button>
                              {isNestedExpanded && (
                                <div className="ml-4 pl-4 border-l-2 border-slate-200 dark:border-slate-800 space-y-1">
                                  {subItem.subItems.map((nestedItem: any) => {
                                    const nestedActive = pathname === nestedItem.href
                                    return (
                                      <Link
                                        key={nestedItem.href}
                                        href={nestedItem.href}
                                        className={cn(
                                          "block rounded-lg px-4 py-2 text-xs font-medium transition-all duration-300",
                                          nestedActive
                                            ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 shadow-sm"
                                            : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
                                        )}
                                      >
                                        <div className="flex items-center gap-2">
                                          <div className="w-1 h-1 rounded-full bg-current opacity-30" />
                                          <span>{nestedItem.label}</span>
                                        </div>
                                      </Link>
                                    )
                                  })}
                                </div>
                              )}
                            </div>
                          )
                        }

                        return (
                          <Link
                            key={subItem.href}
                            href={subItem.href}
                            className={cn(
                              "block rounded-lg px-4 py-2 text-xs font-medium transition-all duration-300",
                              subActive
                                ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 shadow-sm font-bold"
                                : "text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              <div className="w-1 h-1 rounded-full bg-current opacity-30" />
                              <span>{subItem.label}</span>
                            </div>
                          </Link>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            }

            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "rounded-xl px-4 py-2.5 text-sm flex items-center gap-3 transition-all duration-300 relative group",
                  active
                    ? "font-bold bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
                    : "text-slate-600 dark:text-slate-400 hover:bg-white/80 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-100 hover:shadow-sm"
                )}
              >
                {active && <div className="absolute left-0 top-2.5 bottom-2.5 w-1 bg-blue-600 dark:bg-blue-400 rounded-r-full" />}
                {item.icon ? (
                  <item.icon size={18} className={cn("transition-transform duration-300 group-hover:scale-110", active ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500 group-hover:text-blue-500")} />
                ) : null}
                <span>{item.label}</span>
              </Link>
            )
          })
        )}
      </nav>
    </aside>
  )
}
