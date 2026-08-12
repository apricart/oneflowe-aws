"use client"

import { Drawer } from "vaul"
import { X,Copy,Check,LayoutDashboard,Info } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useState } from "react"
import { cn } from "@/lib/utils"

export interface DetailField {
    key?: string
    label: string
    value: string | number | React.ReactNode
    type?: "text" | "badge" | "currency" | "date" | "mono" | "section"
}

interface ExpandableRowDrawerProps {
    open: boolean
    onClose: () => void
    title: string
    subtitle?: string
    fields: DetailField[]
}

export function ExpandableRowDrawer({ open, onClose, title, subtitle, fields }: Readonly<ExpandableRowDrawerProps>) {
    const [copiedField, setCopiedField] = useState<string | null>(null)

    const handleCopy = (label: string, value: string | number | React.ReactNode) => {
        if (typeof value === "string" || typeof value === "number") {
            navigator.clipboard.writeText(String(value))
            setCopiedField(label)
            setTimeout(() => setCopiedField(null), 2000)
        }
    }

    return (
        <Drawer.Root open={open} onOpenChange={(isOpen) => !isOpen && onClose()} direction="right">
            <Drawer.Portal>
                <Drawer.Overlay className="fixed inset-0 bg-black/40 backdrop-blur-[2px] z-50 transition-all duration-300" />
                <Drawer.Content
                    className="fixed right-0 top-0 bottom-0 w-full max-w-lg bg-white dark:bg-slate-950 shadow-[0_0_50px_-12px_rgba(0,0,0,0.5)] z-50 flex flex-col outline-none border-l border-slate-200 dark:border-slate-800"
                    style={{ borderTopLeftRadius: "24px", borderBottomLeftRadius: "24px" }}
                >
                    {/* Header */}
                    <div className="relative p-8 border-b border-slate-100 dark:border-slate-800 bg-gradient-to-br from-slate-50/50 via-white to-white dark:from-slate-900/50 dark:via-slate-950 dark:to-slate-950">
                        <div className="flex items-start justify-between gap-6">
                            <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-3 mb-2">
                                    <div className="p-2 rounded-xl bg-indigo-500/10 text-indigo-500 dark:bg-indigo-500/20">
                                        <LayoutDashboard className="h-5 w-5" />
                                    </div>
                                    <Drawer.Title className="text-xl font-black text-slate-900 dark:text-white tracking-tight truncate">
                                        {title}
                                    </Drawer.Title>
                                </div>
                                {subtitle && (
                                    <Drawer.Description className="text-sm font-medium text-slate-400 dark:text-slate-500 flex items-center gap-2">
                                        <span className="w-1 h-1 rounded-full bg-slate-300 dark:bg-slate-700" />
                                        {subtitle}
                                    </Drawer.Description>
                                )}
                            </div>
                            <Button
                                variant="ghost"
                                size="sm"
                                onClick={onClose}
                                className="h-10 w-10 p-0 rounded-2xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-900 dark:hover:text-white transition-all"
                            >
                                <X className="h-5 w-5" />
                            </Button>
                        </div>

                        {/* Decorative background element */}
                        <div className="absolute top-0 right-0 w-32 h-32 bg-indigo-500/5 blur-3xl rounded-full -mr-16 -mt-16 pointer-events-none" />
                    </div>

                    {/* Body */}
                    <div className="flex-1 overflow-y-auto p-8 space-y-8 scrollbar-hide">
                        <div className="space-y-4">
                            {fields.map((field) => {
                                if (field.type === "section") {
                                    return (
                                        <div key={field.key ?? `section-${field.label}`} className="pt-6 pb-2 first:pt-0">
                                            <div className="flex items-center gap-2 mb-4">
                                                <div className="h-4 w-1 bg-indigo-500 rounded-full" />
                                                <h4 className="text-[12px] font-black uppercase tracking-[0.15em] text-slate-900 dark:text-white">
                                                    {field.label}
                                                </h4>
                                            </div>
                                            {field.value}
                                        </div>
                                    )
                                }

                                return (
                                    <div
                                        key={field.key ?? `field-${field.label}`}
                                        className="group relative flex items-center justify-between gap-6 p-4 rounded-2xl bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-800/50 hover:border-indigo-500/30 hover:shadow-lg hover:shadow-indigo-500/5 transition-all duration-300"
                                    >
                                        <div className="flex-1 min-w-0">
                                            <p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500 mb-1.5 flex items-center gap-1.5">
                                                <Info className="h-3 w-3 opacity-50" />
                                                {field.label}
                                            </p>
                                            <div className={cn(
                                                "text-[15px] font-bold text-slate-900 dark:text-white",
                                                field.type === "mono" && "font-mono text-sm tracking-tight",
                                                field.type === "currency" && "font-mono text-indigo-600 dark:text-indigo-400",
                                                field.type === "date" && "font-mono text-sm"
                                            )}>
                                                {field.type === "badge" ? (
                                                    <Badge variant="outline" className="bg-indigo-50 dark:bg-indigo-900/30 text-indigo-600 dark:text-indigo-400 border-none text-[10px] uppercase font-black tracking-widest px-2.5 py-0.5">
                                                        {field.value}
                                                    </Badge>
                                                ) : (
                                                    field.value
                                                )}
                                            </div>
                                        </div>

                                        <div className="shrink-0 flex items-center gap-2">
                                            {(typeof field.value === "string" || typeof field.value === "number") && (
                                                <button type="button"
                                                    onClick={() => handleCopy(field.label, field.value)}
                                                    className="opacity-0 group-hover:opacity-100 transition-all p-2 rounded-xl hover:bg-slate-100 dark:hover:bg-slate-800 text-slate-400 hover:text-indigo-500"
                                                >
                                                    {copiedField === field.label ? (
                                                        <Check className="h-4 w-4 text-emerald-500" />
                                                    ) : (
                                                        <Copy className="h-4 w-4" />
                                                    )}
                                                </button>
                                            )}
                                        </div>
                                    </div>
                                )
                            })}
                        </div>
                    </div>

                    {/* Footer */}
                    <div className="p-8 border-t border-slate-100 dark:border-slate-800 bg-white dark:bg-slate-950">
                        <Button
                            onClick={onClose}
                            className="w-full h-12 text-sm font-bold bg-slate-900 hover:bg-black dark:bg-white dark:hover:bg-slate-100 text-white dark:text-slate-900 rounded-2xl shadow-xl shadow-slate-900/10 dark:shadow-white/5 transition-all active:scale-95"
                        >
                            Dismiss Details
                        </Button>
                    </div>
                </Drawer.Content>
            </Drawer.Portal>
        </Drawer.Root>
    )
}
