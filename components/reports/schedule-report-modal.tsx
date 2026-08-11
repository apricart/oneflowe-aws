"use client"

import { useState,useEffect } from "react"
import { Clock,Mail,FileText,FileSpreadsheet,FileIcon as FilePdf,CalendarClock,Check,Play } from "lucide-react"
import useSWR,{ mutate } from "swr"
import { fetcher } from "@/lib/fetcher"
import { useToast } from "@/hooks/use-toast"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"

interface ScheduleReportModalProps {
    reportName: string
    storageKey?: string
}

interface ScheduleConfig {
    frequency: "daily" | "weekly" | "monthly"
    format: "pdf" | "csv" | "excel"
    emails: string[]
    enabled: boolean
}

export function ScheduleReportModal({ reportName, storageKey = "schedule-report" }: Readonly<ScheduleReportModalProps>) {
    const [open, setOpen] = useState(false)
    const [saved, setSaved] = useState(false)
    const [isSaving, setIsSaving] = useState(false)
    const [isTesting, setIsTesting] = useState(false)
    const [emailInput, setEmailInput] = useState("")
    const { toast } = useToast()

    const { data: schedules } = useSWR<any[]>("/api/v1/reports/schedule", fetcher)
    const activeSchedule = schedules?.find(s => s.reportName === reportName)

    const [config, setConfig] = useState<ScheduleConfig>({
        frequency: "weekly",
        format: "pdf",
        emails: [],
        enabled: false,
    })

    useEffect(() => {
        if (activeSchedule) {
            setConfig({
                frequency: activeSchedule.frequency,
                format: activeSchedule.format,
                emails: activeSchedule.emails || [],
                enabled: activeSchedule.enabled,
            })
        }
    }, [activeSchedule])

    const handleSave = async () => {
        setIsSaving(true)
        try {
            const res = await fetch("/api/v1/reports/schedule", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    ...config,
                    reportName,
                    id: activeSchedule?.id
                }),
            })
            if (res.ok) {
                mutate("/api/v1/reports/schedule")
                setSaved(true)
                toast({
                    title: "Schedule Saved",
                    description: `The delivery schedule for ${reportName} has been updated.`,
                })
                setTimeout(() => {
                    setSaved(false)
                    setOpen(false)
                }, 1500)
            } else {
                toast({
                    title: "Failed to Save",
                    description: "There was an error saving your schedule. Please try again.",
                    variant: "destructive",
                })
            }
        } catch (error) {
            console.error(error)
            toast({
                title: "Error",
                description: "A network error occurred while saving the schedule.",
                variant: "destructive",
            })
        } finally {
            setIsSaving(false)
        }
    }

    const handleTestNow = async () => {
        if (!activeSchedule?.id) return
        setIsTesting(true)
        try {
            const res = await fetch("/api/v1/reports/process-schedules", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ scheduleId: activeSchedule.id, isTest: true }),
            })
            
            if (res.ok) {
                toast({
                    title: "Test Successful",
                    description: "The report has been processed and sent to the recipients.",
                })
            } else {
                toast({
                    title: "Test Failed",
                    description: "The server failed to process the report test.",
                    variant: "destructive",
                })
            }
        } catch (error) {
            console.error("Failed to run scheduled report test:", error)
            toast({
                title: "Test Error",
                description: "A network error occurred during the test.",
                variant: "destructive",
            })
        } finally {
            setIsTesting(false)
        }
    }

    const addEmail = () => {
        const email = emailInput.trim()
        if (email && email.includes("@") && !config.emails.includes(email)) {
            setConfig(prev => ({ ...prev, emails: [...prev.emails, email] }))
            setEmailInput("")
        }
    }

    const removeEmail = (email: string) => {
        setConfig(prev => ({ ...prev, emails: prev.emails.filter(e => e !== email) }))
    }

    const formatIcons = {
        pdf: <FilePdf className="h-4 w-4" />,
        csv: <FileText className="h-4 w-4" />,
        excel: <FileSpreadsheet className="h-4 w-4" />,
    }

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className="h-9 gap-2 text-xs font-semibold border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800"
                >
                    <CalendarClock className="h-3.5 w-3.5 text-slate-400" />
                    Schedule
                    {config.enabled && (
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                    )}
                </Button>
            </DialogTrigger>
            <DialogContent className="sm:max-w-md border-slate-200 dark:border-slate-700">
                <DialogHeader>
                    <DialogTitle className="flex items-center gap-2 text-lg">
                        <Clock className="h-5 w-5 text-indigo-500" />
                        Schedule Report
                    </DialogTitle>
                    <DialogDescription>
                        Configure automated {reportName} delivery to your inbox.
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-5 pt-2">
                    {/* Frequency */}
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 block">
                            Frequency
                        </p>
                        <div className="flex gap-2">
                            {(["daily", "weekly", "monthly"] as const).map(freq => (
                                <button type="button"
                                    key={freq}
                                    onClick={() => setConfig(prev => ({ ...prev, frequency: freq }))}
                                    className={cn(
                                        "flex-1 py-2 rounded-lg text-xs font-bold capitalize transition-all border",
                                        config.frequency === freq
                                            ? "bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300"
                                            : "border-slate-200 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600"
                                    )}
                                >
                                    {freq}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Format */}
                    <div>
                        <p className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 block">
                            Export Format
                        </p>
                        <div className="flex gap-2">
                            {(["pdf", "csv", "excel"] as const).map(fmt => (
                                <button type="button"
                                    key={fmt}
                                    onClick={() => setConfig(prev => ({ ...prev, format: fmt }))}
                                    className={cn(
                                        "flex-1 flex items-center justify-center gap-2 py-2 rounded-lg text-xs font-bold uppercase transition-all border",
                                        config.format === fmt
                                            ? "bg-indigo-50 dark:bg-indigo-900/30 border-indigo-200 dark:border-indigo-800 text-indigo-700 dark:text-indigo-300"
                                            : "border-slate-200 dark:border-slate-700 text-slate-500 hover:border-slate-300 dark:hover:border-slate-600"
                                    )}
                                >
                                    {formatIcons[fmt]}
                                    {fmt}
                                </button>
                            ))}
                        </div>
                    </div>

                    {/* Email Recipients */}
                    <div>
                        <label htmlFor="schedule-report-recipients" className="text-[10px] font-bold uppercase tracking-wider text-slate-400 mb-2 block">
                            Email Recipients
                        </label>
                        <div className="flex gap-2">
                            <Input
                                id="schedule-report-recipients"
                                type="email"
                                placeholder="email@example.com"
                                value={emailInput}
                                onChange={(e) => setEmailInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && addEmail()}
                                className="h-9 text-xs"
                            />
                            <Button onClick={addEmail} size="sm" className="h-9 px-3 text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white">
                                Add
                            </Button>
                        </div>
                        {config.emails.length > 0 && (
                            <div className="flex flex-wrap gap-1.5 mt-2">
                                {config.emails.map(email => (
                                    <Badge
                                        key={email}
                                        variant="secondary"
                                        className="text-[10px] font-medium cursor-pointer hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 transition-colors"
                                        onClick={() => removeEmail(email)}
                                    >
                                        <Mail className="h-2.5 w-2.5 mr-1 opacity-50" />
                                        {email} ×
                                    </Badge>
                                ))}
                            </div>
                        )}
                    </div>

                    {/* Save Button */}
                    <div className="flex gap-2">
                        <Button
                            onClick={handleSave}
                            className={cn(
                                "flex-[2] h-10 text-xs font-bold transition-all",
                                saved
                                    ? "bg-emerald-600 hover:bg-emerald-600 text-white"
                                    : "bg-indigo-600 hover:bg-indigo-700 text-white"
                            )}
                            disabled={config.emails.length === 0 || isSaving}
                        >
                            {(() => {
                              if (isSaving) {
                                return (
                                "Saving..."
                            )
                              }
                              if (saved) {
                                return (
                                <span className="flex items-center gap-2"><Check className="h-4 w-4" /> Saved Successfully</span>
                            )
                              }
                              return (
                                "Save Schedule"
                            )
                            })()}
                        </Button>

                        {activeSchedule && (
                            <Button
                                variant="outline"
                                onClick={handleTestNow}
                                disabled={isTesting}
                                className="flex-1 h-10 text-xs font-bold border-slate-200 dark:border-slate-700"
                            >
                                {isTesting ? (
                                    "Testing..."
                                ) : (
                                    <span className="flex items-center gap-2"><Play className="h-3.5 w-3.5" /> Test</span>
                                )}
                            </Button>
                        )}
                    </div>
                    <p className="text-[10px] text-center text-slate-400">
                        {activeSchedule?.lastExecutedAt
                            ? `Last sent: ${new Date(activeSchedule.lastExecutedAt).toLocaleDateString()}`
                            : "Server-side email delivery is active for this schedule."}
                    </p>
                </div>
            </DialogContent>
        </Dialog>
    )
}
