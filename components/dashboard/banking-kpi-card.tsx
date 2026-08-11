"use client"
import { ArrowUpRight,ArrowDownRight } from "lucide-react"
import { motion,AnimatePresence } from "framer-motion"
import { cn } from "@/lib/utils"

export type TrendDirection = "up" | "down"

type BankingKPICardProps = {
    icon: any
    title: string
    value: string | number
    subtitle?: string
    trend?: TrendDirection
    trendValue?: string
    gradient: string
    iconBg: string
    delay?: number
    onClick?: () => void
    comparisonValue?: string | number
    comparisonLabel?: string
    isLoading?: boolean
    details?: Array<{ label: string; value: string | number }>
}

/* Decorative background glow */
const GlowBackground = ({ gradient }: { gradient: string }) => (
    <>
        <div className={cn(
            "absolute -right-12 -top-12 h-48 w-48 rounded-full blur-[80px] opacity-10 transition-opacity duration-700 group-hover:opacity-25 bg-gradient-to-br",
            gradient
        )} />
        <div className={cn(
            "absolute -left-8 -bottom-8 h-32 w-32 rounded-full blur-[60px] opacity-10 transition-opacity duration-700 group-hover:opacity-20 bg-gradient-to-tr",
            gradient
        )} />
    </>
)

export const BankingKPICard = ({
    icon: Icon,
    title,
    value,
    subtitle,
    trend,
    trendValue,
    gradient,
    iconBg,
    delay = 0,
    onClick,
    comparisonValue,
    comparisonLabel,
    isLoading = false,
    details,
}: BankingKPICardProps) => {
    const isPositive = trend === "up"

    return (
        <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
                duration: 0.5,
                delay: delay / 1000,
                ease: [0.23, 1, 0.32, 1]
            }}
            whileHover={{ y: -4, scale: 1.02 }}
            whileTap={{ scale: 0.98 }}
            onClick={onClick}
            className={cn(
                "group relative overflow-hidden rounded-[1.5rem] p-4 transition-all duration-500",
                "glass-card hover:shadow-[0_20px_50px_rgba(0,0,0,0.1)] dark:hover:shadow-[0_20px_50px_rgba(0,0,0,0.3)]",
                onClick && "cursor-pointer"
            )}
        >
            <GlowBackground gradient={gradient} />

            <div className="relative flex items-center justify-between mb-3">
                {/* Compact Icon Container */}
                <div className="relative">
                    <div className={cn(
                        "absolute inset-0 blur-xl opacity-20 group-hover:opacity-40 transition-opacity duration-500 rounded-full scale-150 bg-gradient-to-br",
                        gradient
                    )} />
                    <div className="relative w-10 h-10 rounded-xl bg-white dark:bg-slate-800 shadow-sm border border-slate-200/50 dark:border-slate-700/50 flex items-center justify-center transition-all duration-500 group-hover:scale-110 group-hover:-rotate-6 ring-1 ring-black/5 dark:ring-white/5">
                        <Icon className={cn("w-5 h-5 transition-colors duration-300", iconBg.split(' ')[0])} strokeWidth={2.5} />
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <AnimatePresence>
                        {!isLoading && trend && trendValue !== "0.0%" && (
                            <motion.div
                                initial={{ opacity: 0, x: 10 }}
                                animate={{ opacity: 1, x: 0 }}
                                className={cn(
                                    "flex items-center gap-1.5 px-3 py-1.5 rounded-full border backdrop-blur-md",
                                    isPositive
                                        ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                                        : 'bg-red-500/10 border-red-500/20 text-red-600 dark:text-red-400'
                                )}
                            >
                                {isPositive ? (
                                    <ArrowUpRight className="w-3.5 h-3.5" />
                                ) : (
                                    <ArrowDownRight className="w-3.5 h-3.5" />
                                )}
                                <span className="text-xs font-bold tracking-tight">
                                    {trendValue}
                                </span>
                            </motion.div>
                        )}
                    </AnimatePresence>
                    
                    {onClick && (
                        <div className="w-8 h-8 rounded-full bg-slate-100/50 dark:bg-slate-800/50 flex items-center justify-center text-slate-400 dark:text-slate-500 group-hover:bg-primary group-hover:text-primary-foreground transition-all duration-500 shadow-sm border border-slate-200/20 dark:border-slate-700/20">
                            <ArrowUpRight className="w-4 h-4" />
                        </div>
                    )}
                </div>
            </div>

            <div className="relative space-y-0.5">
                <p className="text-[9px] font-bold text-slate-500 dark:text-slate-400 uppercase tracking-widest line-clamp-1">
                    {title}
                </p>
                <div className="flex items-baseline gap-2">
                    {isLoading ? (
                        <div className="h-7 w-24 rounded-md bg-slate-200 dark:bg-slate-700 animate-pulse" />
                    ) : (
                        <p className={cn(
                            "font-extrabold text-slate-900 dark:text-white tracking-tight leading-none",
                            "text-lg lg:text-xl xl:text-2xl"
                        )}>
                            {value}
                        </p>
                    )}
                </div>
                
                {subtitle && (
                    <motion.p 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        className="text-[10px] font-medium text-slate-400 dark:text-slate-500 mt-1"
                    >
                        {subtitle}
                    </motion.p>
                )}

                {!isLoading && details && details.length > 0 && (
                    <div className="mt-2 grid grid-cols-2 gap-1.5">
                        {details.map((detail) => (
                            <div
                                key={detail.label}
                                className="rounded-lg border border-slate-200/60 bg-white/45 px-2 py-1 dark:border-slate-700/50 dark:bg-slate-900/35"
                            >
                                <p className="text-[8px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                                    {detail.label}
                                </p>
                                <p className="text-xs font-extrabold leading-tight text-slate-700 dark:text-slate-200">
                                    {detail.value}
                                </p>
                            </div>
                        ))}
                    </div>
                )}

                {!isLoading && comparisonValue && trendValue !== "0.0%" && (
                    <p className="text-[9px] text-slate-400 dark:text-slate-500 mt-1 flex items-center gap-1">
                        <span className="opacity-50 line-through">vs {comparisonValue}</span>
                        <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700 mx-0.5" />
                        <span className="font-semibold uppercase tracking-wider">{comparisonLabel}</span>
                    </p>
                )}
            </div>

            {/* Side & Bottom Accent Bars */}
            <div className="absolute top-0 left-0 bottom-0 w-1 overflow-hidden opacity-40 group-hover:opacity-100 transition-opacity duration-500">
                <div className={cn(
                    "h-full w-full bg-gradient-to-b",
                    gradient
                )} />
            </div>
            
            <div className="absolute bottom-0 left-0 right-0 h-1 overflow-hidden opacity-30 group-hover:opacity-100 transition-opacity duration-500">
                <div className={cn(
                    "h-full w-full bg-gradient-to-r",
                    gradient
                )} />
            </div>
        </motion.div>
    )
}
