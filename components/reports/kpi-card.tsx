"use client"

import { Card, CardContent } from "@/components/ui/card"
import { TrendingUp, TrendingDown, Minus } from "lucide-react"
import { cn } from "@/lib/utils"
import { LineChart, Line, ResponsiveContainer } from "recharts"
interface KPICardProps {
    title: string
    value: string | number
    trend?: number // percentage change vs previous period
    trendData?: number[] // array of values for sparkline
    icon: React.ElementType
    colorScheme?: "indigo" | "emerald" | "rose" | "amber" | "blue" | "violet"
    comparisonValue?: string | number
    comparisonLabel?: string
    subtitle?: string
    // Show a skeleton instead of the value — pass while the source data is
    // still undefined so a fabricated 0 is never displayed
    isLoading?: boolean
}

const colorMap = {
    indigo: {
        gradient: "bg-gradient-to-br from-indigo-50/80 to-blue-50/80 border-indigo-100/50 text-indigo-700 dark:from-indigo-900/20 dark:to-blue-900/20 dark:border-indigo-800/30 dark:text-indigo-400",
        iconBadge: "bg-white/80 text-indigo-600 shadow-sm border border-indigo-100 dark:bg-slate-800 dark:border-indigo-800",
        sparkline: "#6366f1",
    },
    emerald: {
        gradient: "bg-gradient-to-br from-teal-50/80 to-emerald-50/80 border-teal-100/50 text-teal-700 dark:from-teal-900/20 dark:to-emerald-900/20 dark:border-teal-800/30 dark:text-teal-400",
        iconBadge: "bg-white/80 text-teal-600 shadow-sm border border-teal-100 dark:bg-slate-800 dark:border-teal-800",
        sparkline: "#10b981",
    },
    rose: {
        gradient: "bg-gradient-to-br from-rose-50/80 to-red-50/80 border-rose-100/50 text-rose-700 dark:from-rose-900/20 dark:to-red-900/20 dark:border-rose-800/30 dark:text-rose-400",
        iconBadge: "bg-white/80 text-rose-600 shadow-sm border border-rose-100 dark:bg-slate-800 dark:border-rose-800",
        sparkline: "#f43f5e",
    },
    amber: {
        gradient: "bg-gradient-to-br from-amber-50/80 to-orange-50/80 border-amber-100/50 text-amber-700 dark:from-amber-900/20 dark:to-orange-900/20 dark:border-amber-800/30 dark:text-amber-400",
        iconBadge: "bg-white/80 text-amber-600 shadow-sm border border-amber-100 dark:bg-slate-800 dark:border-amber-800",
        sparkline: "#f59e0b",
    },
    blue: {
        gradient: "bg-gradient-to-br from-blue-50/80 to-cyan-50/80 border-blue-100/50 text-blue-700 dark:from-blue-900/20 dark:to-cyan-900/20 dark:border-blue-800/30 dark:text-blue-400",
        iconBadge: "bg-white/80 text-blue-600 shadow-sm border border-blue-100 dark:bg-slate-800 dark:border-blue-800",
        sparkline: "#3b82f6",
    },
    violet: {
        gradient: "bg-gradient-to-br from-fuchsia-50/80 to-purple-50/80 border-fuchsia-100/50 text-fuchsia-700 dark:from-fuchsia-900/20 dark:to-purple-900/20 dark:border-fuchsia-800/30 dark:text-fuchsia-400",
        iconBadge: "bg-white/80 text-fuchsia-600 shadow-sm border border-fuchsia-100 dark:bg-slate-800 dark:border-fuchsia-800",
        sparkline: "#8b5cf6",
    },
}

export function KPICard({
    title,
    value,
    trend,
    trendData,
    icon: Icon,
    colorScheme = "indigo",
    comparisonValue,
    comparisonLabel,
    subtitle,
    isLoading = false,
}: Readonly<KPICardProps>) {
    const colors = colorMap[colorScheme]
    const chartData = trendData?.map((v, i) => ({ value: v, index: i })) || []

    const TrendIcon = (() => {
      if (trend !== undefined) {
        if (trend > 0) {
          return TrendingUp
        }
        if (trend < 0) {
          return TrendingDown
        }
        return Minus
      }
      return null
    })()

    return (
        <Card className={cn(
            "border rounded-2xl shadow-sm transition-all duration-300 hover:shadow-md hover:-translate-y-0.5",
            colors.gradient
        )}>
            <CardContent className="p-3 flex items-start justify-between relative overflow-hidden h-full">
                <div className="space-y-1 flex-1 max-w-[calc(100%-4rem)] pr-1 z-10 flex flex-col justify-between h-full">
                    <div className="min-w-0">
                        <p className="text-[10px] font-bold opacity-80 uppercase tracking-[0.15em] mb-1">
                            {title}
                        </p>
                        {isLoading ? (
                            <div className="h-7 w-20 rounded-md bg-slate-300/40 dark:bg-slate-600/40 animate-pulse" />
                        ) : (
                            <h3 className="text-xl xl:text-xl font-black tracking-tight text-slate-900 dark:text-white  min-w-0 sm:break-normal" >
                                {value}
                            </h3>
                        )}
                    </div>

                    {/* Additional Sub info */}
                    {(trend !== undefined || comparisonValue || subtitle) && (
                        <div className="pt-4 space-y-1.5 mt-auto">
                            {trend !== undefined && Math.abs(trend).toFixed(1) !== "0.0" && (
                                <div className="flex items-center gap-1.5 mt-1.5">
                                    <div className={cn(
                                        "flex items-center gap-0.5 px-2 py-0.5 rounded-md text-[10px] font-black shadow-sm tracking-tight",
                                        (() => {
                                          if (trend > 0) {
                                            return "bg-emerald-500/10 text-emerald-600 dark:bg-emerald-500/20 dark:text-emerald-400"
                                          }
                                          if (trend < 0) {
                                            return "bg-rose-500/10 text-rose-600 dark:bg-rose-500/20 dark:text-rose-400"
                                          }
                                          return "bg-slate-500/10 text-slate-600 dark:bg-slate-500/20 dark:text-slate-400"
                                        })()
                                    )}>
                                        {TrendIcon && <TrendIcon className="h-2 w-2" />}
                                        {Math.abs(trend).toFixed(1)}%
                                    </div>
                                    <span className="text-[9px] text-slate-500 uppercase font-bold tracking-widest">{subtitle ? '' : 'vs prior'}</span>
                                </div>
                            )}

                            {comparisonValue && (
                                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                                    {comparisonLabel}: <span className="font-black text-slate-700 dark:text-slate-300">{comparisonValue}</span>
                                </p>
                            )}
                            {subtitle && (
                                <p className="text-[9px] font-bold text-slate-400 uppercase tracking-widest">
                                    {subtitle}
                                </p>
                            )}
                        </div>
                    )}
                </div>

                <div className={cn("flex shrink-0 h-11 w-11 items-center justify-center rounded-2xl z-10", colors.iconBadge)}>
                    <Icon className="h-6 w-6 stroke-[2.5]" />
                </div>

                {/* Sparkline background */}
                {chartData.length > 1 && (
                    <div className="absolute right-0 bottom-0 w-32 h-16 opacity-30 pointer-events-none">
                        <ResponsiveContainer width="100%" height="100%">
                            <LineChart data={chartData}>
                                <Line
                                    type="monotone"
                                    dataKey="value"
                                    stroke={colors.sparkline}
                                    strokeWidth={3}
                                    dot={false}
                                    isAnimationActive={true}
                                />
                            </LineChart>
                        </ResponsiveContainer>
                    </div>
                )}
            </CardContent>
        </Card>
    )
}
