"use client"

import { useMemo, useState } from "react"
import useSWR from "swr"
import {
    BarChart,
    Bar,
    XAxis,
    YAxis,
    CartesianGrid,
    Tooltip,
    ResponsiveContainer,
    Cell,
    LabelList
} from "recharts"
import {
    Building2,
    Package,
    ShoppingBag,
    TrendingUp,
    BarChart3,
    ArrowUpRight,
    Search,
    Layers
} from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppContext } from "@/components/context/app-context"
import { Skeleton } from "@/components/ui/skeleton"
import { Input } from "@/components/ui/input"

const fetcher = (url: string) => fetch(url).then((res) => res.json())

interface GroupStat {
    id: number | string
    name: string
    organizationId: number
    totalOrders: number
    totalAmountCents: number
    branchCount: number
    branches: { id: number, name: string }[]
    type: 'group' | 'branch'
    organizationName?: string
}

interface UngroupedBranch {
    id: number
    name: string
    organizationId: number
    totalOrders: number
    totalAmountCents: number
    organizationName?: string
}

const GROUP_CHART_COLORS = ["#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe", "#dbeafe"]

function formatGroupCurrency(cents: number) {
    return new Intl.NumberFormat("en-PK", {
        style: "currency",
        currency: "PKR",
        maximumFractionDigits: 0,
    }).format(cents / 100)
}

function GroupChartTooltip({ active, payload, activeTab }: any) {
    if (!active || !payload?.length) {
        return null
    }

    const data = payload[0].payload
    return (
        <div className="bg-white/90 dark:bg-slate-900/90 backdrop-blur-xl p-6 border border-slate-100 dark:border-slate-800 rounded-3xl shadow-[0_20px_50px_rgba(0,0,0,0.1)] border-b-4 border-b-blue-500">
            <p className="font-black text-slate-900 dark:text-white text-lg mb-1">{data.fullName}</p>
            <div className="flex items-center gap-2 text-blue-600 dark:text-blue-400 font-black text-2xl">
                {activeTab === "purchases" ? formatGroupCurrency(data.value * 100) : `${data.value.toLocaleString()} Orders`}
            </div>
        </div>
    )
}

function GroupChartLabel({ x, y, width, value, activeTab }: any) {
    const formattedValue = activeTab === "purchases"
        ? `₨${(value / 1000).toFixed(1)}k`
        : value

    return (
        <g>
            <rect
                x={x + width / 2 - 35}
                y={y - 35}
                width={70}
                height={28}
                fill="white"
                rx={8}
                className="drop-shadow-lg"
                opacity={0.95}
            />
            <text
                x={x + width / 2}
                y={y - 16}
                textAnchor="middle"
                className="fill-slate-900 font-black text-sm"
            >
                {formattedValue}
            </text>
        </g>
    )
}

export function GroupAnalytics({ role }: Readonly<{ role: string }>) {
    const { organizationId: globalOrgId } = useAppContext()
    const [activeTab, setActiveTab] = useState<"purchases" | "orders">("purchases")
    const [searchQuery, setSearchQuery] = useState("")

    const url = globalOrgId
        ? `/api/v1/analytics/groups?organizationId=${globalOrgId}`
        : "/api/v1/analytics/groups"

    const { data, error, isLoading } = useSWR(url, fetcher)

    const label = role === "SUPER_ADMIN" ? "Sales" : "Purchases"

    // Separate groups and ungrouped branches
    const { groupsData, ungroupedBranchesData } = useMemo(() => {
        if (!data) return { groupsData: [], ungroupedBranchesData: [] }

        const groups: GroupStat[] = (data.groups || []).map((g: any) => ({ ...g, type: 'group' }))
        const ungrouped: UngroupedBranch[] = data.ungroupedBranches || []

        // Filter groups by search
        const filteredGroups = groups.filter(item =>
            item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            (item.branches || []).some(b => b.name.toLowerCase().includes(searchQuery.toLowerCase()))
        )

        // Filter ungrouped by search
        const filteredUngrouped = ungrouped.filter(item =>
            item.name.toLowerCase().includes(searchQuery.toLowerCase())
        )

        // Sort groups by value
        const sortedGroups = filteredGroups.toSorted((a, b) => {
            if (activeTab === "purchases") return b.totalAmountCents - a.totalAmountCents
            return b.totalOrders - a.totalOrders
        })

        // Sort ungrouped by value
        const sortedUngrouped = filteredUngrouped.toSorted((a, b) => {
            if (activeTab === "purchases") return b.totalAmountCents - a.totalAmountCents
            return b.totalOrders - a.totalOrders
        })

        return { groupsData: sortedGroups, ungroupedBranchesData: sortedUngrouped }
    }, [data, searchQuery, activeTab])

    // Top 5 groups only (no ungrouped branches, and only groups with branches)
    const topGroups = useMemo(() => {
        // Filter out groups with no branches
        const groupsWithBranches = groupsData.filter(g => g.branchCount > 0)
        return groupsWithBranches.slice(0, 5)
    }, [groupsData])

    if (error) {
        console.error("Group Analytics Fetch Error:", error)
        return (
            <div className="flex items-center justify-center min-h-[400px]">
                <div className="text-center">
                    <div className="text-red-500 text-lg font-semibold mb-2">Failed to load analytics</div>
                    <p className="text-slate-500 text-sm">Please try refreshing the page or contact support if the issue persists.</p>
                </div>
            </div>
        )
    }

    if (isLoading) {
        return (
            <div className="space-y-6">
                <Skeleton className="h-32 w-full rounded-xl" />
                <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
                    <Skeleton className="h-[500px] lg:col-span-2 rounded-xl" />
                    <Skeleton className="h-[500px] rounded-xl" />
                </div>
            </div>
        )
    }

    const chartData = topGroups.map((g) => ({
        name: g.name,
        value: activeTab === "purchases" ? g.totalAmountCents / 100 : g.totalOrders,
        fullName: g.name,
        type: g.type
    }))

    if (groupsData.length === 0 && ungroupedBranchesData.length === 0 && !searchQuery) {
        return (
            <div className="flex flex-col items-center justify-center py-20 px-4 text-center space-y-4 bg-slate-50 dark:bg-slate-900/20 rounded-[3rem] border border-dashed border-slate-200 dark:border-slate-800">
                <div className="p-6 bg-blue-500/10 rounded-full text-blue-500">
                    <BarChart3 className="h-12 w-12" />
                </div>
                <div>
                    <h3 className="text-xl font-bold text-slate-900 dark:text-white">No Analytics Data Available</h3>
                    <p className="text-slate-500 max-w-md mx-auto mt-2">
                        We couldn't find any transaction data for your organization yet. Analytics will appear here once orders are processed.
                    </p>
                </div>
            </div>
        )
    }

    return (
        <div className="space-y-10 pb-10">
            <style jsx>{`
                @keyframes fadeInUp {
                    from {
                        opacity: 0;
                        transform: translateY(20px);
                    }
                    to {
                        opacity: 1;
                        transform: translateY(0);
                    }
                }
                .animate-fade-in-up {
                    animation-name: fadeInUp;
                    opacity: 0;
                }
            `}</style>

            {/* --- Premium Header Section --- */}
            <div className="relative group overflow-hidden rounded-[2.5rem] bg-slate-950 p-1">
                {/* Animated Background Orbs */}
                <div className="absolute -top-24 -left-24 w-96 h-96 bg-blue-600/20 blur-[100px] rounded-full group-hover:bg-blue-600/30 transition-colors duration-1000 animate-pulse" />
                <div className="absolute -bottom-24 -right-24 w-96 h-96 bg-indigo-600/20 blur-[100px] rounded-full group-hover:bg-indigo-600/30 transition-colors duration-1000 animate-pulse delay-700" />

                <div className="relative z-10 bg-white/5 backdrop-blur-2xl px-10 py-12 rounded-[2.4rem] border border-white/10 flex flex-col md:flex-row md:items-center justify-between gap-8">
                    <div>
                        <div className="flex items-center gap-4 mb-4">
                            <div className="p-3 bg-blue-500/10 rounded-2xl border border-blue-500/20 shadow-inner">
                                <BarChart3 className="h-9 w-9 text-blue-400" />
                            </div>
                            <div>
                                <h1 className="text-4xl font-black text-white tracking-tight">{role === "SUPER_ADMIN" ? "Sales" : "Performance"} <span className="text-blue-400">Hub</span></h1>
                                <p className="text-slate-400 font-medium">Group-level analytics and strategic insights</p>
                            </div>
                        </div>
                    </div>

                    <div className="flex items-center gap-2 p-1.5 bg-slate-900/50 rounded-2xl border border-white/5 shadow-2xl overflow-hidden self-start md:self-center">
                        <button type="button"
                            onClick={() => setActiveTab("purchases")}
                            className={`px-8 py-3 rounded-xl text-sm font-bold tracking-wide transition-all duration-300 ${activeTab === "purchases"
                                ? "bg-white text-slate-950 shadow-[0_0_20px_rgba(255,255,255,0.3)]"
                                : "text-slate-400 hover:text-white"
                                }`}
                        >
                            {label.toUpperCase()}
                        </button>
                        <button type="button"
                            onClick={() => setActiveTab("orders")}
                            className={`px-8 py-3 rounded-xl text-sm font-bold tracking-wide transition-all duration-300 ${activeTab === "orders"
                                ? "bg-white text-slate-950 shadow-[0_0_20px_rgba(255,255,255,0.3)]"
                                : "text-slate-400 hover:text-white"
                                }`}
                        >
                            ORDERS
                        </button>
                    </div>
                </div>
            </div>

            {/* --- Charts & List Section --- */}
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10">

                {/* Main Visualizer (Bar Chart) */}
                <div className="lg:col-span-8 flex flex-col gap-6">
                    <Card className="border-none shadow-2xl shadow-slate-200 dark:shadow-none bg-white dark:bg-slate-900/50 rounded-[2.5rem] overflow-hidden">
                        <CardHeader className="p-10 pb-0 flex flex-row items-center justify-between space-y-0">
                            <div>
                                <CardTitle className="text-2xl font-bold flex items-center gap-3">
                                    <div className="h-10 w-2 rounded-full bg-blue-500" />
                                    Top 5 Groups
                                </CardTitle>
                                <CardDescription className="mt-2 text-base font-medium">Highest performing groups by {activeTab === "purchases" ? label.toLowerCase() : "orders"}</CardDescription>
                            </div>
                            <div className="p-4 bg-emerald-500/10 dark:bg-emerald-500/20 rounded-2xl">
                                <TrendingUp className="text-emerald-500 h-6 w-6 animate-bounce" />
                            </div>
                        </CardHeader>
                        <CardContent className="p-10 pt-4">
                            <div className="h-[440px] w-full">
                                <ResponsiveContainer width="100%" height="100%">
                                    <BarChart data={chartData} margin={{ top: 60, right: 20, left: 10, bottom: 20 }}>
                                        <CartesianGrid
                                            strokeDasharray="4 4"
                                            vertical={false}
                                            className="stroke-slate-200 dark:stroke-slate-800"
                                            strokeOpacity={0.5}
                                        />
                                        <XAxis
                                            dataKey="name"
                                            axisLine={false}
                                            tickLine={false}
                                            tick={{ fill: "#94a3b8", fontSize: 13, fontWeight: 600 }}
                                            dy={15}
                                        />
                                        <YAxis
                                            axisLine={false}
                                            tickLine={false}
                                            tick={{ fill: "#94a3b8", fontSize: 11, fontWeight: 600 }}
                                            tickFormatter={(value) => (() => {
                                              if (activeTab === "purchases") {
                                                return `₨${value >= 1000 ? (value / 1000).toFixed(0) + "k" : value}`
                                              }
                                              return value
                                            })()}
                                        />
                                        <Tooltip
                                            cursor={{ fill: "rgba(59, 130, 246, 0.08)", radius: 12 }}
                                            content={<GroupChartTooltip activeTab={activeTab} />}
                                        />
                                        <Bar dataKey="value" radius={[18, 18, 0, 0]} barSize={64} animationDuration={1500}>
                                            {chartData.map((entry, index) => (
                                                <Cell key={entry.fullName} fill={GROUP_CHART_COLORS[index % GROUP_CHART_COLORS.length]} className="hover:opacity-80 transition-opacity duration-300" />
                                            ))}
                                            <LabelList
                                                dataKey="value"
                                                position="top"
                                                content={<GroupChartLabel activeTab={activeTab} />}
                                            />
                                        </Bar>
                                    </BarChart>
                                </ResponsiveContainer>
                            </div>
                        </CardContent>
                    </Card>
                </div>

                {/* --- Sidebar (Groups List) --- */}
                <div className="lg:col-span-4 flex flex-col gap-8">
                    <div className="flex flex-col gap-6 h-full">
                        {/* Search & Filter Header */}
                        <div className="space-y-4">
                            <div className="relative group">
                                <div className="absolute inset-y-0 left-5 flex items-center pointer-events-none">
                                    <Search className="h-5 w-5 text-slate-400 group-focus-within:text-blue-500 transition-colors" />
                                </div>
                                <Input
                                    className="pl-14 h-16 bg-white dark:bg-slate-900 border-none shadow-xl shadow-slate-100 dark:shadow-none rounded-2xl text-base font-medium placeholder:text-slate-400 focus-visible:ring-2 focus-visible:ring-blue-500"
                                    placeholder="Search groups..."
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                />
                            </div>
                        </div>

                        {/* List Detail */}
                        <Card className="flex-1 border-none shadow-2xl shadow-slate-200 dark:shadow-none bg-white dark:bg-slate-950/20 rounded-[2.5rem] overflow-hidden flex flex-col">
                            <CardHeader className="p-10 pb-6 border-b border-slate-100 dark:border-slate-800/50">
                                <div className="flex items-center justify-between">
                                    <CardTitle className="text-xl font-bold">Groups Overview</CardTitle>
                                    <Badge className="bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 border-none rounded-lg px-3 py-1 font-bold">
                                        {groupsData.length} GROUPS
                                    </Badge>
                                </div>
                            </CardHeader>
                            <CardContent className="p-4 flex-1 overflow-hidden pt-6">
                                <ScrollArea className="h-[520px] pr-4">
                                    <div className="space-y-4">
                                        {groupsData.map((item) => (
                                            <div
                                                key={item.id}
                                                className="group/item p-6 rounded-3xl border transition-all duration-300 bg-slate-50/50 dark:bg-slate-900/30 border-slate-100 dark:border-slate-800 hover:border-blue-400/50 dark:hover:border-blue-500/30 hover:shadow-[0_15px_40px_rgba(0,0,0,0.05)]"
                                            >
                                                <div className="flex justify-between items-start gap-4">
                                                    <div className="space-y-1 overflow-hidden">
                                                        <div className="flex items-center gap-2">
                                                            <Layers className="h-4 w-4 text-blue-500" />
                                                            <span className="font-black text-slate-900 dark:text-white truncate text-lg group-hover/item:text-blue-500 dark:group-hover/item:text-blue-400 transition-colors">
                                                                {item.name}
                                                            </span>
                                                            {role === "SUPER_ADMIN" && item.organizationName && (
                                                                <Badge variant="outline" className="text-[10px] uppercase tracking-tighter bg-blue-50/50 dark:bg-blue-900/10 border-blue-100 dark:border-blue-900/30 text-blue-700 dark:text-blue-400 h-5">
                                                                    {item.organizationName}
                                                                </Badge>
                                                            )}
                                                        </div>
                                                        <div className="flex items-center gap-4 text-xs font-bold text-slate-500 tracking-tight">
                                                            <div className="flex items-center gap-1.5 capitalize">
                                                                <Package className="h-3.5 w-3.5 opacity-60" />
                                                                {item.totalOrders} orders
                                                            </div>
                                                            <div className="flex items-center gap-1.5 text-blue-600 dark:text-blue-400 font-black">
                                                                <ShoppingBag className="h-3.5 w-3.5 opacity-60" />
                                                                {formatGroupCurrency(item.totalAmountCents)}
                                                            </div>
                                                        </div>
                                                    </div>
                                                    <div className="shrink-0">
                                                        <div className="w-10 h-10 rounded-xl bg-white dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-800 flex items-center justify-center group-hover/item:bg-blue-500 transition-colors duration-300">
                                                            <ArrowUpRight className="h-5 w-5 text-slate-400 group-hover/item:text-white transition-colors" />
                                                        </div>
                                                    </div>
                                                </div>

                                                {/* Visual indicator of branch density */}
                                                <div className="mt-5 space-y-3">
                                                    <div className="flex items-center justify-between text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">
                                                        <span>Branch Network</span>
                                                        <span className="text-slate-600 dark:text-slate-300">{item.branchCount} nodes</span>
                                                    </div>
                                                    <div className="flex flex-wrap gap-1.5">
                                                        {(item.branches || []).slice(0, 3).map((b) => (
                                                            <span key={b.id ?? b.name} className="text-[10px] px-2.5 py-1 rounded-lg bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-800 font-bold text-slate-600 dark:text-slate-400">
                                                                {b.name}
                                                            </span>
                                                        ))}
                                                        {(item.branches || []).length > 3 && (
                                                            <span className="text-[10px] px-2.5 py-1 rounded-lg bg-blue-50 dark:bg-blue-900/30 font-black text-blue-600 dark:text-blue-400">
                                                                +{(item.branches || []).length - 3} MORE
                                                            </span>
                                                        )}
                                                    </div>
                                                </div>
                                            </div>
                                        ))}

                                        {groupsData.length === 0 && (
                                            <div className="py-20 text-center space-y-4">
                                                <div className="inline-flex p-5 bg-slate-50 dark:bg-slate-900 rounded-full">
                                                    <Search className="h-10 w-10 text-slate-300" />
                                                </div>
                                                <p className="text-slate-400 font-bold tracking-tight">No groups found.</p>
                                            </div>
                                        )}
                                    </div>
                                </ScrollArea>
                            </CardContent>
                        </Card>
                    </div>
                </div>
            </div>

            {/* Ungrouped Branches Section - Mesmerizing Animated Design */}
            {ungroupedBranchesData.length > 0 && (
                <div className="mt-10 animate-in fade-in slide-in-from-bottom-4 duration-700">
                    <Card className="border-none shadow-2xl shadow-slate-200 dark:shadow-none bg-white dark:bg-slate-900/50 rounded-[2.5rem] overflow-hidden">
                        <CardHeader className="p-10 pb-6 border-b border-slate-100 dark:border-slate-800">
                            <div className="flex items-center justify-between">
                                <div className="flex items-center gap-4">
                                    <div className="relative">
                                        <div className="absolute inset-0 bg-indigo-500/20 blur-xl rounded-full animate-pulse"></div>
                                        <div className="relative p-3 bg-indigo-500/10 dark:bg-indigo-500/20 rounded-2xl border border-indigo-500/20">
                                            <Building2 className="h-7 w-7 text-indigo-600 dark:text-indigo-400" />
                                        </div>
                                    </div>
                                    <div>
                                        <CardTitle className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-2">
                                            <span>Independent Branches</span>
                                            <span className="inline-flex h-2 w-2 rounded-full bg-indigo-500 animate-pulse"></span>
                                        </CardTitle>
                                        <p className="text-sm text-slate-600 dark:text-slate-400 mt-1">Branches operating independently without group assignment</p>
                                    </div>
                                </div>
                                <Badge className="bg-indigo-100 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 border-none rounded-xl px-4 py-2 font-black text-lg shadow-lg shadow-indigo-100 dark:shadow-none">
                                    {ungroupedBranchesData.length}
                                </Badge>
                            </div>
                        </CardHeader>
                        <CardContent className="p-10">
                            <div className="flex flex-col gap-4">
                                {ungroupedBranchesData.map((branch, index) => (
                                    <div
                                        key={branch.id}
                                        className="group relative flex flex-col md:flex-row md:items-center justify-between p-6 rounded-[2rem] bg-slate-50/50 dark:bg-slate-900/30 border border-slate-100 dark:border-slate-800 hover:border-indigo-400 dark:hover:border-indigo-600 hover:bg-white dark:hover:bg-slate-900 transition-all duration-500 hover:shadow-[0_20px_50px_rgba(0,0,0,0.05)] animate-fade-in-up overflow-hidden"
                                        style={{
                                            animationDelay: `${index * 80}ms`,
                                            animationDuration: '0.6s',
                                            animationTimingFunction: 'ease-out',
                                            animationFillMode: 'forwards'
                                        }}
                                    >
                                        {/* Background accent */}
                                        <div className="absolute top-0 left-0 w-1.5 h-full bg-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity duration-300"></div>

                                        <div className="flex items-center gap-6 flex-1">
                                            <div className="relative shrink-0">
                                                <div className="w-14 h-14 rounded-2xl bg-white dark:bg-slate-800 shadow-sm border border-slate-100 dark:border-slate-800 flex items-center justify-center text-slate-400 group-hover:bg-indigo-500 group-hover:text-white group-hover:scale-110 group-hover:rotate-6 transition-all duration-300">
                                                    <Building2 className="h-7 w-7" />
                                                </div>
                                                <div className="absolute -bottom-1 -right-1 w-4 h-4 rounded-full bg-emerald-500 border-2 border-white dark:border-slate-900 group-hover:animate-ping"></div>
                                            </div>

                                            <div className="space-y-1">
                                                <div className="flex items-center gap-3">
                                                    <h3 className="font-black text-xl text-slate-900 dark:text-white group-hover:text-indigo-600 dark:group-hover:text-indigo-400 transition-colors duration-300">
                                                        {branch.name}
                                                    </h3>
                                                    {role === "SUPER_ADMIN" && branch.organizationName && (
                                                        <Badge variant="secondary" className="text-[10px] bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-400 border-none px-2 h-5 font-bold uppercase tracking-wider">
                                                            {branch.organizationName}
                                                        </Badge>
                                                    )}
                                                </div>
                                                <p className="text-xs font-bold text-slate-400 uppercase tracking-[0.2em]">Operational Independent Node</p>
                                            </div>
                                        </div>

                                        <div className="flex flex-wrap items-center gap-8 mt-6 md:mt-0">
                                            <div className="flex flex-col items-center md:items-end">
                                                <div className="flex items-center gap-2 text-slate-400 mb-1">
                                                    <Package className="h-3.5 w-3.5" />
                                                    <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Orders</span>
                                                </div>
                                                <span className="text-2xl font-black text-slate-900 dark:text-white">{branch.totalOrders}</span>
                                            </div>

                                            <div className="w-px h-10 bg-slate-100 dark:bg-slate-800 hidden sm:block"></div>

                                            <div className="flex flex-col items-center md:items-end min-w-[140px]">
                                                <div className="flex items-center gap-2 text-indigo-500 mb-1">
                                                    <ShoppingBag className="h-3.5 w-3.5" />
                                                    <span className="text-[10px] font-black uppercase tracking-widest text-indigo-500/70">{label}</span>
                                                </div>
                                                <span className="text-2xl font-black text-indigo-600 dark:text-indigo-400">{formatGroupCurrency(branch.totalAmountCents)}</span>
                                            </div>

                                            <div className="shrink-0 ml-4 hidden lg:block">
                                                <div className="w-12 h-12 rounded-full border-2 border-slate-100 dark:border-slate-800 flex items-center justify-center group-hover:border-indigo-500 transition-colors duration-300">
                                                    <ArrowUpRight className="h-6 w-6 text-slate-300 group-hover:text-indigo-500 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                ))}
                            </div>
                        </CardContent>
                    </Card>
                </div>
            )}
        </div>
    )
}
