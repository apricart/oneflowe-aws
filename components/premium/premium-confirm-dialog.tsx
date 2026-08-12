"use client"

import * as React from "react"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { AlertCircle,AlertTriangle,Info,CheckCircle2 } from "lucide-react"
import { cn } from "@/lib/utils"

type ConfirmType = "danger" | "warning" | "info" | "success"

interface PremiumConfirmProps {
    open: boolean
    onOpenChange: (open: boolean) => void
    onConfirm: () => void
    title: string
    description?: string
    confirmText?: string
    cancelText?: string
    type?: ConfirmType
    isLoading?: boolean
}

export function PremiumConfirmDialog({
    open,
    onOpenChange,
    onConfirm,
    title,
    description,
    confirmText = "Confirm",
    cancelText = "Cancel",
    type = "info",
    isLoading = false,
}: Readonly<PremiumConfirmProps>) {

    const iconConfig = {
        danger: {
            icon: AlertCircle,
            color: "text-red-500",
            bg: "bg-red-50 dark:bg-red-950/30",
            button: "bg-red-600 hover:bg-red-700 text-white",
            pulse: "bg-red-500/20"
        },
        warning: {
            icon: AlertTriangle,
            color: "text-amber-500",
            bg: "bg-amber-50 dark:bg-amber-950/30",
            button: "bg-amber-600 hover:bg-amber-700 text-white",
            pulse: "bg-amber-500/20"
        },
        info: {
            icon: Info,
            color: "text-blue-500",
            bg: "bg-blue-50 dark:bg-blue-950/30",
            button: "bg-blue-600 hover:bg-blue-700 text-white",
            pulse: "bg-blue-500/20"
        },
        success: {
            icon: CheckCircle2,
            color: "text-emerald-500",
            bg: "bg-emerald-50 dark:bg-emerald-950/30",
            button: "bg-emerald-600 hover:bg-emerald-700 text-white",
            pulse: "bg-emerald-500/20"
        }
    }[type]

    const Icon = iconConfig.icon

    return (
        <AlertDialog open={open} onOpenChange={onOpenChange}>
            <AlertDialogContent className="max-w-[300px] border-none bg-white/90 dark:bg-slate-900/90 backdrop-blur-2xl rounded-[1.875rem] shadow-[0_24px_48px_-9px_rgba(0,0,0,0.2)] p-6 overflow-hidden">
                {/* Abstract Background Elements */}
                <div className={cn("absolute -top-[72px] -right-[72px] w-36 h-36 opacity-20 blur-3xl rounded-full", iconConfig.pulse)} />

                <AlertDialogHeader className="relative z-10 flex flex-col items-center sm:items-center text-center">
                    <div className={cn("h-[60px] w-[60px] rounded-3xl flex items-center justify-center mb-[18px] relative group", iconConfig.bg)}>
                        <div className={cn("absolute inset-0 rounded-3xl opacity-40 animate-ping", iconConfig.pulse)} />
                        <Icon size={30} className={cn("relative z-10", iconConfig.color)} />
                    </div>
                    <AlertDialogTitle className="text-lg font-black text-slate-900 dark:text-white leading-tight">
                        {title}
                    </AlertDialogTitle>
                    {description && (
                        <AlertDialogDescription className="text-slate-500 dark:text-slate-400 font-medium text-sm mt-2.5 leading-relaxed">
                            {description}
                        </AlertDialogDescription>
                    )}
                </AlertDialogHeader>

                <AlertDialogFooter className="flex-col sm:flex-row gap-2.5 mt-6 relative z-10 w-full sm:justify-center">
                    <AlertDialogCancel className="w-full sm:w-1/2 h-[42px] rounded-xl border-slate-200 dark:border-slate-800 font-bold text-sm text-slate-600 hover:bg-slate-50 dark:hover:bg-slate-800 transition-all duration-300">
                        {cancelText}
                    </AlertDialogCancel>
                    <AlertDialogAction
                        onClick={(e: React.MouseEvent) => {
                            e.preventDefault()
                            if (!isLoading) onConfirm()
                        }}
                        disabled={isLoading}
                        className={cn(
                            "w-full sm:w-1/2 h-[42px] rounded-xl font-black text-sm shadow-lg shadow-blue-500/20 transition-all duration-300 hover:scale-[1.02] active:scale-[0.98]",
                            iconConfig.button
                        )}
                    >
                        {isLoading ? "Processing..." : confirmText}
                    </AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
