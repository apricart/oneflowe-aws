"use client"

import * as React from "react"
import { useEffect } from "react"
import { motion, AnimatePresence } from "framer-motion"
import { X, AlertCircle, CheckCircle2, Info, AlertTriangle } from "lucide-react"
import { cn } from "@/lib/utils"

export type AlertType = "success" | "error" | "warning" | "info"

interface PremiumAlertProps {
    message: string
    type?: AlertType
    duration?: number // in milliseconds
    isVisible: boolean
    onClose: () => void
    placement?: "fixed" | "sticky"
}

export function PremiumAlert({
    message,
    type = "info",
    duration = 5000,
    isVisible,
    onClose,
    placement = "fixed",
}: Readonly<PremiumAlertProps>) {
    useEffect(() => {
        if (!isVisible) return

        const timer = setTimeout(() => {
            onClose()
        }, duration)

        return () => clearTimeout(timer)
    }, [isVisible, duration, onClose])

    const config = {
        success: {
            icon: CheckCircle2,
            color: "text-emerald-500",
            bg: "bg-emerald-50/90 dark:bg-emerald-950/90",
            border: "border-emerald-200/50 dark:border-emerald-800/50",
            bar: "bg-emerald-500",
            shadow: "shadow-emerald-500/20",
        },
        error: {
            icon: AlertCircle,
            color: "text-red-500",
            bg: "bg-red-50/90 dark:bg-red-950/90",
            border: "border-red-200/50 dark:border-red-800/50",
            bar: "bg-red-500",
            shadow: "shadow-red-500/20",
        },
        warning: {
            icon: AlertTriangle,
            color: "text-amber-500",
            bg: "bg-amber-50/90 dark:bg-amber-950/90",
            border: "border-amber-200/50 dark:border-amber-800/50",
            bar: "bg-amber-500",
            shadow: "shadow-amber-500/20",
        },
        info: {
            icon: Info,
            color: "text-blue-500",
            bg: "bg-blue-50/90 dark:bg-blue-950/90",
            border: "border-blue-200/50 dark:border-blue-800/50",
            bar: "bg-blue-500",
            shadow: "shadow-blue-500/20",
        },
    }[type]

    const Icon = config.icon
    const containerClassName = placement === "sticky"
        ? "sticky top-0 z-[60] flex justify-center px-2 pb-3 pointer-events-none"
        : "fixed inset-x-0 top-8 z-[9999] flex justify-center px-4 pointer-events-none"

    return (
        <AnimatePresence>
            {isVisible && (
                <div data-premium-alert className={containerClassName}>
                    <motion.div
                        initial={{ opacity: 0, y: -20, scale: 0.95 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, y: -20, scale: 0.95 }}
                        className={cn(
                            "relative pointer-events-auto flex items-center gap-4 overflow-hidden rounded-2xl border p-4 pr-12 shadow-2xl backdrop-blur-xl min-w-[320px] max-w-[500px]",
                            config.bg,
                            config.border,
                            config.shadow
                        )}
                    >
                        <div className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", config.bg)}>
                            <Icon className={cn("h-6 w-6", config.color)} />
                        </div>

                        <div className="flex-1 min-w-0">
                            <p className="text-sm font-semibold text-slate-900 dark:text-white leading-relaxed whitespace-pre-wrap break-words">
                                {typeof message === 'string' ? message : JSON.stringify(message)}
                            </p>
                        </div>

                        <button type="button"
                            onClick={(event) => {
                                event.preventDefault()
                                event.stopPropagation()
                                onClose()
                            }}
                            className="absolute right-2 top-2 rounded-full p-2 text-slate-400 hover:bg-slate-200/50 dark:hover:bg-slate-800/50 hover:text-slate-600 dark:hover:text-slate-200 transition-colors"
                        >
                            <X className="h-4 w-4" />
                        </button>

                        {/* Progress Bar */}
                        <div className="absolute bottom-0 left-0 h-1 w-full bg-slate-200/30 dark:bg-slate-700/30">
                            <motion.div
                                className={cn("h-full", config.bar)}
                                initial={{ width: "100%" }}
                                animate={{ width: "0%" }}
                                transition={{ duration: duration / 1000, ease: "linear" }}
                            />
                        </div>
                    </motion.div>
                </div>
            )}
        </AnimatePresence>
    )
}
