"use client"
import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { AlertTriangle, RefreshCw, Home } from "lucide-react"

export default function GlobalError({
  error,
  reset,
}: Readonly<{
  error: Error & { digest?: string }
  reset: () => void
}>) {
  useEffect(() => {
    // Log error to monitoring service
    console.error("Application Error:", error)
  }, [error])

  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-white dark:from-slate-950 dark:to-slate-900 p-4">
      <Card className="w-full max-w-lg p-8 space-y-6">
        <div className="flex items-center justify-center h-16 w-16 bg-red-50 dark:bg-red-950 rounded-full mx-auto">
          <AlertTriangle className="h-8 w-8 text-red-600 dark:text-red-400" />
        </div>

        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold text-slate-900 dark:text-white">Something went wrong!</h1>
          <p className="text-muted-foreground">An error occurred while processing your request.</p>
        </div>

        <div className="p-4 bg-red-50 dark:bg-red-950 border border-red-200 dark:border-red-800 rounded-lg space-y-2">
          <p className="text-sm font-mono text-red-700 dark:text-red-300 break-all">
            {error.message || "Unknown error"}
          </p>
          {error.digest && (
            <p className="text-xs text-red-600 dark:text-red-400">
              Error ID: {error.digest}
            </p>
          )}
        </div>

        <div className="flex gap-3">
          <Button
            onClick={reset}
            className="flex-1 gap-2 bg-blue-600 hover:bg-blue-700"
          >
            <RefreshCw className="h-4 w-4" />
            Try Again
          </Button>
          <Button
            onClick={() => window.location.replace("/")}
            variant="outline"
            className="flex-1 gap-2"
          >
            <Home className="h-4 w-4" />
            Home
          </Button>
        </div>

        <p className="text-xs text-muted-foreground text-center">
          If this problem persists, please contact support with Error ID: {error.digest}
        </p>
      </Card>
    </main>
  )
}
