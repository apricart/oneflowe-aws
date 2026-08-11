"use client"
import { Spinner } from "@/components/ui/spinner"

export function LoaderOverlay({ show = true, label = "Loading..." }: Readonly<{ show?: boolean; label?: string }>) {
  if (!show) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-background/60 backdrop-blur-sm">
      <div className="flex items-center gap-3 rounded-lg border bg-card px-4 py-3 shadow-lg">
        <Spinner className="h-5 w-5" />
        <span className="text-sm">{label}</span>
      </div>
    </div>
  )
}
