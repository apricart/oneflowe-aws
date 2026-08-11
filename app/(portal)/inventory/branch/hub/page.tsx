"use client"

import { useState } from "react"
import dynamic from "next/dynamic"
import { Card, CardHeader, CardTitle } from "@/components/ui/card"
import { GitBranch, Eye, Package, ToggleLeft, Plus, Trash2, Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

// Dynamic imports — each child loads only when its tab is selected
const GroupProducts = dynamic(
    () => import("@/app/(portal)/inventory/branch/page"),
    { loading: () => <TabLoader />, ssr: false }
)
const OrgProducts = dynamic(
    () => import("@/app/(portal)/inventory/branch/org-products/page"),
    { loading: () => <TabLoader />, ssr: false }
)
const ActivateDeactivate = dynamic(
    () => import("@/app/(portal)/inventory/branch/status/page"),
    { loading: () => <TabLoader />, ssr: false }
)
const AssignToGroup = dynamic(
    () => import("@/app/(portal)/inventory/branch/assign/page"),
    { loading: () => <TabLoader />, ssr: false }
)
const RemoveFromGroup = dynamic(
    () => import("@/app/(portal)/inventory/branch/remove/page"),
    { loading: () => <TabLoader />, ssr: false }
)

function TabLoader() {
    return (
        <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
    )
}

const tabs = [
    {
        id: "group-products",
        title: "Group Products",
        icon: Eye,
        color: "border-violet-500 bg-violet-50 dark:bg-violet-950/40",
        activeText: "text-violet-700 dark:text-violet-300",
        iconColor: "text-violet-600 dark:text-violet-400",
        accent: "bg-violet-500",
    },
    {
        id: "org-products",
        title: "Organization Products",
        icon: Package,
        color: "border-blue-500 bg-blue-50 dark:bg-blue-950/40",
        activeText: "text-blue-700 dark:text-blue-300",
        iconColor: "text-blue-600 dark:text-blue-400",
        accent: "bg-blue-500",
    },
    {
        id: "status",
        title: "Activate / Deactivate",
        icon: ToggleLeft,
        color: "border-amber-500 bg-amber-50 dark:bg-amber-950/40",
        activeText: "text-amber-700 dark:text-amber-300",
        iconColor: "text-amber-600 dark:text-amber-400",
        accent: "bg-amber-500",
    },
    {
        id: "assign",
        title: "Assign to Group",
        icon: Plus,
        color: "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40",
        activeText: "text-emerald-700 dark:text-emerald-300",
        iconColor: "text-emerald-600 dark:text-emerald-400",
        accent: "bg-emerald-500",
    },
    {
        id: "remove",
        title: "Remove from Group",
        icon: Trash2,
        color: "border-rose-500 bg-rose-50 dark:bg-rose-950/40",
        activeText: "text-rose-700 dark:text-rose-300",
        iconColor: "text-rose-600 dark:text-rose-400",
        accent: "bg-rose-500",
    },
]

export default function BranchAssignmentsPage() {
    const [activeTab, setActiveTab] = useState("group-products")

    return (
        <div className="space-y-6 p-6">
            {/* Header */}
            <Card className="relative overflow-hidden border-none bg-gradient-to-r from-violet-900 via-purple-900 to-fuchsia-800 text-white shadow-xl">
                <div className="pointer-events-none absolute inset-0 opacity-30">
                    <div className="absolute -top-16 right-0 h-48 w-48 rounded-full bg-white/30 blur-3xl" />
                    <div className="absolute bottom-0 left-0 h-32 w-32 rounded-full bg-purple-400/40 blur-3xl" />
                </div>
                <CardHeader className="relative space-y-2 pb-4">
                    <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-white/70">
                        <GitBranch className="h-4 w-4" />
                        Group Management
                    </p>
                    <CardTitle className="text-2xl font-semibold text-white">Group Inventory</CardTitle>
                </CardHeader>
            </Card>

            {/* Tab Cards */}
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.id
                    return (
                        <button type="button"
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "group relative flex flex-col items-center gap-2 rounded-xl border-2 p-3 text-center transition-all duration-150",
                                isActive
                                    ? `${tab.color} border-opacity-100 shadow-sm`
                                    : "border-transparent bg-card hover:bg-muted/60 border-slate-200 dark:border-slate-800"
                            )}
                        >
                            <div className={cn(
                                "flex h-9 w-9 items-center justify-center rounded-lg transition-colors",
                                isActive ? tab.color : "bg-muted"
                            )}>
                                <tab.icon className={cn("h-4.5 w-4.5", isActive ? tab.iconColor : "text-muted-foreground")} />
                            </div>
                            <p className={cn(
                                "font-semibold text-xs leading-tight",
                                isActive ? tab.activeText : "text-foreground"
                            )}>
                                {tab.title}
                            </p>
                            {isActive && (
                                <div className={cn(
                                    "absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-10 rounded-full",
                                    tab.accent
                                )} />
                            )}
                        </button>
                    )
                })}
            </div>

            {/* Tab Content — renders BELOW cards, no page navigation */}
            <div className="-mx-6">
                {activeTab === "group-products" && <GroupProducts />}
                {activeTab === "org-products" && <OrgProducts />}
                {activeTab === "status" && <ActivateDeactivate />}
                {activeTab === "assign" && <AssignToGroup />}
                {activeTab === "remove" && <RemoveFromGroup />}
            </div>
        </div>
    )
}
