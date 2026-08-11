"use client"

import { useMemo,useEffect,useState } from "react"
import { useTheme } from "next-themes"
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  BarChart,
  Bar,
  LabelList,
  Cell,Line,ReferenceLine
} from "recharts"
import {
  TrendingUp,BarChart3,DollarSign,Activity,
  Award,Info
} from "lucide-react"
import { motion } from "framer-motion"
import { cn } from "@/lib/utils"
import type { SalesSeriesPoint,BranchSalesPoint,DateRange } from "@/lib/hooks/use-sales-performance"
import {
  format,
  eachDayOfInterval,
  eachHourOfInterval,
  eachMonthOfInterval,
  isSameDay,startOfDay,
  endOfDay,
  startOfMonth,
  endOfMonth,
  eachYearOfInterval,
  startOfYear,
  endOfYear,
  subDays,
  addDays
} from "date-fns"
import { useAppContext } from "@/components/context/app-context"

type Props = {
  data: {
    month: string
    value: number
  }[]
}

const barColors = [
  "oklch(0.6 0.25 260)", // Vibrant Blue
  "oklch(0.65 0.2 180)",  // Teal
  "oklch(0.7 0.2 80)",   // Gold/Amber
  "oklch(0.6 0.22 300)",  // Purple
  "oklch(0.65 0.22 20)",  // Rose
  "oklch(0.5 0.2 260)",   // Deep Blue
]

const barColorsDark = [
  "oklch(0.75 0.22 260)", // Fluorescent Blue
  "oklch(0.75 0.2 180)",  // Fluorescent Teal
  "oklch(0.85 0.18 80)",  // Fluorescent Gold
  "oklch(0.75 0.2 300)",  // Fluorescent Purple
  "oklch(0.75 0.2 20)",   // Fluorescent Rose
  "oklch(0.7 0.22 260)",  // Lighter Blue
]

const CustomTooltip = ({ active, payload, labelText = "Purchase" }: any) => {
  if (!active || !payload?.length) return null

  return (
    <div className="glass-card rounded-[1.25rem] shadow-2xl overflow-hidden min-w-[200px]">
      <div className="bg-slate-50/50 dark:bg-slate-800/50 px-4 py-2.5 border-b border-slate-200/50 dark:border-slate-700/50">
        <p className="font-bold text-slate-800 dark:text-slate-200 text-xs tracking-wider uppercase">{payload[0].payload.month || payload[0].payload.label}</p>
      </div>
      <div className="px-5 py-4">
        <p className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest mb-1.5">{labelText}</p>
        <p className="text-xl font-bold text-slate-900 dark:text-white">
          ₨{payload[0].value.toLocaleString()}
        </p>
      </div>
    </div>
  )
}

type TrendPoint = { label: string; value: number }
type ChartDatum = { label: string; value: number }

const currencyFormatter = new Intl.NumberFormat("en-PK", {
  style: "currency",
  currency: "PKR",
  maximumFractionDigits: 0,
})

// ----------------- Dynamic Font Size Helper -----------------
export const getValueFontSize = (val: string | number) => {
  const str = String(val);
  if (str.length >= 13) return 'text-xs sm:text-xs md:text-sm lg:text-base tracking-tight';
  if (str.length >= 10) return 'text-sm sm:text-sm md:text-base lg:text-lg tracking-tight';
  if (str.length >= 7) return 'text-base sm:text-base md:text-lg lg:text-xl tracking-tight';
  return 'text-lg sm:text-lg md:text-xl lg:text-2xl';
}

// ----------------- Yearly Sales Spline Chart -----------------
export type SalesData = { month: string; sales: number }
export type YearlySalesSplineChartProps = {
  yearlySalesData: SalesData[]
  avgSales: number
  label?: string
}

function yearlyChartTheme(isDark: boolean) {
  return {
    grid: isDark ? "#475569" : "#e2e8f0",
    tick: isDark ? "#94a3b8" : "#64748b",
    axis: isDark ? "#475569" : "#cbd5e1",
    tooltipBackground: isDark ? "#1e293b" : "white",
    tooltipBorder: isDark ? "1px solid #475569" : "1px solid #e2e8f0",
    tooltipLabel: isDark ? "#cbd5e1" : "#334155",
    average: isDark ? "#fbbf24" : "#f59e0b",
    series: isDark ? "#60a5fa" : "#2563eb",
    seriesFill: isDark ? "url(#salesGradientDark)" : "url(#salesGradient)",
    dotFill: isDark ? "#1e293b" : "#ffffff",
  }
}

export function YearlySalesSplineChart({ yearlySalesData, avgSales, label = "Purchase" }: Readonly<YearlySalesSplineChartProps>) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const colors = yearlyChartTheme(isDark)

  // Add null safety checks
  if (!yearlySalesData || yearlySalesData.length === 0) {
    return (
      <div className="animate-fade-in p-6 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
        <p className="text-slate-500 dark:text-slate-400 text-center">No sales data available</p>
      </div>
    )
  }

  const totalSales = yearlySalesData.reduce((sum, item) => sum + item.sales, 0)
  const peakMonth = yearlySalesData.reduce((max, item) => item.sales > max.sales ? item : max, yearlySalesData[0])

  return (
    <div className="animate-fade-in space-y-6">
      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateY(10px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @keyframes fadeIn {
          from { opacity: 0; }
          to { opacity: 1; }
        }
        .animate-slide-in {
          animation: slideIn 0.4s ease-out;
        }
        .animate-fade-in {
          animation: fadeIn 0.5s ease-out;
        }
      `}</style>

      <div className="px-1">
        {/* Key Metrics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6 animate-slide-in">
          <div className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="bg-blue-600 dark:bg-blue-500 p-1.5 rounded flex-shrink-0">
                <DollarSign className="h-3.5 w-3.5 text-white" />
              </div>
              <p className="text-[10px] font-bold text-blue-900 dark:text-blue-300 uppercase tracking-wider truncate">
                Total {label}
              </p>
            </div>
            <div>
              <p className={`${getValueFontSize('₨' + totalSales.toLocaleString())} font-bold text-blue-900 dark:text-blue-200 break-words leading-tight`}>
                ₨{totalSales.toLocaleString()}
              </p>
            </div>
          </div>

          <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-indigo-900/30 dark:to-indigo-800/20 border border-indigo-200 dark:border-indigo-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="bg-indigo-600 dark:bg-indigo-500 p-1.5 rounded flex-shrink-0">
                <Activity className="h-3.5 w-3.5 text-white" />
              </div>
              <p className="text-[10px] font-bold text-indigo-900 dark:text-indigo-300 uppercase tracking-wider truncate">
                Average
              </p>
            </div>
            <div>
              <p className={`${getValueFontSize('₨' + Math.round(avgSales).toLocaleString())} font-bold text-indigo-900 dark:text-indigo-200 break-words leading-tight`}>
                ₨{Math.round(avgSales).toLocaleString()}
              </p>
            </div>
          </div>

          <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/30 dark:to-emerald-800/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="bg-emerald-600 dark:bg-emerald-500 p-1.5 rounded flex-shrink-0">
                <Award className="h-3.5 w-3.5 text-white" />
              </div>
              <p className="text-[10px] font-bold text-emerald-900 dark:text-emerald-300 uppercase tracking-wider truncate">
                Peak Period
              </p>
            </div>
            <div>
              <p className="text-xl lg:text-2xl font-bold text-emerald-900 dark:text-emerald-200 break-words">
                {peakMonth.month}
              </p>
              <p className="text-xs lg:text-sm text-emerald-700 dark:text-emerald-400 font-semibold break-words mt-0.5">
                ₨{peakMonth.sales.toLocaleString()}
              </p>
            </div>
          </div>
        </div>

        {/* Chart Container */}
        <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6 animate-fade-in">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 bg-blue-600 dark:bg-blue-400 rounded-full"></div>
            <span className="text-xs font-semibold text-slate-700 dark:text-slate-300 uppercase tracking-wide">Performance Trend</span>
          </div>

          <div className="h-[320px] bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-800 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={yearlySalesData}
                margin={{ top: 10, right: 30, left: 10, bottom: 10 }}
              >
                <defs>
                  <linearGradient id="salesGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563eb" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#2563eb" stopOpacity={0.05} />
                  </linearGradient>
                  <linearGradient id="salesGradientDark" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#60a5fa" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="#60a5fa" stopOpacity={0.1} />
                  </linearGradient>
                </defs>

                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={colors.grid}
                  vertical={false}
                />
                <XAxis
                  dataKey="month"
                  tick={{ fill: colors.tick, fontWeight: 600, fontSize: 11 }}
                  axisLine={{ stroke: colors.axis, strokeWidth: 1 }}
                  tickLine={false}
                  dy={5}
                />
                <YAxis
                  tick={{ fill: colors.tick, fontWeight: 600, fontSize: 11 }}
                  tickFormatter={(value) => `₨${value / 1000}k`}
                  axisLine={{ stroke: colors.axis, strokeWidth: 1 }}
                  tickLine={false}
                  dx={-5}
                />

                <Tooltip
                  contentStyle={{
                    background: colors.tooltipBackground,
                    borderRadius: "8px",
                    border: colors.tooltipBorder,
                    boxShadow: "0 4px 12px rgba(0, 0, 0, 0.1)",
                    padding: "8px 12px",
                  }}
                  labelStyle={{
                    color: colors.tooltipLabel,
                    fontWeight: "600",
                    fontSize: "12px",
                    marginBottom: "4px"
                  }}
                  formatter={(value: number) => [`₨${value.toLocaleString()}`, label]}
                />

                <ReferenceLine
                  y={avgSales}
                  label={{
                    value: `Avg: ₨${Math.round(avgSales).toLocaleString()}`,
                    position: "right",
                    fill: colors.average,
                    fontWeight: "600",
                    fontSize: 10
                  }}
                  stroke={colors.average}
                  strokeWidth={1.5}
                  strokeDasharray="5 5"
                />

                <Area
                  type="monotone"
                  dataKey="sales"
                  stroke={colors.series}
                  strokeWidth={2.5}
                  fill={colors.seriesFill}
                  dot={{
                    r: 4,
                    fill: colors.dotFill,
                    stroke: colors.series,
                    strokeWidth: 2
                  }}
                  activeDot={{
                    r: 6,
                    fill: colors.series,
                    stroke: "#ffffff",
                    strokeWidth: 2
                  }}
                  animationDuration={1200}
                  animationEasing="ease-in-out"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}

// ----------------- Chart Tooltip Component -----------------
export function ChartTooltip({
  active,
  payload,
  label,
  prefix = "",
  labelText,
}: Readonly<{
  active?: boolean
  payload?: any[]
  label?: string
  prefix?: "currency" | "count" | ""
  labelText?: string
}>) {
  if (!active || !payload?.length) return null
  const value = payload[0].value as number
  const formatted =
    (() => {
      if (prefix === "currency") {
        return currencyFormatter.format(value)
      }
      if (prefix === "count") {
        return `${value.toLocaleString()} orders`
      }
      return value.toLocaleString()
    })()

  return (
    <div className="relative glass-card rounded-[2.5rem] p-8 shadow-2xl overflow-hidden min-h-[440px]">
      <div className="bg-slate-50 dark:bg-slate-900 px-4 py-2 border-b border-slate-200 dark:border-slate-700">
        <p className="font-semibold text-slate-700 dark:text-slate-300 text-xs">{label}</p>
      </div>
      <div className="px-4 py-3">
        {labelText && <p className="text-xs text-slate-500 dark:text-slate-400 mb-1">{labelText}</p>}
        <p className="text-lg font-bold text-slate-900 dark:text-slate-100">{formatted}</p>
      </div>
    </div>
  )
}

// ----------------- Trend Area Chart -----------------
export function TrendAreaChart({ data, className, label = "Purchase" }: Readonly<{ data: TrendPoint[]; className?: string; label?: string }>) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const chartData: ChartDatum[] = useMemo(
    () => data?.map((point) => ({ label: point.label, value: point.value })) || [],
    [data]
  )

  if (!chartData || chartData.length === 0) {
    return (
      <div className={className}>
        <div className="p-6 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
          <p className="text-slate-500 dark:text-slate-400 text-center">No data available</p>
        </div>
      </div>
    )
  }

  const totalValue = chartData.reduce((sum, item) => sum + item.value, 0)
  const peakDay = chartData.reduce((max, item) => item.value > max.value ? item : max, chartData[0])

  return (
    <div className={className}>
      <div className="space-y-6">
        <div className="px-1">
          {/* Mini Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
            <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/30 dark:to-emerald-800/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
              <div className="flex items-center gap-2 mb-2">
                <div className="bg-emerald-600 dark:bg-emerald-500 p-1.5 rounded flex-shrink-0">
                  <DollarSign className="h-3.5 w-3.5 text-white" />
                </div>
                <p className="text-[10px] font-bold text-emerald-800 dark:text-emerald-300 uppercase tracking-wider truncate">
                  Total Value
                </p>
              </div>
              <div>
                <p className={`${getValueFontSize('₨' + totalValue.toLocaleString())} font-bold text-emerald-900 dark:text-emerald-200 break-words leading-tight`}>
                  ₨{totalValue.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
              <div className="flex items-center gap-2 mb-2">
                <div className="bg-blue-600 dark:bg-blue-500 p-1.5 rounded flex-shrink-0">
                  <Award className="h-3.5 w-3.5 text-white" />
                </div>
                <p className="text-[10px] font-bold text-blue-800 dark:text-blue-300 uppercase tracking-wider truncate">
                  Peak Day
                </p>
              </div>
              <div>
                <p className="text-xl lg:text-2xl font-bold text-blue-900 dark:text-blue-200 break-words">
                  {peakDay.label}
                </p>
                <p className="text-xs lg:text-sm text-blue-700 dark:text-blue-400 font-semibold break-words mt-0.5">
                  ₨{peakDay.value.toLocaleString()}
                </p>
              </div>
            </div>

            <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-indigo-900/30 dark:to-indigo-800/20 border border-indigo-200 dark:border-indigo-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
              <div className="flex items-center gap-2 mb-2">
                <div className="bg-indigo-600 dark:bg-indigo-500 p-1.5 rounded flex-shrink-0">
                  <Activity className="h-3.5 w-3.5 text-white" />
                </div>
                <p className="text-[10px] font-bold text-indigo-800 dark:text-indigo-300 uppercase tracking-wider truncate">
                  Average
                </p>
              </div>
              <div>
                <p className={`${getValueFontSize('₨' + Math.round(totalValue / (chartData.length || 1)).toLocaleString())} font-bold text-indigo-900 dark:text-indigo-200 break-words leading-tight`}>
                  ₨{Math.round(totalValue / (chartData.length || 1)).toLocaleString()}
                </p>
              </div>
            </div>
          </div>

          {/* Chart */}
          <div className="bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-4">
            <div className="h-[320px] bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-800 p-3">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 10 }}>
                  <defs>
                    <linearGradient id="weeklyGradient" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="weeklyGradientDark" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#34d399" stopOpacity={0.4} />
                      <stop offset="100%" stopColor="#34d399" stopOpacity={0.1} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid
                    strokeDasharray="3 3"
                    stroke={isDark ? "#475569" : "#e2e8f0"}
                    vertical={false}
                  />
                  <XAxis
                    dataKey="label"
                    tickLine={false}
                    axisLine={{ stroke: isDark ? "#475569" : "#cbd5e1", strokeWidth: 1 }}
                    tickMargin={8}
                    tick={{ fill: isDark ? "#94a3b8" : "#64748b", fontWeight: 600, fontSize: 10 }}
                  />
                  <YAxis
                    tickFormatter={(value) => `₨${value / 1000}k`}
                    width={60}
                    axisLine={{ stroke: isDark ? "#475569" : "#cbd5e1", strokeWidth: 1 }}
                    tickLine={false}
                    tickMargin={8}
                    tick={{ fill: isDark ? "#94a3b8" : "#64748b", fontWeight: 600, fontSize: 10 }}
                  />
                  <Tooltip content={<ChartTooltip prefix="currency" labelText={label} />} />
                  <Area
                    type="monotone"
                    dataKey="value"
                    stroke={isDark ? "#34d399" : "#10b981"}
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill={isDark ? "url(#weeklyGradientDark)" : "url(#weeklyGradient)"}
                    animationDuration={1200}
                    animationEasing="ease-in-out"
                    dot={{
                      r: 4,
                      fill: isDark ? "#1e293b" : "#ffffff",
                      stroke: isDark ? "#34d399" : "#10b981",
                      strokeWidth: 2
                    }}
                    activeDot={{
                      r: 6,
                      fill: isDark ? "#34d399" : "#10b981",
                      stroke: "#ffffff",
                      strokeWidth: 2
                    }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ----------------- Comparison Bar Chart -----------------
export function ComparisonBarChart({
  data,
  className,
  title,
}: Readonly<{
  data: TrendPoint[]
  className?: string
  title?: string
}>) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const chartData: ChartDatum[] = useMemo(
    () => data.map((point) => ({ label: point.label, value: point.value })),
    [data]
  )

  return (
    <div className={className}>
      <div className="relative glass-card rounded-[2.5rem] p-8 shadow-2xl overflow-hidden min-h-[440px]">
        {title && (
          <div className="bg-slate-50 dark:bg-slate-800 border-b border-slate-200 dark:border-slate-700 px-6 py-4">
            <div className="flex items-center gap-3">
              <div className="bg-blue-600 dark:bg-blue-500 p-2 rounded-lg">
                <BarChart3 className="h-5 w-5 text-white" />
              </div>
              <p className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                {title}
              </p>
            </div>
          </div>
        )}
        <div className="h-72 bg-slate-50 dark:bg-slate-900 p-6">
          <div className="h-full bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-800 p-3">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: -10, bottom: 10 }}>
                <defs>
                  <linearGradient id="comparisonBar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563eb" />
                    <stop offset="100%" stopColor="#3b82f6" />
                  </linearGradient>
                  <linearGradient id="comparisonBarDark" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#60a5fa" />
                    <stop offset="100%" stopColor="#3b82f6" />
                  </linearGradient>
                </defs>
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={isDark ? "#475569" : "#e2e8f0"}
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tickLine={false}
                  axisLine={{ stroke: isDark ? "#475569" : "#cbd5e1", strokeWidth: 1 }}
                  tickMargin={8}
                  tick={{ fill: isDark ? "#94a3b8" : "#64748b", fontWeight: 600, fontSize: 10 }}
                />
                <YAxis
                  allowDecimals={false}
                  axisLine={{ stroke: isDark ? "#475569" : "#cbd5e1", strokeWidth: 1 }}
                  tickLine={false}
                  tick={{ fill: isDark ? "#94a3b8" : "#64748b", fontWeight: 600, fontSize: 10 }}
                />
                <Tooltip
                  content={<ChartTooltip prefix="count" />}
                  cursor={{ fill: isDark ? "rgba(51, 65, 85, 0.3)" : "rgba(226, 232, 240, 0.3)" }}
                />
                <Bar
                  dataKey="value"
                  radius={[6, 6, 0, 0]}
                  fill={isDark ? "url(#comparisonBarDark)" : "url(#comparisonBar)"}
                  animationDuration={1000}
                  animationEasing="ease-in-out"
                  label={{
                    position: "top",
                    fill: isDark ? "#cbd5e1" : "#334155",
                    fontSize: 10,
                    fontWeight: "600",
                    offset: 8
                  }}
                />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  )
}

// ----------------- Sales Bar Chart -----------------
export default function SalesBarChart({ data, label = "Purchase" }: Props & { label?: string }) {
  const { theme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)
  }, [])

  const isDark = mounted && theme === "dark"

  if (!data || data.length === 0) {
    return (
      <div className="p-6 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg">
        <p className="text-slate-500 dark:text-slate-400 text-center">No data available</p>
      </div>
    )
  }

  const totalRevenue = data.reduce((sum, item) => sum + item.value, 0)
  const avgRevenue = Math.round(totalRevenue / data.length)
  const peakMonth = data.reduce((max, item) => item.value > max.value ? item : max, data[0])

  return (
    <div className="space-y-6">
      <div className="px-1">
        {/* Chart */}
        <div className="mb-6 bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg p-6">
          <div className="h-[320px] bg-white dark:bg-slate-900 rounded border border-slate-200 dark:border-slate-800 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                data={data}
                barSize={40}
                margin={{ top: 20, right: 20, left: 10, bottom: 10 }}
              >
                <defs>
                  <linearGradient id="barGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#2563eb" />
                    <stop offset="100%" stopColor="#3b82f6" />
                  </linearGradient>
                </defs>

                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={isDark ? "#475569" : "#e2e8f0"}
                  vertical={false}
                />

                <XAxis
                  dataKey="month"
                  tick={{ fill: isDark ? "#94a3b8" : "#64748b", fontWeight: 600, fontSize: 11 }}
                  axisLine={{ stroke: isDark ? "#475569" : "#cbd5e1", strokeWidth: 1 }}
                  tickLine={false}
                  dy={8}
                />

                <YAxis
                  tick={{ fill: isDark ? "#94a3b8" : "#64748b", fontWeight: 600, fontSize: 11 }}
                  axisLine={{ stroke: isDark ? "#475569" : "#cbd5e1", strokeWidth: 1 }}
                  tickLine={false}
                  tickFormatter={(value) => `₨${value / 1000}k`}
                />

                <Tooltip content={<CustomTooltip labelText={label} />} cursor={{ fill: isDark ? "rgba(51, 65, 85, 0.3)" : "rgba(226, 232, 240, 0.3)" }} />

                <Bar
                  dataKey="value"
                  radius={[6, 6, 0, 0]}
                  animationDuration={1000}
                  animationEasing="ease-in-out"
                >
                  {data.map((entry, index) => (
                    <Cell
                      key={entry.month}
                      fill={isDark ? barColorsDark[index % barColorsDark.length] : barColors[index % barColors.length]}
                    />
                  ))}
                  <LabelList
                    dataKey="value"
                    position="top"
                    formatter={(value: number) => `₨${(value / 1000).toFixed(1)}k`}
                    style={{
                      fill: isDark ? "#cbd5e1" : "#334155",
                      fontWeight: "600",
                      fontSize: 10,
                    }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Summary Statistics */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div className="bg-gradient-to-br from-blue-50 to-blue-100 dark:from-blue-900/30 dark:to-blue-800/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="bg-blue-600 dark:bg-blue-500 p-1.5 rounded flex-shrink-0">
                <DollarSign className="h-3.5 w-3.5 text-white" />
              </div>
              <p className="text-[10px] font-bold text-blue-800 dark:text-blue-300 uppercase tracking-wider truncate">Total {label}</p>
            </div>
            <div>
              <p className={`${getValueFontSize('₨' + totalRevenue.toLocaleString())} font-bold text-blue-900 dark:text-blue-200 break-words leading-tight`}>
                ₨{totalRevenue.toLocaleString()}
              </p>
            </div>
          </div>

          <div className="bg-gradient-to-br from-indigo-50 to-indigo-100 dark:from-indigo-900/30 dark:to-indigo-800/20 border border-indigo-200 dark:border-indigo-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="bg-indigo-600 dark:bg-indigo-500 p-1.5 rounded flex-shrink-0">
                <Activity className="h-3.5 w-3.5 text-white" />
              </div>
              <p className="text-[10px] font-bold text-indigo-800 dark:text-indigo-300 uppercase tracking-wider truncate">Average</p>
            </div>
            <div>
              <p className={`${getValueFontSize('₨' + avgRevenue.toLocaleString())} font-bold text-indigo-900 dark:text-indigo-200 break-words leading-tight`}>
                ₨{avgRevenue.toLocaleString()}
              </p>
            </div>
          </div>

          <div className="bg-gradient-to-br from-emerald-50 to-emerald-100 dark:from-emerald-900/30 dark:to-emerald-800/20 border border-emerald-200 dark:border-emerald-800 rounded-lg p-4 hover:shadow-md transition-shadow flex flex-col justify-between min-h-[110px]">
            <div className="flex items-center gap-2 mb-2">
              <div className="bg-emerald-600 dark:bg-emerald-500 p-1.5 rounded flex-shrink-0">
                <Award className="h-3.5 w-3.5 text-white" />
              </div>
              <p className="text-[10px] font-bold text-emerald-800 dark:text-emerald-300 uppercase tracking-wider truncate">Peak Month</p>
            </div>
            <div>
              <p className="text-xl lg:text-2xl font-bold text-emerald-900 dark:text-emerald-200 break-words">
                {peakMonth.month}
              </p>
              <p className="text-xs lg:text-sm text-emerald-700 dark:text-emerald-400 font-semibold break-words mt-0.5">
                ₨{peakMonth.value.toLocaleString()}
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

export type SalesPerformanceLineChartProps = {
  seriesData: SalesSeriesPoint[]
  totalSales: number
  avgSales: number
  totalOrders: number
  peakPeriod: { label: string; sales: number; orders: number } | null
  label?: string
  granularity?: "hourly" | "daily" | "monthly" | "yearly"
  dateRange: DateRange | null
}

const formatCurrency = (value: number) => {
  if (value >= 1000000) return `₨${(value / 1000000).toFixed(1)}M`
  if (value >= 1000) return `₨${(value / 1000).toFixed(1)}k`
  return `₨${value}`
}

function salesPerformanceBaseTheme(isDark: boolean) {
  return {
    comparison: isDark ? "#fbbf24" : "#f59e0b",
    comparisonDotFill: isDark ? "#0f172a" : "#ffffff",
    comparisonActiveStroke: isDark ? "#f59e0b" : "#ffffff",
    grid: isDark ? "#1e293b" : "#f1f5f9",
    tick: isDark ? "#94a3b8" : "#64748b",
    cursor: isDark ? "#475569" : "#cbd5e1",
    secondary: isDark ? "#475569" : "#cbd5e1",
    primaryDotFill: isDark ? "#0f172a" : "#ffffff",
  }
}

function salesPerformanceMetricTheme(isDark: boolean, activeMetric: 'revenue' | 'orders') {
  const isRevenue = activeMetric === 'revenue'
  return {
    series: isRevenue ? (isDark ? "#34d399" : "#10b981") : (isDark ? "#60a5fa" : "#3b82f6"),
    activeDotStroke: isRevenue ? (isDark ? "#10b981" : "#ffffff") : (isDark ? "#3b82f6" : "#ffffff"),
    shadowClass: isRevenue ? 'rgba(16,185,129,0.5)' : 'rgba(59,130,246,0.5)',
    axisWidth: isRevenue ? 100 : 55,
  }
}

function salesPerfTooltipModel(data: any, activeMetric: string, isBuyer: boolean, hasComparison: boolean) {
  const sales = data.sales ?? 0
  const orders = data.orders ?? 0
  const compSales = data.compSales ?? 0
  const compOrders = data.compOrders ?? 0
  const isRevenue = activeMetric === 'revenue'
  const currentValue = isRevenue ? sales : orders
  const previousValue = isRevenue ? compSales : compOrders
  const metricLabel = isRevenue ? (isBuyer ? 'Purchased' : 'Revenue') : 'Orders'
  const formatValue = (value: number) => isRevenue ? `â‚¨ ${value.toLocaleString()}` : value.toLocaleString()
  const changePercent = hasComparison && previousValue > 0
    ? ((currentValue - previousValue) / previousValue) * 100
    : 0
  return {
    sales,
    orders,
    isRevenue,
    currentValue,
    previousValue,
    metricLabel,
    formatValue,
    changePercent,
    changeDirection: currentValue >= previousValue ? 'up' : 'down',
  }
}

function SalesPerfCurrentCard({ model }: Readonly<{ model: ReturnType<typeof salesPerfTooltipModel> }>) {
  return (
    <div className={cn("p-4 rounded-2xl ring-1 ring-inset", model.isRevenue ? 'bg-emerald-500/10 ring-emerald-500/20' : 'bg-blue-500/10 ring-blue-500/20')}>
      <div className="flex items-center gap-2 mb-2">
        <div className={`h-2 w-2 rounded-full ${model.isRevenue ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]'}`} />
        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Current {model.metricLabel}</span>
      </div>
      <span className={cn("text-2xl font-black tracking-tighter", model.isRevenue ? 'text-emerald-600 dark:text-emerald-400' : 'text-blue-600 dark:text-blue-400')}>
        {model.formatValue(model.currentValue)}
      </span>
    </div>
  )
}

function SalesPerfComparisonCard({ model }: Readonly<{ model: ReturnType<typeof salesPerfTooltipModel> }>) {
  return (
    <div className="p-4 rounded-2xl bg-amber-500/10 ring-1 ring-inset ring-amber-500/20">
      <div className="flex items-center gap-2 mb-2">
        <div className="h-2 w-2 rounded-full bg-amber-500 shadow-[0_0_8px_rgba(245,158,11,0.5)]" />
        <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest">Previous {model.metricLabel}</span>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-xl font-bold text-amber-600 dark:text-amber-400 tracking-tight">{model.formatValue(model.previousValue)}</span>
        <div className={cn("flex items-center gap-1 px-2.5 py-1 rounded-full text-[10px] font-black", model.changeDirection === 'up' ? 'bg-emerald-500/20 text-emerald-600 dark:text-emerald-400' : 'bg-red-500/20 text-red-600 dark:text-red-400')}>
          {model.changeDirection === 'up' ? 'â–²' : 'â–¼'} {Math.abs(model.changePercent).toFixed(1)}%
        </div>
      </div>
    </div>
  )
}

function SalesPerfSummary({ model }: Readonly<{ model: ReturnType<typeof salesPerfTooltipModel> }>) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div className="p-3 rounded-xl bg-slate-500/5 ring-1 ring-inset ring-slate-500/10">
        <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase block mb-1">Orders</span>
        <span className="text-sm font-bold text-slate-900 dark:text-white">{model.orders.toLocaleString()}</span>
      </div>
      <div className="p-3 rounded-xl bg-slate-500/5 ring-1 ring-inset ring-slate-500/10">
        <span className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase block mb-1">Avg Value</span>
        <span className="text-sm font-bold text-slate-900 dark:text-white">â‚¨{model.orders > 0 ? Math.round(model.sales / model.orders).toLocaleString() : 0}</span>
      </div>
    </div>
  )
}

const SalesPerfTooltip = ({ active, payload, label: tooltipLabel, activeMetric, hasComparison }: any) => {
  const { userRole } = useAppContext()
  if (!active || !payload?.length) return null
  const isBuyer = ["HEAD_OFFICE", "BRANCH_ADMIN"].includes(userRole ?? "")
  const model = salesPerfTooltipModel(payload[0].payload, activeMetric, isBuyer, hasComparison)
  return (
    <div className="glass shadow-[0_20px_60px_rgba(0,0,0,0.2)] dark:shadow-[0_20px_60px_rgba(0,0,0,0.4)] p-5 rounded-[1.5rem] border border-white/20 dark:border-slate-700/30 min-w-[280px]">
      <p className="font-black text-slate-900 dark:text-white text-lg mb-4 tracking-tight border-b border-slate-200/50 dark:border-slate-800/50 pb-2">{tooltipLabel}</p>
      <div className="space-y-4">
        <SalesPerfCurrentCard model={model} />
        {hasComparison && model.previousValue > 0 && <SalesPerfComparisonCard model={model} />}
        {!hasComparison && <SalesPerfSummary model={model} />}
      </div>
    </div>
  )
}

export function SalesPerformanceLineChart({
  seriesData,
  comparisonSeries,
  totalSales,
  avgSales,
  totalOrders,
  peakPeriod,
  label = "Sales",
  granularity = "daily",
  dateRange,
}: SalesPerformanceLineChartProps & { comparisonSeries?: SalesSeriesPoint[] }) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const [activeMetric, setActiveMetric] = useState<'revenue' | 'orders'>('revenue')
  const chartTheme = salesPerformanceBaseTheme(isDark)
  const metricTheme = salesPerformanceMetricTheme(isDark, activeMetric)

  const hasComparison = !!comparisonSeries && comparisonSeries.length > 0

  const safeData = useMemo(() => {
    if (!dateRange?.startDate || !dateRange.endDate) {
      return seriesData
    }

    const { startDate, endDate } = dateRange
    let intervals: Date[]

    if (granularity === 'hourly') {
      intervals = eachHourOfInterval({ start: startOfDay(startDate), end: endOfDay(endDate) })
    } else if (granularity === 'daily') {
      const start = startOfDay(startDate)
      const end = endOfDay(endDate)
      if (isSameDay(start, end)) {
        // Padding for single day consistency
        intervals = [subDays(start, 1), start, addDays(start, 1)]
      } else {
        intervals = eachDayOfInterval({ start, end })
      }
    } else if (granularity === 'yearly') {
      intervals = eachYearOfInterval({ start: startOfYear(startDate), end: endOfYear(endDate) })
    } else {
      intervals = eachMonthOfInterval({ start: startOfMonth(startDate), end: endOfMonth(endDate) })
    }

    const padded = intervals.map((date, index) => {
      let labelStr = ""
      if (granularity === 'hourly') labelStr = format(date, 'hh:mm a')
      else if (granularity === 'daily') labelStr = format(date, 'dd MMM')
      else if (granularity === 'yearly') labelStr = format(date, 'yyyy')
      else labelStr = format(date, 'MMM yyyy')

      const match = seriesData?.find(d => d.label === labelStr)
      // Comparison data might have different labels if granularity is daily/monthly
      // In many cases, we want to overlay point-for-point
      const compMatch = comparisonSeries ? (comparisonSeries[index] || null) : null

      return {
        label: labelStr,
        sales: match?.sales ?? 0,
        orders: match?.orders ?? 0,
        compSales: compMatch?.sales ?? 0,
        compOrders: compMatch?.orders ?? 0,
        fullDate: date
      }
    })

    const mapped = padded.map(d => {
      const vSales = Math.sqrt(d.sales || 0)
      const vOrders = Math.sqrt(d.orders || 0)
      const vCompSales = Math.sqrt(d.compSales || 0)
      const vCompOrders = Math.sqrt(d.compOrders || 0)

      return {
        ...d,
        vSales,
        vOrders,
        vCompSales,
        vCompOrders,
        vActive: activeMetric === 'revenue' ? vSales : vOrders,
        vCompActive: activeMetric === 'revenue' ? vCompSales : vCompOrders,
        vSecondary: activeMetric === 'revenue' ? vOrders : vSales
      }
    })

    return mapped
  }, [seriesData, comparisonSeries, dateRange, granularity, activeMetric])

  const isEmpty = useMemo(() => !seriesData || seriesData.length === 0 || totalSales === 0, [seriesData, totalSales])

  return (
    <motion.div 
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6 }}
      className="space-y-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h3 className="text-2xl font-black text-slate-900 dark:text-white flex items-center gap-3 tracking-tighter">
            <div className="p-2 rounded-xl bg-primary/10 text-primary">
               <TrendingUp className="w-6 h-6" />
            </div>
            Overview
          </h3>
          <p className="text-xs font-bold text-slate-500 dark:text-slate-400 mt-1 uppercase tracking-widest opacity-70">
            Real-time performance analytics
          </p>
        </div>

        {/* Metric Toggle */}
        <div className="flex p-1 bg-slate-100 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
          <button type="button"
            onClick={() => setActiveMetric('revenue')}
            className={`
              flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200
              ${activeMetric === 'revenue'
                ? "bg-white dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 shadow-sm"
                : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}
            `}
          >
            <div className={`w-2 h-2 rounded-full ${activeMetric === 'revenue' ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`} />
            Revenue
          </button>
          <button type="button"
            onClick={() => setActiveMetric('orders')}
            className={`
              flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200
              ${activeMetric === 'orders'
                ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm"
                : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}
            `}
          >
            <div className={`w-2 h-2 rounded-full ${activeMetric === 'orders' ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-700'}`} />
            Orders
          </button>
        </div>
      </div>

      <div className="relative glass-card rounded-[2.5rem] p-8 shadow-2xl overflow-hidden min-h-[440px]">
        {isEmpty && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/40 dark:bg-slate-950/40 backdrop-blur-[2px]">
            <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4 shadow-inner">
              <Info className="w-8 h-8 text-slate-300 dark:text-slate-600" />
            </div>
            <p className="text-sm font-bold text-slate-400 dark:text-slate-500">No activity recorded for this period</p>
            <p className="text-[11px] text-slate-300 dark:text-slate-600 mt-1 font-medium italic">Adjust filters to see more results</p>
          </div>
        )}

        <div className={`h-[380px] w-full transition-opacity duration-500 ${isEmpty ? 'opacity-30 grayscale-[50%]' : 'opacity-100'}`}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={safeData}
              margin={{ top: 20, right: 30, left: 20, bottom: 20 }}
            >
              <defs>
                <linearGradient id="activeMetricGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={metricTheme.series} stopOpacity={0.25} />
                  <stop offset="100%" stopColor={metricTheme.series} stopOpacity={0.02} />
                </linearGradient>
                <linearGradient id="comparisonMetricGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={chartTheme.comparison} stopOpacity={0.15} />
                  <stop offset="100%" stopColor={chartTheme.comparison} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="4 4" vertical={false} stroke={chartTheme.grid} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: chartTheme.tick, fontSize: 11, fontWeight: 700 }}
                dy={15}
                minTickGap={25}
              />
              <YAxis
                axisLine={false}
                tickLine={false}
                tick={{ fill: chartTheme.tick, fontSize: 11, fontWeight: 700 }}
                tickFormatter={(val) => {
                  const realVal = Math.pow(val, 2)
                  return activeMetric === 'revenue'
                    ? `₨ ${formatCurrency(realVal).replace('₨', '')}`
                    : Math.round(realVal).toLocaleString()
                }}
                width={metricTheme.axisWidth}
                dx={-10}
                domain={[0, 'auto']}
              />
              <Tooltip
                content={<SalesPerfTooltip activeMetric={activeMetric} hasComparison={hasComparison} />}
                cursor={{ stroke: chartTheme.cursor, strokeWidth: 1.5, strokeDasharray: "4 4" }}
              />

              {/* Comparison Line */}
              {hasComparison && (
                <Area
                  type="monotone"
                  dataKey="vCompActive"
                  stroke={chartTheme.comparison}
                  strokeWidth={3}
                  fill="url(#comparisonMetricGrad)"
                  dot={{
                    r: 3,
                    strokeWidth: 2,
                    fill: chartTheme.comparisonDotFill,
                    stroke: chartTheme.comparison
                  }}
                  activeDot={{
                    r: 6,
                    strokeWidth: 2,
                    fill: chartTheme.comparison,
                    stroke: chartTheme.comparisonActiveStroke
                  }}
                  animationDuration={1500}
                />
              )}

              {/* Secondary Metric Line */}
              {!hasComparison && (
                <Line
                  type="monotone"
                  dataKey="vSecondary"
                  stroke={chartTheme.secondary}
                  strokeWidth={2}
                  strokeDasharray="8 6"
                  dot={false}
                  activeDot={false}
                  animationDuration={1500}
                />
              )}

              {/* Primary Active Metric Area */}
              <Area
                type="monotone"
                dataKey="vActive"
                stroke={metricTheme.series}
                strokeWidth={4}
                fill="url(#activeMetricGrad)"
                animationDuration={1500}
                animationEasing="ease-in-out"
                dot={{
                  r: 4,
                  strokeWidth: 2.5,
                  fill: chartTheme.primaryDotFill,
                  stroke: metricTheme.series
                }}
                activeDot={{
                  r: 8,
                  strokeWidth: 3,
                  fill: metricTheme.series,
                  stroke: metricTheme.activeDotStroke,
                  className: `drop-shadow-[0_0_12px_${metricTheme.shadowClass}]`
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Comparison Legend */}
        {hasComparison && (
          <div className="flex items-center justify-center gap-8 mt-4 p-3 bg-slate-50/80 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-800">
            <div className="flex items-center gap-2.5">
              <div className={`w-6 h-1 rounded-full ${activeMetric === 'revenue' ? 'bg-emerald-500' : 'bg-blue-500'}`} />
              <span className="text-xs font-bold text-slate-600 dark:text-slate-300">Current Period</span>
            </div>
            <div className="flex items-center gap-2.5">
              <div className="w-6 h-1 rounded-full bg-amber-500" />
              <span className="text-xs font-bold text-slate-600 dark:text-slate-300">Previous Period</span>
            </div>
          </div>
        )}
      </div>
    </motion.div>
  )
}


// ── Sales Performance Bar Chart (Standardized) ──
export function SalesPerformanceBarChart({
  seriesData,
  comparisonSeries,
  totalSales,
  avgSales,
  totalOrders,
  peakPeriod,
  label = "Sales",
  granularity = "daily",
  dateRange,
  organizationSales,
  branchSales,
  showOrgView,
}: SalesPerformanceLineChartProps & {
  comparisonSeries?: SalesSeriesPoint[]
  organizationSales?: { organizationId: number; organizationName: string; sales: number; orders: number }[]
  branchSales?: BranchSalesPoint[]
  showOrgView?: boolean
}) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'
  const { userRole } = useAppContext()
  const isBuyer = userRole === "HEAD_OFFICE" || userRole === "BRANCH_ADMIN"

  const [activeMetric, setActiveMetric] = useState<'revenue' | 'orders' | 'sales'>('revenue')

  const hasComparison = !!comparisonSeries && comparisonSeries.length > 0

  const yAxisLabel = useMemo(() => {
    const unit = activeMetric === 'orders' ? 'Orders' : 'PKR'
    if (!dateRange?.startDate) return unit
    const { startDate, endDate } = dateRange
    const startYear = startDate.getFullYear()
    const endYear = endDate.getFullYear()
    if (startYear !== endYear) return `${unit} · ${startYear}–${endYear}`
    if (startDate.getMonth() !== endDate.getMonth()) return `${unit} · ${startYear}`
    return `${unit} · ${format(startDate, 'MMM yyyy')}`
  }, [activeMetric, dateRange])

  const safeData = useMemo(() => {
    let dataToMap = seriesData || []

    if (dateRange?.startDate && dateRange.endDate) {
      const { startDate, endDate } = dateRange
      let intervals: Date[]

      if (granularity === 'hourly') {
        intervals = eachHourOfInterval({ start: startOfDay(startDate), end: endOfDay(endDate) })
      } else if (granularity === 'daily') {
        const start = startOfDay(startDate)
        const end = endOfDay(endDate)
        if (isSameDay(start, end)) {
          // Add padding for single day to keep the bar small and centered
          intervals = [subDays(start, 1), start, addDays(start, 1)]
        } else {
          intervals = eachDayOfInterval({ start, end })
        }
      } else if (granularity === 'yearly') {
        intervals = eachYearOfInterval({ start: startOfYear(startDate), end: endOfYear(endDate) })
      } else {
        intervals = eachMonthOfInterval({ start: startOfMonth(startDate), end: endOfMonth(endDate) })
      }

      dataToMap = intervals.map((date, index) => {
        let labelStr = ""
        if (granularity === 'hourly') labelStr = format(date, 'hh:mm a')
        else if (granularity === 'daily') labelStr = format(date, 'dd MMM')
        else if (granularity === 'yearly') labelStr = format(date, 'yyyy')
        else labelStr = format(date, 'MMM yyyy')

        const match = seriesData?.find(d => d.label === labelStr)
        const compMatch = comparisonSeries ? (comparisonSeries[index] || null) : null

        return {
          label: labelStr,
          sales: match?.sales ?? 0,
          orders: match?.orders ?? 0,
          compSales: compMatch?.sales ?? 0,
          compOrders: compMatch?.orders ?? 0,
          fullDate: date
        }
      })
    }

    return dataToMap.map((d: any) => ({
      ...d,
      active: activeMetric === 'revenue' ? (d.sales || 0) : (d.orders || 0),
      compActive: activeMetric === 'revenue' ? (d.compSales || 0) : (d.compOrders || 0),
    }))
  }, [seriesData, comparisonSeries, dateRange, granularity, activeMetric])

  const isEmpty = useMemo(() => !seriesData || seriesData.length === 0 || totalSales === 0, [seriesData, totalSales])

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1 }}
      className="space-y-6"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <p className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-[0.3em]">
            {(() => {
              if (activeMetric === 'revenue') {
                return (isBuyer ? 'Purchase Distribution' : 'Revenue Distribution')
              }
              return 'Order Volume Metrics'
            })()}
          </p>
        </div>

        {/* Metric Toggle */}
        <div className="flex p-1 bg-slate-100 dark:bg-slate-900 rounded-xl border border-slate-200 dark:border-slate-800">
          <button type="button"
            onClick={() => setActiveMetric('revenue')}
            className={`
              flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200
              ${activeMetric === 'revenue'
                ? "bg-white dark:bg-slate-800 text-emerald-600 dark:text-emerald-400 shadow-sm"
                : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}
            `}
          >
            <div className={`w-2 h-2 rounded-full ${activeMetric === 'revenue' ? 'bg-emerald-500' : 'bg-slate-300 dark:bg-slate-700'}`} />
            {isBuyer ? 'Purchased' : 'Revenue'}
          </button>
          <button type="button"
            onClick={() => setActiveMetric('orders')}
            className={`
              flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200
              ${activeMetric === 'orders'
                ? "bg-white dark:bg-slate-800 text-blue-600 dark:text-blue-400 shadow-sm"
                : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}
            `}
          >
            <div className={`w-2 h-2 rounded-full ${activeMetric === 'orders' ? 'bg-blue-500' : 'bg-slate-300 dark:bg-slate-700'}`} />
            Orders
          </button>
          {(organizationSales || branchSales) && (
            <button type="button"
              onClick={() => setActiveMetric('sales')}
              className={`
                flex items-center gap-2 px-4 py-1.5 rounded-lg text-xs font-bold transition-all duration-200
                ${activeMetric === 'sales'
                  ? "bg-white dark:bg-slate-800 text-amber-600 dark:text-amber-400 shadow-sm"
                  : "text-slate-500 hover:text-slate-700 dark:hover:text-slate-300"}
              `}
            >
              <div className={`w-2 h-2 rounded-full ${activeMetric === 'sales' ? 'bg-amber-500' : 'bg-slate-300 dark:bg-slate-700'}`} />
              {(() => {
                if (showOrgView === false) {
                  return (isBuyer ? 'Branch Purchased' : 'Branch Sales')
                }
                return ((() => {
                  if (organizationSales && organizationSales.length > 0) {
                    return (isBuyer ? 'Org Purchased' : 'Org Sales')
                  }
                  return (isBuyer ? 'Branch Purchased' : 'Branch Sales')
                })())
              })()}
            </button>
          )}
        </div>
      </div>

      <div className="relative glass-card rounded-[2.5rem] p-8 shadow-2xl overflow-hidden min-h-[440px]">
        {(() => {
          if (activeMetric === 'sales') {
            return (
          /* ── Inline Organization / Branch Sales View ── */
          <div className="py-2">
            {(() => {
              if (showOrgView === false) {
                return (
              /* Show Branch Sales */
              branchSales && branchSales.length > 0 ? (
                <BranchSalesBarChart branchSales={branchSales} label={label} />
              ) : (
                <div className="h-48 flex items-center justify-center bg-slate-50/50 dark:bg-slate-900/30 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800">
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No branch data available for this period</p>
                </div>
              )
            )
              }
              return (
              /* Show Organization Sales (default when no specific org selected) */
              (() => {
                if (organizationSales && organizationSales.length > 0) {
                  return (
                <OrganizationSalesBarChart organizationSales={organizationSales} label={label} />
              )
                }
                if (branchSales && branchSales.length > 0) {
                  return (
                <BranchSalesBarChart branchSales={branchSales} label={label} />
              )
                }
                return (
                <div className="h-48 flex items-center justify-center bg-slate-50/50 dark:bg-slate-900/30 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800">
                  <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No organization data available for this period</p>
                </div>
              )
              })()
            )
            })()}
          </div>
        )
          }
          return (
          /* ── Default Revenue / Orders Bar Chart ── */
          <>
            {isEmpty && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center bg-white/40 dark:bg-slate-950/40 backdrop-blur-[2px]">
                <div className="w-16 h-16 rounded-full bg-slate-100 dark:bg-slate-800 flex items-center justify-center mb-4 shadow-inner">
                  <Info className="w-8 h-8 text-slate-300 dark:text-slate-600" />
                </div>
                <p className="text-sm font-bold text-slate-400 dark:text-slate-500">No activity recorded for this period</p>
              </div>
            )}

            <div className={`h-[380px] w-full transition-opacity duration-500 ${isEmpty ? 'opacity-30 grayscale-[50%]' : 'opacity-100'}`}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={safeData}
                  margin={{ top: 20, right: 30, left: 40, bottom: 20 }}
                  barGap={hasComparison ? 8 : 0}
                >
                  <defs>
                    <linearGradient id="activeBarGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={activeMetric === 'revenue' ? "#10b981" : "#3b82f6"} stopOpacity={1} />
                      <stop offset="100%" stopColor={activeMetric === 'revenue' ? "#059669" : "#2563eb"} stopOpacity={0.8} />
                    </linearGradient>
                    <linearGradient id="compBarGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.7} />
                      <stop offset="100%" stopColor="#d97706" stopOpacity={0.5} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" vertical={false} stroke={isDark ? "#1e293b" : "#f1f5f9"} />
                  <XAxis
                    dataKey="label"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: isDark ? "#94a3b8" : "#64748b", fontSize: 11, fontWeight: 700 }}
                    dy={15}
                    minTickGap={10}
                  />
                  <YAxis
                    axisLine={false}
                    tickLine={false}
                    tick={{ fill: isDark ? "#94a3b8" : "#64748b", fontSize: 11, fontWeight: 700 }}
                    tickFormatter={(val) => {
                      return activeMetric === 'revenue'
                        ? formatCurrency(val)
                        : val.toLocaleString()
                    }}
                    width={80}
                    dx={-10}
                    label={{
                      value: yAxisLabel,
                      angle: -90,
                      position: 'insideLeft',
                      offset: -25,
                      style: { fontSize: 10, fontWeight: 700, fill: isDark ? "#64748b" : "#94a3b8", textAnchor: 'middle' }
                    }}
                  />
                  <Tooltip
                    content={<SalesPerfTooltip activeMetric={activeMetric} hasComparison={hasComparison} />}
                    cursor={{ fill: isDark ? "rgba(255,255,255,0.05)" : "rgba(0,0,0,0.02)" }}
                  />

                  {hasComparison && (
                    <Bar
                      dataKey="compActive"
                      name="Previous Period"
                      fill="url(#compBarGrad)"
                      radius={[4, 4, 0, 0]}
                      animationDuration={1500}
                    />
                  )}

                  <Bar
                    dataKey="active"
                    name="Current Period"
                    fill="url(#activeBarGrad)"
                    radius={[4, 4, 0, 0]}
                    animationDuration={1500}
                    barSize={granularity === 'daily' && safeData.length <= 7 ? 60 : undefined}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Legend */}
            {hasComparison && (
              <div className="flex items-center justify-center gap-8 mt-4 p-3 bg-slate-50/80 dark:bg-slate-900/50 rounded-xl border border-slate-200 dark:border-slate-800">
                <div className="flex items-center gap-2.5">
                  <div className={`w-4 h-4 rounded-sm ${activeMetric === 'revenue' ? 'bg-emerald-500' : 'bg-blue-500'}`} />
                  <span className="text-xs font-bold text-slate-600 dark:text-slate-300">Current Period</span>
                </div>
                <div className="flex items-center gap-2.5">
                  <div className="w-4 h-4 rounded-sm bg-amber-500" />
                  <span className="text-xs font-bold text-slate-600 dark:text-slate-300">Previous Period</span>
                </div>
              </div>
            )}
          </>
        )
        })()}
      </div>
    </motion.div>
  )
}


// ── Branch Sales Horizontal Bar Chart ──
const HorizontalBranchTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md p-4 rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 dark:border-slate-800 min-w-[200px]">
      <p className="font-bold text-slate-800 dark:text-slate-200 text-sm mb-2.5 pb-2 border-b border-slate-100 dark:border-slate-800">{d.branchName}</p>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Sales</span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white">₨{d.sales.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Orders</span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white">{d.orders.toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

export function BranchSalesBarChart({ branchSales, label = "Sales" }: Readonly<{ branchSales: BranchSalesPoint[]; label?: string }>) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  const filteredBranches = branchSales.filter(b => b.sales > 0 || b.orders > 0)

  if (!filteredBranches || filteredBranches.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center bg-slate-50/50 dark:bg-slate-900/30 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No branch data available for this period</p>
      </div>
    )
  }

  const sortedBranches = [...filteredBranches].sort((a, b) => b.sales - a.sales)
  const topBranchId = sortedBranches[0]?.branchId

  // Dynamic height: if 1 branch 90px, else 55px per branch (min 200)
  const chartHeight = sortedBranches.length === 1 ? 90 : Math.max(200, sortedBranches.length * 55)

  const barFill = (entry: any) => {
    if (entry.branchId === topBranchId) return isDark ? "#fbbf24" : "#f59e0b"
    return isDark ? "#818cf8" : "#6366f1"
  }

  return (
    <div>
      <div style={{ height: chartHeight }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={sortedBranches}
            layout="vertical"
            margin={{ top: 5, right: 80, left: 10, bottom: 5 }}
            barCategoryGap="20%"
          >
            <CartesianGrid strokeDasharray="4 4" horizontal={false} stroke={isDark ? "#1e293b" : "#f1f5f9"} />
            <XAxis
              type="number"
              axisLine={false}
              tickLine={false}
              tick={{ fill: isDark ? "#64748b" : "#94a3b8", fontSize: 11, fontWeight: 600 }}
              tickFormatter={(v) => {
                if (v >= 1000000) return `₨${(v / 1000000).toFixed(1)}M`
                if (v >= 1000) return `₨${(v / 1000).toFixed(0)}k`
                return `₨${v}`
              }}
            />
            <YAxis
              type="category"
              dataKey="branchName"
              axisLine={false}
              tickLine={false}
              width={150}
              tick={{ fill: isDark ? "#94a3b8" : "#475569", fontSize: 12, fontWeight: 600 }}
            />
            <Tooltip
              content={<HorizontalBranchTooltip />}
              cursor={{ fill: isDark ? "rgba(51,65,85,0.08)" : "rgba(241,245,249,0.6)" }}
            />
            <Bar
              dataKey="sales"
              radius={[0, 6, 6, 0]}
              animationDuration={1200}
              animationEasing="ease-out"
              minPointSize={10}
              barSize={32}
            >
              <LabelList
                dataKey="sales"
                position="right"
                formatter={(v: number) => {
                  if (v >= 1000000) return `₨${(v / 1000000).toFixed(1)}M`
                  if (v >= 1000) return `₨${(v / 1000).toFixed(1)}k`
                  return `₨${v}`
                }}
                style={{ fill: isDark ? "#cbd5e1" : "#475569", fontWeight: 700, fontSize: 11 }}
              />
              {sortedBranches.map((entry, index) => (
                <Cell key={entry.branchName} fill={barFill(entry)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center justify-center gap-6 mt-4 p-2.5 bg-slate-50/80 dark:bg-slate-900/50 rounded-xl border border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-amber-500 shadow-sm" />
          <span className="text-xs font-bold text-slate-500 dark:text-slate-400">Top Branch</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-indigo-500 shadow-sm" />
          <span className="text-xs font-bold text-slate-500 dark:text-slate-400">Other Branches</span>
        </div>
      </div>
    </div>
  )
}

// ── Organization Sales Bar Chart ──
const OrgTooltipContent = ({ active, payload, label: bLabel }: any) => {
  if (!active || !payload?.length) return null
  const sales = payload.find((p: any) => p.dataKey === 'sales')?.value ?? 0
  const ordersVal = payload.find((p: any) => p.dataKey === 'orders')?.value ?? 0

  return (
    <div className="bg-slate-900/95 dark:bg-slate-800/95 border border-slate-700 p-3 rounded-xl shadow-2xl backdrop-blur-sm text-sm">
      <div className="font-bold text-white mb-2">{bLabel}</div>
      <div className="flex justify-between gap-4 text-emerald-400">
        <span className="font-medium">Total Sales</span>
        <span className="font-bold">₨{sales.toLocaleString()}</span>
      </div>
      <div className="flex justify-between gap-4 text-blue-400 mt-1">
        <span className="font-medium">Orders Finished</span>
        <span className="font-bold">{ordersVal}</span>
      </div>
    </div>
  )
}

// ── Organization Sales Horizontal Bar Chart ──
const HorizontalOrgTooltip = ({ active, payload }: any) => {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="bg-white/95 dark:bg-slate-900/95 backdrop-blur-md p-4 rounded-xl shadow-[0_8px_30px_rgb(0,0,0,0.12)] border border-slate-100 dark:border-slate-800 min-w-[200px]">
      <p className="font-bold text-slate-800 dark:text-slate-200 text-sm mb-2.5 pb-2 border-b border-slate-100 dark:border-slate-800">{d.name}</p>
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Total Sales</span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white">₨{d.sales.toLocaleString()}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">Orders</span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white">{d.orders.toLocaleString()}</span>
        </div>
      </div>
    </div>
  )
}

export function OrganizationSalesBarChart({
  organizationSales,
  label = "Organization Sales",
}: Readonly<{
  organizationSales: { organizationId: number; organizationName: string; sales: number; orders: number }[]
  label?: string
}>) {
  const { theme } = useTheme()
  const isDark = theme === 'dark'

  const filteredOrgs = organizationSales.filter(o => o.sales > 0 || o.orders > 0)

  if (!filteredOrgs || filteredOrgs.length === 0) {
    return (
      <div className="h-48 flex items-center justify-center bg-slate-50/50 dark:bg-slate-900/30 rounded-2xl border border-dashed border-slate-200 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-500 dark:text-slate-400">No organization data available for this period</p>
      </div>
    )
  }

  const sortedOrgs = [...filteredOrgs].sort((a, b) => b.sales - a.sales).map(o => ({
    name: o.organizationName,
    sales: o.sales,
    orders: o.orders,
    id: o.organizationId
  }))

  const topOrgId = sortedOrgs[0]?.id

  // Dynamic height: if 1 org 90px, else 55px per org (min 200)
  const chartHeight = sortedOrgs.length === 1 ? 90 : Math.max(200, sortedOrgs.length * 55)

  const barFill = (entry: any) => {
    if (entry.id === topOrgId) return isDark ? "#fbbf24" : "#f59e0b"
    return isDark ? "#818cf8" : "#6366f1"
  }

  return (
    <div className="relative">
      <div style={{ height: chartHeight }} className="w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={sortedOrgs}
            layout="vertical"
            margin={{ top: 5, right: 80, left: 10, bottom: 5 }}
            barCategoryGap="20%"
          >
            <CartesianGrid strokeDasharray="4 4" horizontal={false} stroke={isDark ? "#1e293b" : "#f1f5f9"} />
            <XAxis
              type="number"
              axisLine={false}
              tickLine={false}
              tick={{ fill: isDark ? "#64748b" : "#94a3b8", fontSize: 11, fontWeight: 600 }}
              tickFormatter={(v) => {
                if (v >= 1000000) return `₨${(v / 1000000).toFixed(1)}M`
                if (v >= 1000) return `₨${(v / 1000).toFixed(0)}k`
                return `₨${v}`
              }}
            />
            <YAxis
              type="category"
              dataKey="name"
              axisLine={false}
              tickLine={false}
              width={150}
              tick={{ fill: isDark ? "#94a3b8" : "#475569", fontSize: 12, fontWeight: 600 }}
            />
            <Tooltip
              content={<HorizontalOrgTooltip />}
              cursor={{ fill: isDark ? "rgba(51,65,85,0.08)" : "rgba(241,245,249,0.6)" }}
            />
            <Bar
              dataKey="sales"
              radius={[0, 6, 6, 0]}
              animationDuration={1200}
              animationEasing="ease-out"
              minPointSize={10}
              barSize={32}
            >
              <LabelList
                dataKey="sales"
                position="right"
                formatter={(v: number) => {
                  if (v >= 1000000) return `₨${(v / 1000000).toFixed(1)}M`
                  if (v >= 1000) return `₨${(v / 1000).toFixed(1)}k`
                  return `₨${v}`
                }}
                style={{ fill: isDark ? "#cbd5e1" : "#475569", fontWeight: 700, fontSize: 11 }}
              />
              {sortedOrgs.map((entry, index) => (
                <Cell key={entry.name} fill={barFill(entry)} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="flex items-center justify-center gap-6 mt-4 p-2.5 bg-slate-50/80 dark:bg-slate-900/50 rounded-xl border border-slate-100 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-amber-500 shadow-sm" />
          <span className="text-xs font-bold text-slate-500 dark:text-slate-400">Top Organization</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 rounded bg-indigo-500 shadow-sm" />
          <span className="text-xs font-bold text-slate-500 dark:text-slate-400">Other Organizations</span>
        </div>
      </div>
    </div>
  )
}
