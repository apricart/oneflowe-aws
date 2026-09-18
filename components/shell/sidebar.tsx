"use client"
import Link from "next/link"
import { usePathname } from "next/navigation"
import { cn } from "@/lib/utils"
import { Home,Building2,Users,Package,Boxes,Wallet,BarChart3,Settings,FolderTree,ChevronDown,ClipboardCheck,LifeBuoy,PanelLeftClose,PanelLeftOpen } from "lucide-react"
import Image from "next/image"
import { useCallback,useEffect,useState,type ReactNode } from "react"
import { Tooltip,TooltipContent,TooltipTrigger } from "@/components/ui/tooltip"
import { HoverCard,HoverCardContent,HoverCardTrigger } from "@/components/ui/hover-card"

import { useSession } from "next-auth/react"

const COLLAPSED_STORAGE_KEY = "oneflowe.sidebar.collapsed"

export const getNavigationByRole = (role: string, budgetAllocationEnabled = false) => {
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
          { href: "/reports/graphical", label: "Graphical Reports" },
          { href: "/reports/graphical?tab=product-performance", label: "Product Performance" },
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
      { href: "/support", label: "Support", icon: LifeBuoy },
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
          { href: "/reports/graphical", label: "Graphical Reports" },
          { href: "/reports/graphical?tab=product-performance", label: "Product Performance" },
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
      { href: "/support", label: "Support", icon: LifeBuoy },
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
      { href: "/support", label: "Support", icon: LifeBuoy },
      { href: "/settings", label: "Settings", icon: Settings },
    ]
  }

  // The approver shares the shell but not the administrator's reach: it gets a
  // dashboard and an order directory covering the branches assigned to it, its
  // own approval queue, optionally the money budgets of those same branches, and the
  // reports those assignments scope — and no inventory, user, branch,
  // organization or quantity-budget entries. `proxy.ts` enforces the same
  // allowlist, so a hand-typed URL cannot reach anything omitted here, and
  // every endpoint behind the entries below re-derives the branch set from the
  // caller's own assignments.
  if (role === "GROUP_USER") {
    return [
      ...baseNav,
      { href: "/orders", label: "Orders", icon: Package },
      { href: "/approvals", label: "Approvals", icon: ClipboardCheck },
      ...(budgetAllocationEnabled ? [{ href: "/budgets", label: "Budgets", icon: Wallet }] : []),
      {
        href: "/reports",
        label: "Reports",
        icon: BarChart3,
        subItems: [
          { href: "/reports/graphical", label: "Graphical Reports" },
          { href: "/reports/graphical?tab=product-performance", label: "Product Performance" },
          { href: "/reports/order-report", label: "Order Report" },
          { href: "/reports/group-orders", label: "Group Order Report" },
          { href: "/reports/refund-report", label: "Refund Report" },
          { href: "/reports/product-performance", label: "Product Report" },
          { href: "/reports/user-report", label: "User Report" },
          { href: "/reports/branch-reports", label: "Branch Report" },
        ]
      },
      { href: "/support", label: "Support", icon: LifeBuoy },
      { href: "/settings", label: "Settings", icon: Settings },
    ]
  }

  return baseNav
}

const describeRole = (role: string) => {
  if (role === "SUPER_ADMIN") {
    return "Administrator"
  }
  if (role === "HEAD_OFFICE") {
    return "Head Office"
  }
  if (role === "BRANCH_ADMIN") {
    return "Branch Admin"
  }
  if (role === "GROUP_USER") {
    return "Group User"
  }
  return ""
}

// The rail remembers whether it is collapsed so the choice survives navigation
// and reloads. The stored value is read after mount so the server-rendered
// markup and the first client render always agree.
const useCollapsedRail = () => {
  const [collapsed, setCollapsed] = useState(false)

  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "true")
    } catch {
      // Storage can be blocked; the rail simply starts expanded.
    }
  }, [])

  const changeCollapsed = useCallback((next: boolean) => {
    setCollapsed(next)
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, String(next))
    } catch {
      // Persisting is best effort — the current session still switches.
    }
  }, [])

  return { collapsed, changeCollapsed }
}

// Links shown inside the fly-out that stands in for an expanded submenu while
// the rail is collapsed. Sub-items may themselves nest, so this recurses.
function FlyoutLinks({ items, pathname }: Readonly<{ items: any[]; pathname: string }>) {
  return (
    <div className="space-y-0.5">
      {items.map((entry: any) => {
        const nested = 'subItems' in entry && Array.isArray(entry.subItems) && entry.subItems.length > 0
        return (
          <div key={entry.href}>
            <Link
              href={entry.href}
              className={cn(
                "flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-colors",
                pathname === entry.href
                  ? "bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 font-bold"
                  : "text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100"
              )}
            >
              <div className="w-1 h-1 rounded-full bg-current opacity-30" />
              <span>{entry.label}</span>
            </Link>
            {nested && (
              <div className="ml-4 pl-2 border-l-2 border-slate-200 dark:border-slate-800">
                <FlyoutLinks items={entry.subItems} pathname={pathname} />
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

export function Sidebar() {
  const pathname = usePathname()
  const { data: session, status } = useSession()
  const role = (session?.user as any)?.role
  const isLoading = status === "loading"
  const nav = getNavigationByRole(role || "", (session?.user as any)?.budgetAllocationEnabled === true)
  const [expandedItems, setExpandedItems] = useState<string[]>([])
  const { collapsed, changeCollapsed } = useCollapsedRail()

  const toggleExpanded = (href: string) => {
    setExpandedItems(prev =>
      prev.includes(href)
        ? prev.filter(item => item !== href)
        : [...prev, href]
    )
  }

  // Picking a group from the collapsed rail opens the sidebar on that group so
  // the user lands where the fly-out was pointing.
  const openGroupFromRail = (href: string) => {
    changeCollapsed(false)
    setExpandedItems(prev => (prev.includes(href) ? prev : [...prev, href]))
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

  const railItemClass = (active: boolean) =>
    cn(
      "relative group mx-auto flex h-11 w-11 items-center justify-center rounded-xl transition-all duration-300",
      active
        ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
        : "text-slate-600 dark:text-slate-400 hover:bg-white/80 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-100 hover:shadow-sm"
    )

  const railIconClass = (active: boolean) =>
    cn(
      "transition-transform duration-300 group-hover:scale-110",
      active ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500 group-hover:text-blue-500"
    )

  const renderCollapsedItem = (item: any): ReactNode => {
    const active = isItemActive(item)
    const hasSubItems = 'subItems' in item && Array.isArray(item.subItems) && item.subItems.length > 0

    const activeMarker = active
      ? <span className="absolute left-0 top-2 bottom-2 w-1 bg-blue-600 dark:bg-blue-400 rounded-r-full" />
      : null

    if (hasSubItems) {
      return (
        <HoverCard key={item.href} openDelay={80} closeDelay={120}>
          <HoverCardTrigger asChild>
            <button
              type="button"
              onClick={() => openGroupFromRail(item.href)}
              className={railItemClass(active)}
            >
              {activeMarker}
              {item.icon && <item.icon size={20} className={railIconClass(active)} />}
              <span className="sr-only">{item.label}</span>
            </button>
          </HoverCardTrigger>
          <HoverCardContent side="right" align="start" sideOffset={12} className="w-60 p-2">
            <div className="px-3 pb-2 text-[11px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400">
              {item.label}
            </div>
            <FlyoutLinks items={item.subItems} pathname={pathname} />
          </HoverCardContent>
        </HoverCard>
      )
    }

    return (
      <Tooltip key={item.href}>
        <TooltipTrigger asChild>
          <Link href={item.href} className={railItemClass(active)}>
            {activeMarker}
            {item.icon && <item.icon size={20} className={railIconClass(active)} />}
            <span className="sr-only">{item.label}</span>
          </Link>
        </TooltipTrigger>
        <TooltipContent side="right" sideOffset={10}>{item.label}</TooltipContent>
      </Tooltip>
    )
  }

  const renderExpandedItem = (item: any): ReactNode => {
    const active = isItemActive(item)
    const hasSubItems = 'subItems' in item && Array.isArray(item.subItems) && item.subItems.length > 0;
    const isExpanded = expandedItems.includes(item.href)

    if (hasSubItems) {
      return (
        <div key={item.href} className="space-y-1">
          <button type="button"
            onClick={() => toggleExpanded(item.href)}
            className={cn(
              "w-full rounded-xl px-4 py-2.5 text-sm flex items-center gap-3 text-left transition-all duration-300 relative group",
              active
                ? "font-bold bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm ring-1 ring-slate-200 dark:ring-slate-700"
                : "text-slate-600 dark:text-slate-400 hover:bg-white/80 dark:hover:bg-slate-800/80 hover:text-slate-900 dark:hover:text-slate-100 hover:shadow-sm"
            )}
          >
            {active && <div className="absolute left-0 top-2.5 bottom-2.5 w-1 bg-blue-600 dark:bg-blue-400 rounded-r-full" />}
            {item.icon && (
              <item.icon size={18} className={cn("transition-transform duration-300 group-hover:scale-110", active ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500 group-hover:text-blue-500")} />
            )}
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
                      <button type="button"
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
        {item.icon && (
          <item.icon size={18} className={cn("transition-transform duration-300 group-hover:scale-110", active ? "text-blue-600 dark:text-blue-400" : "text-slate-400 dark:text-slate-500 group-hover:text-blue-500")} />
        )}
        <span>{item.label}</span>
      </Link>
    )
  }

  return (
    <aside
      data-collapsed={collapsed}
      className={cn(
        "shrink-0 h-svh border-r border-slate-200 dark:border-slate-800 flex flex-col bg-slate-50/50 dark:bg-slate-900/50 backdrop-blur-xl transition-[width] duration-300 ease-in-out",
        collapsed ? "w-[76px]" : "w-64"
      )}
    >
      <div
        className={cn(
          "bg-gradient-to-br from-blue-600 via-indigo-700 to-violet-800 dark:from-sky-900 dark:via-blue-900 dark:to-indigo-950 shadow-lg relative overflow-hidden group",
          collapsed ? "px-2 py-4 flex flex-col items-center gap-3" : "px-6 py-6 flex items-center gap-3"
        )}
      >
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,_rgba(255,255,255,0.1),transparent)] group-hover:opacity-100 transition-opacity duration-700"></div>
        <div className="relative z-10 bg-white/10 backdrop-blur-md rounded-xl p-2 flex items-center justify-center ring-1 ring-white/20 shadow-inner">
          <Image src="/logo-pos.png" alt="OneFlowe" width={32} height={32} className="drop-shadow-sm" />
        </div>
        {!collapsed && (
          <div className="relative z-10 leading-tight min-w-0">
            <div className="text-lg font-bold tracking-tight text-white drop-shadow-sm">OneFlowe</div>
            <div className="text-[10px] font-bold uppercase tracking-[0.1em] text-blue-100/80 group-hover:text-white transition-colors duration-300 min-h-[12px]">
              {isLoading
                ? <div className="h-2 w-16 bg-white/20 rounded animate-pulse mt-1" />
                : describeRole(role)}
            </div>
          </div>
        )}
        <button
          type="button"
          onClick={() => changeCollapsed(!collapsed)}
          aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-expanded={!collapsed}
          title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
          className={cn(
            "relative z-10 rounded-lg p-1.5 text-white/80 bg-white/10 ring-1 ring-white/20 hover:bg-white/20 hover:text-white transition-colors",
            collapsed ? "" : "ml-auto"
          )}
        >
          {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
        </button>
      </div>

      <nav
        className={cn(
          "flex flex-col gap-1.5 overflow-y-auto overflow-x-hidden flex-1 min-h-0 bg-transparent custom-scrollbar",
          collapsed ? "p-2" : "p-4"
        )}
        aria-busy={isLoading}
        aria-live="polite"
      >
        {isLoading
          ? (
            <div className="space-y-4">
              {Array.from({ length: 6 }, (_, position) => `sidebar-loading-${position + 1}`).map((skeletonKey) => (
                <div
                  key={skeletonKey}
                  className={cn(
                    "bg-slate-200/50 dark:bg-slate-800/50 rounded-xl animate-pulse",
                    collapsed ? "h-11 w-11 mx-auto" : "h-10 w-full"
                  )}
                />
              ))}
            </div>
          )
          : nav.map((item) => (collapsed ? renderCollapsedItem(item) : renderExpandedItem(item)))}
      </nav>
    </aside>
  )
}
