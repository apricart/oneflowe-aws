"use client"

import { useState,useEffect } from "react"
import dynamic from "next/dynamic"
import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { Card,CardHeader,CardTitle } from "@/components/ui/card"
import { Building2,Upload,Eye,Loader2 } from "lucide-react"
import { cn } from "@/lib/utils"

// Dynamic imports for child pages — loaded on demand for fast tab switching
const AssignProducts = dynamic(
    () => import("@/app/(portal)/inventory/assign/page"),
    { loading: () => <TabLoader />, ssr: false }
)
const ViewAssigned = dynamic(
    () => import("@/app/(portal)/inventory/assigned/page"),
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
        id: "assign",
        title: "Assign Products",
        description: "Assign from global catalog",
        icon: Upload,
        color: "border-blue-500 bg-blue-50 dark:bg-blue-950/40",
        activeText: "text-blue-700 dark:text-blue-300",
        iconColor: "text-blue-600 dark:text-blue-400",
    },
    {
        id: "view",
        title: "View Assigned",
        description: "Browse org inventory",
        icon: Eye,
        color: "border-emerald-500 bg-emerald-50 dark:bg-emerald-950/40",
        activeText: "text-emerald-700 dark:text-emerald-300",
        iconColor: "text-emerald-600 dark:text-emerald-400",
    },
]

export default function OrganizationInventoryPage() {
    const { data: session } = useSession()
    const router = useRouter()
    const role = (session?.user as any)?.role

    useEffect(() => {
        if (role === "BRANCH_ADMIN") {
            router.push("/dashboard")
        }
    }, [role, router])

    const [activeTab, setActiveTab] = useState("assign")

    return (
        <div className="space-y-6 p-6">
            {/* Header */}
            <Card className="relative overflow-hidden border-none bg-gradient-to-r from-blue-900 via-indigo-900 to-violet-800 text-white shadow-xl">
                <div className="pointer-events-none absolute inset-0 opacity-30">
                    <div className="absolute -top-16 right-0 h-48 w-48 rounded-full bg-white/30 blur-3xl" />
                    <div className="absolute bottom-0 left-0 h-32 w-32 rounded-full bg-indigo-400/40 blur-3xl" />
                </div>
                <CardHeader className="relative space-y-2 pb-4">
                    <p className="inline-flex items-center gap-2 text-xs uppercase tracking-[0.3em] text-white/70">
                        <Building2 className="h-4 w-4" />
                        Inventory
                    </p>
                    <CardTitle className="text-2xl font-semibold text-white">Organization Inventory</CardTitle>
                </CardHeader>
            </Card>

            {/* Tab Cards */}
            <div className="grid grid-cols-2 gap-4">
                {tabs.map((tab) => {
                    const isActive = activeTab === tab.id
                    return (
                        <button type="button"
                            key={tab.id}
                            onClick={() => setActiveTab(tab.id)}
                            className={cn(
                                "group relative flex items-center gap-3 rounded-xl border-2 p-4 text-left transition-all duration-150",
                                isActive
                                    ? `${tab.color} border-opacity-100 shadow-sm`
                                    : "border-transparent bg-card hover:bg-muted/60 border-slate-200 dark:border-slate-800"
                            )}
                        >
                            <div className={cn(
                                "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg transition-colors",
                                isActive ? tab.color : "bg-muted"
                            )}>
                                <tab.icon className={cn("h-5 w-5", isActive ? tab.iconColor : "text-muted-foreground")} />
                            </div>
                            <div>
                                <p className={cn(
                                    "font-semibold text-sm",
                                    isActive ? tab.activeText : "text-foreground"
                                )}>
                                    {tab.title}
                                </p>
                                <p className="text-xs text-muted-foreground">{tab.description}</p>
                            </div>
                            {isActive && (
                                <div className={cn(
                                    "absolute bottom-0 left-1/2 -translate-x-1/2 h-0.5 w-12 rounded-full",
                                    tab.id === "assign" ? "bg-blue-500" : "bg-emerald-500"
                                )} />
                            )}
                        </button>
                    )
                })}
            </div>

            {/* Tab Content */}
            <div className="-mx-6">
                {activeTab === "assign" && <AssignProducts />}
                {activeTab === "view" && <ViewAssigned />}
            </div>
        </div>
    )
}
